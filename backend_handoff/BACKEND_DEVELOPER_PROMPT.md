# Backend developer ko yeh brief bhejo

DeskBuddy Flutter Android app ka Firebase-backed REST API backend banana hai. Frontend ka exact contract `openapi.json` aur `API_CONTRACT.md` mein hai. In files ko source of truth rakho; endpoint names, JSON nesting aur field types frontend se discuss kiye bina change mat karna.

## Required implementation

1. Node.js + TypeScript + Express, Firebase Authentication (Email/Password) aur Cloud Firestore use karo. User passwords sirf Firebase Authentication manage kare; Firestore mein plaintext ya custom password hash mat store karna.
2. **Authentication bhi hamare REST API se hogi:** signup/login ke liye backend Firebase Auth REST API call kare; Firebase Admin SDK password sign-in nahi karta. Firebase ID token ko response mein `accessToken` naam do; refresh token aur numeric `expiresIn` do. Flutter app mein Firebase Admin/service-account credential nahi jayega.
3. Ye endpoints implement karo:
   - `POST /v1/auth/signup`
   - `POST /v1/auth/login`
   - `POST /v1/auth/refresh`
   - `POST /v1/auth/forgot-password`
   - `POST /v1/auth/send-verification` — authenticated
   - `GET /v1/me` — profile API
   - `PATCH /v1/me` — displayName/timezone only
   - `GET /v1/me/preferences`
   - `PATCH /v1/me/preferences`
   - `GET /v1/me/devices`
   - `PUT /v1/me/devices` — metadata/settings snapshot upsert
   - `DELETE /v1/me/devices/{recordId}` — account metadata only
   - `GET /v1/me/sessions?limit=20&cursor=...`
   - `POST /v1/me/sessions` — idempotent accepted-start history
   - `GET /healthz` — no secrets/details
4. Protected endpoints par `Authorization: Bearer <Firebase ID token>` verify karo: `admin.auth().verifyIdToken(token, true)`. Har Firestore path decoded `uid` se niklega. Body/query ka uid trust mat karna. Cross-user access, revoked/expired/disabled-user tests compulsory hain.
5. Firestore paths: `users/{uid}`, aur uske `preferences/app`, `devices/{recordId}`, `sessions/{clientEventId}`. Admin SDK rules bypass karta hai: server authorization mandatory hai. Included deny-all client rules deploy karo; app direct Firestore access nahi karti.
6. Bluetooth pairing, PIN entry, bonding, live status, notification delivery aur **sab device commands sirf local BLE** se honge. Koi cloud command queue, Firebase command listener, command replay, OTA/reset/claim endpoint mat banana. Cloud device record physical ownership ka proof nahi hai.
7. API data: profile, app preferences, selected notification app package names, last observed device settings/firmware and accepted-start session history. Bluetooth addresses/PINs/bond keys, notification text/title/sender/OTP, raw BLE packets aur passwords database/logs mein nahi jane chahiye.
8. Exact success envelope: `{ "data": { ... }, "requestId": "..." }`. Exact error envelope: `{ "error": { "code": "...", "message": "..." }, "requestId": "..." }`. Response timestamps ISO-8601 UTC strings; `expiresIn` integer seconds, Firebase REST ka string directly return mat karna. `null` vs absent fields contract follow karein.
9. Zod/strict server validation, bounded JSON body, HTTPS, auth/reset rate limiting, generic reset responses, redacted logs, no-store token responses, correct HTTP codes, pagination limits, IAM least privilege aur environment-based config implement karo. Email enumeration protection/password policy Firebase console mein configure karo. Reset/verification email templates and authorized domains configure karo; actual delivery test karo.
10. Signup mein Auth create hone ke baad profile DB write fail ho sakti hai. Login/GET profile par missing profile safely upsert karke recover karo; retries par existing Auth account delete/recreate nahi karna. Device metadata upsert deterministic ho aur session `clientEventId` retries duplicate rows na banayein.
11. Cloud settings kabhi automatically hardware par apply nahi honi chahiye. Device `settings` last-observed snapshot hai; firmware RAM-vs-flash persistence ka proof nahi. Notification choices restore karne ke liye app mein explicit user action hoga; backend OS Notification Access grant nahi kar sakta.

## Deliverables / acceptance

- Complete backend source, pinned `package-lock.json`, `.env.example`, Firebase rules/indexes/config, deployment README, local emulator tests, OpenAPI docs and CI commands.
- Hand over staging **HTTPS base URL without `/v1` suffix**, Firebase project ID, deployment region, public health URL and test report. Frontend mein secret paste karne ko mat kehna.
- Included `smoke-test.ps1` own staging test account par pass ho. Invalid/expired tokens, malformed payload, rate limit, cross-user access, token refresh/revocation, reset/verification email, duplicate session ID and partial signup recovery tests pass hon.
- Automated tests/emulator pass hona real production deployment/email delivery ka proof nahi. Staging end-to-end result separately report karo.
- Existing app local controls offline kaam karte rahenge. Account unavailable hone par backend retries kabhi BLE action repeat nahi karein.

## App connect karne ka command

Backend ready hone ke baad frontend ko yeh actual URL do:

```powershell
flutter run --dart-define=API_BASE_URL=https://YOUR-STAGING-API.example.com
flutter build apk --debug --dart-define=API_BASE_URL=https://YOUR-STAGING-API.example.com
```

Abhi live backend/Firebase credentials available nahi hain. Is brief ka matlab implementation handoff hai; Firebase project provision/deploy abhi nahi hua hai.
