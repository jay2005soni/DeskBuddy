import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { initializeApp, deleteApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { createApp } from '../src/app.js';
import { readConfig } from '../src/config.js';
import { FirebaseAuthService } from '../src/auth.js';
import { AccountStore } from '../src/store.js';
if (!process.env.FIREBASE_PROJECT_ID?.startsWith('demo-') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '') || !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST ?? '')) {
    throw new Error('Run npm run test:emulators; integration tests require local demo emulators.');
}
const config = readConfig();
const firebase = initializeApp({
    projectId: config.FIREBASE_PROJECT_ID
}, 'integration');
const admin = getAuth(firebase);
const db = getFirestore(firebase);
const auth = new FirebaseAuthService(admin, config);
const store = new AccountStore(db, config.CURSOR_SECRET);
const app = createApp(config, auth, store, false);
const password = 'DeskBuddy-Test-123!';
const email = ()=>`${randomUUID()}@example.test`;
const focus = (clientEventId = randomUUID().replaceAll('-', ''))=>({
        clientEventId,
        deviceId: 'opaque-unit',
        kind: 'focus',
        focusMinutes: 25,
        breakMinutes: 5,
        startedAt: new Date().toISOString()
    });
const device = {
    deviceId: 'opaque-unit',
    label: 'DeskBuddy',
    firmware: '1.0.1',
    settings: {
        audio: false,
        volume: 30
    }
};
let alice, bob;
async function signup() {
    const address = email();
    const r = await request(app).post('/v1/auth/signup').send({
        email: address,
        password,
        displayName: 'API Test'
    }).expect(201);
    return {
        ...r.body.data,
        email: address
    };
}
beforeAll(async ()=>{
    alice = await signup();
    bob = await signup();
}, 60000);
afterAll(async ()=>{
    await db.terminate();
    await deleteApp(firebase);
});
describe('real Firebase Auth + Firestore emulators', ()=>{
    it('returns exact account profile/tokens and stores no password/email in Firestore', async ()=>{
        expect(alice.expiresIn).toBe(3600);
        expect(alice.user.displayName).toBe('API Test');
        expect((await admin.getUser(alice.user.uid)).displayName).toBe('API Test');
        const data = (await db.doc(`users/${alice.user.uid}`).get()).data();
        expect(Object.keys(data).sort()).toEqual([
            'createdAt',
            'displayName',
            'timezone',
            'updatedAt'
        ]);
        const r = await request(app).post('/v1/auth/login').send({
            email: alice.email,
            password
        }).expect(200);
        expect(r.body.data.user.uid).toBe(alice.user.uid);
    });
    it('merges preferences atomically without losing unrelated concurrent changes', async ()=>{
        await Promise.all([
            request(app).patch('/v1/me/preferences').auth(alice.accessToken, {
                type: 'bearer'
            }).send({
                focusMinutes: 27
            }).expect(200),
            request(app).patch('/v1/me/preferences').auth(alice.accessToken, {
                type: 'bearer'
            }).send({
                breakMinutes: 7
            }).expect(200)
        ]);
        const r = await request(app).get('/v1/me/preferences').auth(alice.accessToken, {
            type: 'bearer'
        }).expect(200);
        expect(r.body.data.preferences).toMatchObject({
            focusMinutes: 27,
            breakMinutes: 7,
            breathingSeconds: 60,
            notificationApps: [],
            notificationForwardingEnabled: false
        });
    });
    it('isolates profile/preferences/devices/history between users including delete', async ()=>{
        const a = await request(app).put('/v1/me/devices').auth(alice.accessToken, {
            type: 'bearer'
        }).send(device).expect(200);
        const event = focus();
        await request(app).post('/v1/me/sessions').auth(alice.accessToken, {
            type: 'bearer'
        }).send(event).expect(201);
        expect((await request(app).get('/v1/me/devices').auth(bob.accessToken, {
            type: 'bearer'
        })).body.data.devices).toEqual([]);
        expect((await request(app).get('/v1/me/sessions').auth(bob.accessToken, {
            type: 'bearer'
        })).body.data.sessions).toEqual([]);
        expect((await request(app).get('/v1/me').auth(bob.accessToken, {
            type: 'bearer'
        })).body.data.profile.uid).toBe(bob.user.uid);
        expect((await request(app).get('/v1/me/preferences').auth(bob.accessToken, {
            type: 'bearer'
        })).body.data.preferences.focusMinutes).toBe(25);
        await request(app).delete(`/v1/me/devices/${a.body.data.device.recordId}`).auth(bob.accessToken, {
            type: 'bearer'
        }).expect(200);
        expect((await store.devices(alice.user.uid)).length).toBe(1);
        await request(app).patch('/v1/me').auth(bob.accessToken, {
            type: 'bearer'
        }).send({
            uid: alice.user.uid,
            displayName: 'Attack'
        }).expect(400);
    });
    it('preserves device createdAt with deterministic upsert and enforces 100 record cap', async ()=>{
        const a = await store.upsertDevice(alice.user.uid, device);
        const b = await store.upsertDevice(alice.user.uid, {
            ...device,
            settings: {
                volume: 70
            }
        });
        expect(a.recordId).toBe(b.recordId);
        expect(a.createdAt).toBe(b.createdAt);
        const uid = `cap-${randomUUID()}`;
        const batch = db.batch();
        for(let i = 0; i < 99; i++)batch.set(db.doc(`users/${uid}/devices/${String(i).padStart(64, '0')}`), {
            deviceId: String(i)
        });
        await batch.commit();
        const writes = await Promise.allSettled([
            store.upsertDevice(uid, {
                ...device,
                deviceId: 'one'
            }),
            store.upsertDevice(uid, {
                ...device,
                deviceId: 'two'
            })
        ]);
        expect(writes.filter((r)=>r.status === 'fulfilled')).toHaveLength(1);
        expect((await store.devices(uid)).length).toBe(100);
    }, 30000);
    it('deduplicates concurrent session retries, conflicts on changed payload and omits TTL internals', async ()=>{
        const body = focus();
        const replies = await Promise.all(Array.from({
            length: 3
        }, ()=>request(app).post('/v1/me/sessions').auth(alice.accessToken, {
                type: 'bearer'
            }).send(body)));
        expect(replies.map((r)=>r.status).sort()).toEqual([
            200,
            200,
            201
        ]);
        expect(replies[0].body.data.session.expiresAt).toBeUndefined();
        await request(app).post('/v1/me/sessions').auth(alice.accessToken, {
            type: 'bearer'
        }).send({
            ...body,
            focusMinutes: 24
        }).expect(409);
        const saved = await db.doc(`users/${alice.user.uid}/sessions/${body.clientEventId}`).get();
        expect(saved.data().expiresAt.toMillis() - Date.parse(saved.data().receivedAt)).toBe(90 * 86400000);
        await request(app).post('/v1/me/sessions').auth(bob.accessToken, {
            type: 'bearer'
        }).send(body).expect(201);
    });
    it('paginates timestamp ties, binds cursors to uid/query, rejects tampering', async ()=>{
        const uid = `pagination-${randomUUID()}`;
        const batch = db.batch();
        for(let i = 1; i <= 5; i++){
            const body = focus(String(i).padStart(32, '0'));
            batch.set(db.doc(`users/${uid}/sessions/${body.clientEventId}`), {
                ...body,
                id: body.clientEventId,
                state: 'start_accepted',
                receivedAt: '2026-10-25T00:00:00.000Z'
            });
        }
        await batch.commit();
        const one = await store.sessions(uid, 2);
        const two = await store.sessions(uid, 2, one.nextCursor);
        const three = await store.sessions(uid, 2, two.nextCursor);
        expect([
            ...one.sessions,
            ...two.sessions,
            ...three.sessions
        ].map((s)=>s.id)).toEqual([
            5,
            4,
            3,
            2,
            1
        ].map((i)=>String(i).padStart(32, '0')));
        expect(three.nextCursor).toBeNull();
        await expect(store.sessions(bob.user.uid, 2, one.nextCursor)).rejects.toMatchObject({
            status: 400
        });
        await expect(store.sessions(uid, 3, one.nextCursor)).rejects.toMatchObject({
            status: 400
        });
        await expect(store.sessions(uid, 2, one.nextCursor + 'x')).rejects.toMatchObject({
            status: 400
        });
    });
    it('recovers profile after injected post-Auth signup failure without recreating Auth account', async ()=>{
        const address = email();
        const failure = vi.spyOn(store, 'profile').mockRejectedValueOnce(new Error('simulated Firestore outage'));
        await request(app).post('/v1/auth/signup').send({
            email: address,
            password,
            displayName: 'Recovered Name'
        }).expect(503);
        const original = await admin.getUserByEmail(address);
        expect((await db.doc(`users/${original.uid}`).get()).exists).toBe(false);
        await request(app).post('/v1/auth/signup').send({
            email: address,
            password,
            displayName: 'Recovered Name'
        }).expect(409);
        const login = await request(app).post('/v1/auth/login').send({
            email: address,
            password
        }).expect(200);
        expect(login.body.data.user).toMatchObject({
            uid: original.uid,
            displayName: 'Recovered Name'
        });
        await db.doc(`users/${original.uid}`).delete();
        await request(app).get('/v1/me').auth(login.body.data.accessToken, {
            type: 'bearer'
        }).expect(200);
        expect((await db.doc(`users/${original.uid}`).get()).exists).toBe(true);
        failure.mockRestore();
    });
    it('refreshes tokens and rejects invalid/revoked/disabled sessions', async ()=>{
        const user = await signup();
        const fresh = await request(app).post('/v1/auth/refresh').send({
            refreshToken: user.refreshToken
        }).expect(200);
        await request(app).get('/v1/me').auth(fresh.body.data.accessToken, {
            type: 'bearer'
        }).expect(200);
        await request(app).get('/v1/me').auth('invalid-token', {
            type: 'bearer'
        }).expect(401);
        await request(app).post('/v1/auth/refresh').send({
            refreshToken: 'invalid'
        }).expect(401);
        await new Promise((resolve)=>setTimeout(resolve, 1100));
        await admin.revokeRefreshTokens(user.user.uid);
        await request(app).get('/v1/me').auth(user.accessToken, {
            type: 'bearer'
        }).expect(401);
        await request(app).post('/v1/auth/refresh').send({
            refreshToken: user.refreshToken
        }).expect(401);
        await admin.updateUser(bob.user.uid, {
            disabled: true
        });
        await request(app).get('/v1/me').auth(bob.accessToken, {
            type: 'bearer'
        }).expect(403);
        await request(app).post('/v1/auth/refresh').send({
            refreshToken: bob.refreshToken
        }).expect(401);
        await admin.updateUser(bob.user.uid, {
            disabled: false
        });
    }, 15000);
    it('sends reset/verification to emulator action sink and uses generic reset response', async ()=>{
        const a = await request(app).post('/v1/auth/forgot-password').send({
            email: alice.email
        }).expect(200);
        const b = await request(app).post('/v1/auth/forgot-password').send({
            email: email()
        }).expect(200);
        expect(a.body.data).toEqual(b.body.data);
        await request(app).post('/v1/auth/send-verification').auth(alice.accessToken, {
            type: 'bearer'
        }).send({}).expect(200);
        const response = await fetch(`http://${config.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${config.FIREBASE_PROJECT_ID}/oobCodes`);
        const sink = await response.json();
        expect(sink.oobCodes.some((c)=>c.email === alice.email && c.requestType === 'PASSWORD_RESET')).toBe(true);
        expect(sink.oobCodes.some((c)=>c.email === alice.email && c.requestType === 'VERIFY_EMAIL')).toBe(true);
        await admin.updateUser(alice.user.uid, {
            emailVerified: true
        });
        const profile = await request(app).get('/v1/me').auth(alice.accessToken, {
            type: 'bearer'
        }).expect(200);
        expect(profile.body.data.profile.emailVerified).toBe(true);
        await request(app).post('/v1/auth/send-verification').auth(alice.accessToken, {
            type: 'bearer'
        }).send({}).expect(200);
    });
    it('enforces shared rate counter atomically and denies every direct Firestore client', async ()=>{
        const key = randomUUID();
        const results = await Promise.all(Array.from({
            length: 4
        }, ()=>store.consumeLimit(key, 2, 60000)));
        expect(results.filter((n)=>n === 0)).toHaveLength(2);
        expect(results.filter((n)=>n > 0)).toHaveLength(2);
        const base = `http://${config.FIRESTORE_EMULATOR_HOST}/v1/projects/${config.FIREBASE_PROJECT_ID}/databases/(default)/documents`;
        const headers = { Authorization: `Bearer ${alice.accessToken}`, 'Content-Type': 'application/json' };
        expect((await fetch(`${base}/users/${alice.user.uid}`, { headers })).status).toBe(403);
        expect((await fetch(`${base}/users/${alice.user.uid}/preferences/app`, { method: 'PATCH', headers, body: JSON.stringify({ fields: { focusMinutes: { integerValue: '30' } } }) })).status).toBe(403);
        expect((await fetch(`${base}/users/${alice.user.uid}`)).status).toBe(403);
    });
});
