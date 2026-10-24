# Backend handoff package

Send this entire folder to the backend developer. Start with **BACKEND_DEVELOPER_PROMPT.md**. This is an implementation contract/config/test package, not an already deployed API server. No Firebase project or live endpoint exists yet; app auth screens cannot create real accounts until the backend is provided.

Files:

- `BACKEND_DEVELOPER_PROMPT.md`: copy-paste assignment for the developer.
- `API_CONTRACT.md`: exact routes, JSON, storage boundaries, validations and security behavior.
- `openapi.json`: import into Swagger Editor/Postman for schema and endpoint documentation.
- `smoke-test.ps1`: staging end-to-end contract check, creates an account in the target environment. Use a test email you control; it leaves test profile/history/device metadata behind.
- `firestore.rules`, `firestore.indexes.json`, `firebase.json`: locked client-access config and emulator ports. Add indexes if the backend query plan needs them; empty indexes alone do not certify pagination.
- `.env.example`: backend configuration names, no real credentials.
- `validate-contract.mjs`: dependency-free JSON/reference sanity check (`node validate-contract.mjs`); use a full OpenAPI linter in backend CI as well.

## Commands for the backend developer

Run in a **new backend folder**. These are setup commands only; the developer must implement the server described by the contract.

```powershell
mkdir deskbuddy-api
cd deskbuddy-api
npm init -y
npm install express firebase-admin zod helmet express-rate-limit cors
npm install --save-dev typescript tsx vitest supertest @types/node @types/express @types/supertest firebase-tools
npx tsc --init
```

Use a maintained Node LTS supported by the chosen Firebase Admin version and commit the resulting package lock. Set package scripts `dev`, `build`, `start`, `test`, and `test:integration`. Copy this handoff config to the backend root, create a private `.env` from the example and exclude it/service-account keys from git. Enable Firebase Email/Password auth, email templates/authorized domains and Firestore Native mode in the selected project. Region/billing/IAM are owner choices; no command in this handoff provisions paid services automatically.

For emulator integration tests (project ID has a `demo-` prefix to avoid accidentally selecting a live project):

```powershell
npx firebase emulators:start --project demo-deskbuddy --only auth,firestore
```

In a second terminal, start the implemented backend with emulator environment variables from `.env.example` and run its integration tests. For staging, configure proper ADC/IAM credentials and HTTPS hosting, then run:

```powershell
.\smoke-test.ps1 -BaseUrl https://YOUR-STAGING-API.example.com -Email YOUR-UNIQUE-TEST-EMAIL@example.com
```

The script asks for a test password securely; do not put it in command-line history. Don't run against real customer accounts. It does not print access/refresh tokens. Reset/verification delivery, two-user authorization, revoked-token and Firebase partial-failure tests must also be implemented by the backend developer.

## Connect the Flutter app after handoff

```powershell
flutter run --dart-define=API_BASE_URL=https://YOUR-STAGING-API.example.com
flutter build apk --debug --dart-define=API_BASE_URL=https://YOUR-STAGING-API.example.com
```

Local Android emulator only (debug build):

```powershell
flutter run --dart-define=API_BASE_URL=http://10.0.2.2:8080 --dart-define=ALLOW_INSECURE_API=true
```

Alternatively use `adb reverse tcp:8080 tcp:8080` and `http://localhost:8080` on a USB-debugging test phone. Plain HTTP is rejected in release builds and for arbitrary hosts. API_BASE_URL must be an origin, without `/v1` suffix, query, fragments, embedded credentials or trailing resource path. A URL is public config; never pass Firebase Admin secrets via dart-define.

Backend must return the full profile after signup/login and expose `GET /v1/me`. Android needs no `google-services.json` for this architecture because Firebase Auth/Firestore access lives behind the REST backend.
