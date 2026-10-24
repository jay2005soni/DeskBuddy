import { z } from 'zod';
const integer = (min, max)=>z.number().int().min(min).max(max);
const name = z.string().trim().min(2).max(80);
const email = z.string().trim().email().max(254);
const token = z.string().min(1).max(8192);
const nonempty = (value)=>Object.keys(value).length > 0;
export const signup = z.object({
    displayName: name,
    email,
    password: z.string().min(8).max(128)
}).strict();
export const login = z.object({
    email,
    password: z.string().min(1).max(128)
}).strict();
export const refresh = z.object({
    refreshToken: token
}).strict();
export const forgot = z.object({
    email
}).strict();
export const empty = z.object({}).strict();
export const profilePatch = z.object({
    displayName: name.optional(),
    timezone: z.string().min(1).max(64).refine((value)=>{
        try {
            new Intl.DateTimeFormat('en', {
                timeZone: value
            });
            return true;
        } catch  {
            return false;
        }
    }).optional()
}).strict().refine(nonempty);
export const preferencePatch = z.object({
    focusMinutes: integer(1, 90).optional(),
    breakMinutes: integer(1, 30).optional(),
    breathingSeconds: integer(10, 180).optional(),
    notificationForwardingEnabled: z.boolean().optional(),
    notificationApps: z.array(z.string().max(255).regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/)).max(100).refine((items)=>new Set(items).size === items.length).optional()
}).strict().refine(nonempty);
const settings = z.object({
    audio: z.boolean().optional(),
    pir: z.boolean().optional(),
    voice: z.boolean().optional(),
    quiet: z.boolean().optional(),
    chat: z.boolean().optional(),
    touch: integer(0, 2).optional(),
    volume: integer(0, 100).optional(),
    brightness: integer(8, 255).optional(),
    idle: integer(30, 600).optional(),
    focus: integer(1, 90).optional(),
    rest: integer(1, 30).optional(),
    reminder: integer(0, 120).optional(),
    debounce: integer(20, 100).optional()
}).strict().refine(nonempty);
const deviceId = z.string().min(1).max(128);
export const device = z.object({
    deviceId,
    label: z.string().min(1).max(80),
    firmware: z.string().min(1).max(40),
    settings
}).strict();
export const recordId = z.string().regex(/^[a-f0-9]{64}$/);
const sessionBase = {
    clientEventId: z.string().regex(/^[a-f0-9]{32}$/),
    deviceId,
    startedAt: z.string().datetime()
};
export const session = z.discriminatedUnion('kind', [
    z.object({
        ...sessionBase,
        kind: z.literal('focus'),
        focusMinutes: integer(1, 90),
        breakMinutes: integer(1, 30)
    }).strict(),
    z.object({
        ...sessionBase,
        kind: z.literal('breathing'),
        breathingSeconds: integer(10, 180)
    }).strict()
]);
export const pagination = z.object({
    limit: z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/).transform(Number).optional().default(20),
    cursor: z.string().min(1).max(2048).optional()
}).strict();
export const noQuery = z.object({}).strict();
