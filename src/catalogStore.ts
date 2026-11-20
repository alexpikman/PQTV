import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseM3uFile } from './m3uParser.js';
import { storage } from './storage.js';
import { normalizeChannelName, StreamParser } from './streamParser.js';

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

export async function checkStreamUrl(
  url: string,
  timeoutMs = 3000
): Promise<{ online: boolean; code: number; ms: number }> {
  const t0 = Date.now();
  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return { online: false, code: 0, ms: 0 };
  }
  try {
    let res = await fetch(url, {
      method: 'HEAD',
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Checker' },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 405 || res.status === 501) {
      res = await fetch(url, {
        method: 'GET',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) IPTV-Checker' },
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
    }
    const ms = Date.now() - t0;
    return { online: res.status >= 200 && res.status < 400, code: res.status, ms };
  } catch {
    return { online: false, code: 0, ms: Date.now() - t0 };
  }
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

  stats() {
    this.ensureInit();
    return {
      channels: this.channels.length,
      in_my_pl: this.channels.filter((c) => c.in_my_pl === 1).length,
      streams: this.streams.length,
      streams_online: this.streams.filter((s) => s.online === 1).length,
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
    const set = new Set<string>();
    for (const c of this.channels) {
      for (const pl of c.used_in) {
        if (pl) set.add(pl);
      }
    }
    return Array.from(set).sort();
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

    const streamCounts = new Map<number, { total: number; online: number }>();
    for (const s of this.streams) {
      const entry = streamCounts.get(s.channel_id) || { total: 0, online: 0 };
      entry.total++;
      if (s.online === 1) entry.online++;
      streamCounts.set(s.channel_id, entry);
    }

    const filtered = this.channels
      .filter((c) => {
        if (sLower) {
          const hay = (c.name + ' ' + c.alt_names.join(' ')).toLowerCase();
          if (!hay.includes(sLower)) return false;
        }
        const counts = streamCounts.get(c.id) || { total: 0, online: 0 };
        if (filter === 'online' && counts.online === 0) return false;
        if (filter === 'offline' && (counts.total === 0 || counts.online > 0)) return false;
        if (filter === 'no_streams' && counts.total > 0) return false;

        if (playlists.length > 0) {
          const hasMatch = playlists.some((pl) => c.used_in.includes(pl));
          if (!hasMatch) return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (b.in_my_pl !== a.in_my_pl) return b.in_my_pl - a.in_my_pl;
        return a.name.localeCompare(b.name, 'ru');
      });

    return filtered.slice(offset, offset + limit).map((c) => {
      const counts = streamCounts.get(c.id) || { total: 0, online: 0 };
      return {
        ...c,
        used_in: JSON.stringify(c.used_in),
        alt_names: JSON.stringify(c.alt_names),
        streams_count: counts.total,
        streams_online: counts.online,
      };
    });
  }

  getChannel(id: number) {
    this.ensureInit();
    const ch = this.channels.find((c) => c.id === id);
    if (!ch) return null;
    const chStreams = this.streams
      .filter((s) => s.channel_id === id)
      .sort((a, b) => b.online - a.online || b.added_at - a.added_at);
    return {
      ...ch,
      used_in: JSON.stringify(ch.used_in),
      alt_names: JSON.stringify(ch.alt_names),
      streams: chStreams,
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

  async checkStreams(limit = 500): Promise<{ checked: number; online: number }> {
    this.ensureInit();
    const target = this.streams.slice(0, limit);
    let onlineCount = 0;
    const batchSize = 15;

    for (let i = 0; i < target.length; i += batchSize) {
      const batch = target.slice(i, i + batchSize);
      await Promise.all(
        batch.map(async (s) => {
          const res = await checkStreamUrl(s.url, 3000);
          s.online = res.online ? 1 : 0;
          s.http_code = res.code;
          s.response_ms = res.ms;
          s.checked_at = Math.floor(Date.now() / 1000);
          if (res.online) onlineCount++;
        })
      );
    }
    this.saveToDisk();
    return { checked: target.length, online: onlineCount };
  }

  async aggregateFromSources(): Promise<{ addedChannels: number; addedStreams: number }> {
    this.ensureInit();
    await StreamParser.refreshAll();
    let addedChannels = 0;
    let addedStreams = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const src of this.sources) {
      if (!src.enabled) continue;
      try {
        const res = await fetch(src.url, {
          headers: { 'User-Agent': 'IPTV-Manager-Catalog/1.0' },
          signal: AbortSignal.timeout(20000),
        });
        if (!res.ok) continue;
        const body = await res.text();
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
}

export const catalogStore = new CatalogStore();
