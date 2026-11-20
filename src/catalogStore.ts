import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseM3uFile } from './m3uParser.js';
import { storage } from './storage.js';
import { normalizeChannelName, StreamParser } from './streamParser.js';

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
  name: string;
  type: string;
  url: string;
  enabled: number;
  created_at: number;
  last_run?: number;
  last_status?: string;
  total_found?: number;
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

/**
 * In-memory replacement for MySQL CatalogDB (`pqtv_catalog`).
 * Seeded from local playlists and sources.json so Catalog works out of the box without MySQL.
 */
class CatalogStore {
  private channels: CatalogChannel[] = [];
  private streams: CatalogStream[] = [];
  private sources: CatalogSource[] = [];
  private nextChannelId = 1;
  private nextStreamId = 1;
  private nextSourceId = 1;
  private initialized = false;
  private catalogFile = path.join(config.dataDir, 'catalog.json');
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureInit(): void {
    if (this.initialized) return;
    this.initialized = true;
    if (!this.loadFromDisk()) {
      this.seedFromLocalFiles();
      this.saveToDisk();
    } else {
      // Merge any new playlists that appeared on disk
      this.importFromPlaylists();
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
        nextSourceId?: number;
      };
      if (!Array.isArray(raw.channels) || !Array.isArray(raw.streams)) return false;
      this.channels = raw.channels;
      this.streams = raw.streams;
      this.sources = Array.isArray(raw.sources) ? raw.sources : [];
      this.nextChannelId =
        Number(raw.nextChannelId) ||
        Math.max(1, ...this.channels.map((c) => c.id + 1));
      this.nextStreamId =
        Number(raw.nextStreamId) ||
        Math.max(1, ...this.streams.map((s) => s.id + 1));
      this.nextSourceId =
        Number(raw.nextSourceId) ||
        Math.max(1, ...this.sources.map((s) => s.id + 1));
      return true;
    } catch {
      return false;
    }
  }

  private saveToDisk(): void {
    try {
      fs.mkdirSync(path.dirname(this.catalogFile), { recursive: true });
      const tmp = `${this.catalogFile}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          nextChannelId: this.nextChannelId,
          nextStreamId: this.nextStreamId,
          nextSourceId: this.nextSourceId,
          channels: this.channels,
          streams: this.streams,
          sources: this.sources,
        }),
        'utf-8'
      );
      fs.renameSync(tmp, this.catalogFile);
    } catch {
      // ignore disk write errors
    }
  }

  private scheduleSaveToDisk(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 500);
  }

  private seedFromLocalFiles(): void {
    const now = Math.floor(Date.now() / 1000);
    for (const s of StreamParser.getSources()) {
      this.sources.push({
        id: this.nextSourceId++,
        name: s.name,
        type: s.type || 'm3u',
        url: s.url,
        enabled: s.enabled ? 1 : 0,
        created_at: now,
      });
    }
    this.importFromPlaylists();
  }

  importFromPlaylists(): { imported: number } {
    const playlists = storage.getPlaylists();
    let imported = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const pl of playlists) {
      const file = path.join(config.playlistDir, `${pl}.m3u`);
      const items = parseM3uFile(file);
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
          existing.in_my_pl = 1;
          if (!existing.used_in.includes(pl)) existing.used_in.push(pl);
          if (!existing.logo && ch.logo) existing.logo = ch.logo;
          if (!existing.tvg_id && ch.tvg_id) existing.tvg_id = ch.tvg_id;
          existing.updated_at = now;
        }
        if (ch.url) {
          this.addStreamInternal(existing.id, ch.url, null, null, null);
        }
      }
    }
    if (imported > 0) this.saveToDisk();
    return { imported };
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
    if (!url) return false;
    const dup = this.streams.find((s) => s.channel_id === channelId && s.url === url);
    if (dup) return false;
    this.streams.push({
      id: this.nextStreamId++,
      channel_id: channelId,
      url,
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
      sources: this.sources.length,
      sources_enabled: this.sources.filter((s) => s.enabled === 1).length,
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
          status: !fresh || stream.online === 0
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

  getSources(): CatalogSource[] {
    this.ensureInit();
    return [...this.sources].sort((a, b) => b.id - a.id);
  }

  addSource(name: string, type: string, url: string, enabled = 1): number {
    this.ensureInit();
    const id = this.nextSourceId++;
    this.sources.push({
      id,
      name,
      type,
      url,
      enabled,
      created_at: Math.floor(Date.now() / 1000),
    });
    this.saveToDisk();
    return id;
  }

  updateSource(id: number, patch: Partial<CatalogSource>): boolean {
    this.ensureInit();
    const src = this.sources.find((s) => s.id === id);
    if (!src) return false;
    Object.assign(src, patch);
    this.saveToDisk();
    return true;
  }

  deleteSource(id: number): void {
    this.ensureInit();
    this.sources = this.sources.filter((s) => s.id !== id);
    this.saveToDisk();
  }

  deleteStream(streamId: number): void {
    this.ensureInit();
    this.streams = this.streams.filter((s) => s.id !== streamId);
    this.saveToDisk();
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

  async checkStreams(limit = 500, force = true): Promise<{ checked: number; online: number; offline: number; unknown: number }> {
    this.ensureInit();
    const target = Array.from(new Set(
      this.streams.slice(0, limit).map((stream) => stream.url).filter(Boolean)
    ));
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
    this.saveToDisk();
    return { checked: target.length, online: onlineCount, offline: offlineCount, unknown: unknownCount };
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

    // 1. Catalog channels + streams
    for (const ch of this.channels) {
      const nameMatch =
        ch.name.trim().toLowerCase() === qLower ||
        (qNorm && normalizeChannelName(ch.name) === qNorm) ||
        (cleanTvg && ch.tvg_id.trim().toLowerCase() === cleanTvg) ||
        ch.alt_names.some((a) => a.trim().toLowerCase() === qLower || (qNorm && normalizeChannelName(a) === qNorm));
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

    // 2. Indexed streams from StreamParser
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

    // 3. Fallback fuzzy substring match in index if nothing exact found
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

  async aggregateFromSources(): Promise<{ addedChannels: number; addedStreams: number }> {
    this.ensureInit();
    await StreamParser.refreshAll();
    let addedChannels = 0;
    let addedStreams = 0;
    const now = Math.floor(Date.now() / 1000);
    const parserSources = StreamParser.getSources();

    for (const src of this.sources) {
      if (!src.enabled) continue;
      try {
        const matchingParserSrc = parserSources.find((ps) => ps.url === src.url || ps.name === src.name);
        const body = await StreamParser.fetchTextWithSource(src.url, matchingParserSrc, 20000);
        if (!body) {
          src.last_run = now;
          src.last_status = 'error';
          continue;
        }
        const items = StreamParser.parseSource(body, {
          id: String(src.id),
          name: src.name,
          type: src.type,
          url: src.url,
          enabled: true,
        });
        let found = 0;
        for (const it of items.slice(0, 500)) {
          let ch = this.findByNameInternal(it.name);
          if (!ch) {
            const id = this.nextChannelId++;
            ch = {
              id,
              code: 'ID' + String(id).padStart(6, '0'),
              name: it.name,
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
          if (this.addStreamInternal(ch.id, it.url, src.id, src.name, src.type)) {
            addedStreams++;
          }
          found++;
        }
        src.last_run = now;
        src.last_status = 'ok';
        src.total_found = found;
      } catch {
        src.last_run = now;
        src.last_status = 'error';
      }
    }
    this.saveToDisk();
    return { addedChannels, addedStreams };
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
    return {
      nextChannelId: this.nextChannelId,
      nextStreamId: this.nextStreamId,
      nextSourceId: this.nextSourceId,
      channels: this.channels,
      streams: this.streams,
      sources: this.sources,
    };
  }

  hydrateRawState(raw: {
    nextChannelId?: number;
    nextStreamId?: number;
    nextSourceId?: number;
    channels?: CatalogChannel[];
    streams?: CatalogStream[];
    sources?: CatalogSource[];
  }): boolean {
    if (!raw || typeof raw !== 'object') return false;
    if (!Array.isArray(raw.channels) || !Array.isArray(raw.streams)) return false;
    this.channels = raw.channels;
    this.streams = raw.streams;
    this.sources = Array.isArray(raw.sources) ? raw.sources : [];
    this.nextChannelId =
      Number(raw.nextChannelId) || Math.max(1, ...this.channels.map((c) => c.id + 1));
    this.nextStreamId =
      Number(raw.nextStreamId) || Math.max(1, ...this.streams.map((s) => s.id + 1));
    this.nextSourceId =
      Number(raw.nextSourceId) || Math.max(1, ...this.sources.map((s) => s.id + 1));
    this.initialized = true;
    this.saveToDisk();
    return true;
  }
}

export const catalogStore = new CatalogStore();
