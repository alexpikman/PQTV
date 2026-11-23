import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import {
  activateDatabasePersistence, atomicWriteJsonSync, configurePersistencePool,
  flushPersistence, hasJsonStateSync, importLegacyJsonState, loadPersistentState,
  readJsonSync, safeUnlinkSync,
} from '../src/persistence.js';

class MemoryPool {
  readonly rows = new Map<string, unknown>();
  async connect() {
    return {
      query: async (sql: string, values: unknown[] = []) => {
        if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [], rowCount: 0 };
        if (sql.startsWith('INSERT INTO app_state')) {
          const key = String(values[0]);
          if (sql.includes('DO UPDATE')) {
            this.rows.set(key, JSON.parse(String(values[1])));
            return { rows: [], rowCount: 1 };
          }
          if (this.rows.has(key)) return { rows: [], rowCount: 0 };
          this.rows.set(key, JSON.parse(String(values[1])));
          return { rows: [{ state_key: key }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT state_key, value FROM app_state')) {
          return { rows: Array.from(this.rows, ([state_key, value]) => ({ state_key, value })), rowCount: this.rows.size };
        }
        if (sql.startsWith('DELETE FROM app_state')) {
          const existed = this.rows.delete(String(values[0]));
          return { rows: [], rowCount: existed ? 1 : 0 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
  }
}

test('PostgreSQL persistence imports legacy JSON once and serves durable state from the database cache', async () => {
  const oldDataDir = config.dataDir;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pqtv-pg-state-'));
  const pool = new MemoryPool();
  try {
    config.dataDir = tempDir;
    fs.writeFileSync(path.join(tempDir, 'users.json'), JSON.stringify([{ id: 'u1', login: 'viewer' }]));
    fs.writeFileSync(path.join(tempDir, 'catalog.json'), JSON.stringify({ channels: [], streams: [], nextChannelId: 1, nextStreamId: 1 }));

    assert.equal(await importLegacyJsonState(pool), 2);
    assert.equal(await importLegacyJsonState(pool), 0);
    assert.equal(pool.rows.size, 2);

    configurePersistencePool(pool);
    assert.equal(await loadPersistentState(pool), 2);
    activateDatabasePersistence();

    const usersFile = path.join(tempDir, 'users.json');
    assert.equal(hasJsonStateSync(usersFile), true);
    assert.deepEqual(readJsonSync(usersFile, []), [{ id: 'u1', login: 'viewer' }]);

    assert.equal(atomicWriteJsonSync(usersFile, [{ id: 'u1', login: 'updated' }]).ok, true);
    await flushPersistence();
    assert.deepEqual(pool.rows.get('users.json'), [{ id: 'u1', login: 'updated' }]);
    assert.deepEqual(readJsonSync(usersFile, []), [{ id: 'u1', login: 'updated' }]);

    assert.equal(safeUnlinkSync(usersFile).ok, true);
    await flushPersistence();
    assert.equal(pool.rows.has('users.json'), false);
  } finally {
    config.dataDir = oldDataDir;
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
