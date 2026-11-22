import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

let tempRoot = '';
let baseUrl = '';
let server: http.Server;
let adminToken = '';
const csrfToken = 'test_csrf_token_0123456789abcdef0123456789abcdef';

let configMod: typeof import('../src/config.js');
let storageMod: typeof import('../src/storage.js');
let streamParserMod: typeof import('../src/streamParser.js');
let catalogStoreMod: typeof import('../src/catalogStore.js');
let channelHealthMod: typeof import('../src/channelHealth.js');
let stateLifecycleMod: typeof import('../src/stateLifecycle.js');
let userAuthMod: typeof import('../src/userAuth.js');

function makeAdminToken(email: string, csrf: string, secret: string): string {
  const payload = {
    email,
    csrf,
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

async function api<T = Record<string, unknown>>(
  pathname: string,
  method: 'GET' | 'POST' | 'DELETE' = 'GET',
  body?: unknown
): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = {
    'X-Admin-Token': adminToken,
  };
  if (method !== 'GET') {
    headers['X-CSRF-Token'] = csrfToken;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { status: res.status, data: parsed as T };
}

function resetTempWorkspace(): void {
  if (!tempRoot) return;
  for (const sub of ['playlist', 'data', 'data/backups/playlist', 'data/cache', 'data/cache/source_index']) {
    const dir = path.join(tempRoot, sub);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
  }
  stateLifecycleMod.stateLifecycle.resetCache();
  streamParserMod.StreamParser.resetCache();
  catalogStoreMod.catalogStore.resetState();
  channelHealthMod.channelHealth.resetState();
}

before(async () => {
  process.env.PQTV_NO_LISTEN = '1';
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pqtv-integrity-'));

  configMod = await import('../src/config.js');
  configMod.config.playlistDir = path.join(tempRoot, 'playlist');
  configMod.config.dataDir = path.join(tempRoot, 'data');
  configMod.config.backupDir = path.join(tempRoot, 'data/backups/playlist');
  configMod.config.cacheDir = path.join(tempRoot, 'data/cache');

  fs.mkdirSync(configMod.config.playlistDir, { recursive: true });
  fs.mkdirSync(configMod.config.dataDir, { recursive: true });
  fs.mkdirSync(configMod.config.backupDir, { recursive: true });
  fs.mkdirSync(configMod.config.cacheDir, { recursive: true });

  const srvMod = await import('../server.js');
  storageMod = await import('../src/storage.js');
  streamParserMod = await import('../src/streamParser.js');
  catalogStoreMod = await import('../src/catalogStore.js');
  channelHealthMod = await import('../src/channelHealth.js');
  stateLifecycleMod = await import('../src/stateLifecycle.js');
  userAuthMod = await import('../src/userAuth.js');

  adminToken = makeAdminToken(configMod.config.adminEmail, csrfToken, configMod.config.sessionSecret);

  server = http.createServer(srvMod.app);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

after(async () => {
  if (server) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  if (tempRoot) {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('PQTV Data Lifecycle & Integrity Suite', () => {
  test('1-3. Deleting a playlist removes unique channels, cleans user/invite assignments, preserves shared channels, and isolates backups', async () => {
    resetTempWorkspace();

    assert.equal((await api('/api/playlists', 'POST', { name: 'pl_a' })).status, 200);
    assert.equal((await api('/api/playlists', 'POST', { name: 'pl_b' })).status, 200);

    await api('/api/channels/save', 'POST', {
      playlist: 'pl_a',
      channels: [
        { name: 'OnlyInA', group: 'G1', logo: '', url: 'https://example.com/only_a.m3u8' },
        { name: 'SharedAB', group: 'G1', logo: '', url: 'https://example.com/shared.m3u8' },
      ],
    });
    await api('/api/channels/save', 'POST', {
      playlist: 'pl_b',
      channels: [
        { name: 'SharedAB', group: 'G1', logo: '', url: 'https://example.com/shared.m3u8' },
        { name: 'OnlyInB', group: 'G2', logo: '', url: 'https://example.com/only_b.m3u8' },
      ],
    });

    // Assign both playlists to a user and an invite
    const uSave = await api<{ ok: boolean; user: { id: string } }>('/api/users/save', 'POST', {
      login: 'viewer1',
      password: 'secret',
      name: 'Viewer 1',
      playlists: ['pl_a', 'pl_b'],
      enabled: true,
    });
    assert.equal(uSave.status, 200);
    const invSave = await api('/api/invites/save', 'POST', {
      email: 'guest@example.com',
      name: 'Guest',
      playlists: ['pl_a'],
      enabled: true,
    });
    assert.equal(invSave.status, 200);

    // Delete pl_a
    const delRes = await api<{
      ok: boolean;
      removedChannels: number;
      cleanedUsers: number;
      cleanedInvites: number;
    }>('/api/playlists/delete', 'POST', { name: 'pl_a' });
    assert.equal(delRes.status, 200);
    assert.equal(delRes.data.ok, true);
    assert.equal(delRes.data.removedChannels, 1);
    assert.equal(delRes.data.cleanedUsers, 1);
    assert.equal(delRes.data.cleanedInvites, 1);

    // Scenario 1: pl_a is gone from playlists, catalog playlists, users, and invites
    const pls = await api<{ playlists: string[] }>('/api/playlists');
    assert.deepEqual(pls.data.playlists, ['pl_b']);

    const catPls = await api<{ playlists: string[] }>('/api/catalog/playlists');
    assert.deepEqual(catPls.data.playlists, ['pl_b']);

    const usersRes = await api<{ users: Array<{ login: string; playlists: string[] }> }>('/api/users');
    assert.deepEqual(usersRes.data.users[0].playlists, ['pl_b']);

    const invitesRes = await api<{ invites: Array<{ email: string; playlists: string[] }> }>('/api/invites');
    assert.deepEqual(invitesRes.data.invites[0].playlists, []);

    // DEF-05: No .bak files inside playlistDir; backup lives only in backupDir
    const filesInPlaylistDir = fs.readdirSync(configMod.config.playlistDir);
    assert.ok(filesInPlaylistDir.every((f) => !f.includes('.bak')));
    const backupsRes = await api<{ backups: Array<{ playlistName: string; filename: string }> }>('/api/playlists/backups');
    assert.ok(backupsRes.data.backups.some((b) => b.playlistName === 'pl_a'));

    // Scenario 2 & 3: OnlyInA disappeared; SharedAB preserved with updated used_in_list
    const catCh = await api<{
      channels: Array<{ name: string; used_in_list: string[] }>;
    }>('/api/catalog/channels?limit=50');
    const names = catCh.data.channels.map((c) => c.name);
    assert.equal(names.includes('OnlyInA'), false);
    assert.equal(names.includes('SharedAB'), true);
    assert.equal(names.includes('OnlyInB'), true);

    const shared = catCh.data.channels.find((c) => c.name === 'SharedAB')!;
    assert.deepEqual(shared.used_in_list, ['pl_b']);
  });

  test('4-5. Deleting sources cleans source_index cache and orphan streams while preserving multi-source channels', async () => {
    resetTempWorkspace();

    const s1 = { id: 'src_one', name: 'Source One', type: 'm3u', url: 'https://example.com/s1.m3u', enabled: true };
    const s2 = { id: 'src_two', name: 'Source Two', type: 'm3u', url: 'https://example.com/s2.m3u', enabled: true };
    assert.equal((await api('/api/sources/save', 'POST', { sources: [s1, s2] })).status, 200);

    // Fetch saved sources to get their assigned catalogId
    const savedSources = (await api<{ sources: Array<{ id: string; catalogId: number; name: string; type: string }> }>('/api/sources')).data.sources;
    const src1Obj = savedSources.find((s) => s.id === 'src_one')!;
    const src2Obj = savedSources.find((s) => s.id === 'src_two')!;

    // Populate source_index caches + ingest items into catalog
    streamParserMod.StreamParser.hydrateIndexData({
      src_one: {
        items: [
          { name: 'SoloFromOne', url: 'https://cdn.example.com/s1_solo.m3u8', logo: '', group: 'G', tvg_id: '' },
          { name: 'MultiSourceCh', url: 'https://cdn.example.com/s1_multi.m3u8', logo: '', group: 'G', tvg_id: '' },
        ],
      },
      src_two: {
        items: [
          { name: 'MultiSourceCh', url: 'https://cdn.example.com/s2_multi.m3u8', logo: '', group: 'G', tvg_id: '' },
        ],
      },
    });
    catalogStoreMod.catalogStore.ingestSourceItems(src1Obj, [
      { name: 'SoloFromOne', url: 'https://cdn.example.com/s1_solo.m3u8', logo: '', group: 'G', tvg_id: '' },
      { name: 'MultiSourceCh', url: 'https://cdn.example.com/s1_multi.m3u8', logo: '', group: 'G', tvg_id: '' },
    ]);
    catalogStoreMod.catalogStore.ingestSourceItems(src2Obj, [
      { name: 'MultiSourceCh', url: 'https://cdn.example.com/s2_multi.m3u8', logo: '', group: 'G', tvg_id: '' },
    ]);
    catalogStoreMod.catalogStore.reconcile({ save: true });

    const idxDir = path.join(configMod.config.cacheDir, 'source_index');
    assert.equal(fs.existsSync(path.join(idxDir, 'src_one.json')), true);
    assert.equal(fs.existsSync(path.join(idxDir, 'src_two.json')), true);

    // Delete source one via unified endpoint
    const delS1 = await api<{ ok: boolean; removedStreams: number; removedChannels: number }>(
      '/api/sources/delete',
      'POST',
      { id: 'src_one' }
    );
    assert.equal(delS1.status, 200);
    assert.equal(delS1.data.removedStreams, 2);
    assert.equal(delS1.data.removedChannels, 1);

    // DEF-09: src_one index cache files removed, src_two preserved
    assert.equal(fs.existsSync(path.join(idxDir, 'src_one.json')), false);
    assert.equal(fs.existsSync(path.join(idxDir, 'src_one.meta')), false);
    assert.equal(fs.existsSync(path.join(idxDir, 'src_two.json')), true);

    // MultiSourceCh survives with 1 remaining stream from src_two; SoloFromOne is gone
    const catAfter1 = await api<{ channels: Array<{ name: string; streams_count: number }> }>(
      '/api/catalog/channels?limit=50'
    );
    assert.deepEqual(
      catAfter1.data.channels.map((c) => c.name),
      ['MultiSourceCh']
    );
    assert.equal(catAfter1.data.channels[0].streams_count, 1);

    // Delete second source -> MultiSourceCh becomes orphaned and is pruned too
    const delS2 = await api<{ ok: boolean; removedStreams: number; removedChannels: number }>(
      '/api/sources/delete',
      'POST',
      { id: 'src_two' }
    );
    assert.equal(delS2.status, 200);
    assert.equal(delS2.data.removedStreams, 1);
    assert.equal(delS2.data.removedChannels, 1);
    assert.equal(fs.existsSync(path.join(idxDir, 'src_two.json')), false);

    const catAfter2 = await api<{ channels: unknown[] }>('/api/catalog/channels?limit=50');
    assert.equal(catAfter2.data.channels.length, 0);
  });

  test('6. Re-import / reconcile is idempotent and never duplicates or resurrects deleted records', async () => {
    resetTempWorkspace();

    await api('/api/playlists', 'POST', { name: 'news' });
    await api('/api/channels/save', 'POST', {
      playlist: 'news',
      channels: [
        { name: 'News 1', group: 'News', logo: '', url: 'https://example.com/news1.m3u8' },
        { name: 'News 2', group: 'News', logo: '', url: 'https://example.com/news2.m3u8' },
      ],
    });

    // Remove News 2 from playlist
    await api('/api/channels/save', 'POST', {
      playlist: 'news',
      channels: [{ name: 'News 1', group: 'News', logo: '', url: 'https://example.com/news1.m3u8' }],
    });

    const r1 = await api<{ ok: boolean; removedChannels: number }>('/api/catalog/reconcile', 'POST', {});
    assert.equal(r1.status, 200);

    const beforeStats = (await api<{ channels: number; streams: number }>('/api/catalog/stats')).data;
    assert.equal(beforeStats.channels, 1);
    assert.equal(beforeStats.streams, 1);

    // Repeat import multiple times -> counts stay exact 1/1 and News 2 never comes back
    const r2 = await api('/api/catalog/import', 'POST', {});
    const r3 = await api('/api/catalog/reconcile', 'POST', {});
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 200);

    const afterStats = (await api<{ channels: number; streams: number }>('/api/catalog/stats')).data;
    assert.deepEqual(afterStats, beforeStats);
    const chList = (await api<{ channels: Array<{ name: string }> }>('/api/catalog/channels?limit=50')).data.channels;
    assert.deepEqual(
      chList.map((c) => c.name),
      ['News 1']
    );
  });

  test('7-8. Cloud hydrate replaces playlists without resurrection and rejects stale snapshots with HTTP 409', async () => {
    resetTempWorkspace();

    await api('/api/playlists', 'POST', { name: 'old_pl' });
    await api('/api/channels/save', 'POST', {
      playlist: 'old_pl',
      channels: [{ name: 'OldChan', group: 'Old', logo: '', url: 'https://example.com/old.m3u8' }],
    });
    await api('/api/playlists', 'POST', { name: 'keep_pl' });
    await api('/api/channels/save', 'POST', {
      playlist: 'keep_pl',
      channels: [{ name: 'KeepChan', group: 'Keep', logo: '', url: 'https://example.com/keep.m3u8' }],
    });

    // Capture a snapshot at earlier revision (say rev 2), then delete old_pl locally (bumping rev higher)
    const staleExport = (await api<Record<string, unknown>>('/api/cloud/export')).data;
    const staleRev = Number(staleExport.revision);
    assert.ok(staleRev > 0);

    // Newer local deletion -> old_pl is deleted, revision advances
    assert.equal((await api('/api/playlists/delete', 'POST', { name: 'old_pl' })).status, 200);
    const currentMeta = (await api<{ revision: number }>('/api/state/revision')).data;
    assert.ok(currentMeta.revision > staleRev);

    // Scenario 8: Stale cloud snapshot rejected with 409! old_pl stays deleted!
    const rejectRes = await api<{ ok: boolean; stale: boolean; localRevision: number }>(
      '/api/cloud/hydrate',
      'POST',
      staleExport
    );
    assert.equal(rejectRes.status, 409);
    assert.equal(rejectRes.data.ok, false);
    assert.equal(rejectRes.data.stale, true);

    const plsAfterReject = (await api<{ playlists: string[] }>('/api/playlists')).data.playlists;
    assert.deepEqual(plsAfterReject, ['keep_pl']);

    // Scenario 7: Authoritative newer snapshot (rev >= local) without old_pl replaces playlists cleanly
    const freshSnapshot = {
      revision: currentMeta.revision + 5,
      playlists: {
        new_pl: [{ name: 'FreshChan', group: 'Fresh', logo: '', url: 'https://example.com/fresh.m3u8' }],
      },
      sources: [],
      epgSources: [],
    };
    const hydrateOk = await api<{ ok: boolean; playlistsRemoved: number }>('/api/cloud/hydrate', 'POST', freshSnapshot);
    assert.equal(hydrateOk.status, 200);
    assert.equal(hydrateOk.data.ok, true);
    assert.equal(hydrateOk.data.playlistsRemoved, 1);

    const plsFinal = (await api<{ playlists: string[] }>('/api/playlists')).data.playlists;
    assert.deepEqual(plsFinal, ['new_pl']);
    const catFinal = (await api<{ channels: Array<{ name: string }> }>('/api/catalog/channels?limit=50')).data.channels;
    assert.deepEqual(
      catFinal.map((c) => c.name),
      ['FreshChan']
    );
  });

  test('9. Bulk category assignment updates exact URL matches across playlists and preserves unrelated channels', async () => {
    resetTempWorkspace();

    await api('/api/playlists', 'POST', { name: 'category_a' });
    await api('/api/playlists', 'POST', { name: 'category_b' });
    await api('/api/channels/save', 'POST', {
      playlist: 'category_a',
      channels: [
        { name: 'Shared A', group: 'Old', logo: '', url: 'https://example.com/shared.m3u8' },
        { name: 'Only A', group: 'Old', logo: '', url: 'https://example.com/only-a.m3u8' },
      ],
    });
    await api('/api/channels/save', 'POST', {
      playlist: 'category_b',
      channels: [
        { name: 'Shared B', group: 'Old', logo: '', url: 'https://example.com/shared.m3u8' },
        { name: 'Only B', group: 'Keep', logo: '', url: 'https://example.com/only-b.m3u8' },
      ],
    });

    const result = await api<{
      ok: boolean;
      updatedChannels: number;
      updatedPlaylists: string[];
    }>('/api/playlists/categories/bulk', 'POST', {
      playlist: 'category_a',
      urls: ['https://example.com/shared.m3u8'],
      group: 'Спорт',
    });

    assert.equal(result.status, 200);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.updatedChannels, 2);
    assert.deepEqual(result.data.updatedPlaylists, ['category_a', 'category_b']);

    const a = (await api<{ channels: Array<{ url: string; group: string }> }>('/api/channels?playlist=category_a')).data.channels;
    const b = (await api<{ channels: Array<{ url: string; group: string }> }>('/api/channels?playlist=category_b')).data.channels;
    assert.equal(a.find((channel) => channel.url.endsWith('/shared.m3u8'))?.group, 'Спорт');
    assert.equal(b.find((channel) => channel.url.endsWith('/shared.m3u8'))?.group, 'Спорт');
    assert.equal(a.find((channel) => channel.url.endsWith('/only-a.m3u8'))?.group, 'Old');
    assert.equal(b.find((channel) => channel.url.endsWith('/only-b.m3u8'))?.group, 'Keep');
  });

  test('10. Write/save failure surfaces HTTP 500 error instead of returning fake ok:true', async () => {
    resetTempWorkspace();

    // Force atomic write failure on epg.json by turning target path into a directory
    const epgPath = path.join(configMod.config.dataDir, 'epg.json');
    fs.mkdirSync(epgPath, { recursive: true });
    fs.writeFileSync(path.join(epgPath, 'blocker'), 'x');

    const failEpg = await api<{ ok?: boolean; error?: string }>('/api/epg/save', 'POST', {
      epg: [{ id: 'e1', name: 'EPG1', url: 'https://example.com/epg.xml', enabled: true }],
    });
    assert.equal(failEpg.status, 500);
    assert.notEqual(failEpg.data.ok, true);
    assert.ok(failEpg.data.error);

    // Force write failure on sources.json
    const sourcesPath = path.join(configMod.config.dataDir, 'sources.json');
    fs.mkdirSync(sourcesPath, { recursive: true });
    fs.writeFileSync(path.join(sourcesPath, 'blocker'), 'x');

    const failSources = await api<{ ok?: boolean; error?: string }>('/api/sources/save', 'POST', {
      sources: [{ id: 's1', name: 'S1', type: 'm3u', url: 'https://example.com/s1.m3u', enabled: true }],
    });
    assert.equal(failSources.status, 500);
    assert.notEqual(failSources.data.ok, true);
    assert.ok(failSources.data.error);
  });

  test('11. Deleting nonexistent records returns HTTP 404 consistently', async () => {
    resetTempWorkspace();

    assert.equal((await api('/api/playlists/delete', 'POST', { name: 'does_not_exist' })).status, 404);
    assert.equal((await api('/api/playlists/backups/delete', 'POST', { filename: 'missing.m3u.2026-01-01_120000.bak' })).status, 404);
    assert.equal((await api('/api/sources/delete', 'POST', { id: 'missing_src_id' })).status, 404);
    assert.equal((await api('/api/catalog/sources/delete', 'POST', { id: 999999 })).status, 404);
    assert.equal((await api('/api/catalog/stream/delete', 'POST', { id: 999999 })).status, 404);
    assert.equal((await api('/api/users/delete', 'POST', { id: 'missing_user_id' })).status, 404);
    assert.equal((await api('/api/invites/delete', 'POST', { id: 'missing_invite_id' })).status, 404);
  });

  test('12. State remains consistent across simulated server restart (in-memory caches reset and reloaded from disk)', async () => {
    resetTempWorkspace();

    await api('/api/playlists', 'POST', { name: 'persist_pl' });
    await api('/api/channels/save', 'POST', {
      playlist: 'persist_pl',
      channels: [
        { name: 'Channel A', group: 'Main', logo: '', url: 'https://example.com/a.m3u8' },
        { name: 'Channel B', group: 'Main', logo: '', url: 'https://example.com/b.m3u8' },
      ],
    });
    await api('/api/sources/save', 'POST', {
      sources: [{ id: 'src_persist', name: 'Persist Src', type: 'm3u', url: 'https://example.com/p.m3u', enabled: true }],
    });
    await api('/api/users/save', 'POST', {
      login: 'persist_user',
      password: 'secret',
      name: 'Persist User',
      playlists: ['persist_pl'],
      enabled: true,
    });

    const revBefore = (await api<{ revision: number }>('/api/state/revision')).data.revision;
    const statsBefore = (await api<{ channels: number; streams: number; sources: number }>('/api/catalog/stats')).data;

    // Simulate process restart: wipe all singleton in-memory caches without touching disk files
    stateLifecycleMod.stateLifecycle.resetCache();
    streamParserMod.StreamParser.resetCache();
    catalogStoreMod.catalogStore.resetState();
    channelHealthMod.channelHealth.resetState();

    // Reload stores & verify HTTP responses match pre-restart state identically
    assert.equal(storageMod.storage.playlistExists('persist_pl'), true);
    assert.equal(userAuthMod.userAuth.findByLogin('persist_user')?.playlists[0], 'persist_pl');

    const revAfter = (await api<{ revision: number }>('/api/state/revision')).data.revision;
    const plsAfter = (await api<{ playlists: string[] }>('/api/playlists')).data.playlists;
    const srcsAfter = (await api<{ sources: Array<{ id: string }> }>('/api/sources')).data.sources;
    const statsAfter = (await api<{ channels: number; streams: number; sources: number }>('/api/catalog/stats')).data;

    assert.equal(revAfter, revBefore);
    assert.deepEqual(plsAfter, ['persist_pl']);
    assert.deepEqual(
      srcsAfter.map((s) => s.id),
      ['src_persist']
    );
    assert.deepEqual(statsAfter, statsBefore);
  });
});
