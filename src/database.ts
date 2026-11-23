import fs from 'node:fs';
import path from 'node:path';
import { Pool, PoolConfig } from 'pg';
import { config } from './config.js';
import {
  activateDatabasePersistence,
  configurePersistencePool,
  deactivateDatabasePersistence,
  exportStateCacheToDisk,
  flushPersistence,
  hasStateCacheKey,
  importLegacyJsonState,
  isDatabasePersistenceActive,
  loadPersistentState,
} from './persistence.js';
import { storage } from './storage.js';
import { loadStorageSettings, PostgresConfig, isPostgresConfigured } from './storageSettings.js';

let currentPool: Pool | null = config.databaseUrl
  ? new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    })
  : null;

if (currentPool) {
  currentPool.on('error', (error) => console.error('[postgres] Idle client error:', error));
}

export const pool = {
  query: (...args: unknown[]) => {
    if (!currentPool) throw new Error('PostgreSQL pool is not connected');
    return (currentPool.query as (...a: unknown[]) => unknown)(...args);
  },
  connect: () => {
    if (!currentPool) throw new Error('PostgreSQL pool is not connected');
    return currentPool.connect();
  },
  end: async () => {
    if (currentPool) await currentPool.end();
  },
  on: (...args: unknown[]) => {
    if (currentPool) (currentPool.on as (...a: unknown[]) => unknown)(...args);
  },
} as unknown as Pool;

let initialization: Promise<boolean> | null = null;

function buildPoolConfig(pgCfg?: PostgresConfig | null): PoolConfig | null {
  const effective = pgCfg || loadStorageSettings().postgresConfig;
  if (effective.useEnvDatabaseUrl) {
    if (!config.databaseUrl) return null;
    return {
      connectionString: config.databaseUrl,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  }
  if (effective.connectionString) {
    return {
      connectionString: effective.connectionString,
      ...(effective.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    };
  }
  if (!effective.host || !effective.database || !effective.user) return null;
  return {
    host: effective.host,
    port: effective.port || 5432,
    database: effective.database,
    user: effective.user,
    password: effective.password,
    ...(effective.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  };
}

async function applyMigrationsToPool(targetPool: Pool): Promise<void> {
  await targetPool.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())'
  );
  const dir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(dir)) throw new Error(`PostgreSQL migrations directory is missing: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/i, '');
    const found = await targetPool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (found.rows.length) continue;
    const client = await targetPool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf-8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [
        version,
      ]);
      await client.query('COMMIT');
      console.log(`[postgres] Applied migration ${version}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

export async function testPostgresConnection(
  pgCfg: PostgresConfig
): Promise<{ ok: boolean; version?: string; error?: string }> {
  const poolCfg = buildPoolConfig(pgCfg);
  if (!poolCfg) {
    return { ok: false, error: 'Параметры подключения PostgreSQL не заполнены' };
  }
  const probe = new Pool({ ...poolCfg, max: 2, connectionTimeoutMillis: 7000 });
  try {
    const res = await probe.query('SELECT version() AS ver');
    const ver = String((res.rows[0] as { ver?: string } | undefined)?.ver || 'PostgreSQL');
    return { ok: true, version: ver.split(',')[0].trim() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    await probe.end().catch(() => undefined);
  }
}

async function activatePoolInternal(targetPool: Pool): Promise<{ imported: number; loaded: number }> {
  await targetPool.query('SELECT 1');
  await applyMigrationsToPool(targetPool);

  // Capture local .m3u playlists into playlists_snapshot.json before legacy import if missing
  const snapshotPath = path.join(config.dataDir, 'playlists_snapshot.json');
  if (!fs.existsSync(snapshotPath) && storage.getPlaylists().length > 0) {
    storage.syncPlaylistsSnapshot();
  }

  configurePersistencePool(targetPool);
  const imported = await importLegacyJsonState(targetPool);
  const loaded = await loadPersistentState(targetPool);
  activateDatabasePersistence();

  if (hasStateCacheKey('playlists_snapshot.json')) {
    storage.restorePlaylistsFromSnapshot();
  } else if (storage.getPlaylists().length > 0) {
    storage.syncPlaylistsSnapshot();
    await flushPersistence();
  }

  return { imported, loaded };
}

export async function activateRuntimePostgres(
  pgCfg: PostgresConfig
): Promise<{ ok: boolean; imported?: number; loaded?: number; error?: string }> {
  const poolCfg = buildPoolConfig(pgCfg);
  if (!poolCfg) {
    return { ok: false, error: 'Не заданы параметры подключения PostgreSQL' };
  }
  const nextPool = new Pool(poolCfg);
  nextPool.on('error', (error) => console.error('[postgres] Idle client error:', error));

  try {
    if (isDatabasePersistenceActive()) {
      await flushPersistence().catch(() => undefined);
      exportStateCacheToDisk();
      if (storage.getPlaylists().length > 0) {
        storage.syncPlaylistsSnapshot();
      }
      deactivateDatabasePersistence();
    }

    const oldPool = currentPool;
    const { imported, loaded } = await activatePoolInternal(nextPool);
    currentPool = nextPool;
    if (oldPool) {
      await oldPool.end().catch(() => undefined);
    }
    return { ok: true, imported, loaded };
  } catch (err) {
    await nextPool.end().catch(() => undefined);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function deactivateRuntimePostgres(): Promise<void> {
  if (isDatabasePersistenceActive()) {
    await flushPersistence().catch(() => undefined);
    exportStateCacheToDisk();
    if (hasStateCacheKey('playlists_snapshot.json')) {
      storage.restorePlaylistsFromSnapshot();
    }
    deactivateDatabasePersistence();
  }
  if (currentPool) {
    const oldPool = currentPool;
    currentPool = null;
    await oldPool.end().catch(() => undefined);
  }
}

export async function initializeDatabase(): Promise<boolean> {
  const settings = loadStorageSettings();
  if (settings.mode !== 'postgres') {
    console.log(`[storage] Active storage mode: ${settings.mode}; PostgreSQL persistence skipped`);
    return false;
  }
  if (!isPostgresConfigured(settings.postgresConfig)) {
    console.log('[storage] PostgreSQL mode selected but not configured; starting with local fallback');
    return false;
  }
  if (initialization) return initialization;
  initialization = (async () => {
    const poolCfg = buildPoolConfig(settings.postgresConfig);
    if (!poolCfg) return false;
    if (!currentPool) {
      currentPool = new Pool(poolCfg);
      currentPool.on('error', (error) => console.error('[postgres] Idle client error:', error));
    }
    const { imported, loaded } = await activatePoolInternal(currentPool);
    console.log(`[postgres] Ready. Imported ${imported} legacy JSON records; loaded ${loaded} database records.`);
    return true;
  })().catch((error) => {
    initialization = null;
    console.warn('[postgres] Startup connection failed; continuing with local fallback:', error);
    return false;
  });
  return initialization;
}

export async function closeDatabase(): Promise<void> {
  await flushPersistence().catch(() => undefined);
  if (currentPool) {
    await currentPool.end().catch(() => undefined);
    currentPool = null;
  }
}
