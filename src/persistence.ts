import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

export interface WriteResult { ok: boolean; error?: string; filePath: string; }
interface QueryResult { rows: Array<Record<string, unknown>>; rowCount?: number | null; }
interface PersistenceClient { query(text: string, values?: unknown[]): Promise<QueryResult>; release(): void; }
interface PersistencePool { connect(): Promise<PersistenceClient>; }

const asyncQueues = new Map<string, Promise<unknown>>();
const stateCache = new Map<string, unknown>();
const pendingWrites = new Map<string, unknown | null>();
let lastWriteError = '';
let persistencePool: PersistencePool | null = null;
let databaseReady = false;
let flushPromise: Promise<void> | null = null;

const DATABASE_STATE_FILES = new Set([
  'admin_auth.json', 'auto_refresh.json', 'catalog.json', 'categories.json',
  'channel_alerts.json', 'channel_health.json', 'epg.json',
  'github_build_state.json', 'github_config.json', 'invites.json',
  'lifecycle_log.json', 'playlist_meta.json', 'playlists_snapshot.json',
  'sources.json', 'state_meta.json',
  'streaming_settings.json', 'ui_settings.json',
  'user_sessions.json', 'users.json', 'apk/releases.json',
]);

export function configurePersistencePool(pool: PersistencePool | null): void { persistencePool = pool; }
export function activateDatabasePersistence(): void { databaseReady = true; }
export function deactivateDatabasePersistence(): void {
  databaseReady = false;
  persistencePool = null;
  stateCache.clear();
  pendingWrites.clear();
}
export function isDatabasePersistenceActive(): boolean { return databaseReady; }
export function hasStateCacheKey(key: string): boolean { return stateCache.has(key); }

function stateKey(targetPath: string): string | null {
  const root = path.resolve(config.dataDir);
  const absolute = path.resolve(targetPath);
  const relative = path.relative(root, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('../') || path.isAbsolute(relative)) return null;
  return DATABASE_STATE_FILES.has(relative) ? relative : null;
}

function cloneJson<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value)) as T;
}

export async function importLegacyJsonState(pool: PersistencePool): Promise<number> {
  const rows: Array<{ key: string; value: unknown }> = [];
  for (const key of DATABASE_STATE_FILES) {
    const file = path.join(config.dataDir, ...key.split('/'));
    if (!fs.existsSync(file)) continue;
    try {
      rows.push({ key, value: JSON.parse(fs.readFileSync(file, 'utf-8')) });
    } catch (error) {
      throw new Error(`Legacy JSON import stopped: ${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!rows.length) return 0;
  const client = await pool.connect();
  let imported = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const result = await client.query(
        'INSERT INTO app_state (state_key, value) VALUES ($1, $2::jsonb) ON CONFLICT (state_key) DO NOTHING RETURNING state_key',
        [row.key, JSON.stringify(row.value)]
      );
      imported += result.rowCount || 0;
    }
    await client.query('COMMIT');
    return imported;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

export async function loadPersistentState(pool: PersistencePool): Promise<number> {
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT state_key, value FROM app_state');
    stateCache.clear();
    for (const row of result.rows) {
      if (typeof row.state_key === 'string') stateCache.set(row.state_key, row.value);
    }
    return stateCache.size;
  } finally { client.release(); }
}

/**
 * Mirrors active PostgreSQL app_state back onto local disk JSON files so switching
 * back to Local mode keeps all recent database mutations intact.
 */
export function exportStateCacheToDisk(): number {
  let written = 0;
  for (const [key, value] of stateCache.entries()) {
    if (!DATABASE_STATE_FILES.has(key)) continue;
    const targetPath = path.join(config.dataDir, ...key.split('/'));
    const res = atomicWriteFileSync(targetPath, JSON.stringify(value, null, 2));
    if (res.ok) written++;
  }
  return written;
}

export async function flushPersistence(): Promise<void> {
  if (!databaseReady || !persistencePool) return;
  if (flushPromise) return flushPromise;
  if (pendingWrites.size === 0) return;
  flushPromise = (async () => {
    while (pendingWrites.size) {
      const batch = new Map(pendingWrites);
      pendingWrites.clear();
      const client = await persistencePool!.connect();
      try {
        await client.query('BEGIN');
        for (const [key, value] of batch) {
          if (value === null) {
            await client.query('DELETE FROM app_state WHERE state_key = $1', [key]);
          } else {
            await client.query(
              'INSERT INTO app_state (state_key, value, updated_at) VALUES ($1, $2::jsonb, NOW()) ON CONFLICT (state_key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()',
              [key, JSON.stringify(value)]
            );
          }
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        for (const [key, value] of batch) if (!pendingWrites.has(key)) pendingWrites.set(key, value);
        lastWriteError = error instanceof Error ? error.message : String(error);
        throw error;
      } finally { client.release(); }
    }
    lastWriteError = '';
  })().finally(() => { flushPromise = null; });
  return flushPromise;
}

export function getLastPersistenceError(): string { return lastWriteError; }
export function clearLastPersistenceError(): void { lastWriteError = ''; }
export function uniqueTempPath(targetPath: string): string {
  return `${targetPath}.tmp.${process.pid}.${Date.now()}.${crypto.randomBytes(6).toString('hex')}`;
}

export function withAsyncWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const normalizedKey = path.resolve(key);
  const prev = asyncQueues.get(normalizedKey) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn());
  const cleanup = next.finally(() => { if (asyncQueues.get(normalizedKey) === cleanup) asyncQueues.delete(normalizedKey); });
  asyncQueues.set(normalizedKey, cleanup);
  return next;
}

export function hasJsonStateSync(targetPath: string): boolean {
  const key = databaseReady ? stateKey(targetPath) : null;
  return key ? stateCache.has(key) : fs.existsSync(targetPath);
}

export function readJsonSync<T>(targetPath: string, fallback: T): T {
  const key = databaseReady ? stateKey(targetPath) : null;
  if (key) return stateCache.has(key) ? cloneJson(stateCache.get(key) as T) : fallback;
  if (!fs.existsSync(targetPath)) return fallback;
  return JSON.parse(fs.readFileSync(targetPath, 'utf-8')) as T;
}

export function atomicWriteFileSync(targetPath: string, content: string | Buffer): WriteResult {
  const absTarget = path.resolve(targetPath);
  const tmpPath = uniqueTempPath(absTarget);
  try {
    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    if (typeof content === 'string') fs.writeFileSync(tmpPath, content, 'utf-8');
    else fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, absTarget);
    return { ok: true, filePath: absTarget };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `Write failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch { /* ignore cleanup failure */ }
    return { ok: false, error: msg, filePath: absTarget };
  }
}

export function atomicWriteJsonSync(targetPath: string, data: unknown, indent?: number): WriteResult {
  const absTarget = path.resolve(targetPath);
  try {
    const serialized = indent !== undefined ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    const key = databaseReady ? stateKey(absTarget) : null;
    if (key) {
      const value = JSON.parse(serialized);
      stateCache.set(key, value);
      pendingWrites.set(key, value);
      void flushPersistence().catch((error) => console.error('[postgres] Queued state write failed:', error));
      return { ok: true, filePath: absTarget };
    }
    return atomicWriteFileSync(absTarget, serialized);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `JSON serialization failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    return { ok: false, error: msg, filePath: absTarget };
  }
}

export function safeUnlinkSync(targetPath: string): { ok: boolean; existed: boolean; error?: string } {
  const absTarget = path.resolve(targetPath);
  const key = databaseReady ? stateKey(absTarget) : null;
  if (key) {
    const existed = stateCache.has(key);
    stateCache.delete(key);
    pendingWrites.set(key, null);
    void flushPersistence().catch((error) => console.error('[postgres] Queued state delete failed:', error));
    return { ok: true, existed };
  }
  if (!fs.existsSync(absTarget)) return { ok: true, existed: false };
  try { fs.unlinkSync(absTarget); return { ok: true, existed: true }; }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `Delete failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    return { ok: false, existed: true, error: msg };
  }
}
