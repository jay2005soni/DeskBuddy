import express from 'express';
import helmet from 'helmet';
import { randomUUID, createHmac } from 'node:crypto';
import { ZodError } from 'zod';
import { ApiError, unavailable } from './errors.js';
import * as s from './schemas.js';
export function createApp(config, auth, store, logging = true) {
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', config.TRUST_PROXY_HOPS);
    app.use(helmet());
    app.use((req, res, next)=>{
        res.locals.requestId = randomUUID();
        res.set('Cache-Control', 'no-store').set('X-Request-Id', res.locals.requestId);
        if (logging) res.on('finish', ()=>{
            process.stdout.write(JSON.stringify({
                requestId: res.locals.requestId,
                method: req.method,
                status: res.statusCode
            }) + '\n');
        });
        if (config.NODE_ENV === 'production' && req.path !== '/healthz' && !req.secure) return next(new ApiError(400, 'https_required', 'HTTPS is required.'));
        next();
    });
    app.use(express.json({
        limit: '32kb',
        strict: true,
        type: 'application/json'
    }));
    app.use((req, _res, next)=>{
        if ([
            'POST',
            'PATCH',
            'PUT'
        ].includes(req.method) && !req.is('application/json')) return next(new ApiError(415, 'unsupported_media_type', 'Use application/json.'));
        next();
    });
    const ok = (res, data, status = 200)=>res.status(status).json({
            data,
            requestId: res.locals.requestId
        });
    const noQuery = (req, _res, next)=>{
        try {
            s.noQuery.parse(req.query);
            next();
        } catch (e) {
            next(e);
        }
    };
    const limit = (scope, max, windowMs, key)=>async (req, res, next)=>{
            try {
                const hash = createHmac('sha256', config.CURSOR_SECRET).update(`${scope}:${key(req, res)}`).digest('hex');
                const retry = await store.consumeLimit(hash, max, windowMs);
                if (retry) {
                    res.set('Retry-After', String(retry));
                    throw new ApiError(429, 'rate_limited', 'Too many requests. Please retry later.');
                }
                next();
            } catch (e) {
                next(e);
            }
        };
    const ipLimit = (scope, max)=>limit(scope, max, 15 * 60000, (req)=>req.ip ?? 'unknown');
    const emailLimit = (scope, max)=>limit(scope, max, 15 * 60000, (req)=>typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase().slice(0, 254) : 'invalid');
    app.get('/healthz', noQuery, (_req, res)=>ok(res, {
            status: 'ok'
        }));
    app.post('/v1/auth/signup', noQuery, ipLimit('auth-ip', 30), emailLimit('signup-email', 5), async (req, res)=>{
        const body = s.signup.parse(req.body);
        const pair = await auth.signup(body.email, body.password, body.displayName);
        const uid = await auth.verify(pair.accessToken);
        await auth.setName(uid, body.displayName);
        const user = await store.profile(await auth.user(uid));
        ok(res, {
            ...pair,
            user
        }, 201);
    });
    app.post('/v1/auth/login', noQuery, ipLimit('auth-ip', 30), emailLimit('login-email', 15), async (req, res)=>{
        const body = s.login.parse(req.body);
        const pair = await auth.login(body.email, body.password);
        const uid = await auth.verify(pair.accessToken);
        ok(res, {
            ...pair,
            user: await store.profile(await auth.user(uid))
        });
    });
    app.post('/v1/auth/refresh', noQuery, ipLimit('refresh-ip', 120), async (req, res)=>ok(res, await auth.refresh(s.refresh.parse(req.body).refreshToken)));
    app.post('/v1/auth/forgot-password', noQuery, ipLimit('reset-ip', 10), emailLimit('reset-email', 3), async (req, res)=>{
        await auth.forgot(s.forgot.parse(req.body).email);
        ok(res, {
            message: 'If an account exists, a reset email will be sent.'
        });
    });
    const protectedApi = express.Router();
    protectedApi.use(ipLimit('protected-ip', 600));
    protectedApi.use(async (req, res, next)=>{
        const match = /^Bearer ([^\s]{1,8192})$/i.exec(req.get('Authorization') ?? '');
        if (!match) throw new ApiError(401, 'unauthorized', 'A Bearer token is required.');
        res.locals.token = match[1];
        res.locals.uid = await auth.verify(match[1]);
        next();
    });
    protectedApi.use(limit('user', 600, 60000, (_req, res)=>res.locals.uid));
    protectedApi.post('/auth/send-verification', noQuery, limit('verify', 3, 15 * 60000, (_req, res)=>res.locals.uid), async (req, res)=>{
        s.empty.parse(req.body);
        await auth.verification(res.locals.uid, res.locals.token);
        ok(res, {
            message: 'Verification email requested.'
        });
    });
    protectedApi.get('/me', noQuery, async (_req, res)=>ok(res, {
            profile: await store.profile(await auth.user(res.locals.uid))
        }));
    protectedApi.patch('/me', noQuery, async (req, res)=>{
        const body = s.profilePatch.parse(req.body);
        if (body.displayName !== undefined) await auth.setName(res.locals.uid, body.displayName);
        ok(res, {
            profile: await store.profile(await auth.user(res.locals.uid), body)
        });
    });
    protectedApi.get('/me/preferences', noQuery, async (_req, res)=>ok(res, {
            preferences: await store.preferences(res.locals.uid)
        }));
    protectedApi.patch('/me/preferences', noQuery, async (req, res)=>ok(res, {
            preferences: await store.preferences(res.locals.uid, s.preferencePatch.parse(req.body))
        }));
    protectedApi.get('/me/devices', noQuery, async (_req, res)=>ok(res, {
            devices: await store.devices(res.locals.uid)
        }));
    protectedApi.put('/me/devices', noQuery, async (req, res)=>ok(res, {
            device: await store.upsertDevice(res.locals.uid, s.device.parse(req.body))
        }));
    protectedApi.delete('/me/devices/:recordId', noQuery, async (req, res)=>{
        await store.deleteDevice(res.locals.uid, s.recordId.parse(req.params.recordId));
        ok(res, {
            deleted: true
        });
    });
    protectedApi.post('/me/sessions', noQuery, limit('session-write', 60, 60000, (_req, res)=>res.locals.uid), async (req, res)=>{
        const result = await store.createSession(res.locals.uid, s.session.parse(req.body));
        ok(res, {
            session: result.session
        }, result.created ? 201 : 200);
    });
    protectedApi.get('/me/sessions', async (req, res)=>{
        const query = s.pagination.parse(req.query);
        ok(res, await store.sessions(res.locals.uid, query.limit, query.cursor));
    });
    app.use('/v1', protectedApi);
    app.use((_req, _res, next)=>next(new ApiError(404, 'not_found', 'Endpoint not found.')));
    app.use((err, _req, res, _next)=>{
        let error;
        if (err instanceof ApiError) error = err;
        else if (err instanceof ZodError) error = new ApiError(400, 'validation_error', 'Invalid request fields.');
        else if (typeof err === 'object' && err !== null && 'type' in err && err.type === 'entity.too.large') error = new ApiError(413, 'payload_too_large', 'Request body is too large.');
        else if (err instanceof SyntaxError) error = new ApiError(400, 'validation_error', 'Invalid JSON body.');
        else error = unavailable();
        if (error.status === 429 && !res.hasHeader('Retry-After')) res.set('Retry-After', '60');
        res.status(error.status).json({
            error: {
                code: error.code,
                message: error.message
            },
            requestId: res.locals.requestId
        });
    });
    return app;
}
