import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteFileSync } from './persistence.js';

export type StorageMode = 'local' | 'postgres' | 'cloud';

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

export interface PostgresConfig {
  useEnvDatabaseUrl: boolean;
  connectionString: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

export interface StorageSettings {
  mode: StorageMode;
  useCustomFirebaseConfig: boolean;
  firebaseConfig: FirebaseWebConfig;
  postgresConfig: PostgresConfig;
  updatedAt: number;
}

export interface MaskedPostgresConfig {
  useEnvDatabaseUrl: boolean;
  hasEnvDatabaseUrl: boolean;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl: boolean;
  hasConnectionString: boolean;
  maskedConnectionString: string;
  hasPassword: boolean;
}

export interface MaskedStorageSettings {
  mode: StorageMode;
  useCustomFirebaseConfig: boolean;
  firebaseConfig: FirebaseWebConfig;
  postgresConfig: MaskedPostgresConfig;
  updatedAt: number;
}

export interface PublicStorageClientConfig {
  mode: StorageMode;
  configured: boolean;
  firebaseConfig: FirebaseWebConfig | null;
}

const MASK_SENTINEL = '********';

function cleanStr(val: unknown, maxLen = 512): string {
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

export function emptyPostgresConfig(): PostgresConfig {
  return {
    useEnvDatabaseUrl: Boolean(config.databaseUrl),
    connectionString: '',
    host: '',
    port: 5432,
    database: 'pqtv',
    user: 'postgres',
    password: '',
    ssl: false,
  };
}

function normalizePort(raw: unknown): number {
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 1 && n <= 65535) return Math.floor(n);
  return 5432;
}

function normalizePostgresConfig(raw: unknown, fallback?: PostgresConfig): PostgresConfig {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const base = fallback || emptyPostgresConfig();

  const rawConn = cleanStr(obj.connectionString, 1024);
  const nextConn =
    rawConn === MASK_SENTINEL
      ? base.connectionString
      : obj.connectionString !== undefined
        ? rawConn
        : base.connectionString;

  const rawPass = typeof obj.password === 'string' ? obj.password.slice(0, 512) : undefined;
  const nextPass =
    rawPass === MASK_SENTINEL
      ? base.password
      : rawPass !== undefined
        ? rawPass
        : base.password;

  return {
    useEnvDatabaseUrl:
      obj.useEnvDatabaseUrl !== undefined ? Boolean(obj.useEnvDatabaseUrl) : base.useEnvDatabaseUrl,
    connectionString: nextConn,
    host: cleanStr(obj.host, 255) || (obj.host !== undefined ? '' : base.host),
    port: obj.port !== undefined ? normalizePort(obj.port) : base.port,
    database: cleanStr(obj.database, 128) || (obj.database !== undefined ? '' : base.database),
    user: cleanStr(obj.user, 128) || (obj.user !== undefined ? '' : base.user),
    password: nextPass,
    ssl: obj.ssl !== undefined ? Boolean(obj.ssl) : base.ssl,
  };
}

export function maskConnectionString(raw: string): string {
  const trimmed = cleanStr(raw, 1024);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.password) parsed.password = MASK_SENTINEL;
    return parsed.toString();
  } catch {
    return trimmed.replace(/(:\/\/[^:@/\s]+:)([^@/\s]+)(@)/g, `$1${MASK_SENTINEL}$3`);
  }
}

export function getMaskedPostgresConfig(pg: PostgresConfig): MaskedPostgresConfig {
  const hasEnv = Boolean(config.databaseUrl);
  const effectiveConn = pg.useEnvDatabaseUrl ? config.databaseUrl : pg.connectionString;
  return {
    useEnvDatabaseUrl: Boolean(pg.useEnvDatabaseUrl),
    hasEnvDatabaseUrl: hasEnv,
    host: pg.host,
    port: pg.port || 5432,
    database: pg.database,
    user: pg.user,
    ssl: Boolean(pg.ssl),
    hasConnectionString: Boolean(pg.connectionString),
    maskedConnectionString: pg.connectionString ? maskConnectionString(pg.connectionString) : (hasEnv && pg.useEnvDatabaseUrl ? maskConnectionString(effectiveConn) : ''),
    hasPassword: Boolean(pg.password),
  };
}

export function getMaskedStorageSettings(): MaskedStorageSettings {
  const full = loadStorageSettings();
  return {
    mode: full.mode,
    useCustomFirebaseConfig: full.useCustomFirebaseConfig,
    firebaseConfig: full.firebaseConfig,
    postgresConfig: getMaskedPostgresConfig(full.postgresConfig),
    updatedAt: full.updatedAt,
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

function readDiskStorageSettings(): Partial<StorageSettings> | null {
  const filePath = getSettingsPath();
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    return raw && typeof raw === 'object' ? (raw as Partial<StorageSettings>) : null;
  } catch {
    return null;
  }
}

export function hasSavedStorageSettings(): boolean {
  return fs.existsSync(getSettingsPath());
}

export function loadStorageSettings(): StorageSettings {
  const bundled = getBundledFirebaseConfig();
  const envCfg = getEnvFirebaseOverride();
  const defaultCfg = envCfg || bundled || emptyFirebaseConfig();
  const defaultPg = emptyPostgresConfig();
  const envModeRaw = cleanStr(process.env.PQTV_STORAGE_MODE, 16).toLowerCase();
  const defaultMode: StorageMode =
    envModeRaw === 'local'
      ? 'local'
      : envModeRaw === 'postgres'
        ? 'postgres'
        : envModeRaw === 'cloud'
          ? 'cloud'
          : config.databaseUrl
            ? 'postgres'
            : defaultCfg.projectId && defaultCfg.apiKey
              ? 'cloud'
              : 'local';

  const stored = readDiskStorageSettings();
  if (!stored) {
    return {
      mode: defaultMode,
      useCustomFirebaseConfig: Boolean(envCfg),
      firebaseConfig: { ...defaultCfg },
      postgresConfig: { ...defaultPg },
      updatedAt: 0,
    };
  }

  try {
    const raw = stored;
    const mode: StorageMode =
      raw.mode === 'local'
        ? 'local'
        : raw.mode === 'postgres'
          ? 'postgres'
          : raw.mode === 'cloud'
            ? 'cloud'
            : defaultMode;
    const useCustom = Boolean(raw.useCustomFirebaseConfig);
    const fb = normalizeFirebaseConfig(raw.firebaseConfig, defaultCfg);
    const pg = normalizePostgresConfig(raw.postgresConfig, defaultPg);
    return {
      mode,
      useCustomFirebaseConfig: useCustom,
      firebaseConfig: fb,
      postgresConfig: pg,
      updatedAt: Number(raw.updatedAt) || 0,
    };
  } catch {
    return {
      mode: defaultMode,
      useCustomFirebaseConfig: Boolean(envCfg),
      firebaseConfig: { ...defaultCfg },
      postgresConfig: { ...defaultPg },
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

export function isPostgresConfigured(pg: PostgresConfig): boolean {
  if (pg.useEnvDatabaseUrl) {
    return Boolean(config.databaseUrl);
  }
  if (pg.connectionString) {
    return /^postgres(ql)?:\/\//i.test(pg.connectionString);
  }
  return Boolean(pg.host && pg.database && pg.user);
}

export function resolvePostgresInputConfig(rawPg: unknown, fallback?: PostgresConfig): PostgresConfig {
  return normalizePostgresConfig(rawPg, fallback || loadStorageSettings().postgresConfig);
}

export function getPublicStorageClientConfig(): PublicStorageClientConfig {
  const settings = loadStorageSettings();
  if (settings.mode === 'local') {
    return {
      mode: 'local',
      configured: true,
      firebaseConfig: null,
    };
  }
  if (settings.mode === 'postgres') {
    return {
      mode: 'postgres',
      configured: isPostgresConfigured(settings.postgresConfig),
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
  postgresConfig?: unknown;
}): { ok: boolean; settings?: StorageSettings; error?: string } {
  const current = loadStorageSettings();
  const bundled = getBundledFirebaseConfig();
  const nextMode: StorageMode =
    input.mode === 'local'
      ? 'local'
      : input.mode === 'postgres'
        ? 'postgres'
        : input.mode === 'cloud'
          ? 'cloud'
          : current.mode;
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

  const nextPg: PostgresConfig =
    input.postgresConfig && typeof input.postgresConfig === 'object'
      ? normalizePostgresConfig(input.postgresConfig, current.postgresConfig)
      : current.postgresConfig;

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

  if (nextMode === 'postgres') {
    if (nextPg.useEnvDatabaseUrl) {
      if (!config.databaseUrl) {
        return {
          ok: false,
          error: 'Переменная окружения DATABASE_URL не задана на сервере. Укажите параметры PostgreSQL вручную.',
        };
      }
    } else if (nextPg.connectionString) {
      if (!/^postgres(ql)?:\/\//i.test(nextPg.connectionString)) {
        return {
          ok: false,
          error: 'Строка подключения PostgreSQL должна начинаться с postgres:// или postgresql://',
        };
      }
    } else {
      if (!nextPg.host) {
        return { ok: false, error: 'Укажите хост (Host) сервера PostgreSQL или строку DATABASE_URL' };
      }
      if (!nextPg.database) {
        return { ok: false, error: 'Укажите имя базы данных PostgreSQL' };
      }
      if (!nextPg.user) {
        return { ok: false, error: 'Укажите имя пользователя PostgreSQL' };
      }
    }
  }

  const nextSettings: StorageSettings = {
    mode: nextMode,
    useCustomFirebaseConfig: nextUseCustom,
    firebaseConfig: nextFb,
    postgresConfig: nextPg,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  const writeRes = atomicWriteFileSync(getSettingsPath(), JSON.stringify(nextSettings, null, 2));
  if (!writeRes.ok) {
    return { ok: false, error: writeRes.error || 'Не удалось сохранить storage_settings.json' };
  }

  return { ok: true, settings: nextSettings };
}
