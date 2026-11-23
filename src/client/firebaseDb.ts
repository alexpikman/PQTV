import {
  collection,
  deleteDoc,
  doc,
  DocumentReference,
  getDoc,
  getDocs,
  serverTimestamp,
  runTransaction,
  setDoc,
  updateDoc,
  writeBatch,
} from 'firebase/firestore';
import { auth, db, handleFirestoreError, OperationType } from './firebaseApp.js';

export interface CloudChannelItem {
  name: string;
  group: string;
  logo: string;
  url: string;
  tvg_id: string;
  paused?: boolean;
  userAgent?: string;
  referer?: string;
  origin?: string;
}

export interface CloudSourceItem {
  id: string;
  catalogId?: number;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  userAgent?: string;
  referer?: string;
  origin?: string;
  timeoutSec?: number;
  ignoreTlsErrors?: boolean;
  created_at?: number;
  last_run?: number;
  last_status?: string;
  total_found?: number;
}

export interface CloudEpgSourceItem {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface CloudIndexedItem {
  name: string;
  url: string;
  logo: string;
  group: string;
  tvg_id: string;
  userAgent?: string;
  referer?: string;
  origin?: string;
}

export interface CloudStreamingSettings {
  preset?: 'vlc_smooth' | 'balanced' | 'low_latency' | 'custom';
  mode: 'auto_proxy_first' | 'auto_direct_first' | 'proxy_only' | 'direct_only';
  preferDirectOnTv?: boolean;
  tryHttpsUpgrade: boolean;
  protocolHint?: 'auto' | 'hls' | 'mpegts' | 'native';
  proxyUserAgent?: string;
  proxyFollowRedirects?: number;
  proxyTimeoutSec: number;
  proxyKeepAlive?: boolean;
  proxyMaxSockets?: number;
  proxyBufferKb?: number;
  proxyRetryCount?: number;
  hlsUseWorkers?: boolean;
  hlsLowLatency?: boolean;
  hlsLiveSyncDurationCount?: number;
  hlsMaxBufferLengthSec?: number;
  hlsMaxMaxBufferLengthSec?: number;
  hlsBackBufferLengthSec?: number;
  hlsStartFragPrefetch?: boolean;
  hlsManifestTimeoutSec?: number;
  hlsManifestMaxRetry?: number;
  hlsFragTimeoutSec?: number;
  hlsFragMaxRetry?: number;
  hlsMaxBufferHoleMs?: number;
  mpegtsUseWorker?: boolean;
  mpegtsStashBuffer?: boolean;
  mpegtsStashSizeKb?: number;
  mpegtsLiveLatencyChasing?: boolean;
  mpegtsMaxLatencySec?: number;
  mpegtsMinRemainSec?: number;
  attemptTimeoutSec?: number;
  previewEnabled?: boolean;
  previewDebounceMs?: number;
  previewResumeDelayMs?: number;
  codecCheckDelaySec?: number;
}

export interface CloudUiSettings {
  logoEnabled: boolean;
  logoOpacity: number;
  logoPulseEnabled: boolean;
  logoPulseSpeedSec: number;
  logoPosition: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  logoSizePercent: number;
}

export interface CloudApkRelease {
  id: string;
  versionCode: number;
  versionName: string;
  filename: string;
  size: number;
  sha256: string;
  changelog: string;
  mandatory: boolean;
  blocked: boolean;
  blockReason?: string;
  source?: 'github' | 'upload';
  githubRunId?: number;
  externalApkUrl?: string;
  uploadedAt: number;
}

export interface CloudApkPolicy {
  lastVersionCode: number;
  lastVersionName: string;
  minSupportedVersionCode: number;
  blockedVersionCodes: number[];
  blockMode: 'hard' | 'soft';
  blockMessage: string;
  updatedAt?: number;
}

export interface CloudApkState {
  policy: CloudApkPolicy;
  releases: CloudApkRelease[];
}

export interface CloudChannelHealthState {
  urlDiagnostics?: Record<string, Record<string, unknown>>;
  issues?: Record<string, Record<string, unknown>>;
}

export interface CloudExportPayload {
  revision?: number;
  playlists: Record<string, CloudChannelItem[]>;
  playlistMeta?: Record<string, { enabled?: boolean }>;
  sources: CloudSourceItem[];
  sourceIndex: Record<string, { items: CloudIndexedItem[]; updatedAt: number }>;
  epgSources: CloudEpgSourceItem[];
  catalog: {
    nextChannelId: number;
    nextStreamId: number;
    nextSourceId: number;
    channels: Array<Record<string, unknown>>;
    streams: Array<Record<string, unknown>>;
    sources: Array<Record<string, unknown>>;
  };
  streamingSettings: CloudStreamingSettings;
  uiSettings?: CloudUiSettings;
  apkState?: CloudApkState;
  channelHealth?: CloudChannelHealthState;
  users: Array<{
    id: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    password_hash?: string;
    created_at?: number;
  }>;
  invites?: Array<{
    id: string;
    email: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    claimed_uid?: string;
  }>;
  alerts?: Array<{
    id: string;
    userId?: string;
    userLogin: string;
    userName: string;
    totalChannels: number;
    unavailableCount: number;
    items: Array<{ name: string; group: string; reason: string }>;
    resolved: boolean;
    created_at?: number;
    updated_at?: number;
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
  payload: Record<string, unknown>,
  mutableKeys: string[]
): Promise<void> {
  const path = ref.path;
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
    const existingData = snap.data();
    const changedKeys = mutableKeys.filter(
      (key) =>
        key in payload &&
        JSON.stringify(existingData[key]) !== JSON.stringify(payload[key])
    );
    if (changedKeys.length === 0) return;

    const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
    for (const key of changedKeys) {
      patch[key] = payload[key];
    }
    try {
      await updateDoc(ref, patch);
    } catch (err) {
      handleFirestoreError(err, OperationType.UPDATE, path);
    }
  }
}

interface CloudBatchUpsertEntry {
  ref: DocumentReference;
  payload: Record<string, unknown>;
  mutableKeys: string[];
}

async function batchUpsertDocs(
  entries: CloudBatchUpsertEntry[],
  operationPath: string
): Promise<void> {
  if (entries.length > 500) {
    throw new Error(`Firestore batch limit exceeded for ${operationPath}: ${entries.length} writes`);
  }
  if (entries.length === 0) return;

  const snapshots = await Promise.all(entries.map(async (entry) => {
    try {
      return await getDoc(entry.ref);
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, entry.ref.path);
    }
  }));

  const batch = writeBatch(db);
  let writeCount = 0;
  entries.forEach((entry, index) => {
    const snap = snapshots[index];
    if (!snap.exists()) {
      batch.set(entry.ref, {
        ...entry.payload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      writeCount++;
      return;
    }

    const existing = snap.data();
    const hasChanges = entry.mutableKeys.some((key) =>
      key in entry.payload && JSON.stringify(existing[key]) !== JSON.stringify(entry.payload[key])
    );
    if (!hasChanges) return;

    batch.set(entry.ref, {
      ...entry.payload,
      createdAt: existing.createdAt,
      updatedAt: serverTimestamp(),
    });
    writeCount++;
  });

  if (writeCount === 0) return;
  try {
    await batch.commit();
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, operationPath);
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
  revision?: number;
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
      revision: typeof d.revision === 'number' ? d.revision : undefined,
    };
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, 'cloud_meta/manifest');
    return null;
  }
}

async function writeManifestPatch(patch: Partial<{
  playlists: string[]; sourceIds: string[]; sourceIndexIds: string[]; epgIds: string[];
  localUserIds: string[]; catalogChannelChunks: number; catalogStreamChunks: number; revision: number;
}>): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid) throw new Error('Для записи cloud_meta/manifest требуется авторизация администратора');
  const ref = doc(db, 'cloud_meta', 'manifest');
  try {
    await runTransaction(db, async (transaction) => {
      const snap = await transaction.get(ref);
      const current = snap.exists() ? snap.data() : {};
      const nextRevision = patch.revision !== undefined
        ? Math.max(0, Math.floor(Number(patch.revision) || 0))
        : typeof current.revision === 'number' ? current.revision : undefined;
      const merged: Record<string, unknown> = {
        docId: 'manifest',
        playlists: (patch.playlists ?? (Array.isArray(current.playlists) ? current.playlists as string[] : [])).slice(0, 100),
        sourceIds: (patch.sourceIds ?? (Array.isArray(current.sourceIds) ? current.sourceIds as string[] : [])).slice(0, 100),
        sourceIndexIds: (patch.sourceIndexIds ?? (Array.isArray(current.sourceIndexIds) ? current.sourceIndexIds as string[] : [])).slice(0, 100),
        epgIds: (patch.epgIds ?? (Array.isArray(current.epgIds) ? current.epgIds as string[] : [])).slice(0, 50),
        localUserIds: (patch.localUserIds ?? (Array.isArray(current.localUserIds) ? current.localUserIds as string[] : [])).slice(0, 500),
        catalogChannelChunks: patch.catalogChannelChunks ?? (Number(current.catalogChannelChunks) || 0),
        catalogStreamChunks: patch.catalogStreamChunks ?? (Number(current.catalogStreamChunks) || 0),
        updatedByUid: uid,
        createdAt: snap.exists() ? current.createdAt : serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      if (nextRevision !== undefined) merged.revision = nextRevision;
      transaction.set(ref, merged);
    });
  } catch (err) {
    handleFirestoreError(err, OperationType.WRITE, 'cloud_meta/manifest');
  }
}

export async function getCloudManifestStatus(): Promise<{
  exists: boolean;
  revision: number | null;
  playlists: string[];
  localUserIds: string[];
}> {
  const cur = await readManifest().catch(() => null);
  if (!cur) {
    return { exists: false, revision: null, playlists: [], localUserIds: [] };
  }
  return {
    exists: true,
    revision: typeof cur.revision === 'number' ? cur.revision : null,
    playlists: cur.playlists,
    localUserIds: cur.localUserIds,
  };
}

export async function bumpCloudManifestRevision(
  revision: number,
  extra?: {
    addLocalUserId?: string;
    removeLocalUserId?: string;
    playlists?: string[];
    sourceIds?: string[];
    sourceIndexIds?: string[];
    catalogChannelChunks?: number;
    catalogStreamChunks?: number;
  }
): Promise<boolean> {
  const uid = auth.currentUser?.uid;
  if (!uid) return false;
  const cur = await readManifest().catch(() => null);
  if (!cur) return false;

  const cleanRev = Math.max(0, Math.floor(Number(revision) || 0));
  const nextRevision = Math.max(cur.revision ?? 0, cleanRev);

  let localUserIds = [...cur.localUserIds];
  if (extra?.addLocalUserId) {
    const addId = safeId(extra.addLocalUserId);
    if (!localUserIds.includes(addId)) localUserIds.push(addId);
  }
  if (extra?.removeLocalUserId) {
    const remId = safeId(extra.removeLocalUserId);
    localUserIds = localUserIds.filter((id) => id !== remId);
  }

  const patch: Parameters<typeof writeManifestPatch>[0] = {
    revision: nextRevision,
    ...(extra?.addLocalUserId || extra?.removeLocalUserId ? { localUserIds } : {}),
    ...(Array.isArray(extra?.playlists)
      ? {
          playlists: extra.playlists
            .map((p) => cleanPlaylistName(p))
            .filter(isValidPlaylistName)
            .sort(),
        }
      : {}),
    ...(Array.isArray(extra?.sourceIds) ? { sourceIds: extra.sourceIds } : {}),
    ...(Array.isArray(extra?.sourceIndexIds) ? { sourceIndexIds: extra.sourceIndexIds } : {}),
    ...(typeof extra?.catalogChannelChunks === 'number'
      ? { catalogChannelChunks: Math.max(0, Math.floor(extra.catalogChannelChunks)) }
      : {}),
    ...(typeof extra?.catalogStreamChunks === 'number'
      ? { catalogStreamChunks: Math.max(0, Math.floor(extra.catalogStreamChunks)) }
      : {}),
  };

  await writeManifestPatch(patch);
  return true;
}

function normalizeChannelItem(raw: Partial<CloudChannelItem>): CloudChannelItem {
  const out: CloudChannelItem = {
    name: s(raw.name, 200),
    group: s(raw.group, 120),
    logo: s(raw.logo, 1000),
    url: s(raw.url, 1500),
    tvg_id: s(raw.tvg_id, 160),
  };
  if (raw.paused) out.paused = true;
  const ua = s(raw.userAgent, 400).trim();
  const ref = s(raw.referer, 500).trim();
  const orig = s(raw.origin, 300).trim();
  if (ua) out.userAgent = ua;
  if (ref) out.referer = ref;
  if (orig) out.origin = orig;
  return out;
}

export async function savePlaylistToCloud(
  rawName: string,
  channels: Array<Partial<CloudChannelItem>>,
  updateManifest = true,
  enabled = true
): Promise<void> {
  const plId = cleanPlaylistName(rawName);
  if (!isValidPlaylistName(plId)) throw new Error('Некорректное имя плейлиста');

  const cleanItems = (Array.isArray(channels) ? channels : [])
    .slice(0, 50000)
    .map(normalizeChannelItem);
  const chunks = chunkArray(cleanItems, 200);
  if (chunks.length > 300) throw new Error(`Слишком много частей плейлиста ${plId}`);

  const metaRef = doc(db, 'playlists', plId);
  let prevChunks = 0;
  try {
    const prevSnap = await getDoc(metaRef);
    if (prevSnap.exists()) prevChunks = Number(prevSnap.data().chunkCount) || 0;
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, metaRef.path);
  }

  const writes: CloudBatchUpsertEntry[] = chunks.map((items, index) => ({
    ref: doc(db, 'playlists', plId, 'chunks', `c_${index}`),
    payload: { playlistId: plId, index, items },
    mutableKeys: ['index', 'items'],
  }));
  writes.push({
    ref: metaRef,
    payload: {
      id: plId,
      name: plId,
      channelCount: cleanItems.length,
      chunkCount: chunks.length,
      enabled: Boolean(enabled),
    },
    mutableKeys: ['name', 'channelCount', 'chunkCount', 'enabled'],
  });
  await batchUpsertDocs(writes, `playlists/${plId}`);

  if (prevChunks > chunks.length) {
    await Promise.all(
      Array.from({ length: prevChunks - chunks.length }, (_, index) =>
        deleteDoc(doc(db, 'playlists', plId, 'chunks', `c_${chunks.length + index}`))
          .catch((err) => console.warn('Obsolete playlist chunk cleanup failed:', err))
      )
    );
  }

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
  const writes: CloudBatchUpsertEntry[] = [];

  for (const src of (Array.isArray(sources) ? sources : []).slice(0, 100)) {
    const id = safeId(src.id);
    if (!nextIds.includes(id)) nextIds.push(id);
    const timeoutSec = Math.max(3, Math.min(60, Math.round(Number(src.timeoutSec) || 15)));
    writes.push({
      ref: doc(db, 'sources', id),
      payload: {
        id,
        name: sReq(src.name, 120, id),
        type: sReq(src.type, 32, 'm3u'),
        url: sReq(src.url, 1000, 'https://example.com'),
        enabled: Boolean(src.enabled),
        userAgent: s(src.userAgent, 400),
        referer: s(src.referer, 500),
        origin: s(src.origin, 300),
        timeoutSec,
        ignoreTlsErrors: Boolean(src.ignoreTlsErrors),
      },
      mutableKeys: [
        'name', 'type', 'url', 'enabled', 'userAgent', 'referer', 'origin',
        'timeoutSec', 'ignoreTlsErrors',
      ],
    });
  }

  await batchUpsertDocs(writes, 'sources');
  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      await deleteDoc(doc(db, 'sources', oldId)).catch((err) => {
        console.warn('Obsolete source cleanup failed:', err);
      });
    }
  }

  if (updateManifest) await writeManifestPatch({ sourceIds: nextIds });
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

    const cleanItems = entry.items.slice(0, 100000).map((it) => {
      const item: CloudIndexedItem = {
        name: s(it.name, 200),
        url: s(it.url, 1500),
        logo: s(it.logo, 1000),
        group: s(it.group, 120),
        tvg_id: s(it.tvg_id, 160),
      };
      const ua = s(it.userAgent, 400).trim();
      const ref = s(it.referer, 500).trim();
      const orig = s(it.origin, 300).trim();
      if (ua) item.userAgent = ua;
      if (ref) item.referer = ref;
      if (orig) item.origin = orig;
      return item;
    });
    const chunks = chunkArray(cleanItems, 250);
    const metaRef = doc(db, 'source_index', sourceId);
    let prevChunks = 0;
    try {
      const snap = await getDoc(metaRef);
      if (snap.exists()) prevChunks = Number(snap.data().chunkCount) || 0;
    } catch (err) {
      handleFirestoreError(err, OperationType.GET, metaRef.path);
    }

    const writes: CloudBatchUpsertEntry[] = chunks.map((items, index) => ({
      ref: doc(db, 'source_index', sourceId, 'chunks', `c_${index}`),
      payload: { sourceId, index, items },
      mutableKeys: ['index', 'items'],
    }));
    writes.push({
      ref: metaRef,
      payload: {
        sourceId,
        count: cleanItems.length,
        chunkCount: chunks.length,
        indexedAt: Math.max(0, Math.floor(Number(entry.updatedAt) || 0)),
      },
      mutableKeys: ['count', 'chunkCount', 'indexedAt'],
    });
    await batchUpsertDocs(writes, `source_index/${sourceId}`);

    if (prevChunks > chunks.length) {
      await Promise.all(
        Array.from({ length: prevChunks - chunks.length }, (_, index) =>
          deleteDoc(doc(db, 'source_index', sourceId, 'chunks', `c_${chunks.length + index}`))
            .catch((err) => console.warn('Obsolete source-index chunk cleanup failed:', err))
        )
      );
    }
  }

  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      const metaRef = doc(db, 'source_index', oldId);
      const snap = await getDoc(metaRef);
      if (snap.exists()) {
        const count = Number(snap.data().chunkCount) || 0;
        await Promise.all(
          Array.from({ length: count }, (_, index) =>
            deleteDoc(doc(db, 'source_index', oldId, 'chunks', `c_${index}`))
          )
        );
        await deleteDoc(metaRef);
      }
    }
  }

  if (updateManifest) await writeManifestPatch({ sourceIndexIds: nextIds });
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
  epgList: CloudEpgSourceItem[],
  updateManifest = true
): Promise<string[]> {
  const cur = await readManifest();
  const prevIds = cur?.epgIds || [];
  const nextIds: string[] = [];
  const writes: CloudBatchUpsertEntry[] = [];

  for (const item of (Array.isArray(epgList) ? epgList : []).slice(0, 50)) {
    const id = safeId(item.id);
    if (!nextIds.includes(id)) nextIds.push(id);
    writes.push({
      ref: doc(db, 'epg_sources', id),
      payload: {
        id,
        name: sReq(item.name, 120, id),
        url: sReq(item.url, 1000, 'https://example.com'),
        enabled: Boolean(item.enabled),
      },
      mutableKeys: ['name', 'url', 'enabled'],
    });
  }

  await batchUpsertDocs(writes, 'epg_sources');
  for (const oldId of prevIds) {
    if (!nextIds.includes(oldId)) {
      await deleteDoc(doc(db, 'epg_sources', oldId)).catch((err) => {
        console.warn('Obsolete EPG source cleanup failed:', err);
      });
    }
  }

  if (updateManifest) await writeManifestPatch({ epgIds: nextIds });
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
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, sumRef.path);
  }

  const cleanChannels = (Array.isArray(catalog.channels) ? catalog.channels : []).map((c) => ({
    id: Math.max(1, Math.floor(Number(c.id) || 1)),
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
    created_at: Math.max(0, Math.floor(Number(c.created_at) || 0)),
    updated_at: Math.max(0, Math.floor(Number(c.updated_at) || 0)),
  }));

  const cleanStreams = (Array.isArray(catalog.streams) ? catalog.streams : []).map((st) => {
    const out: Record<string, unknown> = {
      id: Math.max(1, Math.floor(Number(st.id) || 1)),
      channel_id: Math.max(1, Math.floor(Number(st.channel_id) || 1)),
      url: s(st.url, 1500),
      source_id: st.source_id !== null && st.source_id !== undefined ? Math.floor(Number(st.source_id)) : null,
      source_name: st.source_name ? s(st.source_name, 120) : null,
      source_type: st.source_type ? s(st.source_type, 32) : null,
      online: Number(st.online) === 1 ? 1 : Number(st.online) === -1 ? -1 : 0,
      http_code: Math.max(0, Math.floor(Number(st.http_code) || 0)),
      response_ms: Math.max(0, Math.floor(Number(st.response_ms) || 0)),
      checked_at: Math.max(0, Math.floor(Number(st.checked_at) || 0)),
      added_at: Math.max(0, Math.floor(Number(st.added_at) || 0)),
    };
    if (st.diag_code) out.diag_code = s(st.diag_code, 32);
    if (st.diag_reason) out.diag_reason = s(st.diag_reason, 220);
    if (st.codec_warning) out.codec_warning = s(st.codec_warning, 220);
    return out;
  });

  const cleanSources = (Array.isArray(catalog.sources) ? catalog.sources : []).slice(0, 100).map((cs) => {
    const out: Record<string, unknown> = {
      id: Math.max(1, Math.floor(Number(cs.id) || 1)),
      name: s(cs.name, 120),
      type: s(cs.type || 'm3u', 32),
      url: s(cs.url, 1000),
      enabled: Number(cs.enabled) ? 1 : 0,
      created_at: Math.max(0, Math.floor(Number(cs.created_at) || 0)),
    };
    if (cs.stringId) out.stringId = s(cs.stringId, 64);
    if (cs.last_run !== undefined) out.last_run = Math.max(0, Math.floor(Number(cs.last_run) || 0));
    if (cs.last_status !== undefined) out.last_status = s(cs.last_status, 32);
    if (cs.total_found !== undefined) out.total_found = Math.max(0, Math.floor(Number(cs.total_found) || 0));
    return out;
  });

  const chChunks = chunkArray(cleanChannels, 200);
  const stChunks = chunkArray(cleanStreams, 250);
  if (chChunks.length > 500 || stChunks.length > 500) {
    throw new Error('Каталог превышает лимиты хранения Firestore');
  }

  const channelWrites: CloudBatchUpsertEntry[] = chChunks.map((items, index) => ({
    ref: doc(db, 'catalog_chunks', `ch_${index}`),
    payload: { index, items },
    mutableKeys: ['index', 'items'],
  }));
  await batchUpsertDocs(channelWrites, 'catalog_chunks');

  const streamWrites: CloudBatchUpsertEntry[] = stChunks.map((items, index) => ({
    ref: doc(db, 'catalog_stream_chunks', `st_${index}`),
    payload: { index, items },
    mutableKeys: ['index', 'items'],
  }));
  await batchUpsertDocs(streamWrites, 'catalog_stream_chunks');
  await batchUpsertDocs([{
    ref: sumRef,
    payload: {
      docId: 'main',
      nextChannelId: Math.max(1, Number(catalog.nextChannelId) || 1),
      nextStreamId: Math.max(1, Number(catalog.nextStreamId) || 1),
      nextSourceId: Math.max(1, Number(catalog.nextSourceId) || 1),
      channelChunkCount: chChunks.length,
      streamChunkCount: stChunks.length,
      sources: cleanSources,
    },
    mutableKeys: [
      'nextChannelId',
      'nextStreamId',
      'nextSourceId',
      'channelChunkCount',
      'streamChunkCount',
      'sources',
    ],
  }], 'catalog_summary/main');

  if (prevChChunks > chChunks.length) {
    await Promise.all(
      Array.from({ length: prevChChunks - chChunks.length }, (_, index) =>
        deleteDoc(doc(db, 'catalog_chunks', `ch_${chChunks.length + index}`))
          .catch((err) => console.warn('Obsolete catalog channel chunk cleanup failed:', err))
      )
    );
  }
  if (prevStChunks > stChunks.length) {
    await Promise.all(
      Array.from({ length: prevStChunks - stChunks.length }, (_, index) =>
        deleteDoc(doc(db, 'catalog_stream_chunks', `st_${stChunks.length + index}`))
          .catch((err) => console.warn('Obsolete catalog stream chunk cleanup failed:', err))
      )
    );
  }

  if (updateManifest) {
    await writeManifestPatch({
      catalogChannelChunks: chChunks.length,
      catalogStreamChunks: stChunks.length,
    });
  }
  return { channelChunks: chChunks.length, streamChunks: stChunks.length };
}

export async function loadCatalogFromCloud(): Promise<{
  exists: boolean;
  revision?: number | null;
  sources?: CloudSourceItem[];
  catalog?: CloudExportPayload['catalog'];
}> {
  const sumRef = doc(db, 'catalog_summary', 'main');
  let sumSnap;
  try {
    sumSnap = await getDoc(sumRef);
  } catch (err) {
    handleFirestoreError(err, OperationType.GET, sumRef.path);
  }
  if (!sumSnap.exists()) {
    return { exists: false };
  }

  const sd = sumSnap.data();
  const chCount = Math.max(0, Math.min(500, Number(sd.channelChunkCount) || 0));
  const stCount = Math.max(0, Math.min(500, Number(sd.streamChunkCount) || 0));

  const [manifest, channelSnaps, streamSnaps] = await Promise.all([
    readManifest().catch(() => null),
    Promise.all(
      Array.from({ length: chCount }, async (_, index) => {
        const ref = doc(db, 'catalog_chunks', `ch_${index}`);
        try {
          return await getDoc(ref);
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, ref.path);
        }
      })
    ),
    Promise.all(
      Array.from({ length: stCount }, async (_, index) => {
        const ref = doc(db, 'catalog_stream_chunks', `st_${index}`);
        try {
          return await getDoc(ref);
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, ref.path);
        }
      })
    ),
  ]);

  const channels: Array<Record<string, unknown>> = [];
  for (const snap of channelSnaps) {
    if (snap.exists() && Array.isArray(snap.data().items)) {
      channels.push(...(snap.data().items as Array<Record<string, unknown>>));
    }
  }

  const streams: Array<Record<string, unknown>> = [];
  for (const snap of streamSnaps) {
    if (snap.exists() && Array.isArray(snap.data().items)) {
      streams.push(...(snap.data().items as Array<Record<string, unknown>>));
    }
  }

  const catalogSources = Array.isArray(sd.sources) ? (sd.sources as Array<Record<string, unknown>>) : [];
  const catByStringId = new Map<string, Record<string, unknown>>();
  const catByUrl = new Map<string, Record<string, unknown>>();
  for (const cs of catalogSources) {
    if (typeof cs.stringId === 'string' && cs.stringId) catByStringId.set(cs.stringId, cs);
    if (typeof cs.url === 'string' && cs.url) catByUrl.set(cs.url, cs);
  }

  let sources: CloudSourceItem[] | undefined;
  if (manifest && Array.isArray(manifest.sourceIds)) {
    const loadedSources: CloudSourceItem[] = [];
    await Promise.all(
      manifest.sourceIds.map(async (sid) => {
        const ref = doc(db, 'sources', sid);
        try {
          const snap = await getDoc(ref);
          if (snap.exists()) {
            const d = snap.data();
            const sourceId = String(d.id || sid);
            const url = String(d.url || '');
            const matchedCat = catByStringId.get(sourceId) || catByUrl.get(url);
            const item: CloudSourceItem = {
              id: sourceId,
              name: String(d.name || ''),
              type: String(d.type || 'm3u'),
              url,
              enabled: Boolean(d.enabled),
            };
            if (matchedCat) {
              const catNum = Number(matchedCat.id);
              if (Number.isInteger(catNum) && catNum > 0) item.catalogId = catNum;
              if (typeof matchedCat.created_at === 'number' && matchedCat.created_at > 0) item.created_at = matchedCat.created_at;
              if (typeof matchedCat.last_run === 'number' && matchedCat.last_run > 0) item.last_run = matchedCat.last_run;
              if (typeof matchedCat.last_status === 'string' && matchedCat.last_status) item.last_status = matchedCat.last_status;
              if (typeof matchedCat.total_found === 'number' && matchedCat.total_found >= 0) item.total_found = matchedCat.total_found;
            }
            if (typeof d.userAgent === 'string' && d.userAgent) item.userAgent = d.userAgent;
            if (typeof d.referer === 'string' && d.referer) item.referer = d.referer;
            if (typeof d.origin === 'string' && d.origin) item.origin = d.origin;
            if (typeof d.timeoutSec === 'number' && d.timeoutSec > 0) item.timeoutSec = d.timeoutSec;
            if (typeof d.ignoreTlsErrors === 'boolean') item.ignoreTlsErrors = d.ignoreTlsErrors;
            loadedSources.push(item);
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, ref.path);
        }
      })
    );
    sources = loadedSources;
  }

  return {
    exists: true,
    revision: manifest?.revision ?? null,
    ...(sources ? { sources } : {}),
    catalog: {
      nextChannelId: Math.max(1, Number(sd.nextChannelId) || 1),
      nextStreamId: Math.max(1, Number(sd.nextStreamId) || 1),
      nextSourceId: Math.max(1, Number(sd.nextSourceId) || 1),
      sources: catalogSources,
      channels,
      streams,
    },
  };
}

function clampCloudInt(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : def;
}

function clampCloudFloat(v: unknown, def: number, min: number, max: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(Math.max(min, Math.min(max, n)) * 10) / 10 : def;
}

function normalizeCloudStreamingSettings(raw?: Partial<CloudStreamingSettings> | Record<string, unknown> | null): Required<CloudStreamingSettings> {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const allowedModes = ['auto_proxy_first', 'auto_direct_first', 'proxy_only', 'direct_only'];
  const allowedPresets = ['vlc_smooth', 'balanced', 'low_latency', 'custom'];
  const allowedProtos = ['auto', 'hls', 'mpegts', 'native'];

  const preset = allowedPresets.includes(String(obj.preset || ''))
    ? (String(obj.preset) as Required<CloudStreamingSettings>['preset'])
    : 'vlc_smooth';
  const mode = allowedModes.includes(String(obj.mode || ''))
    ? (String(obj.mode) as CloudStreamingSettings['mode'])
    : 'auto_proxy_first';
  const protocolHint = allowedProtos.includes(String(obj.protocolHint || ''))
    ? (String(obj.protocolHint) as Required<CloudStreamingSettings>['protocolHint'])
    : 'auto';

  const hlsMaxBufferLengthSec = clampCloudInt(obj.hlsMaxBufferLengthSec, 45, 5, 180);
  const hlsMaxMaxBufferLengthSec = Math.max(
    hlsMaxBufferLengthSec,
    clampCloudInt(obj.hlsMaxMaxBufferLengthSec, 90, 10, 360)
  );
  const mpegtsMinRemainSec = clampCloudFloat(obj.mpegtsMinRemainSec, 1.5, 0.5, 10);
  const mpegtsMaxLatencySec = Math.max(
    mpegtsMinRemainSec + 0.5,
    clampCloudFloat(obj.mpegtsMaxLatencySec, 5, 1, 20)
  );
  const rawUa = typeof obj.proxyUserAgent === 'string' ? obj.proxyUserAgent.trim() : '';

  return {
    preset,
    mode,
    preferDirectOnTv: obj.preferDirectOnTv !== undefined ? Boolean(obj.preferDirectOnTv) : true,
    tryHttpsUpgrade: obj.tryHttpsUpgrade !== undefined ? Boolean(obj.tryHttpsUpgrade) : true,
    protocolHint,
    proxyUserAgent: (rawUa || 'VLC/3.0.20 LibVLC/3.0.20').replace(/[\r\n]/g, '').slice(0, 240),
    proxyFollowRedirects: clampCloudInt(obj.proxyFollowRedirects, 5, 0, 10),
    proxyTimeoutSec: clampCloudInt(obj.proxyTimeoutSec, 15, 3, 60),
    proxyKeepAlive: obj.proxyKeepAlive !== undefined ? Boolean(obj.proxyKeepAlive) : true,
    proxyMaxSockets: clampCloudInt(obj.proxyMaxSockets, 64, 4, 200),
    proxyBufferKb: clampCloudInt(obj.proxyBufferKb, 128, 16, 1024),
    proxyRetryCount: clampCloudInt(obj.proxyRetryCount, 2, 0, 5),
    hlsUseWorkers: obj.hlsUseWorkers !== undefined ? Boolean(obj.hlsUseWorkers) : true,
    hlsLowLatency: obj.hlsLowLatency !== undefined ? Boolean(obj.hlsLowLatency) : false,
    hlsLiveSyncDurationCount: clampCloudInt(obj.hlsLiveSyncDurationCount, 4, 1, 12),
    hlsMaxBufferLengthSec,
    hlsMaxMaxBufferLengthSec,
    hlsBackBufferLengthSec: clampCloudInt(obj.hlsBackBufferLengthSec, 15, 0, 120),
    hlsStartFragPrefetch: obj.hlsStartFragPrefetch !== undefined ? Boolean(obj.hlsStartFragPrefetch) : true,
    hlsManifestTimeoutSec: clampCloudInt(obj.hlsManifestTimeoutSec, 12, 3, 60),
    hlsManifestMaxRetry: clampCloudInt(obj.hlsManifestMaxRetry, 3, 0, 10),
    hlsFragTimeoutSec: clampCloudInt(obj.hlsFragTimeoutSec, 25, 5, 60),
    hlsFragMaxRetry: clampCloudInt(obj.hlsFragMaxRetry, 4, 0, 10),
    hlsMaxBufferHoleMs: clampCloudInt(obj.hlsMaxBufferHoleMs, 500, 100, 5000),
    mpegtsUseWorker: obj.mpegtsUseWorker !== undefined ? Boolean(obj.mpegtsUseWorker) : true,
    mpegtsStashBuffer: obj.mpegtsStashBuffer !== undefined ? Boolean(obj.mpegtsStashBuffer) : true,
    mpegtsStashSizeKb: clampCloudInt(obj.mpegtsStashSizeKb, 512, 64, 2048),
    mpegtsLiveLatencyChasing: obj.mpegtsLiveLatencyChasing !== undefined ? Boolean(obj.mpegtsLiveLatencyChasing) : false,
    mpegtsMaxLatencySec,
    mpegtsMinRemainSec,
    attemptTimeoutSec: clampCloudInt(obj.attemptTimeoutSec, 15, 4, 60),
    previewEnabled: obj.previewEnabled !== undefined ? Boolean(obj.previewEnabled) : true,
    previewDebounceMs: clampCloudInt(obj.previewDebounceMs, 450, 0, 3000),
    previewResumeDelayMs: clampCloudInt(obj.previewResumeDelayMs, 350, 0, 3000),
    codecCheckDelaySec: clampCloudInt(obj.codecCheckDelaySec, 8, 0, 30),
  };
}

export async function saveStreamingSettingsToCloud(
  settings: CloudStreamingSettings
): Promise<void> {
  const norm = normalizeCloudStreamingSettings(settings);
  await upsertDoc(
    doc(db, 'app_settings', 'streaming'),
    {
      settingId: 'streaming',
      ...norm,
    },
    Object.keys(norm)
  );
}

export async function fetchStreamingSettingsFromCloud(): Promise<CloudStreamingSettings | null> {
  try {
    const snap = await getDoc(doc(db, 'app_settings', 'streaming'));
    if (!snap.exists()) return null;
    return normalizeCloudStreamingSettings(snap.data());
  } catch {
    return null;
  }
}

export async function saveUiSettingsToCloud(
  settings?: Partial<CloudUiSettings>
): Promise<void> {
  if (!settings || typeof settings !== 'object') return;
  const logoEnabled = settings.logoEnabled !== undefined ? Boolean(settings.logoEnabled) : true;
  const opacityRaw = Number(settings.logoOpacity);
  const logoOpacity = Number.isFinite(opacityRaw)
    ? Math.max(0, Math.min(100, Math.round(opacityRaw)))
    : 40;
  const logoPulseEnabled = settings.logoPulseEnabled !== undefined ? Boolean(settings.logoPulseEnabled) : false;
  const speedRaw = Number(settings.logoPulseSpeedSec);
  const logoPulseSpeedSec = Number.isFinite(speedRaw)
    ? Math.max(0, Math.min(10, Math.round(speedRaw * 10) / 10))
    : 3;
  const validLogoPositions = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
  const logoPosition = validLogoPositions.includes(settings.logoPosition as (typeof validLogoPositions)[number])
    ? (settings.logoPosition as (typeof validLogoPositions)[number])
    : 'bottom-left';
  const sizeRaw = Number(settings.logoSizePercent);
  const logoSizePercent = Number.isFinite(sizeRaw)
    ? Math.max(50, Math.min(200, Math.round(sizeRaw / 5) * 5))
    : 100;
  await upsertDoc(
    doc(db, 'app_settings', 'ui'),
    {
      settingId: 'ui',
      logoEnabled,
      logoOpacity,
      logoPulseEnabled,
      logoPulseSpeedSec,
      logoPosition,
      logoSizePercent,
    },
    ['logoEnabled', 'logoOpacity', 'logoPulseEnabled', 'logoPulseSpeedSec', 'logoPosition', 'logoSizePercent']
  );
}

export async function fetchUiSettingsFromCloud(): Promise<CloudUiSettings | null> {
  try {
    const snap = await getDoc(doc(db, 'app_settings', 'ui'));
    if (!snap.exists()) return null;
    const d = snap.data();
    const opacityRaw = Number(d.logoOpacity);
    const speedRaw = Number(d.logoPulseSpeedSec);
    const validLogoPositions = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
    const logoPosition = validLogoPositions.includes(d.logoPosition as (typeof validLogoPositions)[number])
      ? (d.logoPosition as (typeof validLogoPositions)[number])
      : 'bottom-left';
    const sizeRaw = Number(d.logoSizePercent);
    const logoSizePercent = Number.isFinite(sizeRaw)
      ? Math.max(50, Math.min(200, Math.round(sizeRaw / 5) * 5))
      : 100;
    return {
      logoEnabled: d.logoEnabled !== undefined ? Boolean(d.logoEnabled) : true,
      logoOpacity: Number.isFinite(opacityRaw) ? Math.max(0, Math.min(100, Math.round(opacityRaw))) : 40,
      logoPulseEnabled: d.logoPulseEnabled !== undefined ? Boolean(d.logoPulseEnabled) : false,
      logoPulseSpeedSec: Number.isFinite(speedRaw) ? Math.max(0, Math.min(10, Math.round(speedRaw * 10) / 10)) : 3,
      logoPosition,
      logoSizePercent,
    };
  } catch {
    return null;
  }
}

export interface CloudCategory { id: string; name: string; }

export async function listCategoriesFromCloud(): Promise<CloudCategory[]> {
  try {
    const snapshot = await getDocs(collection(db, 'categories'));
    return snapshot.docs.map((item) => ({ id: item.id, name: String(item.data().name || '').trim() }))
      .filter((item) => item.id.length > 0 && item.name.length > 0)
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'categories');
  }
}

export async function createCategoryInCloud(rawName: string): Promise<CloudCategory> {
  const uid = auth.currentUser?.uid;
  const name = String(rawName || '').trim();
  if (!uid) throw new Error('Для управления категориями требуется авторизация администратора');
  if (!name || name.length > 80) throw new Error('Название категории должно содержать от 1 до 80 символов');
  const categories = await listCategoriesFromCloud();
  if (categories.some((item) => item.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) {
    throw new Error('Категория с таким названием уже существует');
  }
  const id = safeId(`cat_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`);
  try {
    await setDoc(doc(db, 'categories', id), {
      id, name, createdByUid: uid, updatedByUid: uid,
      createdAt: serverTimestamp(), updatedAt: serverTimestamp(),
    });
    return { id, name };
  } catch (err) {
    handleFirestoreError(err, OperationType.CREATE, `categories/${id}`);
  }
}

export async function deleteCategoryFromCloud(categoryId: string): Promise<void> {
  const id = safeId(categoryId);
  if (!auth.currentUser?.uid || !id.startsWith('cat_')) throw new Error('Некорректная категория или отсутствует авторизация администратора');
  try {
    await deleteDoc(doc(db, 'categories', id));
  } catch (err) {
    handleFirestoreError(err, OperationType.DELETE, `categories/${id}`);
  }
}

const DEFAULT_APK_BLOCK_MSG =
  'Эта версия приложения устарела и заблокирована администратором. Пожалуйста, установите обновление.';

function normalizeCloudApkState(raw?: Partial<CloudApkState> | Record<string, unknown> | null): CloudApkState {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const rawPol = (src.policy && typeof src.policy === 'object' ? src.policy : src) as Record<string, unknown>;
  const rawReleases = Array.isArray(src.releases) ? src.releases : [];

  const cleanReleases: CloudApkRelease[] = [];
  for (const item of rawReleases.slice(0, 15)) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    const versionCode = Math.max(1, Math.min(1000000, Math.floor(Number(r.versionCode) || 1)));
    const versionName = sReq(r.versionName, 32, `1.0.${versionCode}`);
    const id = sReq(r.id, 80, `v${versionName}-c${versionCode}`);
    const filename = sReq(r.filename, 160, `pqtv-v${versionName}-c${versionCode}.apk`);
    const clean: CloudApkRelease = {
      id,
      versionCode,
      versionName,
      filename,
      size: Math.max(0, Math.floor(Number(r.size) || 0)),
      sha256: s(r.sha256, 128),
      changelog: s(r.changelog, 1000),
      mandatory: Boolean(r.mandatory),
      blocked: Boolean(r.blocked),
      uploadedAt: Math.max(0, Math.floor(Number(r.uploadedAt) || 0)),
    };
    const blockReason = s(r.blockReason, 300).trim();
    if (blockReason) clean.blockReason = blockReason;
    if (r.source === 'github' || r.source === 'upload') clean.source = r.source;
    const runId = Math.floor(Number(r.githubRunId) || 0);
    if (runId > 0) clean.githubRunId = runId;
    const extUrl = s(r.externalApkUrl, 500).trim();
    if (extUrl) clean.externalApkUrl = extUrl;
    cleanReleases.push(clean);
  }
  cleanReleases.sort((a, b) => b.versionCode - a.versionCode);

  const maxReleaseCode = cleanReleases.reduce((m, r) => Math.max(m, r.versionCode), 0);
  const lastVersionCode = Math.max(
    maxReleaseCode,
    Math.max(0, Math.min(1000000, Math.floor(Number(rawPol.lastVersionCode) || 0)))
  );
  let lastVersionName = s(rawPol.lastVersionName, 32).trim();
  if (!lastVersionName && cleanReleases[0]) {
    lastVersionName = cleanReleases[0].versionName;
  }

  const rawBlocked = Array.isArray(rawPol.blockedVersionCodes) ? rawPol.blockedVersionCodes : [];
  const blockedSet = new Set<number>();
  for (const c of rawBlocked) {
    const n = Math.floor(Number(c));
    if (Number.isFinite(n) && n >= 1 && n <= 1000000) blockedSet.add(n);
  }
  for (const rel of cleanReleases) {
    if (rel.blocked) blockedSet.add(rel.versionCode);
  }
  const blockedVersionCodes = Array.from(blockedSet).sort((a, b) => a - b).slice(0, 100);

  const blockMode: 'hard' | 'soft' = rawPol.blockMode === 'soft' ? 'soft' : 'hard';
  const blockMessage = sReq(rawPol.blockMessage, 300, DEFAULT_APK_BLOCK_MSG);
  const minSupportedVersionCode = Math.max(
    0,
    Math.min(1000000, Math.floor(Number(rawPol.minSupportedVersionCode) || 0))
  );

  return {
    policy: {
      lastVersionCode,
      lastVersionName,
      minSupportedVersionCode,
      blockedVersionCodes,
      blockMode,
      blockMessage,
    },
    releases: cleanReleases,
  };
}

export async function saveApkStateToCloud(
  apkState?: Partial<CloudApkState> | null
): Promise<void> {
  if (!apkState || typeof apkState !== 'object') return;
  const norm = normalizeCloudApkState(apkState);
  await upsertDoc(
    doc(db, 'app_settings', 'apk'),
    {
      settingId: 'apk',
      lastVersionCode: norm.policy.lastVersionCode,
      lastVersionName: norm.policy.lastVersionName,
      minSupportedVersionCode: norm.policy.minSupportedVersionCode,
      blockedVersionCodes: norm.policy.blockedVersionCodes,
      blockMode: norm.policy.blockMode,
      blockMessage: norm.policy.blockMessage,
      releases: norm.releases,
    },
    [
      'lastVersionCode',
      'lastVersionName',
      'minSupportedVersionCode',
      'blockedVersionCodes',
      'blockMode',
      'blockMessage',
      'releases',
    ]
  );
}

export async function fetchApkStateFromCloud(): Promise<CloudApkState | null> {
  try {
    const snap = await getDoc(doc(db, 'app_settings', 'apk'));
    if (!snap.exists()) return null;
    const d = snap.data();
    return normalizeCloudApkState({
      policy: {
        lastVersionCode: Number(d.lastVersionCode) || 0,
        lastVersionName: String(d.lastVersionName || ''),
        minSupportedVersionCode: Number(d.minSupportedVersionCode) || 0,
        blockedVersionCodes: Array.isArray(d.blockedVersionCodes) ? (d.blockedVersionCodes as number[]) : [],
        blockMode: d.blockMode === 'soft' ? 'soft' : 'hard',
        blockMessage: String(d.blockMessage || DEFAULT_APK_BLOCK_MSG),
      },
      releases: Array.isArray(d.releases) ? (d.releases as CloudApkRelease[]) : [],
    });
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

export async function saveChannelHealthToCloud(
  health?: CloudChannelHealthState
): Promise<void> {
  const uid = auth.currentUser?.uid;
  if (!uid || !health || typeof health !== 'object') return;

  const rawDiags = Object.values(health.urlDiagnostics || {})
    .filter((d) => d && typeof d === 'object' && typeof d.url === 'string' && String(d.url).trim())
    .sort((a, b) => (Number(b.checkedAt) || 0) - (Number(a.checkedAt) || 0))
    .slice(0, 400);

  const diagnostics = rawDiags.map((d) => ({
    url: s(d.url, 1500),
    online: d.online === true ? true : d.online === false ? false : null,
    status: d.status === 'online' || d.status === 'offline' ? String(d.status) : 'unknown',
    code: Math.max(0, Math.min(999, Math.floor(Number(d.code) || 0))),
    ms: Math.max(0, Math.min(600000, Math.floor(Number(d.ms) || 0))),
    diagCode: s(d.diagCode || 'unknown', 32),
    reason: s(d.reason, 220),
    contentType: s(d.contentType, 120),
    hlsOk: Boolean(d.hlsOk),
    segmentOk: d.segmentOk === undefined ? true : Boolean(d.segmentOk),
    codecWarning: s(d.codecWarning, 200),
    checkedAt: Math.max(0, Math.floor(Number(d.checkedAt) || 0)),
  }));

  const rawIssues = Object.values(health.issues || {})
    .filter((iss) => iss && typeof iss === 'object' && typeof iss.channelKey === 'string' && String(iss.channelKey).trim())
    .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0))
    .slice(0, 250);

  const issues = rawIssues.map((iss) => {
    const rawErrors = Array.isArray(iss.viewerErrors) ? iss.viewerErrors : [];
    const viewerErrors = rawErrors.slice(0, 10).map((ve: Record<string, unknown>) => ({
      userId: s(ve?.userId, 128),
      userLogin: s(ve?.userLogin, 64),
      userName: s(ve?.userName, 80),
      reason: s(ve?.reason, 200),
      diagCode: s(ve?.diagCode || 'network', 32),
      reportedAt: Math.max(0, Math.floor(Number(ve?.reportedAt) || 0)),
    }));
    const rStatus =
      iss.resolveCheckStatus === 'verified_ok' || iss.resolveCheckStatus === 'still_broken_after_resolve'
        ? String(iss.resolveCheckStatus)
        : 'none';
    return {
      channelKey: s(iss.channelKey, 200),
      channelName: s(iss.channelName, 200),
      resolved: Boolean(iss.resolved),
      resolveCheckStatus: rStatus,
      resolveCheckMessage: s(iss.resolveCheckMessage, 250),
      resolveAttemptedAt: Math.max(0, Math.floor(Number(iss.resolveAttemptedAt) || 0)),
      updatedAt: Math.max(0, Math.floor(Number(iss.updatedAt) || 0)),
      viewerErrors,
    };
  });

  await upsertDoc(
    doc(db, 'channel_health', 'main'),
    {
      docId: 'main',
      diagnostics,
      issues,
      updatedByUid: uid,
    },
    ['diagnostics', 'issues', 'updatedByUid']
  );
}

export async function loadChannelHealthFromCloud(): Promise<CloudChannelHealthState | undefined> {
  try {
    const snap = await getDoc(doc(db, 'channel_health', 'main'));
    if (!snap.exists()) return undefined;
    const d = snap.data();
    const urlDiagnostics: Record<string, Record<string, unknown>> = {};
    if (Array.isArray(d.diagnostics)) {
      for (const item of d.diagnostics) {
        if (item && typeof item === 'object' && typeof item.url === 'string' && item.url) {
          urlDiagnostics[item.url] = item as Record<string, unknown>;
        }
      }
    }
    const issues: Record<string, Record<string, unknown>> = {};
    if (Array.isArray(d.issues)) {
      for (const iss of d.issues) {
        if (iss && typeof iss === 'object' && typeof iss.channelKey === 'string' && iss.channelKey) {
          issues[iss.channelKey] = iss as Record<string, unknown>;
        }
      }
    }
    return { urlDiagnostics, issues };
  } catch {
    return undefined;
  }
}

export async function pushFullLocalToCloud(data: CloudExportPayload): Promise<void> {
  const prevManifest = await readManifest().catch(() => null);
  const plNames: string[] = [];
  for (const [rawName, channels] of Object.entries(data.playlists || {})) {
    const clean = cleanPlaylistName(rawName);
    if (!isValidPlaylistName(clean)) continue;
    plNames.push(clean);
    const enabled = data.playlistMeta?.[clean]?.enabled !== false;
    await savePlaylistToCloud(clean, channels, false, enabled);
  }
  plNames.sort();

  // Remove obsolete cloud playlists that were deleted locally
  if (prevManifest && Array.isArray(prevManifest.playlists)) {
    for (const oldPl of prevManifest.playlists) {
      if (!plNames.includes(oldPl) && isValidPlaylistName(oldPl)) {
        try {
          const oldMeta = await getDoc(doc(db, 'playlists', oldPl));
          if (oldMeta.exists()) {
            const cc = Number(oldMeta.data().chunkCount) || 0;
            for (let i = 0; i < cc; i++) {
              await deleteDoc(doc(db, 'playlists', oldPl, 'chunks', `c_${i}`)).catch(() => {});
            }
            await deleteDoc(doc(db, 'playlists', oldPl)).catch(() => {});
          }
        } catch {
          // ignore cleanup failure
        }
      }
    }
  }

  const sourceIds = await saveSourcesToCloud(data.sources || [], false);
  const sourceIndexIds = await saveSourceIndexToCloud(data.sourceIndex || {}, false);
  const epgIds = await saveEpgToCloud(data.epgSources || [], false);
  const catInfo = await saveCatalogToCloud(data.catalog, false);
  await saveStreamingSettingsToCloud(data.streamingSettings);
  await saveUiSettingsToCloud(data.uiSettings);
  await saveApkStateToCloud(data.apkState);
  await saveChannelHealthToCloud(data.channelHealth);
  await saveAdminSettingsToCloud(data.adminSettings);

  // Also ensure local users exist in /users (preserving admin role on existing docs) and store password hashes
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
    const userRef = doc(db, 'users', uid);
    const existingSnap = await getDoc(userRef).catch(() => null);
    if (!existingSnap || !existingSnap.exists()) {
      await setDoc(userRef, {
        uid,
        login,
        name,
        playlists,
        enabled: Boolean(u.enabled),
        role: 'user',
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } else {
      const existingData = existingSnap.data();
      const nextFields: Record<string, unknown> = {
        login,
        name,
        playlists,
        enabled: Boolean(u.enabled),
      };
      const changedKeys = ['login', 'name', 'playlists', 'enabled'].filter(
        (key) => JSON.stringify(existingData[key]) !== JSON.stringify(nextFields[key])
      );
      if (changedKeys.length > 0) {
        const patch: Record<string, unknown> = { updatedAt: serverTimestamp() };
        for (const key of changedKeys) {
          patch[key] = nextFields[key];
        }
        await updateDoc(userRef, patch);
      }
    }
  }
  const localUserIds = await saveLocalUserCredentialsToCloud(data.users || [], false);

  if (Array.isArray(data.invites)) {
    const currentUid = auth.currentUser?.uid;
    if (!currentUid) throw new Error('Для синхронизации приглашений требуется Firebase admin auth');
    const nextInviteIds = new Set<string>();
    const inviteWrites: CloudBatchUpsertEntry[] = [];
    for (const invite of data.invites.slice(0, 500)) {
      const id = String(invite.id || '').trim().toLowerCase();
      const email = String(invite.email || '').trim().toLowerCase().slice(0, 160);
      if (!/^[a-f0-9]{64}$/.test(id) || !email || nextInviteIds.has(id)) continue;
      nextInviteIds.add(id);
      const inviteRef = doc(db, 'invites', id);
      let invitedByUid = currentUid;
      try {
        const existing = await getDoc(inviteRef);
        if (existing.exists() && typeof existing.data().invitedByUid === 'string') {
          invitedByUid = existing.data().invitedByUid as string;
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, inviteRef.path);
      }
      const playlists = Array.isArray(invite.playlists)
        ? invite.playlists.map((item) => cleanPlaylistName(item)).filter(Boolean).slice(0, 50)
        : [];
      inviteWrites.push({
        ref: inviteRef,
        payload: {
          emailHash: id,
          name: sReq(invite.name, 80, email.split('@')[0] || 'Пользователь'),
          playlists,
          enabled: Boolean(invite.enabled),
          invitedByUid,
          claimedUid: String(invite.claimed_uid || '').slice(0, 128),
        },
        mutableKeys: ['name', 'playlists', 'enabled', 'claimedUid'],
      });
      inviteWrites.push({
        ref: doc(db, 'invites', id, 'private', 'info'),
        payload: { emailHash: id, email },
        mutableKeys: ['email'],
      });
    }
    for (const writeChunk of chunkArray(inviteWrites, 500)) {
      await batchUpsertDocs(writeChunk, 'invites');
    }

    const cloudInvites = await getDocs(collection(db, 'invites'));
    const obsoleteInvites = cloudInvites.docs.filter((item) => !nextInviteIds.has(item.id));
    for (const obsoleteChunk of chunkArray(obsoleteInvites, 250)) {
      if (obsoleteChunk.length === 0) continue;
      const batch = writeBatch(db);
      obsoleteChunk.forEach((item) => {
        batch.delete(doc(db, 'invites', item.id, 'private', 'info'));
        batch.delete(item.ref);
      });
      try {
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, 'invites');
      }
    }
  }

  if (Array.isArray(data.alerts)) {
    const alertWrites: CloudBatchUpsertEntry[] = [];
    for (const alert of data.alerts.slice(0, 500)) {
      const rawUid = String(alert.userId || alert.id || '').trim();
      if (!rawUid || !/^[a-zA-Z0-9_-]{1,128}$/.test(rawUid)) continue;
      const items = Array.isArray(alert.items)
        ? alert.items.filter((item) => item && typeof item.name === 'string' && typeof item.reason === 'string')
            .slice(0, 50)
            .map((item) => ({
              name: sReq(item.name, 120, 'Канал'),
              group: s(item.group, 80),
              reason: sReq(item.reason, 200, 'Неизвестная ошибка'),
            }))
        : [];
      const totalChannels = Math.max(0, Math.min(50000, Math.floor(Number(alert.totalChannels) || 0)));
      const unavailableCount = Math.max(0, Math.min(totalChannels, Math.floor(Number(alert.unavailableCount) || items.length)));
      const alertRef = doc(db, 'channel_alerts', rawUid);
      let userLogin = sReq(alert.userLogin, 64, rawUid);
      let userName = sReq(alert.userName, 80, alert.userLogin || rawUid);
      try {
        const existing = await getDoc(alertRef);
        if (existing.exists()) {
          userLogin = String(existing.data().userLogin || userLogin);
          userName = String(existing.data().userName || userName);
        }
      } catch (err) {
        handleFirestoreError(err, OperationType.GET, alertRef.path);
      }
      alertWrites.push({
        ref: alertRef,
        payload: {
          uid: rawUid,
          userLogin,
          userName,
          totalChannels,
          unavailableCount,
          items,
          resolved: Boolean(alert.resolved),
        },
        mutableKeys: ['totalChannels', 'unavailableCount', 'items', 'resolved'],
      });
    }
    for (const writeChunk of chunkArray(alertWrites, 500)) {
      await batchUpsertDocs(writeChunk, 'channel_alerts');
    }
  }

  await writeManifestPatch({
    playlists: plNames,
    sourceIds,
    sourceIndexIds,
    epgIds,
    localUserIds,
    catalogChannelChunks: catInfo.channelChunks,
    catalogStreamChunks: catInfo.streamChunks,
    ...(typeof data.revision === 'number' ? { revision: data.revision } : {}),
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
  const playlistMeta: Record<string, { enabled: boolean }> = {};
  await Promise.all(
    manifest.playlists.map(async (plId) => {
      try {
        const metaSnap = await getDoc(doc(db, 'playlists', plId));
        if (!metaSnap.exists()) return;
        const metaData = metaSnap.data();
        playlistMeta[plId] = { enabled: metaData.enabled !== false };
        const cc = Number(metaData.chunkCount) || 0;
        const items: CloudChannelItem[] = [];
        for (let i = 0; i < cc; i++) {
          const chunkSnap = await getDoc(doc(db, 'playlists', plId, 'chunks', `c_${i}`));
          if (chunkSnap.exists() && Array.isArray(chunkSnap.data().items)) {
            items.push(...(chunkSnap.data().items as CloudChannelItem[]));
          }
        }
        playlists[plId] = items;
      } catch (err) {
        throw err;
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
          const item: CloudSourceItem = {
            id: String(d.id || sid),
            name: String(d.name || ''),
            type: String(d.type || 'm3u'),
            url: String(d.url || ''),
            enabled: Boolean(d.enabled),
          };
          if (typeof d.userAgent === 'string' && d.userAgent) item.userAgent = d.userAgent;
          if (typeof d.referer === 'string' && d.referer) item.referer = d.referer;
          if (typeof d.origin === 'string' && d.origin) item.origin = d.origin;
          if (typeof d.timeoutSec === 'number' && d.timeoutSec > 0) item.timeoutSec = d.timeoutSec;
          if (typeof d.ignoreTlsErrors === 'boolean') item.ignoreTlsErrors = d.ignoreTlsErrors;
          sources.push(item);
        }
      } catch (err) {
        throw err;
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
      } catch (err) {
        throw err;
      }
    })
  );

  // EPG Sources
  const epgSources: CloudEpgSourceItem[] = [];
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
      } catch (err) {
        throw err;
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
  } catch (err) {
        throw err;
      }

  // Streaming, UI & APK settings
  const [streamingSettings, uiSettings, apkState] = await Promise.all([
    fetchStreamingSettingsFromCloud(),
    fetchUiSettingsFromCloud(),
    fetchApkStateFromCloud(),
  ]);

  // Channel Health state
  const channelHealth = await loadChannelHealthFromCloud();

  // Admin settings
  const adminSettings: Record<string, string> = {};
  try {
    const authSnap = await getDoc(doc(db, 'admin_settings', 'auth'));
    if (authSnap.exists() && typeof authSnap.data().adminPasswordHash === 'string') {
      adminSettings.adminPasswordHash = authSnap.data().adminPasswordHash;
    }
  } catch (err) {
        throw err;
      }

  // All users (both local password users + Google viewer profiles) + password hashes
  const usersById = new Map<string, Record<string, unknown>>();
  try {
    const allUsersSnap = await getDocs(collection(db, 'users'));
    await Promise.all(
      allUsersSnap.docs.map(async (uDoc) => {
        const uid = uDoc.id;
        const ud = uDoc.data();
        let password_hash = '';
        if (manifest.localUserIds.includes(uid) || uid.startsWith('u_')) {
          try {
            const credSnap = await getDoc(doc(db, 'users', uid, 'private', 'credentials'));
            if (credSnap.exists()) {
              password_hash = String(credSnap.data().passwordHash || '');
            }
          } catch {
            // Optional credentials subdoc
          }
        }
        usersById.set(uid, {
          id: uid,
          login: String(ud.login || uid),
          name: String(ud.name || ud.login || uid),
          playlists: Array.isArray(ud.playlists) ? ud.playlists : [],
          enabled: Boolean(ud.enabled),
          password_hash,
        });
      })
    );
  } catch {
    // Fallback to manifest.localUserIds if list query isn't permitted
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
          usersById.set(uid, {
            id: uid,
            login: String(ud.login || uid),
            name: String(ud.name || ud.login || uid),
            playlists: Array.isArray(ud.playlists) ? ud.playlists : [],
            enabled: Boolean(ud.enabled),
            password_hash,
          });
        } catch (err) {
          throw err;
        }
      })
    );
  }
  const users = Array.from(usersById.values());

  // Invites (Google Email invitations + private/info email)
  const invites: Array<Record<string, unknown>> = [];
  try {
    const allInvSnap = await getDocs(collection(db, 'invites'));
    await Promise.all(
      allInvSnap.docs.map(async (invDoc) => {
        const d = invDoc.data();
        let email = '';
        try {
          const piiSnap = await getDoc(doc(db, 'invites', invDoc.id, 'private', 'info'));
          if (piiSnap.exists()) {
            email = String(piiSnap.data().email || '');
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `invites/${invDoc.id}/private/info`);
        }
        if (!email) {
          throw new Error(`Invite ${invDoc.id} has no private email record`);
        }
        invites.push({
          id: invDoc.id,
          email,
          name: String(d.name || ''),
          playlists: Array.isArray(d.playlists) ? d.playlists : [],
          enabled: d.enabled !== undefined ? Boolean(d.enabled) : true,
          claimed_uid: typeof d.claimedUid === 'string' ? d.claimedUid : '',
        });
      })
    );
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'invites');
  }

  const alerts: Array<Record<string, unknown>> = [];
  const toSeconds = (value: unknown): number => {
    if (value && typeof value === 'object' && typeof (value as { toMillis?: unknown }).toMillis === 'function') {
      return Math.floor(((value as { toMillis: () => number }).toMillis()) / 1000);
    }
    return 0;
  };
  try {
    const alertSnapshot = await getDocs(collection(db, 'channel_alerts'));
    for (const alertDoc of alertSnapshot.docs) {
      const d = alertDoc.data();
      alerts.push({
        id: alertDoc.id,
        userId: alertDoc.id,
        userLogin: String(d.userLogin || alertDoc.id),
        userName: String(d.userName || d.userLogin || alertDoc.id),
        totalChannels: Number(d.totalChannels) || 0,
        unavailableCount: Number(d.unavailableCount) || 0,
        items: Array.isArray(d.items) ? d.items.map((item: Record<string, unknown>) => ({
          name: String(item.name || ''),
          group: String(item.group || ''),
          reason: String(item.reason || ''),
        })) : [],
        resolved: Boolean(d.resolved),
        created_at: toSeconds(d.createdAt),
        updated_at: toSeconds(d.updatedAt),
      });
    }
  } catch (err) {
    handleFirestoreError(err, OperationType.LIST, 'channel_alerts');
  }

  return {
    hasCloud: true,
    snapshot: {
      ...(typeof manifest.revision === 'number' ? { revision: manifest.revision } : {}),
      playlists,
      playlistMeta,
      replacePlaylists: true,
      sources,
      sourceIndex,
      epgSources,
      catalog,
      streamingSettings,
      ...(uiSettings ? { uiSettings } : {}),
      ...(apkState ? { apkState } : {}),
      channelHealth,
      users,
      invites,
      alerts,
      adminSettings,
    },
  };
}

export async function fetchViewerCloudState(playlistNames: string[]): Promise<{
  streaming: CloudStreamingSettings | null;
  uiSettings: CloudUiSettings | null;
  apkState: CloudApkState | null;
  playlists: Array<{ name: string; channels: CloudChannelItem[] }>;
}> {
  const [streaming, uiSettings, apkState] = await Promise.all([
    fetchStreamingSettingsFromCloud(),
    fetchUiSettingsFromCloud(),
    fetchApkStateFromCloud(),
  ]);
  const playlists: Array<{ name: string; channels: CloudChannelItem[] }> = [];

  await Promise.all(
    (Array.isArray(playlistNames) ? playlistNames : []).map(async (rawName) => {
      const plId = cleanPlaylistName(rawName);
      if (!isValidPlaylistName(plId)) return;
      try {
        const metaSnap = await getDoc(doc(db, 'playlists', plId));
        if (!metaSnap.exists()) return;
        const metaData = metaSnap.data();
        if (metaData.enabled === false) return;
        const cc = Number(metaData.chunkCount) || 0;
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

  return { streaming, uiSettings, apkState, playlists };
}

export async function fetchAdminWatchCloudState(): Promise<{
  streaming: CloudStreamingSettings | null;
  uiSettings: CloudUiSettings | null;
  apkState: CloudApkState | null;
  playlists: Array<{ name: string; channels: CloudChannelItem[] }>;
}> {
  const manifest = await readManifest().catch(() => null);
  return fetchViewerCloudState(manifest ? manifest.playlists : []);
}
