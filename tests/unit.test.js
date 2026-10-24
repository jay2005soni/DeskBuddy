import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { FirebaseAuthService } from '../src/auth.js';
import { CursorCodec } from '../src/cursor.js';
import { ApiError } from '../src/errors.js';
import * as s from '../src/schemas.js';
const config = readConfig({
    NODE_ENV: 'test',
    FIREBASE_PROJECT_ID: 'demo-deskbuddy',
    FIREBASE_WEB_API_KEY: 'test',
    CURSOR_SECRET: 'a'.repeat(32)
});
function fixture() {
    const admin = {
        verifyIdToken: vi.fn().mockResolvedValue({
            uid: 'alice'
        }),
        getUser: vi.fn().mockResolvedValue({
            uid: 'alice',
            displayName: 'Alice',
            email: 'alice@example.com',
            emailVerified: false
        })
    };
    const auth = new FirebaseAuthService(admin, config);
    const store = {
        consumeLimit: vi.fn().mockResolvedValue(0),
        profile: vi.fn().mockResolvedValue({
            uid: 'alice'
        }),
        devices: vi.fn().mockResolvedValue([]),
        deleteDevice: vi.fn().mockResolvedValue(undefined)
    };
    return {
        app: createApp(config, auth, store, false),
        admin,
        store,
        auth
    };
}
describe('strict request validation', ()=>{
    it('trims email/name and preserves password bytes, allows short existing passwords', ()=>{
        expect(s.signup.parse({
            displayName: ' Alice ',
            email: ' a@example.com ',
            password: ' abcd1234 '
        }).password).toBe(' abcd1234 ');
        expect(s.login.parse({
            email: 'a@example.com',
            password: 'x'
        }).password).toBe('x');
    });
    it('rejects mass assignment, empty patches, mixed sessions and sensitive fields', ()=>{
        for (const value of [
            {},
            {
                uid: 'victim'
            },
            {
                emailVerified: true
            },
            {
                timezone: 'Made/Up'
            }
        ])expect(s.profilePatch.safeParse(value).success).toBe(false);
        expect(s.preferencePatch.safeParse({
            notificationApps: [
                'com.app',
                'com.app'
            ]
        }).success).toBe(false);
        expect(s.preferencePatch.safeParse({
            notificationApps: [
                'invalid'
            ]
        }).success).toBe(false);
        expect(s.device.safeParse({
            deviceId: 'a',
            label: 'x',
            firmware: '1',
            settings: {
                pin: '1234'
            }
        }).success).toBe(false);
        expect(s.session.safeParse({
            clientEventId: 'a'.repeat(32),
            deviceId: 'a',
            kind: 'breathing',
            breathingSeconds: 60,
            focusMinutes: 25,
            startedAt: new Date().toISOString()
        }).success).toBe(false);
        expect(s.session.safeParse({
            clientEventId: 'a'.repeat(32),
            deviceId: 'a',
            kind: 'breathing',
            breathingSeconds: 60,
            startedAt: '2026-10-25T00:00:00+05:30'
        }).success).toBe(false);
    });
    it('enforces exact device ranges and query bounds', ()=>{
        for (const settings of [
            {},
            {
                brightness: 7
            },
            {
                volume: 101
            },
            {
                touch: 1.5
            },
            {
                audio: 'true'
            }
        ])expect(s.device.safeParse({
            deviceId: 'a',
            label: 'x',
            firmware: '1',
            settings
        }).success).toBe(false);
        for (const query of [
            {
                limit: '0'
            },
            {
                limit: '101'
            },
            {
                limit: [
                    '20'
                ]
            },
            {
                uid: 'victim'
            }
        ])expect(s.pagination.safeParse(query).success).toBe(false);
    });
});
describe('HTTP boundary and authorization', ()=>{
    it('returns secret-free health and JSON errors with opaque IDs', async ()=>{
        const { app } = fixture();
        const r = await request(app).get('/healthz');
        expect(r.body.data).toEqual({
            status: 'ok'
        });
        expect(r.headers['cache-control']).toBe('no-store');
        const bad = await request(app).post('/v1/auth/login').set('Content-Type', 'application/json').send('{');
        expect(bad.status).toBe(400);
        expect(bad.body.error.code).toBe('validation_error');
        expect(bad.body.requestId).toBeTruthy();
    });
    it('rejects missing bearer, oversized body, wrong content type and unknown fields', async ()=>{
        const { app } = fixture();
        expect((await request(app).get('/v1/me')).status).toBe(401);
        expect((await request(app).post('/v1/auth/login').send({
            password: 'x'.repeat(40000)
        })).status).toBe(413);
        expect((await request(app).post('/v1/auth/login').type('form').send({
            email: 'a@example.com'
        })).status).toBe(415);
        expect((await request(app).patch('/v1/me').auth('valid', {
            type: 'bearer'
        }).send({
            uid: 'victim'
        })).status).toBe(400);
    });
    it.each([
        [
            'auth/id-token-expired',
            401
        ],
        [
            'auth/id-token-revoked',
            401
        ],
        [
            'auth/invalid-id-token',
            401
        ],
        [
            'auth/user-disabled',
            403
        ],
        [
            'auth/internal-error',
            503
        ]
    ])('maps %s safely', async (code, status)=>{
        const { app, admin, store } = fixture();
        admin.verifyIdToken.mockRejectedValue({
            code,
            message: 'SECRET'
        });
        const r = await request(app).get('/v1/me').auth('secret-token', {
            type: 'bearer'
        });
        expect(r.status).toBe(status);
        expect(JSON.stringify(r.body)).not.toContain('SECRET');
        expect(store.profile).not.toHaveBeenCalled();
        expect(admin.verifyIdToken).toHaveBeenCalledWith('secret-token', true);
    });
    it('scopes deletion to verified uid and rejects uid query injection', async ()=>{
        const { app, store } = fixture();
        await request(app).delete('/v1/me/devices/' + 'a'.repeat(64)).auth('valid', {
            type: 'bearer'
        }).expect(200);
        expect(store.deleteDevice).toHaveBeenCalledWith('alice', 'a'.repeat(64));
        await request(app).get('/v1/me/devices?uid=bob').auth('valid', {
            type: 'bearer'
        }).expect(400);
        expect(store.devices).not.toHaveBeenCalled();
    });
    it('rate limits with envelope and Retry-After', async ()=>{
        const { app, store } = fixture();
        store.consumeLimit.mockResolvedValue(30);
        const r = await request(app).post('/v1/auth/login').send({
            email: 'a@example.com',
            password: 'secret'
        });
        expect(r.status).toBe(429);
        expect(r.headers['retry-after']).toBe('30');
        expect(r.body.error.code).toBe('rate_limited');
        expect(store.consumeLimit.mock.calls[0]?.[0]).toMatch(/^[a-f0-9]{64}$/);
    });
    it('fails closed when limiter storage is unavailable', async ()=>{
        const { app, store } = fixture();
        store.consumeLimit.mockRejectedValue(new Error('private credentials'));
        const r = await request(app).get('/v1/me').auth('valid', {
            type: 'bearer'
        });
        expect(r.status).toBe(503);
        expect(JSON.stringify(r.body)).not.toContain('private');
    });
    it('enforces HTTPS behind the explicitly trusted proxy', async ()=>{
        const { auth, store } = fixture();
        const app = createApp({
            ...config,
            NODE_ENV: 'production',
            TRUST_PROXY_HOPS: 1
        }, auth, store, false);
        await request(app).get('/v1/me').expect(400);
        await request(app).get('/v1/me').set('X-Forwarded-Proto', 'https').expect(401);
    });
});
describe('cursor authentication', ()=>{
    it('binds cursor to uid, page size and sort position', ()=>{
        const codec = new CursorCodec('a'.repeat(32));
        const cursor = codec.encode('alice', 20, new Date().toISOString(), 'a'.repeat(32));
        expect(codec.decode(cursor, 'alice', 20).id).toBe('a'.repeat(32));
        for (const [value, uid, limit] of [
            [
                cursor,
                'bob',
                20
            ],
            [
                cursor,
                'alice',
                10
            ],
            [
                cursor + 'a',
                'alice',
                20
            ],
            [
                '!!!',
                'alice',
                20
            ]
        ])expect(()=>codec.decode(value, uid, limit)).toThrow(ApiError);
    });
});
describe('Auth REST handling', ()=>{
    it('normalizes string expiry, sends password unchanged and handles rotating refresh tokens', async ()=>{
        const http = vi.fn().mockResolvedValueOnce(Response.json({
            idToken: 'id',
            refreshToken: 'refresh',
            expiresIn: '3600'
        })).mockResolvedValueOnce(Response.json({
            id_token: 'new-id',
            refresh_token: 'rotated',
            expires_in: '3600'
        }));
        const admin = {
            verifyIdToken: vi.fn().mockResolvedValue({
                uid: 'alice'
            })
        };
        const auth = new FirebaseAuthService(admin, config, http);
        expect((await auth.login('a@example.com', ' password ')).expiresIn).toBe(3600);
        expect(JSON.parse(http.mock.calls[0][1].body).password).toBe(' password ');
        expect((await auth.refresh('refresh')).refreshToken).toBe('rotated');
        expect(http.mock.calls[1][1].body.toString()).toContain('grant_type=refresh_token');
    });
    it.each([
        'TOKEN_EXPIRED',
        'INVALID_REFRESH_TOKEN',
        'USER_DISABLED',
        'USER_NOT_FOUND'
    ])('maps refresh %s to 401', async (code)=>{
        const auth = new FirebaseAuthService({}, config, vi.fn().mockResolvedValue(Response.json({
            error: {
                message: code
            }
        }, {
            status: 400
        })));
        await expect(auth.refresh('bad')).rejects.toMatchObject({
            status: 401,
            code: 'invalid_refresh_token'
        });
    });
    it('returns the same reset result for absent accounts and never exposes action links', async ()=>{
        const auth = new FirebaseAuthService({}, config, vi.fn().mockResolvedValue(Response.json({
            error: {
                message: 'EMAIL_NOT_FOUND'
            }
        }, {
            status: 400
        })));
        await expect(auth.forgot('absent@example.com')).resolves.toBeUndefined();
    });
});
