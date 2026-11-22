import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteJsonSync } from './persistence.js';

export type StorageMode = 'local' | 'cloud';

export interface FirebaseWebConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  firestoreDatabaseId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
  measurementId?: string;
}

export interface StorageSettings {
  mode: StorageMode;
  useCustomFirebaseConfig: boolean;
  firebaseConfig: FirebaseWebConfig;
  updatedAt: number;
}

export interface PublicStorageClientConfig {
  mode: StorageMode;
  configured: boolean;
  firebaseConfig: FirebaseWebConfig | null;
}

function cleanStr(val: unknown, maxLen = 256): string {
  return typeof val === 'string' ? val.trim().slice(0, maxLen) : '';
}

function emptyFirebaseConfig(): FirebaseWebConfig {
  return {
    apiKey: '',
    authDomain: '',
    projectId: '',
    firestoreDatabaseId: '(default)',
    storageBucket: '',
    messagingSenderId: '',
    appId: '',
    measurementId: '',
  };
}

function normalizeFirebaseConfig(raw: unknown, fallback?: FirebaseWebConfig): FirebaseWebConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = fallback || emptyFirebaseConfig();
  return {
    apiKey: cleanStr(obj.apiKey, 200) || base.apiKey,
    authDomain: cleanStr(obj.authDomain, 200) || base.authDomain,
    projectId: cleanStr(obj.projectId, 128) || base.projectId,
    firestoreDatabaseId:
      cleanStr(obj.firestoreDatabaseId, 128) || base.firestoreDatabaseId || '(default)',
    storageBucket: cleanStr(obj.storageBucket, 200) || base.storageBucket,
    messagingSenderId: cleanStr(obj.messagingSenderId, 64) || base.messagingSenderId,
    appId: cleanStr(obj.appId, 200) || base.appId,
    measurementId: cleanStr(obj.measurementId, 64) || base.measurementId || '',
  };
}

export function getBundledFirebaseConfig(): FirebaseWebConfig | null {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as Record<string, unknown>;
    const normalized = normalizeFirebaseConfig(raw);
    if (!normalized.projectId || !normalized.apiKey) return null;
    return normalized;
  } catch {
    return null;
  }
}

function getEnvFirebaseOverride(): FirebaseWebConfig | null {
  const projectId = cleanStr(process.env.FIREBASE_PROJECT_ID, 128);
  const apiKey = cleanStr(process.env.FIREBASE_API_KEY, 200);
  if (!projectId || !apiKey) return null;
  return {
    projectId,
    apiKey,
    authDomain: cleanStr(process.env.FIREBASE_AUTH_DOMAIN, 200) || `${projectId}.firebaseapp.com`,
    firestoreDatabaseId: cleanStr(process.env.FIREBASE_DATABASE_ID, 128) || '(default)',
    storageBucket:
      cleanStr(process.env.FIREBASE_STORAGE_BUCKET, 200) || `${projectId}.firebasestorage.app`,
    messagingSenderId: cleanStr(process.env.FIREBASE_MESSAGING_SENDER_ID, 64),
    appId: cleanStr(process.env.FIREBASE_APP_ID, 200),
    measurementId: cleanStr(process.env.FIREBASE_MEASUREMENT_ID, 64),
  };
}

function getSettingsPath(): string {
  return path.join(config.dataDir, 'storage_settings.json');
}

export function loadStorageSettings(): StorageSettings {
  const bundled = getBundledFirebaseConfig();
  const envCfg = getEnvFirebaseOverride();
  const defaultCfg = envCfg || bundled || emptyFirebaseConfig();
  const envModeRaw = cleanStr(process.env.PQTV_STORAGE_MODE, 16).toLowerCase();
  const defaultMode: StorageMode =
    envModeRaw === 'local'
      ? 'local'
      : envModeRaw === 'cloud'
        ? 'cloud'
        : defaultCfg.projectId && defaultCfg.apiKey
          ? 'cloud'
          : 'local';

  const filePath = getSettingsPath();
  if (!fs.existsSync(filePath)) {
    return {
      mode: defaultMode,
      useCustomFirebaseConfig: Boolean(envCfg),
      firebaseConfig: { ...defaultCfg },
      updatedAt: 0,
    };
  }

  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Partial<StorageSettings>;
    const mode: StorageMode = raw.mode === 'local' ? 'local' : raw.mode === 'cloud' ? 'cloud' : defaultMode;
    const useCustom = Boolean(raw.useCustomFirebaseConfig);
    const fb = normalizeFirebaseConfig(raw.firebaseConfig, defaultCfg);
    return {
      mode,
      useCustomFirebaseConfig: useCustom,
      firebaseConfig: fb,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return {
      mode: defaultMode,
      useCustomFirebaseConfig: Boolean(envCfg),
      firebaseConfig: { ...defaultCfg },
      updatedAt: 0,
    };
  }
}

export function getStorageMode(): StorageMode {
  return loadStorageSettings().mode;
}

export function getActiveFirebaseConfig(): FirebaseWebConfig | null {
  const settings = loadStorageSettings();
  if (settings.mode !== 'cloud') return null;

  if (settings.useCustomFirebaseConfig) {
    if (settings.firebaseConfig.projectId && settings.firebaseConfig.apiKey) {
      return settings.firebaseConfig;
    }
    return null;
  }

  const envCfg = getEnvFirebaseOverride();
  if (envCfg) return envCfg;
  return getBundledFirebaseConfig();
}

export function getPublicStorageClientConfig(): PublicStorageClientConfig {
  const mode = getStorageMode();
  if (mode === 'local') {
    return {
      mode: 'local',
      configured: true,
      firebaseConfig: null,
    };
  }
  const active = getActiveFirebaseConfig();
  return {
    mode: 'cloud',
    configured: Boolean(active?.projectId && active?.apiKey),
    firebaseConfig: active,
  };
}

export function saveStorageSettings(input: {
  mode?: unknown;
  useCustomFirebaseConfig?: unknown;
  firebaseConfig?: unknown;
}): { ok: boolean; settings?: StorageSettings; error?: string } {
  const current = loadStorageSettings();
  const bundled = getBundledFirebaseConfig();
  const nextMode: StorageMode =
    input.mode === 'local' ? 'local' : input.mode === 'cloud' ? 'cloud' : current.mode;
  const nextUseCustom =
    input.useCustomFirebaseConfig !== undefined
      ? Boolean(input.useCustomFirebaseConfig)
      : current.useCustomFirebaseConfig;

  const rawFb =
    input.firebaseConfig && typeof input.firebaseConfig === 'object'
      ? (input.firebaseConfig as Record<string, unknown>)
      : null;

  const nextFb: FirebaseWebConfig = rawFb
    ? {
        apiKey: cleanStr(rawFb.apiKey, 200),
        authDomain: cleanStr(rawFb.authDomain, 200),
        projectId: cleanStr(rawFb.projectId, 128),
        firestoreDatabaseId: cleanStr(rawFb.firestoreDatabaseId, 128) || '(default)',
        storageBucket: cleanStr(rawFb.storageBucket, 200),
        messagingSenderId: cleanStr(rawFb.messagingSenderId, 64),
        appId: cleanStr(rawFb.appId, 200),
        measurementId: cleanStr(rawFb.measurementId, 64),
      }
    : current.firebaseConfig;

  if (nextMode === 'cloud') {
    if (nextUseCustom) {
      if (!nextFb.projectId || !/^[a-z0-9-]+$/i.test(nextFb.projectId)) {
        return {
          ok: false,
          error: 'Укажите корректный Project ID Firebase (латиница, цифры и дефис)',
        };
      }
      if (!nextFb.apiKey) {
        return { ok: false, error: 'Укажите API Key проекта Firebase' };
      }
      if (!nextFb.authDomain) {
        nextFb.authDomain = `${nextFb.projectId}.firebaseapp.com`;
      }
      if (!nextFb.appId) {
        return { ok: false, error: 'Укажите App ID веб-приложения Firebase' };
      }
    } else if (!getEnvFirebaseOverride() && !bundled) {
      return {
        ok: false,
        error:
          'Стандартный firebase-applet-config.json не найден. Включите «Свои параметры Firebase» или выберите «Локальное» хранение.',
      };
    }
  }

  const nextSettings: StorageSettings = {
    mode: nextMode,
    useCustomFirebaseConfig: nextUseCustom,
    firebaseConfig: nextFb,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  const writeRes = atomicWriteJsonSync(getSettingsPath(), nextSettings, 2);
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || 'Не удалось сохранить storage_settings.json' };
  }

  return { ok: true, settings: nextSettings };
}
