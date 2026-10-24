import { initializeApp, applicationDefault } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { readConfig } from './config.js';
import { FirebaseAuthService } from './auth.js';
import { AccountStore } from './store.js';
import { createApp } from './app.js';
const config = readConfig();
const firebase = initializeApp({
    projectId: config.FIREBASE_PROJECT_ID,
    ...config.FIREBASE_AUTH_EMULATOR_HOST ? {} : {
        credential: applicationDefault()
    }
});
const app = createApp(config, new FirebaseAuthService(getAuth(firebase), config), new AccountStore(getFirestore(firebase), config.CURSOR_SECRET));
const server = app.listen(config.PORT, '0.0.0.0', ()=>console.log(JSON.stringify({
        event: 'listening',
        port: config.PORT
    })));
server.requestTimeout = 30000;
server.headersTimeout = 15000;
for (const signal of [
    'SIGINT',
    'SIGTERM'
])process.on(signal, ()=>{
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(1), 10000).unref();
});
