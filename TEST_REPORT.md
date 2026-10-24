# DeskBuddy backend test report

Executed locally on 25 October 2026 (Asia/Kolkata), Windows, Node.js 22.15.0, npm 10.9.2. Implementation language: plain JavaScript ES modules, Node.js + Express. There are no TypeScript application or test source files and no compilation requirement.

| Check | Result |
| --- | --- |
| `npm run check` | PASS |
| JavaScript syntax | PASS for source, tests and scripts |
| Supplied contract reference checker | PASS: 15 operations, 34 valid references |
| Redocly OpenAPI lint | PASS, one expected warning for unconfigured staging placeholder URL |
| Unit/HTTP tests | 21/21 PASS |
| `npm run test:emulators` | 10/10 PASS, real local Auth + Firestore emulators |
| `npm audit --omit=dev` | 0 known vulnerabilities |
| Full dependency audit | 5 moderate findings in Firebase CLI development dependency tree; no high/critical findings after updates |
| Staging deployment / public HTTPS URL | NOT EXECUTED: no Firebase staging project, hosting configuration or credentials supplied |
| Supplied staging `smoke-test.ps1` | NOT EXECUTED: requires a real staging URL and controlled test inbox |
| Real reset/verification email delivery | NOT EXECUTED: emulator generates actions, does not send email |

Unit/HTTP coverage: strict input bounds/types and unknown field rejection; unmodified passwords; email/name trimming; empty patches; mixed session fields; safe JSON envelopes; missing/invalid/expired/revoked/disabled token handling via controlled fixtures; Admin `verifyIdToken(token, true)` invocation; decoded-UID scoping; body limits/content type; shared limiter responses and failure behavior; trusted-proxy HTTPS enforcement; signed cursor tampering/uid/query validation; Auth REST numeric token expiry and refresh rotation/error mapping; absent-account reset handling.

Emulator coverage: real signup/login/profile/Auth display name; Firestore contains no password or email fields; concurrent preference merges; Alice/Bob isolation across profile/preferences/devices/history and deletion; deterministic device upsert and 100-device concurrent cap; concurrent session deduplication and conflicts; per-user event namespace; internal 90-day TTL omitted from responses; pagination with timestamp ties; cursor uid/query binding; injected Firestore failure after Auth creation and recovery on login/GET; refresh/revocation/disabled-user behavior; reset/verification actions in emulator sink and refreshed Auth verification status; atomic rate-limit counters; authenticated and anonymous direct Firestore reads/writes denied.

An initial sandbox HTTP test attempt was blocked by loopback restrictions; the suite passed when rerun with reviewed loopback access. The initial parallel test worker configuration exceeded this machine's memory; the committed configuration uses one worker and passed. Java 17 was insufficient for current Firebase tools; a SHA-256-verified Java 21 JRE was downloaded into the ignored workspace cache, without changing system Java. Firebase emulator transaction contention retried successfully during concurrent tests.

Production dependencies and tools are pinned in `package-lock.json`. Remaining moderate development findings are inherited from Firebase CLI's OpenTelemetry/UUID dependency chains; npm's suggested automatic fix downgrades the CLI to an older major. They are excluded from the runtime Docker image. Reassess upstream CLI updates before deployment tooling is used on sensitive environments.

Before live handoff, an owner must provide/select staging project and region, configure Auth/email policy/templates/domains, runtime IAM/ADC, secret management and HTTPS ingress, deploy rules/indexes/TTL, then execute the supplied smoke test and actual inbox/action-link checks. Local results do not establish live deployment or email delivery.
