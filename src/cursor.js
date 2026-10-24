import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { ApiError } from './errors.js';
const schema = z.object({
    v: z.literal(1),
    uid: z.string(),
    limit: z.number().int(),
    receivedAt: z.string().datetime(),
    id: z.string().regex(/^[a-f0-9]{32}$/)
}).strict();
export class CursorCodec {
    secret;
    constructor(secret){
        this.secret = secret;
    }
    signature(value) {
        return createHmac('sha256', this.secret).update(value).digest();
    }
    encode(uid, limit, receivedAt, id) {
        const data = Buffer.from(JSON.stringify({
            v: 1,
            uid,
            limit,
            receivedAt,
            id
        })).toString('base64url');
        return `${data}.${this.signature(data).toString('base64url')}`;
    }
    decode(cursor, uid, limit) {
        try {
            if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(cursor)) throw new Error();
            const [data, signature] = cursor.split('.');
            const supplied = Buffer.from(signature, 'base64url');
            const expected = this.signature(data);
            if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new Error();
            const parsed = schema.parse(JSON.parse(Buffer.from(data, 'base64url').toString('utf8')));
            if (parsed.uid !== uid || parsed.limit !== limit) throw new Error();
            return parsed;
        } catch  {
            throw new ApiError(400, 'validation_error', 'Invalid pagination cursor.');
        }
    }
}
