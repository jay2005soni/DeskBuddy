import { spawnSync } from 'node:child_process';
import { mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
const cache = resolve('.cache/firebase/emulators');
mkdirSync(cache, { recursive: true });
const temp = resolve('.tmp');
mkdirSync(temp, { recursive: true });
const localJavaRoot = resolve('.cache/java/runtime');
const localJava = existsSync(localJavaRoot) ? readdirSync(localJavaRoot).map(name => resolve(localJavaRoot, name)).find(path => existsSync(resolve(path, 'bin/java.exe'))) : undefined;
const javaEnv = localJava ? { JAVA_HOME: localJava, Path: `${resolve(localJava, 'bin')};${process.env.Path ?? process.env.PATH}` } : {};
// Child process environment never points integration tests at a real project.
const starting = process.argv.includes('--start');
const args = ['node_modules/firebase-tools/lib/bin/firebase.js', starting ? 'emulators:start' : 'emulators:exec', '--project', 'demo-deskbuddy', '--only', 'auth,firestore'];
if (!starting) args.push('npm run test:integration');
const result = spawnSync(process.execPath, args, {
  stdio: 'inherit', env: { ...process.env, ...javaEnv, XDG_CONFIG_HOME: resolve('.cache/config'), CI: 'true', TEMP: temp, TMP: temp, TMPDIR: temp, FIREBASE_EMULATORS_PATH: cache, FIREBASE_PROJECT_ID: 'demo-deskbuddy', FIREBASE_WEB_API_KEY: 'demo-api-key', FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099', FIRESTORE_EMULATOR_HOST: '127.0.0.1:8081', NODE_ENV: 'test', CURSOR_SECRET: 'integration-only-32-character-secret-key', TRUST_PROXY_HOPS: '0' },
});
process.exit(result.status ?? 1);
