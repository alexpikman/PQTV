import { deleteApp, initializeApp } from 'firebase/app';
import { Auth, getAuth, GoogleAuthProvider } from 'firebase/auth';
import { doc, Firestore, getDocFromServer, getFirestore } from 'firebase/firestore';
import bundledFirebaseConfig from '../../firebase-applet-config.json' with { type: 'json' };

export interface RuntimeFirebaseConfig {
  apiKey?: string;
  authDomain?: string;
  projectId?: string;
  firestoreDatabaseId?: string;
  storageBucket?: string;
  messagingSenderId?: string;
  appId?: string;
  measurementId?: string;
}

export interface RuntimeStorageConfig {
  mode?: 'local' | 'cloud';
  configured?: boolean;
  firebaseConfig?: RuntimeFirebaseConfig | null;
}

function getRuntimeStorageConfig(): RuntimeStorageConfig | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { PQTV_STORAGE_CONFIG?: RuntimeStorageConfig };
  return w.PQTV_STORAGE_CONFIG || null;
}

const runtimeCfg = getRuntimeStorageConfig();
export const storageMode: 'local' | 'cloud' =
  runtimeCfg?.mode === 'local' ? 'local' : 'cloud';

const candidateConfig: RuntimeFirebaseConfig | null =
  storageMode === 'local'
    ? null
    : runtimeCfg?.firebaseConfig &&
        runtimeCfg.firebaseConfig.projectId &&
        runtimeCfg.firebaseConfig.apiKey
      ? runtimeCfg.firebaseConfig
      : runtimeCfg && runtimeCfg.mode === 'cloud' && runtimeCfg.configured === false
        ? null
        : bundledFirebaseConfig;

export const activeFirebaseConfig: RuntimeFirebaseConfig | null =
  candidateConfig && candidateConfig.projectId && candidateConfig.apiKey
    ? candidateConfig
    : null;

export const firebaseEnabled: boolean = Boolean(
  storageMode === 'cloud' && activeFirebaseConfig
);

const app = firebaseEnabled && activeFirebaseConfig ? initializeApp(activeFirebaseConfig) : null;

export const db: Firestore = (
  app && activeFirebaseConfig
    ? getFirestore(app, activeFirebaseConfig.firestoreDatabaseId || '(default)')
    : null
) as unknown as Firestore;

export const auth: Auth = (app ? getAuth(app) : null) as unknown as Auth;

export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const currentUser = auth ? auth.currentUser : null;
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: currentUser?.uid,
      email: currentUser?.email,
      emailVerified: currentUser?.emailVerified,
      isAnonymous: currentUser?.isAnonymous,
      tenantId: currentUser?.tenantId,
      providerInfo:
        currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

export async function testConnection(): Promise<void> {
  if (!firebaseEnabled || !db) return;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export async function probeFirebaseConfig(cfg: RuntimeFirebaseConfig): Promise<{
  ok: boolean;
  reachable: boolean;
  manifestExists?: boolean;
  message: string;
}> {
  const projectId = String(cfg?.projectId || '').trim();
  const apiKey = String(cfg?.apiKey || '').trim();
  const dbId = String(cfg?.firestoreDatabaseId || '(default)').trim() || '(default)';
  if (!projectId || !apiKey) {
    return {
      ok: false,
      reachable: false,
      message: 'Укажите Project ID и API Key перед проверкой.',
    };
  }
  const probeName = `pqtv_probe_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  const probeApp = initializeApp(
    {
      apiKey,
      authDomain: String(cfg.authDomain || `${projectId}.firebaseapp.com`).trim(),
      projectId,
      storageBucket: String(cfg.storageBucket || '').trim(),
      messagingSenderId: String(cfg.messagingSenderId || '').trim(),
      appId: String(cfg.appId || '').trim(),
    },
    probeName
  );
  try {
    const probeDb = getFirestore(probeApp, dbId);
    const snap = await getDocFromServer(doc(probeDb, 'cloud_meta', 'manifest'));
    return {
      ok: true,
      reachable: true,
      manifestExists: snap.exists(),
      message: snap.exists()
        ? `Подключение успешно: база ${projectId}/${dbId} доступна и содержит снимок PQTV.`
        : `Подключение успешно: база ${projectId}/${dbId} доступна (снимок ещё не создан).`,
    };
  } catch (err) {
    const code = (err && typeof err === 'object' && 'code' in err) ? String((err as { code?: unknown }).code || '') : '';
    const msg = err instanceof Error ? err.message : String(err);
    if (code === 'permission-denied' || msg.includes('PERMISSION_DENIED') || msg.includes('Missing or insufficient permissions')) {
      return {
        ok: true,
        reachable: true,
        message: `База ${projectId}/${dbId} найдена и отвечает (для чтения cloud_meta нужен вход администратора Google).`,
      };
    }
    if (code === 'not-found' || msg.toLowerCase().includes('database') && msg.toLowerCase().includes('does not exist')) {
      return {
        ok: false,
        reachable: false,
        message: `База данных ${projectId}/${dbId} не найдена. Проверьте Project ID и Firestore Database ID.`,
      };
    }
    return {
      ok: false,
      reachable: false,
      message: `Не удалось подключиться к Firestore (${code || 'error'}): ${msg}`,
    };
  } finally {
    await deleteApp(probeApp).catch(() => {});
  }
}

if (firebaseEnabled) {
  void testConnection();
}
