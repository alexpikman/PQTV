import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseM3uFile } from './m3uParser.js';
import { atomicWriteJsonSync } from './persistence.js';
import { storage } from './storage.js';
import { normalizeChannelName, SourceItem, StreamParser } from './streamParser.js';

import {
  checkStreamDeep,
  DeepCheckOptions,
  DeepCheckResult,
  StreamCheckStatus,
} from './streamChecker.js';

export type { StreamCheckStatus };

export interface CatalogStream {
  id: number;
  channel_id: number;
  url: string;
  source_id: number | null;
  source_name: string | null;
  source_type: string | null;
  online: number;
  http_code: number;
  response_ms: number;
  checked_at: number;
  added_at: number;
  diag_code?: string;
  diag_reason?: string;
  codec_warning?: string;
}

export interface CatalogChannel {
  id: number;
  code: string;
  name: string;
  logo: string;
  tvg_id: string;
  in_my_pl: number;
  used_in: string[];
  alt_names: string[];
  created_at: number;
  updated_at: number;
}

export interface CatalogSource {
  id: number;
  stringId?: string;
  name: string;
  type: string;
  url: string;
  enabled: number;
  created_at: number;
  last_run?: number;
  last_status?: string;
  total_found?: number;
}

export interface ReconcileResult {
  ok: boolean;
  imported: number;
  removedChannels: number;
  removedStreams: number;
  updatedChannels: number;
  persisted: boolean;
  error?: string;
}

const STREAM_STATUS_TTL_SECONDS: Record<StreamCheckStatus, number> = {
  online: 5 * 60,
  offline: 60,
  unknown: 20,
};

function isStreamStatusFresh(
  stream: Pick<CatalogStream, 'online' | 'checked_at'>,
  now = Math.floor(Date.now() / 1000)
): boolean {
  const status: StreamCheckStatus =
    stream.online === 1 ? 'online' : stream.online === -1 ? 'offline' : 'unknown';
  return stream.checked_at > 0 && now - stream.checked_at <= STREAM_STATUS_TTL_SECONDS[status];
}

export async function checkStreamUrl(
  url: string,
  timeoutMs = 9000,
  force = false,
  extraOpts: Partial<DeepCheckOptions> = {}
): Promise<DeepCheckResult> {
  const srcOpts = StreamParser.getSourceRequestOptions(url);
  return checkStreamDeep(url, {
    timeoutMs: extraOpts.timeoutMs ?? srcOpts.timeoutMs ?? timeoutMs,
    headers: { ...srcOpts.headers, ...(extraOpts.headers || {}) },
    userAgent: extraOpts.userAgent || srcOpts.userAgent,
    referer: extraOpts.referer || srcOpts.referer,
    origin: extraOpts.origin || srcOpts.origin,
    ignoreTlsErrors: extraOpts.ignoreTlsErrors ?? srcOpts.ignoreTlsErrors,
    checkSegments: extraOpts.checkSegments !== false,
    force,
  });
}

function toCatalogSource(src: SourceItem): CatalogSource {
  return {
    id: Number(src.catalogId) || 1,
    stringId: src.id,
    name: src.name,
    type: src.type || 'm3u',
    url: src.url,
    enabled: src.enabled ? 1 : 0,
    created_at: Number(src.created_at) || Math.floor(Date.now() / 1000),
    ...(src.last_run !== undefined ? { last_run: src.last_run } : {}),
    ...(src.last_status !== undefined ? { last_status: src.last_status } : {}),
    ...(src.total_found !== undefined ? { total_found: src.total_found } : {}),
  };
}

class CatalogStore {
  private channels: CatalogChannel[] = [];
  private streams: CatalogStream[] = [];
  private nextChannelId = 1;
  private nextStreamId = 1;
  private initialized = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSaveError = '';

  private get catalogFile(): string {
    return path.join(config.dataDir, 'catalog.json');
  }

  getLastSaveError(): string {
    return this.lastSaveError;
  }

  resetState(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.channels = [];
    this.streams = [];
    this.nextChannelId = 1;
    this.nextStreamId = 1;
    this.initialized = false;
    this.lastSaveError = '';
  }

  reloadFromDisk(): void {
    this.resetState();
    this.ensureInit();
  }

  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.loadFromDisk()) {
      this.reconcile({ save: true });
    } else {
      this.reconcile({ save: true });
    }
  }

  private loadFromDisk(): boolean {
    if (!fs.existsSync(this.catalogFile)) return false;
    try {
      const raw = JSON.parse(fs.readFileSync(this.catalogFile, 'utf-8')) as {
        channels?: CatalogChannel[];
        streams?: CatalogStream[];
        sources?: CatalogSource[];
        nextChannelId?: number;
        nextStreamId?: number;
      };
      if (!Array.isArray(raw.channels) || !Array.isArray(raw.streams)) return false;
      this.channels = raw.channels;
      this.streams = raw.streams;

      // DEF-08: One-time migration if catalog.json had sources but data/sources.json was missing/empty
      if (Array.isArray(raw.sources) && raw.sources.length > 0 && StreamParser.getSources().length === 0) {
        const migrated: SourceItem[] = raw.sources.map((s) => ({
          id: `src_${Number(s.id) || 1}`,
          catalogId: Number(s.id) || 1,
          name: s.name || `Источник ${s.id}`,
          type: s.type || 'm3u',
          url: s.url || '',
          enabled: Boolean(s.enabled),
          created_at: Number(s.created_at) || Math.floor(Date.now() / 1000),
          last_run: s.last_run,
          last_status: s.last_status,
          total_found: s.total_found,
        }));
        StreamParser.saveSources(migrated);
      }

      this.nextChannelId =
        Number(raw.nextChannelId) ||
        Math.max(1, ...this.channels.map((c) => Number(c.id) + 1));
      this.nextStreamId =
        Number(raw.nextStreamId) ||
        Math.max(1, ...this.streams.map((s) => Number(s.id) + 1));
      return true;
    } catch {
      return false;
    }
  }

  saveToDisk(): { ok: boolean; error?: string } {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.lastSaveError = '';
    const authSources = this.getSources();
    const nextSourceId = authSources.reduce((m, s) => Math.max(m, s.id + 1), 1);
    const res = atomicWriteJsonSync(this.catalogFile, {
      nextChannelId: this.nextChannelId,
      nextStreamId: this.nextStreamId,
      nextSourceId,
      channels: this.channels,
      streams: this.streams,
    });
    if (!res.ok) {
      this.lastSaveError = res.error || 'Не удалось сохранить catalog.json';
      return { ok: false, error: this.lastSaveError };
    }
    return { ok: true };
  }

  private scheduleSaveToDisk(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 500);
  }

  /**
   * DEF-01, DEF-02, DEF-03: Full bidirectional reconciliation between live .m3u playlists,
   * authoritative StreamParser sources, and catalog channels/streams.
   */
  reconcile(opts: { save?: boolean } = {}): ReconcileResult {
    this.initialized = true;
    const now = Math.floor(Date.now() / 1000);

    const playlists = storage.getPlaylists();
    const livePlaylistUrls = new Set<string>();
    const playlistItems = new Map<string, ReturnType<typeof parseM3uFile>>();

    for (const rawPl of playlists) {
      const pl = this.stripM3u(rawPl);
      if (!pl) continue;
      const items = parseM3uFile(storage.getPlaylistPath(rawPl));
      playlistItems.set(pl, items);
      for (const ch of items) {
        const url = (ch.url || '').trim();
        if (url) livePlaylistUrls.add(url);
      }
    }

    const authSources = StreamParser.getSources();
    const activeSourcesByCatalogId = new Map<number, SourceItem>();
    for (const s of authSources) {
      if (s.catalogId && s.catalogId > 0) {
        activeSourcesByCatalogId.set(s.catalogId, s);
      }
    }

    // 1. Prune obsolete streams (from deleted playlists or deleted sources) & dedup
    const prevStreamCount = this.streams.length;
    const seenStreamKeys = new Set<string>();
    const nextStreams: CatalogStream[] = [];
    for (const st of this.streams) {
      const cleanUrl = (st.url || '').trim();
      if (!cleanUrl) continue;

      if (st.source_id === null || st.source_id === undefined) {
        if (!livePlaylistUrls.has(cleanUrl)) continue;
      } else {
        const activeSrc = activeSourcesByCatalogId.get(Number(st.source_id));
        if (!activeSrc) continue;
        st.source_name = activeSrc.name;
        st.source_type = activeSrc.type || 'm3u';
      }

      const dedupKey = `${st.channel_id}|${st.source_id ?? 'pl'}|${cleanUrl}`;
      if (seenStreamKeys.has(dedupKey)) continue;
      seenStreamKeys.add(dedupKey);
      nextStreams.push({ ...st, url: cleanUrl });
    }
    this.streams = nextStreams;
    const removedStreams = Math.max(0, prevStreamCount - this.streams.length);

    // 2. Ensure all channels & streams present in live .m3u files exist in catalog
    let imported = 0;
    for (const [pl, items] of playlistItems.entries()) {
      for (const ch of items) {
        const name = (ch.name || '').trim();
        if (!name) continue;
        let existing = this.findByNameInternal(name);
        if (!existing) {
          const id = this.nextChannelId++;
          existing = {
            id,
            code: 'ID' + String(id).padStart(6, '0'),
            name,
            logo: ch.logo || '',
            tvg_id: ch.tvg_id || '',
            in_my_pl: 1,
            used_in: [pl],
            alt_names: [],
            created_at: now,
            updated_at: now,
          };
          this.channels.push(existing);
          imported++;
        } else {
          if (!existing.logo && ch.logo) existing.logo = ch.logo;
          if (!existing.tvg_id && ch.tvg_id) existing.tvg_id = ch.tvg_id;
        }

        const cleanUrl = (ch.url || '').trim();
        if (cleanUrl) {
          this.addStreamInternal(existing.id, cleanUrl, null, null, null);
        }
      }
    }

    // 3. Recompute used_in & in_my_pl from live playlists and remove orphan channels
    const ownership = this.buildLivePlaylistOwnershipMap();
    const streamsByChannel = this.buildStreamsByChannelMap();
    const prevChannelCount = this.channels.length;
    let updatedChannels = 0;
    const nextChannels: CatalogChannel[] = [];

    for (const ch of this.channels) {
      const liveUsedIn = this.resolveLiveUsedIn(ch, streamsByChannel, ownership);
      const chStreams = streamsByChannel.get(ch.id) || [];

      if (liveUsedIn.length === 0 && chStreams.length === 0) {
        // Channel has no active playlists AND no active source streams -> prune
        continue;
      }

      const nextInMyPl = liveUsedIn.length > 0 ? 1 : 0;
      const usedChanged =
        ch.in_my_pl !== nextInMyPl ||
        ch.used_in.length !== liveUsedIn.length ||
        ch.used_in.some((v, idx) => v !== liveUsedIn[idx]);

      if (usedChanged) {
        ch.in_my_pl = nextInMyPl;
        ch.used_in = liveUsedIn;
        ch.updated_at = now;
        updatedChannels++;
      }
      nextChannels.push(ch);
    }

    this.channels = nextChannels;
    const removedChannels = Math.max(0, prevChannelCount - this.channels.length);

    let persisted = true;
    let error: string | undefined;
    if (opts.save !== false) {
      const saveRes = this.saveToDisk();
      persisted = saveRes.ok;
      error = saveRes.error;
    }

    return {
      ok: persisted,
      imported,
      removedChannels,
      removedStreams,
      updatedChannels,
      persisted,
      ...(error ? { error } : {}),
    };
  }

  importFromPlaylists(): ReconcileResult {
    this.ensureInit();
    return this.reconcile({ save: true });
  }

  private findByNameInternal(name: string): CatalogChannel | undefined {
    const exact = this.channels.find((c) => c.name === name);
    if (exact) return exact;
    const norm = normalizeChannelName(name);
    if (!norm) return undefined;
    return this.channels.find(
      (c) =>
        normalizeChannelName(c.name) === norm ||
        c.alt_names.some((a) => normalizeChannelName(a) === norm)
    );
  }

  private addStreamInternal(
    channelId: number,
    url: string,
    sourceId: number | null,
    sourceName: string | null,
    sourceType: string | null
  ): boolean {
    const cleanUrl = url.trim();
    if (!cleanUrl) return false;
    const dup = this.streams.find(
      (s) => s.channel_id === channelId && s.url === cleanUrl && s.source_id === sourceId
    );
    if (dup) return false;
    this.streams.push({
      id: this.nextStreamId++,
      channel_id: channelId,
      url: cleanUrl,
      source_id: sourceId,
      source_name: sourceName,
      source_type: sourceType,
      online: 0,
      http_code: 0,
      response_ms: 0,
      checked_at: 0,
      added_at: Math.floor(Date.now() / 1000),
    });
    return true;
  }

  private stripM3u(name: string): string {
    return name.replace(/\.m3u$/i, '').trim();
  }

  private buildLivePlaylistOwnershipMap(): {
    allPlaylists: string[];
    byUrl: Map<string, Set<string>>;
    byLowerName: Map<string, Set<string>>;
    byNormName: Map<string, Set<string>>;
  } {
    const rawPlaylists = storage.getPlaylists();
    const allPlaylists: string[] = [];
    const byUrl = new Map<string, Set<string>>();
    const byLowerName = new Map<string, Set<string>>();
    const byNormName = new Map<string, Set<string>>();

    const addTo = (map: Map<string, Set<string>>, key: string, plName: string) => {
      if (!key) return;
      let set = map.get(key);
      if (!set) {
        set = new Set<string>();
        map.set(key, set);
      }
      set.add(plName);
    };

    for (const rawPl of rawPlaylists) {
      const cleanPl = this.stripM3u(rawPl);
      if (!cleanPl) continue;
      if (!allPlaylists.includes(cleanPl)) allPlaylists.push(cleanPl);

      const filePath = storage.getPlaylistPath(rawPl);
      const items = parseM3uFile(filePath);
      for (const ch of items) {
        const chName = (ch.name || '').trim();
        const chUrl = (ch.url || '').trim();
        if (chName) {
          addTo(byLowerName, chName.toLowerCase(), cleanPl);
          const norm = normalizeChannelName(chName);
          if (norm) addTo(byNormName, norm, cleanPl);
        }
        if (chUrl) {
          addTo(byUrl, chUrl, cleanPl);
        }
      }
    }

    allPlaylists.sort((a, b) => a.localeCompare(b, 'ru'));
    return { allPlaylists, byUrl, byLowerName, byNormName };
  }

  private resolveLiveUsedIn(
    ch: CatalogChannel,
    streamsByChannel: Map<number, CatalogStream[]>,
    ownership: ReturnType<CatalogStore['buildLivePlaylistOwnershipMap']>
  ): string[] {
    const found = new Set<string>();
    const addSet = (s?: Set<string>) => {
      if (!s) return;
      for (const pl of s) found.add(pl);
    };

    const lower = (ch.name || '').trim().toLowerCase();
    addSet(ownership.byLowerName.get(lower));
    const norm = normalizeChannelName(ch.name || '');
    if (norm) addSet(ownership.byNormName.get(norm));

    if (Array.isArray(ch.alt_names)) {
      for (const alt of ch.alt_names) {
        const altLower = (alt || '').trim().toLowerCase();
        addSet(ownership.byLowerName.get(altLower));
        const altNorm = normalizeChannelName(alt || '');
        if (altNorm) addSet(ownership.byNormName.get(altNorm));
      }
    }

    const chStreams = streamsByChannel.get(ch.id) || [];
    for (const s of chStreams) {
      if (s.url) {
        addSet(ownership.byUrl.get(s.url.trim()));
      }
    }

    return Array.from(found).sort((a, b) => a.localeCompare(b, 'ru'));
  }

  private buildStreamsByChannelMap(): Map<number, CatalogStream[]> {
    const map = new Map<number, CatalogStream[]>();
    for (const s of this.streams) {
      let arr = map.get(s.channel_id);
      if (!arr) {
        arr = [];
        map.set(s.channel_id, arr);
      }
      arr.push(s);
    }
    return map;
  }

  stats() {
    this.ensureInit();
    const ownership = this.buildLivePlaylistOwnershipMap();
    const streamsByChannel = this.buildStreamsByChannelMap();
    const authSources = this.getSources();
    let inMyPlCount = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const c of this.channels) {
      if (this.resolveLiveUsedIn(c, streamsByChannel, ownership).length > 0) {
        inMyPlCount++;
      }
    }
    return {
      channels: this.channels.length,
      in_my_pl: inMyPlCount,
      streams: this.streams.length,
      streams_online: this.streams.filter((s) => s.online === 1 && isStreamStatusFresh(s, now)).length,
      sources: authSources.length,
      sources_enabled: authSources.filter((s) => s.enabled === 1).length,
    };
  }

  getStreamStatusMap(): Map<string, { online: number; http_code: number; checked_at: number }> {
    this.ensureInit();
    const map = new Map<string, { online: number; http_code: number; checked_at: number }>();
    for (const s of this.streams) {
      if (!s.url || !s.checked_at) continue;
      const prev = map.get(s.url);
      if (!prev || s.online === 1 || (prev.online !== 1 && s.checked_at > prev.checked_at)) {
        map.set(s.url, {
          online: s.online,
          http_code: s.http_code || 0,
          checked_at: s.checked_at || 0,
        });
      }
    }
    return map;
  }

  getUsedPlaylists(): string[] {
    this.ensureInit();
    const ownership = this.buildLivePlaylistOwnershipMap();
    return ownership.allPlaylists;
  }

  getChannels(
    limit = 100,
    offset = 0,
    search = '',
    filter = '',
    playlists: string[] = []
  ) {
    this.ensureInit();
    const sLower = search.trim().toLowerCase();
    const cleanFilterPlaylists = playlists.map((p) => this.stripM3u(p)).filter(Boolean);

    const ownership = this.buildLivePlaylistOwnershipMap();
    const streamsByChannel = this.buildStreamsByChannelMap();
    const now = Math.floor(Date.now() / 1000);
    const streamCounts = new Map<number, { total: number; online: number; offline: number; unknown: number }>();
    for (const s of this.streams) {
      const entry = streamCounts.get(s.channel_id) || { total: 0, online: 0, offline: 0, unknown: 0 };
      entry.total++;
      const fresh = isStreamStatusFresh(s, now);
      if (!fresh || s.online === 0) entry.unknown++;
      else if (s.online === 1) entry.online++;
      else if (s.online === -1) entry.offline++;
      else entry.unknown++;
      streamCounts.set(s.channel_id, entry);
    }

    const enriched = this.channels.map((c) => {
      const usedIn = this.resolveLiveUsedIn(c, streamsByChannel, ownership);
      return {
        ch: c,
        usedIn,
        inMyPl: usedIn.length > 0 ? 1 : 0,
        counts: streamCounts.get(c.id) || { total: 0, online: 0, offline: 0, unknown: 0 },
      };
    });

    const filtered = enriched
      .filter(({ ch, usedIn, counts }) => {
        if (sLower) {
          const hay = (ch.name + ' ' + ch.alt_names.join(' ')).toLowerCase();
          if (!hay.includes(sLower)) return false;
        }
        if (filter === 'online' && counts.online === 0) return false;
        if (filter === 'offline' && (counts.total === 0 || counts.offline !== counts.total)) return false;
        if (filter === 'no_streams' && counts.total > 0) return false;

        if (cleanFilterPlaylists.length > 0) {
          const hasMatch = cleanFilterPlaylists.some((pl) => usedIn.includes(pl));
          if (!hasMatch) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (b.inMyPl !== a.inMyPl) return b.inMyPl - a.inMyPl;
        return a.ch.name.localeCompare(b.ch.name, 'ru');
      });

    return filtered.slice(offset, offset + limit).map(({ ch, usedIn, inMyPl, counts }) => ({
      ...ch,
      in_my_pl: inMyPl,
      used_in: JSON.stringify(usedIn),
      used_in_list: usedIn,
      alt_names: JSON.stringify(ch.alt_names),
      streams_count: counts.total,
      streams_online: counts.online,
      streams_offline: counts.offline,
      streams_unknown: counts.unknown,
    }));
  }

  getChannel(id: number) {
    this.ensureInit();
    const ch = this.channels.find((c) => c.id === id);
    if (!ch) return null;
    const ownership = this.buildLivePlaylistOwnershipMap();
    const streamsByChannel = this.buildStreamsByChannelMap();
    const usedIn = this.resolveLiveUsedIn(ch, streamsByChannel, ownership);
    const chStreams = (streamsByChannel.get(id) || [])
      .slice()
      .sort((a, b) => b.online - a.online || b.added_at - a.added_at);
    return {
      ...ch,
      in_my_pl: usedIn.length > 0 ? 1 : 0,
      used_in: JSON.stringify(usedIn),
      used_in_list: usedIn,
      alt_names: JSON.stringify(ch.alt_names),
      streams: chStreams.map((stream) => {
        const fresh = isStreamStatusFresh(stream);
        return {
          ...stream,
          status:
            !fresh || stream.online === 0
              ? 'unknown'
              : stream.online === 1
                ? 'online'
                : stream.online === -1
                  ? 'offline'
                  : 'unknown',
        };
      }),
    };
  }

  /**
   * DEF-08: Always reflects authoritative StreamParser (`data/sources.json`).
   */
  getSources(): CatalogSource[] {
    return StreamParser.getSources()
      .map(toCatalogSource)
      .sort((a, b) => b.id - a.id);
  }

  addSource(name: string, type: string, url: string, enabled = 1): { ok: boolean; id?: number; error?: string } {
    this.ensureInit();
    const res = StreamParser.upsertCatalogSource({
      name,
      type,
      url,
      enabled: Boolean(enabled),
    });
    if (!res.ok) return { ok: false, error: res.error };
    const saveRes = this.saveToDisk();
    if (!saveRes.ok) return { ok: false, id: res.id, error: saveRes.error };
    return { ok: true, id: res.id };
  }

  updateSource(id: number | string, patch: Partial<CatalogSource>): { ok: boolean; notFound?: boolean; error?: string } {
    this.ensureInit();
    const existing = StreamParser.getSources().find(
      (s) => s.catalogId === Number(id) || s.id === String(id)
    );
    if (!existing) {
      return { ok: false, notFound: true, error: 'Источник не найден' };
    }
    const res = StreamParser.upsertCatalogSource({
      id: existing.catalogId,
      name: patch.name !== undefined ? patch.name : existing.name,
      type: patch.type !== undefined ? patch.type : existing.type,
      url: patch.url !== undefined ? patch.url : existing.url,
      enabled: patch.enabled !== undefined ? Boolean(patch.enabled) : existing.enabled,
    });
    if (!res.ok) return { ok: false, error: res.error };
    this.reconcile({ save: false });
    const saveRes = this.saveToDisk();
    if (!saveRes.ok) return { ok: false, error: saveRes.error };
    return { ok: true };
  }

  /**
   * DEF-03 + DEF-08 + DEF-09 + DEF-10: Cascade deletes source -> index -> streams -> orphaned channels.
   */
  deleteSource(id: number | string): {
    deleted: boolean;
    removedSource?: SourceItem;
    removedStreams: number;
    removedChannels: number;
    persisted: boolean;
    error?: string;
  } {
    this.ensureInit();
    const removed = StreamParser.removeSource(id);
    if (!removed.deleted) {
      return {
        deleted: false,
        removedStreams: 0,
        removedChannels: 0,
        persisted: removed.persisted,
        error: removed.error || 'Источник не найден',
      };
    }

    const catId = removed.removedSource?.catalogId;
    const beforeStreams = this.streams.length;
    if (catId !== undefined) {
      this.streams = this.streams.filter((s) => s.source_id !== catId);
    }
    const directRemovedStreams = beforeStreams - this.streams.length;
    const rec = this.reconcile({ save: true });
    return {
      deleted: true,
      removedSource: removed.removedSource,
      removedStreams: directRemovedStreams + rec.removedStreams,
      removedChannels: rec.removedChannels,
      persisted: rec.persisted,
      ...(rec.error ? { error: rec.error } : {}),
    };
  }

  /**
   * DEF-10: Returns notFound if streamId doesn't exist, prunes orphaned channel if empty, persists atomically.
   */
  deleteStream(streamId: number): {
    deleted: boolean;
    removedChannels: number;
    persisted: boolean;
    error?: string;
  } {
    this.ensureInit();
    const target = this.streams.find((s) => s.id === streamId);
    if (!target) {
      return {
        deleted: false,
        removedChannels: 0,
        persisted: true,
        error: 'Поток не найден',
      };
    }

    this.streams = this.streams.filter((s) => s.id !== streamId);
    let removedChannels = 0;

    // Prune parent channel if it no longer has ANY remaining streams AND is not in any live playlist
    const remainingForChannel = this.streams.some((s) => s.channel_id === target.channel_id);
    if (!remainingForChannel) {
      const ch = this.channels.find((c) => c.id === target.channel_id);
      if (ch) {
        const ownership = this.buildLivePlaylistOwnershipMap();
        const streamsByChannel = this.buildStreamsByChannelMap();
        const usedIn = this.resolveLiveUsedIn(ch, streamsByChannel, ownership);
        if (usedIn.length === 0) {
          this.channels = this.channels.filter((c) => c.id !== ch.id);
          removedChannels = 1;
        }
      }
    }

    const saveRes = this.saveToDisk();
    return {
      deleted: true,
      removedChannels,
      persisted: saveRes.ok,
      ...(saveRes.error ? { error: saveRes.error } : {}),
    };
  }

  /**
   * Programmatically adds or ensures streams from an authoritative source during aggregation/testing.
   */
  ingestSourceItems(
    source: Pick<SourceItem, 'catalogId' | 'name' | 'type'>,
    items: Array<{ name: string; url: string; logo?: string; group?: string; tvg_id?: string }>
  ): { addedChannels: number; addedStreams: number } {
    this.ensureInit();
    const now = Math.floor(Date.now() / 1000);
    const catId = Number(source.catalogId) || null;
    let addedChannels = 0;
    let addedStreams = 0;

    for (const it of items) {
      const name = (it.name || '').trim();
      const url = (it.url || '').trim();
      if (!name || !url) continue;

      let ch = this.findByNameInternal(name);
      if (!ch) {
        const id = this.nextChannelId++;
        ch = {
          id,
          code: 'ID' + String(id).padStart(6, '0'),
          name,
          logo: it.logo || '',
          tvg_id: it.tvg_id || '',
          in_my_pl: 0,
          used_in: [],
          alt_names: [],
          created_at: now,
          updated_at: now,
        };
        this.channels.push(ch);
        addedChannels++;
      }
      if (this.addStreamInternal(ch.id, url, catId, source.name, source.type)) {
        addedStreams++;
      }
    }

    return { addedChannels, addedStreams };
  }

  async checkStream(
    url: string,
    force = false,
    persist = true,
    extraOpts: Partial<DeepCheckOptions> = {}
  ): Promise<DeepCheckResult> {
    this.ensureInit();
    const result = await checkStreamUrl(url, 9000, force, extraOpts);
    const matching = this.streams.filter((stream) => stream.url === url);
    for (const stream of matching) {
      stream.online = result.status === 'online' ? 1 : result.status === 'offline' ? -1 : 0;
      stream.http_code = result.code;
      stream.response_ms = result.ms;
      stream.checked_at = result.checkedAt;
      stream.diag_code = result.diagCode;
      stream.diag_reason = result.reason;
      if (result.codecWarning) stream.codec_warning = result.codecWarning;
      else delete stream.codec_warning;
    }
    if (persist && matching.length > 0) this.scheduleSaveToDisk();
    return result;
  }

  async checkStreams(
    limit = 500,
    force = true
  ): Promise<{ checked: number; online: number; offline: number; unknown: number; persisted: boolean; error?: string }> {
    this.ensureInit();
    const target = Array.from(
      new Set(this.streams.slice(0, limit).map((stream) => stream.url).filter(Boolean))
    );
    let onlineCount = 0;
    let offlineCount = 0;
    let unknownCount = 0;
    const batchSize = 6;

    for (let i = 0; i < target.length; i += batchSize) {
      const batch = target.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map((url) => this.checkStream(url, force, false))
      );
      for (const result of results) {
        if (result.status === 'online') onlineCount++;
        else if (result.status === 'offline') offlineCount++;
        else unknownCount++;
      }
    }
    const saveRes = this.saveToDisk();
    return {
      checked: target.length,
      online: onlineCount,
      offline: offlineCount,
      unknown: unknownCount,
      persisted: saveRes.ok,
      ...(saveRes.error ? { error: saveRes.error } : {}),
    };
  }

  findAlternativeStreams(
    channelName: string,
    tvgId = '',
    excludeUrls: string[] = []
  ): Array<{
    url: string;
    name: string;
    source: string;
    online: number;
    diagCode?: string;
    userAgent?: string;
    referer?: string;
    origin?: string;
  }> {
    this.ensureInit();
    const excluded = new Set(excludeUrls.map((u) => u.trim()).filter(Boolean));
    const qLower = channelName.trim().toLowerCase();
    const qNorm = normalizeChannelName(channelName);
    const cleanTvg = tvgId.trim().toLowerCase();
    const byUrl = new Map<
      string,
      {
        url: string;
        name: string;
        source: string;
        online: number;
        diagCode?: string;
        userAgent?: string;
        referer?: string;
        origin?: string;
      }
    >();

    for (const ch of this.channels) {
      const nameMatch =
        ch.name.trim().toLowerCase() === qLower ||
        (qNorm && normalizeChannelName(ch.name) === qNorm) ||
        (cleanTvg && ch.tvg_id.trim().toLowerCase() === cleanTvg) ||
        ch.alt_names.some(
          (a) => a.trim().toLowerCase() === qLower || (qNorm && normalizeChannelName(a) === qNorm)
        );
      if (!nameMatch) continue;
      for (const s of this.streams) {
        if (s.channel_id !== ch.id) continue;
        const u = (s.url || '').trim();
        if (!u || excluded.has(u) || byUrl.has(u)) continue;
        byUrl.set(u, {
          url: u,
          name: ch.name,
          source: s.source_name || 'Каталог',
          online: s.online,
          diagCode: s.diag_code,
        });
      }
    }

    for (const item of StreamParser.getAllIndexedStreams()) {
      const u = (item.url || '').trim();
      if (!u || excluded.has(u) || byUrl.has(u)) continue;
      const itemNorm = normalizeChannelName(item.name || '');
      const itemTvg = (item.tvg_id || '').trim().toLowerCase();
      const match =
        (item.name || '').trim().toLowerCase() === qLower ||
        (qNorm && itemNorm === qNorm) ||
        (cleanTvg && itemTvg === cleanTvg);
      if (!match) continue;
      byUrl.set(u, {
        url: u,
        name: item.name,
        source: item.source || 'Источник',
        online: 0,
        userAgent: item.userAgent,
        referer: item.referer,
        origin: item.origin,
      });
    }

    if (byUrl.size === 0 && qNorm && qNorm.length >= 3) {
      for (const item of StreamParser.getAllIndexedStreams()) {
        const u = (item.url || '').trim();
        if (!u || excluded.has(u) || byUrl.has(u)) continue;
        const itemNorm = normalizeChannelName(item.name || '');
        if (itemNorm.includes(qNorm) || qNorm.includes(itemNorm)) {
          byUrl.set(u, {
            url: u,
            name: item.name,
            source: item.source || 'Источник',
            online: 0,
            userAgent: item.userAgent,
            referer: item.referer,
            origin: item.origin,
          });
          if (byUrl.size >= 15) break;
        }
      }
    }

    return Array.from(byUrl.values()).sort((a, b) => b.online - a.online);
  }

  async aggregateFromSources(): Promise<{
    ok: boolean;
    addedChannels: number;
    addedStreams: number;
    error?: string;
  }> {
    this.ensureInit();
    await StreamParser.refreshAll();
    let addedChannels = 0;
    let addedStreams = 0;
    const now = Math.floor(Date.now() / 1000);
    const parserSources = StreamParser.getSources();

    for (const src of parserSources) {
      if (!src.enabled || !src.catalogId) continue;
      try {
        const body = await StreamParser.fetchTextWithSource(src.url, src, 20000);
        if (!body) {
          StreamParser.updateSourceStats(src.catalogId, { last_run: now, last_status: 'error' });
          continue;
        }
        const items = StreamParser.parseSource(body, src).slice(0, 500);
        const res = this.ingestSourceItems(src, items);
        addedChannels += res.addedChannels;
        addedStreams += res.addedStreams;
        StreamParser.updateSourceStats(src.catalogId, {
          last_run: now,
          last_status: 'ok',
          total_found: items.length,
        });
      } catch {
        StreamParser.updateSourceStats(src.catalogId, { last_run: now, last_status: 'error' });
      }
    }

    const rec = this.reconcile({ save: true });
    return {
      ok: rec.persisted,
      addedChannels,
      addedStreams,
      ...(rec.error ? { error: rec.error } : {}),
    };
  }

  exportRawState(): {
    nextChannelId: number;
    nextStreamId: number;
    nextSourceId: number;
    channels: CatalogChannel[];
    streams: CatalogStream[];
    sources: CatalogSource[];
  } {
    this.ensureInit();
    const sources = this.getSources();
    const nextSourceId = sources.reduce((m, s) => Math.max(m, s.id + 1), 1);
    return {
      nextChannelId: this.nextChannelId,
      nextStreamId: this.nextStreamId,
      nextSourceId,
      channels: this.channels,
      streams: this.streams,
      sources,
    };
  }

  hydrateRawState(raw: {
    nextChannelId?: number;
    nextStreamId?: number;
    nextSourceId?: number;
    channels?: CatalogChannel[];
    streams?: CatalogStream[];
    sources?: CatalogSource[];
  }): { ok: boolean; reconcile?: ReconcileResult; error?: string } {
    if (!raw || typeof raw !== 'object') {
      return { ok: false, error: 'Некорректные данные каталога' };
    }
    if (!Array.isArray(raw.channels) || !Array.isArray(raw.streams)) {
      return { ok: false, error: 'Отсутствуют массивы channels/streams' };
    }
    this.channels = raw.channels;
    this.streams = raw.streams;
    this.nextChannelId =
      Number(raw.nextChannelId) || Math.max(1, ...this.channels.map((c) => Number(c.id) + 1));
    this.nextStreamId =
      Number(raw.nextStreamId) || Math.max(1, ...this.streams.map((s) => Number(s.id) + 1));
    this.initialized = true;

    // Note: Do NOT blindly restore raw.sources over authoritative StreamParser sources
    const rec = this.reconcile({ save: true });
    return {
      ok: rec.persisted,
      reconcile: rec,
      ...(rec.error ? { error: rec.error } : {}),
    };
  }
}

export const catalogStore = new CatalogStore();
