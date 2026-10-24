# DeskBuddy backend

Plain JavaScript (ES modules) + Node.js + Express REST API using Firebase Authentication and Cloud Firestore. Implements the supplied [API contract](API_CONTRACT.md) and [OpenAPI specification](openapi.json). The original ZIP contents are preserved under `backend_handoff/`. The handoff mentions TypeScript; the implementation uses JavaScript as subsequently requested by the owner.

All 15 required routes are implemented. Cloud records contain profile/preferences, last-observed device snapshots, and accepted-start session history. Pairing, PINs, bonds, notification delivery and every hardware command remain local BLE operations. A cloud device record grants no physical ownership, permission or control.

## Run locally (Windows PowerShell)

Requirements: Node.js 22 LTS, npm, Java 21 or newer for Firebase emulators. Java is only needed for local Firestore tests, not the deployed API.

```powershell
npm ci
Copy-Item .env.example .env
npm run emulators
```

In a second terminal in this folder:

```powershell
npm run dev
Invoke-RestMethod http://localhost:8080/healthz
```

The example environment uses both local demo emulators; no Firebase account or private credentials are needed. A local `.env` has also been prepared with these demo values. The emulator helper uses a workspace Java runtime at `.cache/java/runtime/` when present on Windows; otherwise install Java 21+ on PATH. Never remove one emulator variable while keeping the other. The server refuses partial emulator configuration, non-demo emulator project IDs, and any emulator configuration in production.

For a local debug Flutter build:

```powershell
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080 --dart-define=ALLOW_INSECURE_API=true
```

This address is for the Android emulator. USB device development can use `adb reverse tcp:8080 tcp:8080` with `http://localhost:8080`. Release builds require HTTPS. API base URL is an origin with no `/v1` suffix.

## Checks

```powershell
npm run check
npm run test:emulators
```

`check` checks JavaScript syntax, checks OpenAPI references/lints the contract, and runs unit/HTTP tests. No transpilation or TypeScript toolchain is required; `build` is a JavaScript syntax check. `test:emulators` starts Auth/Firestore, runs real integration tests and stops the emulators. It forces a local `demo-deskbuddy` project and refuses real projects. Tests cover REST auth/refresh, two-user isolation, strict validation, atomic preferences, device cap races, concurrent session retries/conflicts, pagination ties/cursor tampering, token revocation/disabled users, missing-profile recovery, generic reset responses, emulator email actions, deny-all client rules and shared rate limits. Expired tokens and dependency failures are tested with controlled unit fixtures because emulator tokens do not faithfully model every production JWT failure.

The upstream smoke script is preserved:

```powershell
.\smoke-test.ps1 -BaseUrl https://YOUR-STAGING-ORIGIN -Email UNIQUE-EMAIL-YOU-CONTROL -TestEmails
```

It requests a password securely and leaves test account/history behind. Do not use customer accounts. Verify actual inbox delivery separately; emulator email actions do not send mail. See [test report](TEST_REPORT.md) for checks actually executed.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PORT` | Listener port, default 8080 |
| `NODE_ENV` | development / test / production |
| `FIREBASE_PROJECT_ID` | Auth/Firestore project ID |
| `FIREBASE_WEB_API_KEY` | Firebase Auth REST project configuration; never an Admin credential |
| `CURSOR_SECRET` | Random secret of at least 32 characters, shared across instances; signs cursors and HMACs rate-limit keys |
| `TRUST_PROXY_HOPS` | Exact trusted proxy hop count; 0 locally, explicitly >=1 in production |
| `GOOGLE_APPLICATION_CREDENTIALS` | Optional local private service-account file outside this repository; prefer workload identity in deployment |
| `FIREBASE_AUTH_EMULATOR_HOST`, `FIRESTORE_EMULATOR_HOST` | Both set for local demo emulators, both absent in staging/production |

Generate a staging secret with `node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"`. Keep it in a secret manager. Rotation invalidates outstanding cursors and creates fresh rate-limit buckets. No secrets belong in Flutter, git, command-line history or build arguments.

## Staging deployment: Cloud Run example

No cloud project, billing, domain or credentials were supplied. This repository does not provision or deploy paid services automatically. An owner must choose a new staging Firebase project, region and billing account first.

1. Create the staging Firebase project and Firestore Native database in the selected region. Enable Authentication Email/Password. Configure password policy and email enumeration protection. Configure authorized domains, hosted action handler and reset/verification templates; test delivery with an inbox you control.
2. Create a dedicated runtime service account. Grant only Firestore data access (`roles/datastore.user`) and Firebase Auth operations needed for `getUser`/`updateUser` and revocation verification. Prefer a custom Auth role granting `firebaseauth.users.get` and `firebaseauth.users.update`; otherwise evaluate the broader `roles/firebaseauth.admin` role explicitly. Runtime does not need project Owner/Editor or deployment roles. Deployment identity is separate. Restrict the Auth REST API key to required Identity Toolkit/Secure Token APIs using restrictions compatible with the server.
3. Deploy locked rules and TTL configuration to the explicitly selected staging project:

```powershell
npx firebase deploy --only firestore:rules,firestore:indexes --project YOUR-STAGING-PROJECT-ID
```

4. Build/deploy the included Dockerfile using your deployment identity and attach the runtime service account. Store `CURSOR_SECRET` in Secret Manager and grant this account access only to that secret. Set `NODE_ENV=production`, project ID/API key and `TRUST_PROXY_HOPS` for the actual ingress. Cloud Run typically uses one trusted ingress hop; confirm with your architecture. Restrict ingress to that proxy so clients cannot bypass it and spoof forwarding headers. TLS terminates at ingress; the app requires forwarded HTTPS for account requests and never redirects credentials. Health is a public liveness check, returning no dependency or secret details.
5. Cloud Run provides the HTTPS origin. Verify `/healthz`, then run the smoke script and manual staging acceptance below. For multiple instances the Firestore-backed rate limits share state. Set ingress limits, instance caps and budget alerts before public traffic: failed authentication attempts consume Firestore operations too.

Build locally with `docker build -t deskbuddy-api .`. Deployment env must omit emulator variables entirely. `npm start` reads injected environment variables; local `npm run dev` reads `.env`. Production image runs as the unprivileged `node` user.

## Storage and operational choices

* Profile: `users/{verifiedUid}`, with server timestamps/name/timezone. Email and verification status always come from Firebase Auth. Profile patch updates Auth's name before the profile transaction; a later GET reconciles an interrupted profile write. Missing profiles recover on login/GET without deleting/recreating Auth users.
* Preferences: `users/{uid}/preferences/app`; defaults and partial updates run in transactions.
* Devices: `users/{uid}/devices/{sha256(UTF8 deviceId)}`. A transaction preserves `createdAt` and caps device count at 100. A supplied settings object replaces the previous snapshot; it does not merge stale hardware observations or issue commands.
* Sessions: `users/{uid}/sessions/{clientEventId}`. Atomic create/retry compares validated payloads, returns 201 once/200 on exact retry and 409 on conflict. `receivedAt` is stored in fixed UTC ISO format and sorted descending followed by document ID descending. Firestore's default descending single-field index includes document name in the same direction; no custom composite index is required. Signed versioned cursors bind uid, limit and sort position and survive deletion of a previous page's last document.
* Session TTL is 90 days after server receipt, via internal Firestore `expiresAt` timestamp, omitted from API responses. TTL deletion is asynchronous; records can remain briefly after expiry. Idempotency lasts while the row exists. Do not replay old BLE commands or expired history uploads. Confirm this retention/retry boundary with product owners before production.
* `_rateLimits/{HMAC(scope:key)}` contains shared counters, expiry and TTL. No plaintext email/IP is persisted. A limit store failure fails account requests closed with 503. Health remains available. Defaults: auth IP 30/15min; signup email 5/15min; login email 15/15min; reset IP 10/15min and email 3/15min; refresh IP 120/15min; protected IP 600/15min; user requests 600/min; session writes 60/min; verification 3/15min per user. Counters use fixed windows and transactions; stricter edge abuse protection can be added at ingress.
* All client Firestore reads/writes are denied. Admin bypasses rules, so API paths always derive from verified uid. Unknown request keys are rejected. No endpoint accepts an owner UID, BLE command, PIN, bond key, notification content or raw packet.
* Logs contain only generated request ID, HTTP method and status. Bodies, URL/query, tokens, emails and provider errors are excluded. Body limit 32 KiB, Auth REST timeout 10s, HTTP timeouts and graceful shutdown are configured. Responses are JSON with `no-store`; errors expose safe text only. CORS is not needed by the Android client; browser clients require an explicitly configured origin policy if added later.

## Live handoff checklist

Record the actual HTTPS origin (without `/v1`), Firebase project ID, region and public health URL in your deployment handoff. Then validate real signup/login/refresh; invalid/expired/revoked/disabled tokens; two-user isolation; rate limits; conflict retries; profile recovery; reset and verification email delivery including hosted action links. Review logs for sensitive fields, IAM, ingress proxy trust, retention and costs. Account deletion/reauth/email changes need a separate release design.

Frontend connection after staging passes:

```powershell
flutter run --dart-define=API_BASE_URL=https://YOUR-ACTUAL-STAGING-ORIGIN
flutter build apk --debug --dart-define=API_BASE_URL=https://YOUR-ACTUAL-STAGING-ORIGIN
```

Firebase behavior references: [Auth REST](https://firebase.google.com/docs/reference/rest/auth), [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens), [query cursors](https://firebase.google.com/docs/firestore/query-data/query-cursors). Automated emulator success is separate from staging deployment and email delivery.
