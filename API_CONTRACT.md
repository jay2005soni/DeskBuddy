# DeskBuddy account API — v1

Frontend version 0.3.0. Base URL is an HTTPS origin; all routes below include `/v1`. JSON UTF-8 only. Detailed machine-readable types: `openapi.json`. `requestId` is a server-generated opaque tracing ID, never a token or device PIN.

## Responses and authentication

Success: `{ "data": { ... }, "requestId": "opaque-id" }`.

Failure: `{ "error": { "code": "validation_error", "message": "Safe user-facing message", "fieldErrors": {"email":"Invalid email"} }, "requestId": "opaque-id" }`.

`fieldErrors` is optional. Errors must not echo credentials/request body or provider internals. HTTP 400 validation; 401 invalid/revoked/missing credentials; 403 disabled/forbidden; 409 existing account/conflicting idempotency key; 429 rate limit (+Retry-After); 503 dependency unavailable. Never return HTML errors or redirect protected/token endpoints. Use `Cache-Control: no-store` for all account responses.

All routes except signup/login/refresh/forgot-password/health require `Authorization: Bearer <accessToken>`. `accessToken` is a Firebase ID token, not an Admin custom token. Verify issuer/audience, expiry, signature and revocation with the Admin SDK. Never take uid from the request. An account record cannot authorize physical device ownership.

## Auth

`POST /v1/auth/signup` request:
```json
{"displayName":"Aarav","email":"aarav@example.com","password":"user-provided-password"}
```
Return HTTP 201. `POST /v1/auth/login` takes email/password and returns HTTP 200 with the same data:
```json
{"data":{"accessToken":"FIREBASE_ID_TOKEN","refreshToken":"FIREBASE_REFRESH_TOKEN","expiresIn":3600,"user":{"uid":"firebase-uid","displayName":"Aarav","email":"aarav@example.com","emailVerified":false,"timezone":"Asia/Kolkata","createdAt":"2026-10-25T00:00:00.000Z","updatedAt":"2026-10-25T00:00:00.000Z"}},"requestId":"opaque-id"}
```

Email max 254 characters, trim around email; never trim/normalize the password. Signup name trims to 2–80 chars. Signup password 8–128 chars and Firebase configured password policy. Login validates presence/max length but must not reject an existing password solely for being shorter than the current signup policy. Use Firebase Auth REST `accounts:signUp` / `accounts:signInWithPassword`. Store displayName in Firebase Auth as well as profile. Do not implement a custom password database.

`POST /v1/auth/refresh`: `{ "refreshToken": "..." }` → data `{ "accessToken":"...", "refreshToken":"...", "expiresIn":3600 }`. Use Secure Token API, map token rotation correctly, and normalize invalid/revoked/disabled sessions to 401 `invalid_refresh_token`/`unauthorized`. The client coalesces concurrent refreshes and never persists access tokens/passwords. Token endpoint responses must be no-store. No explicit logout API is required: sign-out deletes the refresh token on this phone, like Firebase client sign-out; this is not global token revocation.

`POST /v1/auth/forgot-password`: `{ "email":"..." }` → data `{ "message":"If an account exists, a reset email will be sent." }`. Same 200 response for existing/nonexistent accounts. Rate-limit by IP and normalized email without logging plaintext email. Never return reset links in production API responses.

`POST /v1/auth/send-verification`: authenticated `{}` → data `{ "message":"Verification email requested." }`. Use Firebase hosted email action handler; already verified is safe/idempotent. Do not expose action codes. Verification status comes from Firebase Auth (`getUser`), not a client-editable Firestore field.

## Profile

`GET /v1/me` → data `{ "profile": { ...same user shape... } }`.

`PATCH /v1/me` accepts `displayName` (2–80 chars) and/or `timezone` (valid IANA zone, max 64), rejects empty/unknown fields → data `{ "profile": { ... } }`. `uid`, email, emailVerified, createdAt and updatedAt are server-managed/read-only; reject mass-assignment attempts. Return full profile after mutation. The app currently edits name/timezone only.

## Preferences

`GET /v1/me/preferences` → data `{ "preferences": { ... } }` with complete defaults:
```json
{"focusMinutes":25,"breakMinutes":5,"breathingSeconds":60,"notificationForwardingEnabled":false,"notificationApps":[],"updatedAt":"2026-10-25T00:00:00.000Z"}
```
`PATCH /v1/me/preferences` accepts any nonempty subset of the five preference fields (not updatedAt), atomically merges and returns the full object. Types/bounds: focusMinutes integer 1–90; breakMinutes 1–30; breathingSeconds 10–180; forwarding boolean; notificationApps array <=100 unique package strings <=255 chars matching Android package syntax. Reject unrelated/arbitrary data. Notification package choices are user data and require the app's explicit selection; no notification content is ever backed up. Server preferences do not grant phone permissions or auto-enable forwarding.

## Device metadata — no pairing/ownership API

`GET /v1/me/devices` → data `{ "devices": [...] }`, max 100 rows. Each row:
```json
{"recordId":"sha256-of-opaque-device-id","deviceId":"ABCDEF012345","label":"DeskBuddy","firmware":"1.0.1-rc2","settings":{"audio":false,"volume":30},"createdAt":"2026-10-25T00:00:00.000Z","updatedAt":"2026-10-25T00:00:00.000Z"}
```
`PUT /v1/me/devices` body `{ "deviceId":"...", "label":"DeskBuddy", "firmware":"1.0.1-rc2", "settings":{...} }` → data `{ "device":{...full row...} }`. Upsert within the verified uid using SHA-256 of the UTF-8 full opaque deviceId as recordId, preserving createdAt. deviceId 1–128 chars (opaque; don't assume fixed suffix); label 1–80; firmware 1–40. Reject extra fields. Cap per-user device count at 100 in a transaction. Settings permits only these protocol fields/ranges:

| Field | Type / bounds |
|---|---|
| audio, pir, voice, quiet, chat | Boolean |
| touch | Integer 0–2 |
| volume | Integer 0–100 |
| brightness | Integer 8–255 |
| idle | Integer 30–600 |
| focus | Integer 1–90 |
| rest | Integer 1–30 |
| reminder | Integer 0–120 |
| debounce | Integer 20–100 |

Partial settings snapshots are permitted, full snapshots preferred. Never apply them to hardware from the backend. They may reflect volatile RAM settings and are not proof of flash persistence. No Bluetooth address, PIN, bond key, claim/reset flag, command or raw BLE payload is accepted.

`DELETE /v1/me/devices/{recordId}` → data `{ "deleted":true }` (idempotent). Deletes only current user's cloud metadata; never deletes firmware/OS bonds or claims ownership. The current app's Forget action removes its local transport record only; cloud deletion endpoint is supplied for backend/profile management and must remain separate.

## Session history

`POST /v1/me/sessions` focus body:
```json
{"clientEventId":"00112233445566778899aabbccddeeff","deviceId":"ABCDEF012345","kind":"focus","focusMinutes":25,"breakMinutes":5,"startedAt":"2026-10-25T00:00:00.000Z"}
```
Generate a fresh exactly 32 lowercase hex clientEventId for each action. Breathing uses kind `breathing`, `breathingSeconds` 10–180, and omits focusMinutes/breakMinutes. Focus requires both minutes 1–90 and break 1–30. Reject unknown/mixed fields and uid. deviceId is opaque 1–128 chars. startedAt is UTC ISO-8601 client time (display/history only; not authoritative billing/completion evidence).

Return 201 data `{ "session":{ ...body, "id":"same-as-clientEventId", "state":"start_accepted", "receivedAt":"server UTC timestamp" } }`. Same uid + event ID + same payload returns 200 existing row, no duplicate effects; same ID with different payload returns 409 `idempotency_conflict`. Use an atomic transaction/create, not check-then-write. State is a **client report of BLE acceptance**, not cryptographic proof, completed duration or a command queue. No notification contents or individual alert events are uploaded. Cap writes/rate and define retention before production (starter target: 90 days).

`GET /v1/me/sessions?limit=20&cursor=...` → data `{ "sessions":[...], "nextCursor":null }`. limit integer 1–100, default 20. Sort receivedAt descending + document ID tie-break; opaque validated cursor bound to this uid/query. Use explicit Firestore indexes or document an index-free strategy. Unknown/malformed cursor returns 400, not a leaked database error.

## Firebase layout / security

Firebase Auth stores authentication identities/password hashes. Firestore `users/{uid}` stores profile timestamps/name/timezone; email/verification are refreshed from Auth. Preferences: `users/{uid}/preferences/app`. Devices and sessions are private per-user subcollections. Client Firestore rules deny direct reads/writes; backend Admin SDK uses IAM credentials and checks uid on every endpoint. Do not deploy public allow-all rules.

Service-account JSON and Firebase Admin credentials stay on the server; use workload identity/ADC in production. No secrets in Flutter `--dart-define`, APK, git or this handoff. `.env.example` lists config keys only. Auth REST API key is project configuration, not authorization; restrict it appropriately and keep Admin secrets separate.

## Offline and failure rules

Cloud outages must not block Stop/pairing/control. The app keeps only OS keys, encrypted refresh token/cached profile and minimal local Bluetooth/notification cache. Cloud preference backup is explicit; no cloud device setting auto-apply. No background command or sync queue replays actions after reconnect. If a BLE action succeeds but its history upload fails, report unsynced history; never repeat the BLE command. Production account deletion/reauthentication/email changes are a separate required release review; not silently implemented as firmware reset.

## Official implementation references

- [Firebase Auth REST methods](https://firebase.google.com/docs/reference/rest/auth)
- [Admin SDK setup / ADC](https://firebase.google.com/docs/admin/setup)
- [Verify ID tokens](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Manage refresh/revoked sessions](https://firebase.google.com/docs/auth/admin/manage-sessions)
- [Firestore server libraries bypass client rules](https://firebase.google.com/docs/firestore/security/rules-conditions)
- [Android Keystore](https://developer.android.com/privacy-and-security/keystore)
