import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { config } from './config.js';
import { configurePersistencePool, importLegacyJsonState, loadPersistentState, activateDatabasePersistence, flushPersistence } from './persistence.js';

export const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});
pool.on('error', (error) => console.error('[postgres] Idle client error:', error));

let initialization: Promise<void> | null = null;

async function applyMigrations(): Promise<void> {
  await pool.query('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())');
  const dir = path.resolve(process.cwd(), 'migrations');
  if (!fs.existsSync(dir)) throw new Error(`PostgreSQL migrations directory is missing: ${dir}`);
  const files = fs.readdirSync(dir).filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name)).sort();
  for (const file of files) {
    const version = file.replace(/\.sql$/i, '');
    const found = await pool.query('SELECT 1 FROM schema_migrations WHERE version = $1', [version]);
    if (found.rows.length) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf-8'));
      await client.query('INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT (version) DO NOTHING', [version]);
      await client.query('COMMIT');
      console.log(`[postgres] Applied migration ${version}`);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

export async function initializeDatabase(): Promise<void> {
  if (initialization) return initialization;
  initialization = (async () => {
    if (!config.databaseUrl) throw new Error('DATABASE_URL is required; PostgreSQL is the primary PQTV database.');
    await pool.query('SELECT 1');
    await applyMigrations();
    configurePersistencePool(pool);
    const imported = await importLegacyJsonState(pool);
    const loaded = await loadPersistentState(pool);
    activateDatabasePersistence();
    console.log(`[postgres] Ready. Imported ${imported} legacy JSON records; loaded ${loaded} database records.`);
  })().catch((error) => { initialization = null; throw error; });
  return initialization;
}

export async function closeDatabase(): Promise<void> {
  await flushPersistence();
  await pool.end();
}
