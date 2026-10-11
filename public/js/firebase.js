// Firebase の初期化と匿名ログイン。
// 設定が未入力のとき、または URL に ?local=1 を付けたときは「ローカルモード」で動きます。
// ローカルモードではデータをこの端末の localStorage に保存するため、1台で画面の確認ができます。
import { firebaseConfig } from './firebase-config.js';

const SDK_BASE = 'https://www.gstatic.com/firebasejs/10.12.2';
const LOCAL_FLAG = 'nfclove:localMode';
const LOCAL_UID = 'nfclove:localUid';
const EMULATOR_FLAG = 'nfclove:emulator';

// 開発用：?emulator=1 で Firebase Emulator Suite（localhost）につなぐ
function detectEmulator() {
  const params = new URLSearchParams(location.search);
  try {
    if (params.get('emulator') === '1') sessionStorage.setItem(EMULATOR_FLAG, '1');
    if (params.get('emulator') === '0') sessionStorage.removeItem(EMULATOR_FLAG);
    return sessionStorage.getItem(EMULATOR_FLAG) === '1';
  } catch (_) {
    return false;
  }
}

export const useEmulator = detectEmulator();

function detectLocalMode() {
  if (useEmulator) return false;
  const params = new URLSearchParams(location.search);
  try {
    if (params.get('local') === '1') sessionStorage.setItem(LOCAL_FLAG, '1');
    if (params.get('local') === '0') sessionStorage.removeItem(LOCAL_FLAG);
    if (sessionStorage.getItem(LOCAL_FLAG) === '1') return true;
  } catch (_) {
    // sessionStorage が使えない環境では設定値だけで判定する
  }
  return !firebaseConfig.apiKey || firebaseConfig.apiKey.startsWith('YOUR_');
}

export const isLocalMode = detectLocalMode();

let firebaseCtx = null;

// Firebase SDK を CDN から読み込み、app / auth / db と Firestore 関数群を返す
export async function getFirebase() {
  if (isLocalMode) return null;
  if (firebaseCtx) return firebaseCtx;
  const [appMod, authMod, fs] = await Promise.all([
    import(`${SDK_BASE}/firebase-app.js`),
    import(`${SDK_BASE}/firebase-auth.js`),
    import(`${SDK_BASE}/firebase-firestore.js`),
  ]);
  const config = useEmulator ? { apiKey: 'demo-key', projectId: 'demo-honne', authDomain: 'localhost' } : firebaseConfig;
  const app = appMod.initializeApp(config);
  const auth = authMod.getAuth(app);
  const db = fs.getFirestore(app);
  if (useEmulator) {
    authMod.connectAuthEmulator(auth, `http://${location.hostname}:9099`, { disableWarnings: true });
    fs.connectFirestoreEmulator(db, location.hostname, 8080);
  }
  firebaseCtx = { app, auth, db, fs, authMod };
  return firebaseCtx;
}

function randomId(len = 20) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => chars[b % chars.length]).join('');
}

let uidPromise = null;

// 匿名ログインしてプレイヤーID（uid）を返す。同じブラウザなら毎回同じIDになる。
export function signIn() {
  if (uidPromise) return uidPromise;
  uidPromise = (async () => {
    if (isLocalMode) {
      let uid = localStorage.getItem(LOCAL_UID);
      if (!uid) {
        uid = `local-${randomId(12)}`;
        localStorage.setItem(LOCAL_UID, uid);
      }
      return uid;
    }
    const { auth, authMod } = await getFirebase();
    const existing = await new Promise((resolve) => {
      const unsubscribe = authMod.onAuthStateChanged(auth, (user) => {
        unsubscribe();
        resolve(user);
      });
    });
    if (existing) return existing.uid;
    const cred = await authMod.signInAnonymously(auth);
    return cred.user.uid;
  })();
  return uidPromise;
}

export { randomId };
