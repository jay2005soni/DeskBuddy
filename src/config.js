import { z } from 'zod';
const localHost = z.string().regex(/^(localhost|127\.0\.0\.1):\d{2,5}$/);
const envSchema = z.object({
    NODE_ENV: z.enum([
        'development',
        'test',
        'production'
    ]).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(8080),
    FIREBASE_PROJECT_ID: z.string().regex(/^[a-z][a-z0-9-]{4,62}$/),
    FIREBASE_WEB_API_KEY: z.string().min(1),
    CURSOR_SECRET: z.string().min(32),
    FIREBASE_AUTH_EMULATOR_HOST: localHost.optional(),
    FIRESTORE_EMULATOR_HOST: localHost.optional(),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0)
});
export function readConfig(env = process.env) {
    const parsed = envSchema.safeParse(env);
    if (!parsed.success) throw new Error('Invalid environment configuration: ' + parsed.error.issues.map((i)=>i.path.join('.')).join(', '));
    const c = parsed.data;
    if (c.NODE_ENV === 'production' && (c.FIREBASE_AUTH_EMULATOR_HOST || c.FIRESTORE_EMULATOR_HOST || c.FIREBASE_PROJECT_ID.startsWith('demo-'))) {
        throw new Error('Production cannot use emulators or demo projects.');
    }
    if (!!c.FIREBASE_AUTH_EMULATOR_HOST !== !!c.FIRESTORE_EMULATOR_HOST) throw new Error('Configure both emulators together.');
    if (c.FIREBASE_AUTH_EMULATOR_HOST && !c.FIREBASE_PROJECT_ID.startsWith('demo-')) throw new Error('Local emulators require a demo- project.');
    if (c.NODE_ENV === 'production' && c.TRUST_PROXY_HOPS < 1) throw new Error('Production requires an explicitly configured HTTPS reverse proxy.');
    return c;
}
