import {
  deleteDoc,
  doc,
  DocumentReference,
  getDoc,
  serverTimestamp,
  setDoc,
  updateDoc,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebaseApp.js';

export interface CloudChannelItem {
  name: string;
  group: string;
  logo: string;
  url: string;
  tvg_id: string;
}

export interface CloudSourceItem {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
}

export interface CloudIndexedItem {
  name: string;
  url: string;
  logo: string;
  group: string;
  tvg_id: string;
}

export interface CloudStreamingSettings {
  mode: 'auto_proxy_first' | 'auto_direct_first' | 'proxy_only' | 'direct_only';
  tryHttpsUpgrade: boolean;
  proxyTimeoutSec: number;
}

export interface CloudExportPayload {
  playlists: Record<string, CloudChannelItem[]>;
  sources: CloudSourceItem[];
  sourceIndex: Record<string, { items: CloudIndexedItem[]; updatedAt: number }>;
  epgSources: CloudSourceItem[];
  catalog: {
    nextChannelId: number;
    nextStreamId: number;
    nextSourceId: number;
    channels: Array<Record<string, unknown>>;
    streams: Array<Record<string, unknown>>;
    sources: Array<Record<string, unknown>>;
  };
  streamingSettings: CloudStreamingSettings;
  users: Array<{
    id: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    password_hash?: string;
    created_at?: number;
  }>;
  adminSettings?: {
    githubRepo?: string;
    githubBranch?: string;
    adminPasswordHash?: string;
  };
}

function s(val: unknown, maxLen: number): string {
  return String(val ?? '').slice(0, maxLen);
}

function sReq(val: unknown, maxLen: number, fallback: string): string {
  const trimmed = String(val ?? '').trim().slice(0, maxLen);
  return trimmed.length > 0 ? trimmed : fallback;
}

function safeId(raw: unknown): string {
  const clean = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 128);
  return clean || 'item';
}

function cleanPlaylistName(raw: unknown): string {
  return String(raw ?? '')
    .replace(/\.m3u$/i, '')
    .trim()
    .slice(0, 64);
}

function isValidPlaylistName(name: string): boolean {
  return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(name) && !name.includes('..');
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

async function upsertDoc(
  ref: DocumentReference,
  path: string,
  payload: Record<string, unknown>,
  mutableKeys: string[]
): Promise<void> {
  let snap;
  try {
    snap = await getDoc(ref);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, path);
  }

  if (!snap.exists()) {
    try {
      await setDoc(ref, {
        ...payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.CREATE, path);
    }
  } else {
    const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    for (const k of mutableKeys) {
      if (k in payload) patch[k] = payload[k];
    }
    try {
      await updateDoc(ref, patch);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }
}

async function readManifest(): Promise<{
  playlists: string[];
  sourceIds: string[];
  sourceIndexIds: string[];
  epgIds: string[];
  localUserIds: string[];
  catalogChannelChunks: number;
  catalogStreamChunks: number;
} | null> {
  const ref = doc(db, 'cloud_meta', 'manifest');
  try {
    const snap = await getDoc(ref);
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      playlists: Array.isArray(d.playlists) ? (d.playlists as string[]) : [],
      sourceIds: Array.isArray(d.sourceIds) ? (d.sourceIds as string[]) : [],
      sourceIndexIds: Array.isArray(d.sourceIndexIds) ? (d.sourceIndexIds as string[]) : [],
      epgIds: Array.isArray(d.epgIds) ? (d.epgIds as string[]) : [],
      localUserIds: Array.isArray(d.localUserIds) ? (d.localUserIds as string[]) : [],
      catalogChannelChunks: Number(d.catalogChannelChunks) || 0,
      catalogStreamChunks: Number(d.catalogStreamChunks) || 0,
    };
  } catch {
    return null;
  }
}

async function writeManifestPatch(patch: Partial<{
  playlists: string[];
  sourceIds: string[];
  sourceIndexIds: string[];
  epgIds: string[];
  localUserIds: string[];
  catalogChannelChunks: number;
  catalogStreamChunks: number;
}>): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) return;
  const cur = (await readManifest()) || {
    playlists: [],
    sourceIds: [],
    sourceIndexIds: [],
    epgIds: [],
    localUserIds: [],
    catalogChannelChunks: 0,
    catalogStreamChunks: 0,
  };
  const merged = {
    docId: 'manifest',
    playlists: (patch.playlists ?? cur.playlists).slice(0, 100),
    sourceIds: (patch.sourceIds ?? cur.sourceIds).slice(0, 100),
    sourceIndexIds: (patch.sourceIndexIds ?? cur.sourceIndexIds).slice(0, 100),
    epgIds: (patch.epgIds ?? cur.epgIds).slice(0, 50),
    localUserIds: (patch.localUserIds ?? cur.localUserIds).slice(0, 500),
    catalogChannelChunks: patch.catalogChannelChunks ?? cur.catalogChannelChunks,
    catalogStreamChunks: patch.catalogStreamChunks ?? cur.catalogStreamChunks,
    updatedByUid: uid,
  };
  await upsertDoc(
    doc(db, 'cloud_meta', 'manifest'),
    merged,
    [
      'playlists',
      'sourceIds',
      'sourceIndexIds',
      'epgIds',
      'localUserIds',
      'catalogChannelChunks',
      'catalogStreamChunks',
      'updatedByUid',
    ]
  );
}

function normalizeChannelItem(raw: Partial<CloudChannelItem>): CloudChannelItem {
  return {
    name: s(raw.name, 200),
    group: s(raw.group, 120),
    logo: s(raw.logo, 1000),
    url: s(raw.url, 1500),
    tvg_id: s(raw.tvg_id, 160),
  };
}

export async function savePlaylistToCloud(
  rawName: string,
  channels: Array<Partial<CloudChannelItem>>,
  updateManifest = true
): Promise<void> {
  const plId = cleanPlaylistName(rawName);
  if (!isValidPlaylistName(plId)) return;

  const cleanItems = (Array.isArray(channels) ? channels : [])
    .slice(0, 50000)
    .map(normalizeChannelItem);
  const chunks = chunkArray(cleanItems, 150);

  const metaRef = doc(db, 'playlists', plId);
  let prevChunks = 0;
  try {
    const prevSnap = await getDoc(metaRef);
    if (prevSnap.exists()) {
      prevChunks = Number(prevSnap.data().chunkCount) || 0;
    }
  } catch {
    // ignore
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunkId = `c_${i}`;
    await upsertDoc(
      doc(db, 'playlists', plId, 'chunks', chunkId),
      { playlistId: plId, index: i, items: chunks[i] },
      ['index', 'items']
    );
  }

  for (let i = chunks.length; i < prevChunks; i++) {
    try {
      await deleteDoc(doc(db, 'playlists', plId, 'chunks', `c_${i}`));
    } catch {
      // ignore
    }
  }

  await upsertDoc(
    metaRef,
    {
      id: plId,
      name: plId,
      channelCount: cleanItems.length,
      chunkCount: chunks.length,
    },
    ['name', 'channelCount', 'chunkCount']
  );

  if (updateManifest) {
    const cur = await readManifest();
    const list = cur ? [...cur.playlists] : [];
    if (!list.includes(plId)) {
      list.push(plId);
      list.sort();
      await writeManifestPatch({ playlists: list });
    } else if (!cur) {
      await writeManifestPatch({ playlists: [plId] });
    }
  }
}

export async function deletePlaylistFromCloud(rawName: string): Promise<void> {
  const plId = cleanPlaylistName(rawName);
  if (!isValidPlaylistName(plId)) return;
  const metaRef = doc(db, 'playlists', plId);
  try {
    const snap = await getDoc(metaRef);
    if (snap.exists()) {
      const chunkCount = Number(snap.data().chunkCount) || 0;
      for (let i = 0; i < chunkCount; i++) {
        await deleteDoc(doc(db, 'playlists', plId, 'chunks', `c_${i}`)).catch(() => {});
      }
      await deleteDoc(metaRef);
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `playlists/${plId}`);
  }
  const cur = await readManifest();
  if (cur) {
    await writeManifestPatch({ playlists: cur.playlists.filter((p) => p !== plId) });
  }
}

export async function saveSourcesToCloud(
  sources: CloudSourceItem[],
  updateManifest = true
): Promise<string[]> {
  const cur = await readManifest();
  const prevIds = cur?.sourceIds || [];
  const nextIds: string[] = [];

  for (const src of (Array.isArray(sources) ? sources : []).slice(0, 100)) {
    const id = safeId(src.id);
    if (!nextIds.includes(id)) nextIds.push(id);
    await upsertDoc(
      doc(db, 'sources', id),
      {
        id,
        name: sReq(src.name, 120, id),
        type: sReq(src.type, 32, 'm3u'),
        url: sReq(src.url, 1000, 'https://example.com'),
        enabled: Boolean(src.enabled),
      },
      ['name', 'type', 'url', 'enabled']
    );
  }

  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      await deleteDoc(doc(db, 'sources', oldId)).catch(() => {});
    }
  }

  if (updateManifest) {
    await writeManifestPatch({ sourceIds: nextIds });
  }
  return nextIds;
}

export async function saveSourceIndexToCloud(
  indexMap: Record<string, { items: CloudIndexedItem[]; updatedAt: number }>,
  updateManifest = true
): Promise<string[]> {
  const cur = await readManifest();
  const prevIds = cur?.sourceIndexIds || [];
  const nextIds: string[] = [];

  for (const [rawId, entry] of Object.entries(indexMap || {})) {
    const sourceId = safeId(rawId);
    if (!entry || !Array.isArray(entry.items)) continue;
    if (!nextIds.includes(sourceId)) nextIds.push(sourceId);

    const cleanItems = entry.items.slice(0, 100000).map((it) => ({
      name: s(it.name, 200),
      url: s(it.url, 1500),
      logo: s(it.logo, 1000),
      group: s(it.group, 120),
      tvg_id: s(it.tvg_id, 160),
    }));
    const chunks = chunkArray(cleanItems, 200);
    const metaRef = doc(db, 'source_index', sourceId);
    let prevChunks = 0;
    try {
      const snap = await getDoc(metaRef);
      if (snap.exists()) prevChunks = Number(snap.data().chunkCount) || 0;
    } catch {
      // ignore
    }

    for (let i = 0; i < chunks.length; i++) {
      await upsertDoc(
        doc(db, 'source_index', sourceId, 'chunks', `c_${i}`),
        { sourceId, index: i, items: chunks[i] },
        ['index', 'items']
      );
    }
    for (let i = chunks.length; i < prevChunks; i++) {
      await deleteDoc(doc(db, 'source_index', sourceId, 'chunks', `c_${i}`)).catch(() => {});
    }

    await upsertDoc(
      metaRef,
      {
        sourceId,
        count: cleanItems.length,
        chunkCount: chunks.length,
        indexedAt: Math.max(0, Math.floor(Number(entry.updatedAt) || 0)),
      },
      ['count', 'chunkCount', 'indexedAt']
    );
  }

  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      try {
        const snap = await getDoc(doc(db, 'source_index', oldId));
        if (snap.exists()) {
          const cc = Number(snap.data().chunkCount) || 0;
          for (let i = 0; i < cc; i++) {
            await deleteDoc(doc(db, 'source_index', oldId, 'chunks', `c_${i}`)).catch(() => {});
          }
          await deleteDoc(doc(db, 'source_index', oldId)).catch(() => {});
        }
      } catch {
        // ignore
      }
    }
  }

  if (updateManifest) {
    await writeManifestPatch({ sourceIndexIds: nextIds });
  }
  return nextIds;
}

export async function clearSourceIndexInCloud(sourceId?: string | null): Promise<void> {
  const cur = await readManifest();
  const existingIds = cur?.sourceIndexIds || [];
  const targets = sourceId ? [safeId(sourceId)] : existingIds;
  for (const id of targets) {
    try {
      const snap = await getDoc(doc(db, 'source_index', id));
      if (snap.exists()) {
        const cc = Number(snap.data().chunkCount) || 0;
        for (let i = 0; i < cc; i++) {
          await deleteDoc(doc(db, 'source_index', id, 'chunks', `c_${i}`)).catch(() => {});
        }
        await deleteDoc(doc(db, 'source_index', id)).catch(() => {});
      }
    } catch {
      // ignore
    }
  }
  if (cur) {
    await writeManifestPatch({
      sourceIndexIds: sourceId ? existingIds.filter((x) => x !== safeId(sourceId)) : [],
    });
  }
}

export async function saveEpgToCloud(
  epgList: CloudSourceItem[],
  updateManifest = true
): Promise<string[]> {
  const cur = await readManifest();
  const prevIds = cur?.epgIds || [];
  const nextIds: string[] = [];

  for (const item of (Array.isArray(epgList) ? epgList : []).slice(0, 50)) {
    const id = safeId(item.id);
    if (!nextIds.includes(id)) nextIds.push(id);
    await upsertDoc(
      doc(db, 'epg_sources', id),
      {
        id,
        name: sReq(item.name, 120, id),
        url: sReq(item.url, 1000, 'https://example.com'),
        enabled: Boolean(item.enabled),
      },
      ['name', 'url', 'enabled']
    );
  }

  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      await deleteDoc(doc(db, 'epg_sources', oldId)).catch(() => {});
    }
  }

  if (updateManifest) {
    await writeManifestPatch({ epgIds: nextIds });
  }
  return nextIds;
}

export async function saveCatalogToCloud(
  catalog: CloudExportPayload['catalog'],
  updateManifest = true
): Promise<{ channelChunks: number; streamChunks: number }> {
  const sumRef = doc(db, 'catalog_summary', 'main');
  let prevChChunks = 0;
  let prevStChunks = 0;
  try {
    const prevSnap = await getDoc(sumRef);
    if (prevSnap.exists()) {
      prevChChunks = Number(prevSnap.data().channelChunkCount) || 0;
      prevStChunks = Number(prevSnap.data().streamChunkCount) || 0;
    }
  } catch {
    // ignore
  }

  const cleanChannels = (Array.isArray(catalog.channels) ? catalog.channels : []).map((c) => ({
    id: Number(c.id) || 0,
    code: s(c.code, 32),
    name: s(c.name, 200),
    logo: s(c.logo, 1000),
    tvg_id: s(c.tvg_id, 160),
    in_my_pl: Number(c.in_my_pl) ? 1 : 0,
    used_in: Array.isArray(c.used_in)
      ? c.used_in.map((x) => cleanPlaylistName(x)).filter(Boolean).slice(0, 50)
      : [],
    alt_names: Array.isArray(c.alt_names)
      ? c.alt_names.map((x) => s(x, 120)).filter(Boolean).slice(0, 30)
      : [],
    created_at: Number(c.created_at) || 0,
    updated_at: Number(c.updated_at) || 0,
  }));

  const cleanStreams = (Array.isArray(catalog.streams) ? catalog.streams : []).map((st) => ({
    id: Number(st.id) || 0,
    channel_id: Number(st.channel_id) || 0,
    url: s(st.url, 1500),
    source_id: st.source_id !== null && st.source_id !== undefined ? Number(st.source_id) : null,
    source_name: st.source_name ? s(st.source_name, 120) : null,
    source_type: st.source_type ? s(st.source_type, 32) : null,
    online: Number(st.online) ? 1 : 0,
    http_code: Number(st.http_code) || 0,
    response_ms: Number(st.response_ms) || 0,
    checked_at: Number(st.checked_at) || 0,
    added_at: Number(st.added_at) || 0,
  }));

  const cleanSources = (Array.isArray(catalog.sources) ? catalog.sources : []).slice(0, 100).map((cs) => {
    const out: Record<string, unknown> = {
      id: Number(cs.id) || 1,
      name: s(cs.name, 120),
      type: s(cs.type || 'm3u', 32),
      url: s(cs.url, 1000),
      enabled: Number(cs.enabled) ? 1 : 0,
      created_at: Number(cs.created_at) || 0,
    };
    if (cs.last_run !== undefined) out.last_run = Number(cs.last_run) || 0;
    if (cs.last_status !== undefined) out.last_status = s(cs.last_status, 32);
    if (cs.total_found !== undefined) out.total_found = Number(cs.total_found) || 0;
    return out;
  });

  const chChunks = chunkArray(cleanChannels, 150);
  const stChunks = chunkArray(cleanStreams, 200);

  for (let i = 0; i < chChunks.length; i++) {
    await upsertDoc(
      doc(db, 'catalog_chunks', `ch_${i}`),
      { index: i, items: chChunks[i] },
      ['index', 'items']
    );
  }
  for (let i = chChunks.length; i < prevChChunks; i++) {
    await deleteDoc(doc(db, 'catalog_chunks', `ch_${i}`)).catch(() => {});
  }

  for (let i = 0; i < stChunks.length; i++) {
    await upsertDoc(
      doc(db, 'catalog_stream_chunks', `st_${i}`),
      { index: i, items: stChunks[i] },
      ['index', 'items']
    );
  }
  for (let i = stChunks.length; i < prevStChunks; i++) {
    await deleteDoc(doc(db, 'catalog_stream_chunks', `st_${i}`)).catch(() => {});
  }

  await upsertDoc(
    sumRef,
    {
      docId: 'main',
      nextChannelId: Math.max(1, Number(catalog.nextChannelId) || 1),
      nextStreamId: Math.max(1, Number(catalog.nextStreamId) || 1),
      nextSourceId: Math.max(1, Number(catalog.nextSourceId) || 1),
      channelChunkCount: chChunks.length,
      streamChunkCount: stChunks.length,
      sources: cleanSources,
    },
    [
      'nextChannelId',
      'nextStreamId',
      'nextSourceId',
      'channelChunkCount',
      'streamChunkCount',
      'sources',
    ]
  );

  if (updateManifest) {
    await writeManifestPatch({
      catalogChannelChunks: chChunks.length,
      catalogStreamChunks: stChunks.length,
    });
  }
  return { channelChunks: chChunks.length, streamChunks: stChunks.length };
}

export async function saveStreamingSettingsToCloud(
  settings: CloudStreamingSettings
): Promise<void> {
  const allowedModes = ['auto_proxy_first', 'auto_direct_first', 'proxy_only', 'direct_only'];
  const mode = allowedModes.includes(settings.mode) ? settings.mode : 'auto_proxy_first';
  const proxyTimeoutSec = Math.max(3, Math.min(60, Math.round(Number(settings.proxyTimeoutSec) || 15)));
  await upsertDoc(
    doc(db, 'app_settings', 'streaming'),
    {
      settingId: 'streaming',
      mode,
      tryHttpsUpgrade: Boolean(settings.tryHttpsUpgrade),
      proxyTimeoutSec,
    },
    ['mode', 'tryHttpsUpgrade', 'proxyTimeoutSec']
  );
}

export async function fetchStreamingSettingsFromCloud(): Promise<CloudStreamingSettings | null> {
  try {
    const snap = await getDoc(doc(db, 'app_settings', 'streaming'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return {
      mode: (d.mode || 'auto_proxy_first') as CloudStreamingSettings['mode'],
      tryHttpsUpgrade: Boolean(d.tryHttpsUpgrade),
      proxyTimeoutSec: Number(d.proxyTimeoutSec) || 15,
    };
  } catch {
    return null;
  }
}

export async function saveLocalUserCredentialsToCloud(
  users: CloudExportPayload['users'],
  updateManifest = true
): Promise<string[]> {
  const localIds: string[] = [];
  for (const u of (Array.isArray(users) ? users : []).slice(0, 500)) {
    const id = safeId(u.id);
    if (!u.password_hash) continue;
    if (!localIds.includes(id)) localIds.push(id);
    await upsertDoc(
      doc(db, 'users', id, 'private', 'credentials'),
      {
        uid: id,
        passwordHash: s(u.password_hash, 200),
      },
      ['passwordHash']
    );
  }
  if (updateManifest) {
    await writeManifestPatch({ localUserIds: localIds });
  }
  return localIds;
}

export async function saveAdminSettingsToCloud(adminSettings?: {
  githubRepo?: string;
  githubBranch?: string;
  adminPasswordHash?: string;
}): Promise<void> {
  if (!adminSettings) return;
  if (adminSettings.githubRepo) {
    await upsertDoc(
      doc(db, 'admin_settings', 'github'),
      {
        settingId: 'github',
        githubRepo: s(adminSettings.githubRepo, 200),
        githubBranch: s(adminSettings.githubBranch || 'main', 80),
      },
      ['githubRepo', 'githubBranch']
    );
  }
  if (adminSettings.adminPasswordHash) {
    await upsertDoc(
      doc(db, 'admin_settings', 'auth'),
      {
        settingId: 'auth',
        adminPasswordHash: s(adminSettings.adminPasswordHash, 200),
      },
      ['adminPasswordHash']
    );
  }
}

export async function pushFullLocalToCloud(data: CloudExportPayload): Promise<void> {
  const plNames: string[] = [];
  for (const [rawName, channels] of Object.entries(data.playlists || {})) {
    const clean = cleanPlaylistName(rawName);
    if (!isValidPlaylistName(clean)) continue;
    plNames.push(clean);
    await savePlaylistToCloud(clean, channels, false);
  }
  plNames.sort();

  const sourceIds = await saveSourcesToCloud(data.sources || [], false);
  const sourceIndexIds = await saveSourceIndexToCloud(data.sourceIndex || {}, false);
  const epgIds = await saveEpgToCloud(data.epgSources || [], false);
  const catInfo = await saveCatalogToCloud(data.catalog, false);
  await saveStreamingSettingsToCloud(data.streamingSettings);
  await saveAdminSettingsToCloud(data.adminSettings);

  // Also ensure local users exist in /users and store their password hashes in /private/credentials
  for (const u of data.users || []) {
    const uid = safeId(u.id);
    const login = String(u.login || uid)
      .trim()
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 32)
      .padEnd(3, '0');
    const name = sReq(u.name, 80, login);
    const playlists = Array.isArray(u.playlists)
      ? u.playlists.map((p) => cleanPlaylistName(p)).filter(Boolean).slice(0, 50)
      : [];
    await upsertDoc(
      doc(db, 'users', uid),
      {
        uid,
        login,
        name,
        playlists,
        enabled: Boolean(u.enabled),
        role: 'user',
      },
      ['login', 'name', 'playlists', 'enabled', 'role']
    );
  }
  const localUserIds = await saveLocalUserCredentialsToCloud(data.users || [], false);

  await writeManifestPatch({
    playlists: plNames,
    sourceIds,
    sourceIndexIds,
    epgIds,
    localUserIds,
    catalogChannelChunks: catInfo.channelChunks,
    catalogStreamChunks: catInfo.streamChunks,
  });
}

export async function loadFullCloudSnapshot(): Promise<{
  hasCloud: boolean;
  snapshot?: Record<string, unknown>;
}> {
  const manifest = await readManifest();
  if (!manifest) {
    return { hasCloud: false };
  }

  // Playlists
  const playlists: Record<string, CloudChannelItem[]> = {};
  await Promise.all(
    manifest.playlists.map(async (plId) => {
      try {
        const metaSnap = await getDoc(doc(db, 'playlists', plId));
        if (!metaSnap.exists()) return;
        const cc = Number(metaSnap.data().chunkCount) || 0;
        const items: CloudChannelItem[] = [];
        for (let i = 0; i < cc; i++) {
          const chunkSnap = await getDoc(doc(db, 'playlists', plId, 'chunks', `c_${i}`));
          if (chunkSnap.exists() && Array.isArray(chunkSnap.data().items)) {
            items.push(...(chunkSnap.data().items as CloudChannelItem[]));
          }
        }
        playlists[plId] = items;
      } catch {
        // ignore missing
      }
    })
  );

  // Sources
  const sources: CloudSourceItem[] = [];
  await Promise.all(
    manifest.sourceIds.map(async (sid) => {
      try {
        const snap = await getDoc(doc(db, 'sources', sid));
        if (snap.exists()) {
          const d = snap.data();
          sources.push({
            id: String(d.id || sid),
            name: String(d.name || ''),
            type: String(d.type || 'm3u'),
            url: String(d.url || ''),
            enabled: Boolean(d.enabled),
          });
        }
      } catch {
        // ignore
      }
    })
  );

  // Source Indexes
  const sourceIndex: Record<string, { items: CloudIndexedItem[]; updatedAt: number }> = {};
  await Promise.all(
    manifest.sourceIndexIds.map(async (sid) => {
      try {
        const metaSnap = await getDoc(doc(db, 'source_index', sid));
        if (!metaSnap.exists()) return;
        const cc = Number(metaSnap.data().chunkCount) || 0;
        const indexedAt = Number(metaSnap.data().indexedAt) || 0;
        const items: CloudIndexedItem[] = [];
        for (let i = 0; i < cc; i++) {
          const cSnap = await getDoc(doc(db, 'source_index', sid, 'chunks', `c_${i}`));
          if (cSnap.exists() && Array.isArray(cSnap.data().items)) {
            items.push(...(cSnap.data().items as CloudIndexedItem[]));
          }
        }
        sourceIndex[sid] = { items, updatedAt: indexedAt };
      } catch {
        // ignore
      }
    })
  );

  // EPG Sources
  const epgSources: CloudSourceItem[] = [];
  await Promise.all(
    manifest.epgIds.map(async (eid) => {
      try {
        const snap = await getDoc(doc(db, 'epg_sources', eid));
        if (snap.exists()) {
          const d = snap.data();
          epgSources.push({
            id: String(d.id || eid),
            name: String(d.name || ''),
            url: String(d.url || ''),
            enabled: Boolean(d.enabled),
          });
        }
      } catch {
        // ignore
      }
    })
  );

  // Catalog
  let catalog: Record<string, unknown> | undefined;
  try {
    const sumSnap = await getDoc(doc(db, 'catalog_summary', 'main'));
    if (sumSnap.exists()) {
      const sd = sumSnap.data();
      const chCount = Number(sd.channelChunkCount) || 0;
      const stCount = Number(sd.streamChunkCount) || 0;
      const channels: unknown[] = [];
      const streams: unknown[] = [];
      for (let i = 0; i < chCount; i++) {
        const cs = await getDoc(doc(db, 'catalog_chunks', `ch_${i}`));
        if (cs.exists() && Array.isArray(cs.data().items)) {
          channels.push(...(cs.data().items as unknown[]));
        }
      }
      for (let i = 0; i < stCount; i++) {
        const ss = await getDoc(doc(db, 'catalog_stream_chunks', `st_${i}`));
        if (ss.exists() && Array.isArray(ss.data().items)) {
          streams.push(...(ss.data().items as unknown[]));
        }
      }
      catalog = {
        nextChannelId: Number(sd.nextChannelId) || 1,
        nextStreamId: Number(sd.nextStreamId) || 1,
        nextSourceId: Number(sd.nextSourceId) || 1,
        sources: Array.isArray(sd.sources) ? sd.sources : [],
        channels,
        streams,
      };
    }
  } catch {
    // ignore
  }

  // Streaming settings
  const streamingSettings = await fetchStreamingSettingsFromCloud();

  // Admin settings
  const adminSettings: Record<string, string> = {};
  try {
    const authSnap = await getDoc(doc(db, 'admin_settings', 'auth'));
    if (authSnap.exists() && typeof authSnap.data().adminPasswordHash === 'string') {
      adminSettings.adminPasswordHash = authSnap.data().adminPasswordHash;
    }
  } catch {
    // ignore
  }

  // Local users + password hashes
  const users: Array<Record<string, unknown>> = [];
  await Promise.all(
    manifest.localUserIds.map(async (uid) => {
      try {
        const [uSnap, credSnap] = await Promise.all([
          getDoc(doc(db, 'users', uid)),
          getDoc(doc(db, 'users', uid, 'private', 'credentials')),
        ]);
        if (!uSnap.exists()) return;
        const ud = uSnap.data();
        const password_hash = credSnap.exists()
          ? String(credSnap.data().passwordHash || '')
          : '';
        users.push({
          id: uid,
          login: String(ud.login || uid),
          name: String(ud.name || ud.login || uid),
          playlists: Array.isArray(ud.playlists) ? ud.playlists : [],
          enabled: Boolean(ud.enabled),
          password_hash,
        });
      } catch {
        // ignore
      }
    })
  );

  return {
    hasCloud: true,
    snapshot: {
      playlists,
      replacePlaylists: true,
      sources,
      sourceIndex,
      epgSources,
      catalog,
      streamingSettings,
      users,
      adminSettings,
    },
  };
}

export async function fetchViewerCloudState(playlistNames: string[]): Promise<{
  streaming: CloudStreamingSettings | null;
  playlists: Array<{ name: string; channels: CloudChannelItem[] }>;
}> {
  const streaming = await fetchStreamingSettingsFromCloud();
  const playlists: Array<{ name: string; channels: CloudChannelItem[] }> = [];

  await Promise.all(
    (Array.isArray(playlistNames) ? playlistNames : []).map(async (rawName) => {
      const plId = cleanPlaylistName(rawName);
      if (!isValidPlaylistName(plId)) return;
      try {
        const metaSnap = await getDoc(doc(db, 'playlists', plId));
        if (!metaSnap.exists()) return;
        const cc = Number(metaSnap.data().chunkCount) || 0;
        const items: CloudChannelItem[] = [];
        for (let i = 0; i < cc; i++) {
          const cSnap = await getDoc(doc(db, 'playlists', plId, 'chunks', `c_${i}`));
          if (cSnap.exists() && Array.isArray(cSnap.data().items)) {
            items.push(...(cSnap.data().items as CloudChannelItem[]));
          }
        }
        playlists.push({ name: plId, channels: items });
      } catch {
        // Viewer lacks access or doc missing
      }
    })
  );

  return { streaming, playlists };
}
