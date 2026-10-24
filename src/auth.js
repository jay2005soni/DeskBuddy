import { z } from 'zod';
import { ApiError, unavailable, providerCode } from './errors.js';
const pairSchema = z.object({
    idToken: z.string().min(1).max(8192),
    refreshToken: z.string().min(1).max(8192),
    expiresIn: z.coerce.number().int().min(60).max(86400)
});
const refreshSchema = z.object({
    id_token: z.string().min(1).max(8192),
    refresh_token: z.string().min(1).max(8192),
    expires_in: z.coerce.number().int().min(60).max(86400)
});
export class FirebaseAuthService {
    admin;
    config;
    http;
    constructor(admin, config, http = fetch){
        this.admin = admin;
        this.config = config;
        this.http = http;
    }
    async request(method, body, refreshing = false) {
        const host = this.config.FIREBASE_AUTH_EMULATOR_HOST;
        const origin = refreshing ? 'https://securetoken.googleapis.com' : 'https://identitytoolkit.googleapis.com';
        const base = host ? `http://${host}/${refreshing ? 'securetoken.googleapis.com' : 'identitytoolkit.googleapis.com'}` : origin;
        const url = `${base}/v1/${method}?key=${encodeURIComponent(this.config.FIREBASE_WEB_API_KEY)}`;
        let response;
        let payload;
        try {
            response = await this.http(url, {
                method: 'POST',
                signal: AbortSignal.timeout(10000),
                redirect: 'error',
                headers: {
                    'Content-Type': refreshing ? 'application/x-www-form-urlencoded' : 'application/json'
                },
                body: refreshing ? new URLSearchParams(body) : JSON.stringify(body)
            });
            payload = await response.json();
        } catch  {
            throw unavailable();
        }
        if (!response.ok) {
            const code = String(payload?.error?.message ?? '').split(' : ')[0];
            if (response.status >= 500) throw unavailable();
            if (refreshing && [
                'TOKEN_EXPIRED',
                'INVALID_REFRESH_TOKEN',
                'USER_DISABLED',
                'USER_NOT_FOUND',
                'INVALID_GRANT_TYPE'
            ].includes(code)) {
                throw new ApiError(401, 'invalid_refresh_token', 'Please sign in again.');
            }
            if (code === 'EMAIL_EXISTS') throw new ApiError(409, 'account_exists', 'An account with this email already exists.');
            if (code === 'USER_DISABLED') throw new ApiError(403, 'forbidden', 'Account is disabled.');
            if ([
                'INVALID_LOGIN_CREDENTIALS',
                'EMAIL_NOT_FOUND',
                'INVALID_PASSWORD',
                'INVALID_ID_TOKEN',
                'TOKEN_EXPIRED',
                'USER_NOT_FOUND'
            ].includes(code)) {
                throw new ApiError(401, 'unauthorized', 'Invalid credentials.');
            }
            if (code === 'TOO_MANY_ATTEMPTS_TRY_LATER') throw new ApiError(429, 'rate_limited', 'Too many requests. Please retry later.');
            if (code === 'INVALID_EMAIL' || code?.startsWith('WEAK_PASSWORD') || code?.startsWith('PASSWORD_DOES_NOT_MEET_REQUIREMENTS')) {
                throw new ApiError(400, 'validation_error', 'Email or password does not meet account requirements.');
            }
            throw unavailable();
        }
        return payload;
    }
    pair(payload) {
        const result = pairSchema.safeParse(payload);
        if (!result.success) throw unavailable();
        return {
            accessToken: result.data.idToken,
            refreshToken: result.data.refreshToken,
            expiresIn: result.data.expiresIn
        };
    }
    async signup(email, password, displayName) {
        return this.pair(await this.request('accounts:signUp', {
            email,
            password,
            displayName,
            returnSecureToken: true
        }));
    }
    async login(email, password) {
        return this.pair(await this.request('accounts:signInWithPassword', {
            email,
            password,
            returnSecureToken: true
        }));
    }
    async refresh(refreshToken) {
        const parsed = refreshSchema.safeParse(await this.request('token', {
            grant_type: 'refresh_token',
            refresh_token: refreshToken
        }, true));
        if (!parsed.success) throw unavailable();
        try {
            await this.verify(parsed.data.id_token);
        } catch (e) {
            if (e instanceof ApiError && e.status !== 503) throw new ApiError(401, 'invalid_refresh_token', 'Please sign in again.');
            throw e;
        }
        return {
            accessToken: parsed.data.id_token,
            refreshToken: parsed.data.refresh_token,
            expiresIn: parsed.data.expires_in
        };
    }
    async verify(token) {
        try {
            return (await this.admin.verifyIdToken(token, true)).uid;
        } catch (e) {
            const code = providerCode(e);
            if (code === 'auth/user-disabled') throw new ApiError(403, 'forbidden', 'Account is disabled.');
            if ([
                'auth/id-token-expired',
                'auth/id-token-revoked',
                'auth/argument-error',
                'auth/invalid-id-token',
                'auth/user-not-found'
            ].includes(code)) {
                throw new ApiError(401, 'unauthorized', 'Please sign in again.');
            }
            throw unavailable();
        }
    }
    async user(uid) {
        try {
            const user = await this.admin.getUser(uid);
            if (user.disabled) throw new ApiError(403, 'forbidden', 'Account is disabled.');
            return user;
        } catch (e) {
            if (e instanceof ApiError) throw e;
            if (providerCode(e) === 'auth/user-not-found') throw new ApiError(401, 'unauthorized', 'Please sign in again.');
            throw unavailable();
        }
    }
    async setName(uid, displayName) {
        await this.admin.updateUser(uid, {
            displayName
        });
    }
    async forgot(email) {
        try {
            await this.request('accounts:sendOobCode', {
                requestType: 'PASSWORD_RESET',
                email
            });
        } catch (e) {
            if (e instanceof ApiError && e.status === 401) return;
            throw e;
        }
    }
    async verification(uid, idToken) {
        if ((await this.user(uid)).emailVerified) return;
        await this.request('accounts:sendOobCode', {
            requestType: 'VERIFY_EMAIL',
            idToken
        });
    }
}
