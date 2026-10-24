import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { FieldPath, Timestamp } from 'firebase-admin/firestore';
import { ApiError } from './errors.js';
import { CursorCodec } from './cursor.js';
export const defaults = {
    focusMinutes: 25,
    breakMinutes: 5,
    breathingSeconds: 60,
    notificationForwardingEnabled: false,
    notificationApps: []
};
export class AccountStore {
    db;
    cursors;
    constructor(db, secret){
        this.db = db;
        this.cursors = new CursorCodec(secret);
    }
    user(uid) {
        return this.db.collection('users').doc(uid);
    }
    async profile(user, patch = {}) {
        const ref = this.user(user.uid);
        const saved = await this.db.runTransaction(async (tx)=>{
            const old = (await tx.get(ref)).data();
            const now = new Date().toISOString();
            const value = {
                displayName: user.displayName || old?.displayName || 'DeskBuddy User',
                timezone: old?.timezone ?? 'Asia/Kolkata',
                createdAt: old?.createdAt ?? new Date(user.metadata.creationTime).toISOString(),
                updatedAt: old?.updatedAt ?? now,
                ...patch
            };
            if (!old || Object.keys(patch).length) {
                value.updatedAt = now;
                tx.set(ref, value);
            }
            return value;
        });
        return {
            uid: user.uid,
            ...saved,
            email: user.email,
            emailVerified: user.emailVerified
        };
    }
    async preferences(uid, patch = {}) {
        const ref = this.user(uid).collection('preferences').doc('app');
        return this.db.runTransaction(async (tx)=>{
            const old = (await tx.get(ref)).data();
            const value = {
                ...defaults,
                ...old,
                ...patch,
                updatedAt: Object.keys(patch).length || !old ? new Date().toISOString() : old.updatedAt
            };
            if (!old || Object.keys(patch).length) tx.set(ref, value);
            return value;
        });
    }
    async devices(uid) {
        return (await this.user(uid).collection('devices').orderBy(FieldPath.documentId()).limit(100).get()).docs.map((d)=>d.data());
    }
    async upsertDevice(uid, input) {
        const recordId = createHash('sha256').update(input.deviceId, 'utf8').digest('hex');
        const collection = this.user(uid).collection('devices');
        const ref = collection.doc(recordId);
        return this.db.runTransaction(async (tx)=>{
            const existing = await tx.get(collection.limit(101));
            const old = existing.docs.find((d)=>d.id === recordId)?.data();
            if (!old && existing.size >= 100) throw new ApiError(409, 'device_limit_reached', 'Maximum device records reached.');
            const now = new Date().toISOString();
            const value = {
                ...input,
                recordId,
                createdAt: old?.createdAt ?? now,
                updatedAt: now
            };
            tx.set(ref, value);
            return value;
        });
    }
    async deleteDevice(uid, recordId) {
        await this.user(uid).collection('devices').doc(recordId).delete();
    }
    async createSession(uid, input) {
        const ref = this.user(uid).collection('sessions').doc(input.clientEventId);
        return this.db.runTransaction(async (tx)=>{
            const old = (await tx.get(ref)).data();
            if (old) {
                const { id, state, receivedAt, expiresAt, ...original } = old;
                if (!isDeepStrictEqual(original, input)) throw new ApiError(409, 'idempotency_conflict', 'This event ID already has different session data.');
                return {
                    created: false,
                    session: {
                        ...original,
                        id,
                        state,
                        receivedAt
                    }
                };
            }
            const now = new Date();
            const value = {
                ...input,
                id: input.clientEventId,
                state: 'start_accepted',
                receivedAt: now.toISOString()
            };
            tx.create(ref, {
                ...value,
                expiresAt: Timestamp.fromMillis(now.getTime() + 90 * 86400000)
            });
            return {
                created: true,
                session: value
            };
        });
    }
    async sessions(uid, limit, cursor) {
        let query = this.user(uid).collection('sessions').orderBy('receivedAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
        if (cursor) {
            const c = this.cursors.decode(cursor, uid, limit);
            query = query.startAfter(c.receivedAt, c.id);
        }
        const docs = (await query.limit(limit + 1).get()).docs;
        const rows = docs.slice(0, limit).map((doc)=>{
            const { expiresAt, ...value } = doc.data();
            return value;
        });
        const last = rows.at(-1);
        return {
            sessions: rows,
            nextCursor: docs.length > limit && last ? this.cursors.encode(uid, limit, last.receivedAt, last.id) : null
        };
    }
    async consumeLimit(key, max, windowMs) {
        const ref = this.db.collection('_rateLimits').doc(key);
        return this.db.runTransaction(async (tx)=>{
            const old = (await tx.get(ref)).data();
            const now = Date.now();
            const until = old && old.until > now ? old.until : now + windowMs;
            const count = old && old.until > now ? old.count + 1 : 1;
            if (count > max) return Math.max(1, Math.ceil((until - now) / 1000));
            tx.set(ref, {
                count,
                until,
                expiresAt: Timestamp.fromMillis(until)
            });
            return 0;
        });
    }
}
