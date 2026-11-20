import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseM3uContent } from './m3uParser.js';

import { fetchBytesWithNode, buildOutboundHeaders } from './streamChecker.js';

export interface SourceItem {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  userAgent?: string;
  referer?: string;
  origin?: string;
  customHeaders?: Record<string, string>;
  timeoutSec?: number;
  ignoreTlsErrors?: boolean;
}

export interface SourceRequestOptions {
  headers: Record<string, string>;
  userAgent?: string;
  referer?: string;
  origin?: string;
  timeoutMs: number;
  ignoreTlsErrors: boolean;
  sourceName?: string;
}

export interface IndexedChannel {
  name: string;
  url: string;
  logo: string;
  group: string;
  tvg_id: string;
  userAgent?: string;
  referer?: string;
  origin?: string;
}

export interface SearchResult extends IndexedChannel {
  title: string;
  source: string;
}

const INDEX_TTL = 6 * 3600;
const MAX_RESULTS = 40;

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export function normalizeChannelName(s: string): string {
  return s
    .trim()
    .toLowerCase()
    .replace(/\b(hd|fullhd|fhd|uhd|4k|sd|1080p?|720p?|hevc|\+\d+)\b/gi, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

let cachedUrlToSource: Map<string, SourceItem> | null = null;
let cachedOriginToSource: Map<string, SourceItem> | null = null;

function invalidateSourceLookup(): void {
  cachedUrlToSource = null;
  cachedOriginToSource = null;
}

function buildSourceRequestOptions(src?: SourceItem | null): SourceRequestOptions {
  if (!src) {
    return {
      headers: {},
      timeoutMs: 12000,
      ignoreTlsErrors: false,
    };
  }
  const timeoutSec = Number(src.timeoutSec) || 0;
  const timeoutMs = timeoutSec > 0 ? Math.max(3000, Math.min(60000, timeoutSec * 1000)) : 12000;
  const headers: Record<string, string> = {};
  if (src.customHeaders && typeof src.customHeaders === 'object') {
    for (const [k, v] of Object.entries(src.customHeaders)) {
      if (k && typeof v === 'string' && v.trim()) {
        headers[k.trim()] = v.trim();
      }
    }
  }
  return {
    headers,
    userAgent: src.userAgent?.trim() || undefined,
    referer: src.referer?.trim() || undefined,
    origin: src.origin?.trim() || undefined,
    timeoutMs,
    ignoreTlsErrors: Boolean(src.ignoreTlsErrors),
    sourceName: src.name || undefined,
  };
}

export class StreamParser {
  private static getSourcesFile(): string {
    return path.join(config.dataDir, 'sources.json');
  }

  private static getIndexDir(): string {
    const dir = path.join(config.cacheDir, 'source_index');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static getSources(): SourceItem[] {
    const file = this.getSourcesFile();
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static saveSources(sources: SourceItem[]): boolean {
    try {
      const file = this.getSourcesFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(sources, null, 4), 'utf-8');
      invalidateSourceLookup();
      return true;
    } catch {
      return false;
    }
  }

  static getSourceRequestOptions(streamUrl: string): SourceRequestOptions {
    const clean = String(streamUrl || '').trim();
    if (!clean) return buildSourceRequestOptions(null);

    if (!cachedUrlToSource || !cachedOriginToSource) {
      cachedUrlToSource = new Map<string, SourceItem>();
      cachedOriginToSource = new Map<string, SourceItem>();
      const dir = this.getIndexDir();
      for (const src of this.getSources()) {
        if (!src.enabled) continue;
        if (src.url) {
          cachedUrlToSource.set(src.url.trim(), src);
          try {
            cachedOriginToSource.set(new URL(src.url).origin, src);
          } catch {
            // ignore invalid source url
          }
        }
        const id = safeId(src.id || '');
        if (!id) continue;
        const idxFile = path.join(dir, `${id}.json`);
        if (!fs.existsSync(idxFile)) continue;
        try {
          const arr = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
          if (Array.isArray(arr)) {
            for (const ch of arr) {
              const u = typeof ch?.url === 'string' ? ch.url.trim() : '';
              if (!u) continue;
              if (!cachedUrlToSource.has(u)) {
                cachedUrlToSource.set(u, src);
              }
              try {
                const orig = new URL(u).origin;
                if (!cachedOriginToSource.has(orig)) {
                  cachedOriginToSource.set(orig, src);
                }
              } catch {
                // ignore
              }
            }
          }
        } catch {
          // ignore
        }
      }
    }

    const direct = cachedUrlToSource.get(clean);
    if (direct) return buildSourceRequestOptions(direct);
    try {
      const originMatch = cachedOriginToSource.get(new URL(clean).origin);
      if (originMatch) return buildSourceRequestOptions(originMatch);
    } catch {
      // ignore
    }
    return buildSourceRequestOptions(null);
  }

  static getAllIndexedStreams(): SearchResult[] {
    const dir = this.getIndexDir();
    const out: SearchResult[] = [];
    for (const src of this.getSources()) {
      if (!src.enabled) continue;
      const id = safeId(src.id || '');
      if (!id) continue;
      const idxFile = path.join(dir, `${id}.json`);
      if (!fs.existsSync(idxFile)) continue;
      try {
        const items = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
        if (!Array.isArray(items)) continue;
        for (const it of items as IndexedChannel[]) {
          if (!it?.name || !it?.url) continue;
          out.push({
            ...it,
            title: it.name,
            source: src.name || 'Источник',
          });
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  static getIndexStatus() {
    const dir = this.getIndexDir();
    const now = Math.floor(Date.now() / 1000);
    return this.getSources()
      .map((src) => {
        const id = safeId(src.id || '');
        if (!id) return null;
        const idxFile = path.join(dir, `${id}.json`);
        const metaFile = path.join(dir, `${id}.meta`);
        let count = 0;
        if (fs.existsSync(idxFile)) {
          try {
            const arr = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
            if (Array.isArray(arr)) count = arr.length;
          } catch {
            // ignore
          }
        }
        let ts = 0;
        if (fs.existsSync(metaFile)) {
          ts = parseInt(fs.readFileSync(metaFile, 'utf-8').trim(), 10) || 0;
        }
        const age = ts ? now - ts : 0;
        return {
          id: src.id || '',
          name: src.name || '',
          enabled: Boolean(src.enabled),
          indexed: count,
          updated_at: ts,
          age_seconds: age,
          stale: !ts || age > INDEX_TTL,
        };
      })
      .filter(Boolean);
  }

  static async fetchTextWithSource(
    url: string,
    src?: Partial<SourceItem>,
    timeoutMs = 20000
  ): Promise<string | null> {
    if (!url) return null;
    try {
      const effectiveTimeout = src?.timeoutSec
        ? Math.max(3000, Math.min(60000, Number(src.timeoutSec) * 1000))
        : timeoutMs;
      const custom: Record<string, string> = { ...(src?.customHeaders || {}) };
      if (url.includes('api.github.com') && !custom.Accept) {
        custom.Accept = 'application/vnd.github+json';
      }
      const headers = buildOutboundHeaders({
        headers: custom,
        userAgent: src?.userAgent,
        referer: src?.referer,
        origin: src?.origin,
        defaultUa: 'IPTV-Manager-Parser/2.0',
      });
      const res = await fetchBytesWithNode(url, {
        timeoutMs: effectiveTimeout,
        maxBytes: 12 * 1024 * 1024,
        headers,
        ignoreTlsErrors: Boolean(src?.ignoreTlsErrors),
      });
      if (res.status < 200 || res.status >= 400) return null;
      return res.body.toString('utf-8');
    } catch {
      return null;
    }
  }

  private static async fetchText(url: string, timeoutMs = 20000, src?: SourceItem): Promise<string | null> {
    return this.fetchTextWithSource(url, src, timeoutMs);
  }

  static parseSource(body: string, src: SourceItem): IndexedChannel[] {
    const type = (src.type || 'm3u').toLowerCase();
    if (type === 'json') {
      return this.parseJson(body);
    }
    if (type === 'github') {
      return this.parseGithub(body);
    }
    if (type === 'site' || type === 'forum') {
      if (body.includes('#EXTINF:')) {
        return this.parseM3u(body);
      }
      return this.parseHtmlStreams(body, src.name);
    }
    // 'm3u' and 'xtream' (M3U Plus URL) both return standard #EXTM3U format
    return this.parseM3u(body);
  }

  private static parseGithub(body: string): IndexedChannel[] {
    const trimmed = body.trim();
    if (trimmed.startsWith('#EXTM3U') || trimmed.includes('#EXTINF:')) {
      return this.parseM3u(body);
    }
    try {
      const json = JSON.parse(body) as {
        items?: Array<{
          name?: string;
          html_url?: string;
          download_url?: string;
          raw_url?: string;
          repository?: { full_name?: string };
        }>;
      };
      if (Array.isArray(json.items)) {
        const out: IndexedChannel[] = [];
        for (const it of json.items) {
          const url = it.download_url || it.raw_url || it.html_url || '';
          const name = it.name || it.repository?.full_name || '';
          if (name && url) {
            out.push({
              name,
              url,
              logo: '',
              group: 'GitHub',
              tvg_id: '',
            });
          }
        }
        return out;
      }
    } catch {
      // Fallback to JSON/M3U parser
    }
    return this.parseJson(body);
  }

  private static parseHtmlStreams(body: string, sourceName: string): IndexedChannel[] {
    const items: IndexedChannel[] = [];
    const seen = new Set<string>();
    const urlRe = /https?:\/\/[^\s"'<>()]+?\.(?:m3u8?|ts)(?:\?[^\s"'<>()]*)?/gi;
    let m: RegExpExecArray | null;
    while ((m = urlRe.exec(body)) !== null) {
      const url = m[0];
      if (seen.has(url)) continue;
      seen.add(url);
      let name = '';
      try {
        const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || 'Stream';
        name = seg.replace(/\.(m3u8?|ts)$/i, '').replace(/[_-]+/g, ' ').trim() || 'Stream';
      } catch {
        name = 'Stream';
      }
      items.push({
        name,
        url,
        logo: '',
        group: sourceName || 'Импорт',
        tvg_id: '',
      });
      if (items.length >= 200) break;
    }
    return items;
  }

  private static parseM3u(body: string): IndexedChannel[] {
    const lines = body.split(/\r\n|\r|\n/);
    const items: IndexedChannel[] = [];
    let pending: {
      name: string;
      logo: string;
      group: string;
      tvg_id: string;
      userAgent?: string;
      referer?: string;
      origin?: string;
    } | null = null;

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;

      if (line.startsWith('#EXTINF:')) {
        let name = '';
        let logo = '';
        let group = '';
        let tvgId = '';

        const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
        if (logoMatch) logo = logoMatch[1];
        const groupMatch = line.match(/group-title="([^"]*)"/i);
        if (groupMatch) group = groupMatch[1];
        const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
        if (tvgIdMatch) tvgId = tvgIdMatch[1];
        const tvgNameMatch = line.match(/tvg-name="([^"]*)"/i);
        if (tvgNameMatch && tvgNameMatch[1] !== '') name = tvgNameMatch[1];

        const commaPos = line.lastIndexOf(',');
        if (commaPos !== -1) {
          const tail = line.slice(commaPos + 1).trim();
          if (tail !== '') name = tail;
        }
        pending = { name, logo, group, tvg_id: tvgId };
        continue;
      }

      if (pending && line.startsWith('#EXTVLCOPT:')) {
        const opt = line.slice('#EXTVLCOPT:'.length).trim();
        const eqIdx = opt.indexOf('=');
        if (eqIdx > 0) {
          const key = opt.slice(0, eqIdx).trim().toLowerCase();
          const val = opt.slice(eqIdx + 1).trim();
          if (key === 'http-user-agent' && val) pending.userAgent = val;
          else if ((key === 'http-referrer' || key === 'http-referer') && val) pending.referer = val;
          else if (key === 'http-origin' && val) pending.origin = val;
        }
        continue;
      }

      if (pending && (line.startsWith('http://') || line.startsWith('https://'))) {
        if (pending.name !== '') {
          const item: IndexedChannel = {
            name: pending.name,
            url: line,
            logo: pending.logo,
            group: pending.group,
            tvg_id: pending.tvg_id,
          };
          if (pending.userAgent) item.userAgent = pending.userAgent;
          if (pending.referer) item.referer = pending.referer;
          if (pending.origin) item.origin = pending.origin;
          items.push(item);
        }
        pending = null;
      }
    }
    return items;
  }

  private static parseJson(body: string): IndexedChannel[] {
    try {
      const json = JSON.parse(body);
      let list: unknown = json;
      if (json && typeof json === 'object' && !Array.isArray(json)) {
        for (const key of ['channels', 'items', 'data', 'list', 'results', 'streams']) {
          if (Array.isArray((json as Record<string, unknown>)[key])) {
            list = (json as Record<string, unknown>)[key];
            break;
          }
        }
      }
      if (!Array.isArray(list)) return [];
      const items: IndexedChannel[] = [];
      for (const raw of list) {
        if (!raw || typeof raw !== 'object') continue;
        const it = raw as Record<string, unknown>;
        const name = String(it.name || it.title || it['tvg-name'] || '');
        const url = String(it.url || it.stream || it.stream_url || it.link || '');
        if (!name || !url) continue;
        items.push({
          name,
          url,
          logo: String(it.logo || it['tvg-logo'] || ''),
          group: String(it.group || it.category || it['group-title'] || ''),
          tvg_id: String(it.tvg_id || it['tvg-id'] || ''),
        });
      }
      return items;
    } catch {
      return [];
    }
  }

  private static writeIndex(id: string, items: IndexedChannel[]): void {
    const dir = this.getIndexDir();
    const file = path.join(dir, `${id}.json`);
    const meta = path.join(dir, `${id}.meta`);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), 'utf-8');
    fs.renameSync(tmp, file);
    fs.writeFileSync(meta, String(Math.floor(Date.now() / 1000)), 'utf-8');
    invalidateSourceLookup();
  }

  static async refreshAll(): Promise<{
    ok: boolean;
    total: number;
    elapsed: number;
    results: Record<string, { ok: boolean; count: number; error?: string }>;
  }> {
    const sources = this.getSources().filter((s) => s.enabled);
    if (sources.length === 0) {
      return { ok: true, total: 0, elapsed: 0, results: {} };
    }

    const t0 = Date.now();
    const results: Record<string, { ok: boolean; count: number; error?: string }> = {};

    await Promise.all(
      sources.map(async (src) => {
        const id = safeId(src.id || '');
        if (!id) return;
        const body = await this.fetchText(src.url, 30000, src);
        if (!body) {
          results[id] = { ok: false, count: 0, error: 'не удалось загрузить' };
          return;
        }
        const items = this.parseSource(body, src);
        if (items.length > 0) {
          this.writeIndex(id, items);
          results[id] = { ok: true, count: items.length };
        } else {
          results[id] = { ok: false, count: 0, error: 'не распарсилось' };
        }
      })
    );

    return {
      ok: true,
      total: sources.length,
      elapsed: Number(((Date.now() - t0) / 1000).toFixed(2)),
      results,
    };
  }

  static async refreshStale(): Promise<{
    ok: boolean;
    total: number;
    results: Record<string, { ok: boolean; count: number }>;
  }> {
    const dir = this.getIndexDir();
    const now = Math.floor(Date.now() / 1000);
    const staleSources = this.getSources().filter((src) => {
      if (!src.enabled) return false;
      const id = safeId(src.id || '');
      const meta = path.join(dir, `${id}.meta`);
      if (!fs.existsSync(meta)) return true;
      const ts = parseInt(fs.readFileSync(meta, 'utf-8').trim(), 10) || 0;
      return now - ts > INDEX_TTL;
    });

    if (staleSources.length === 0) {
      return { ok: true, total: 0, results: {} };
    }

    const results: Record<string, { ok: boolean; count: number }> = {};
    await Promise.all(
      staleSources.map(async (src) => {
        const id = safeId(src.id || '');
        const body = await this.fetchText(src.url, 30000, src);
        if (!body) {
          results[id] = { ok: false, count: 0 };
          return;
        }
        const items = this.parseSource(body, src);
        if (items.length > 0) {
          this.writeIndex(id, items);
          results[id] = { ok: true, count: items.length };
        } else {
          results[id] = { ok: false, count: 0 };
        }
      })
    );

    return { ok: true, total: staleSources.length, results };
  }

  static search(query: string): SearchResult[] {
    const q = query.trim();
    if (!q) return [];

    // Background refresh of stale indexes if needed
    void this.refreshStale().catch(() => {});

    const dir = this.getIndexDir();
    const qLower = q.toLowerCase();
    const qNorm = normalizeChannelName(q);
    const results: SearchResult[] = [];

    for (const src of this.getSources()) {
      if (!src.enabled) continue;
      const id = safeId(src.id || '');
      if (!id) continue;
      const idxFile = path.join(dir, `${id}.json`);
      if (!fs.existsSync(idxFile)) continue;

      let items: IndexedChannel[] = [];
      try {
        const parsed = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
        if (Array.isArray(parsed)) items = parsed;
      } catch {
        continue;
      }

      for (const it of items) {
        const name = it.name || '';
        if (!name) continue;
        const nameLower = name.toLowerCase();
        let match = nameLower.includes(qLower);
        if (!match && qNorm !== '') {
          match = normalizeChannelName(name).includes(qNorm);
        }
        if (match) {
          results.push({
            title: name,
            name,
            url: it.url || '',
            logo: it.logo || '',
            group: it.group || '',
            tvg_id: it.tvg_id || '',
            userAgent: it.userAgent || src.userAgent,
            referer: it.referer || src.referer,
            origin: it.origin || src.origin,
            source: src.name || '?',
          });
          if (results.length >= 500) break;
        }
      }
      if (results.length >= 500) break;
    }

    // Fallback: also search local playlists if index hasn't been populated yet
    if (results.length === 0 && fs.existsSync(config.playlistDir)) {
      for (const f of fs.readdirSync(config.playlistDir)) {
        if (!f.endsWith('.m3u')) continue;
        const content = fs.readFileSync(path.join(config.playlistDir, f), 'utf-8');
        const parsed = parseM3uContent(content);
        for (const ch of parsed) {
          const nameLower = ch.name.toLowerCase();
          if (nameLower.includes(qLower) || (qNorm && normalizeChannelName(ch.name).includes(qNorm))) {
            results.push({
              title: ch.name,
              name: ch.name,
              url: ch.url,
              logo: ch.logo,
              group: ch.group,
              tvg_id: ch.tvg_id,
              source: f,
            });
          }
        }
      }
    }

    const seen = new Set<string>();
    const final: SearchResult[] = [];
    for (const r of results) {
      const k = r.url.toLowerCase();
      if (seen.has(k)) continue;
      seen.add(k);
      final.push(r);
      if (final.length >= MAX_RESULTS) break;
    }

    return final;
  }

  static clearIndex(sourceId?: string | null): void {
    const dir = this.getIndexDir();
    invalidateSourceLookup();
    if (!sourceId) {
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          try {
            fs.unlinkSync(path.join(dir, f));
          } catch {
            // ignore
          }
        }
      }
      return;
    }
    const id = safeId(sourceId);
    for (const ext of ['.json', '.meta']) {
      const p = path.join(dir, `${id}${ext}`);
      if (fs.existsSync(p)) {
        try {
          fs.unlinkSync(p);
        } catch {
          // ignore
        }
      }
    }
  }

  static exportIndexData(): Record<string, { items: IndexedChannel[]; updatedAt: number }> {
    const dir = this.getIndexDir();
    const out: Record<string, { items: IndexedChannel[]; updatedAt: number }> = {};
    for (const src of this.getSources()) {
      const id = safeId(src.id || '');
      if (!id) continue;
      const idxFile = path.join(dir, `${id}.json`);
      const metaFile = path.join(dir, `${id}.meta`);
      if (!fs.existsSync(idxFile)) continue;
      try {
        const items = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
        const updatedAt = fs.existsSync(metaFile)
          ? parseInt(fs.readFileSync(metaFile, 'utf-8').trim(), 10) || 0
          : 0;
        if (Array.isArray(items)) {
          out[id] = { items, updatedAt };
        }
      } catch {
        // ignore corrupt cache file
      }
    }
    return out;
  }

  static hydrateIndexData(
    indexMap: Record<string, { items?: IndexedChannel[]; updatedAt?: number }>
  ): number {
    if (!indexMap || typeof indexMap !== 'object') return 0;
    const dir = this.getIndexDir();
    let count = 0;
    for (const [rawId, entry] of Object.entries(indexMap)) {
      const id = safeId(rawId);
      if (!id || !entry || !Array.isArray(entry.items)) continue;
      try {
        const file = path.join(dir, `${id}.json`);
        const meta = path.join(dir, `${id}.meta`);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(entry.items), 'utf-8');
        fs.renameSync(tmp, file);
        const ts = Number(entry.updatedAt) || Math.floor(Date.now() / 1000);
        fs.writeFileSync(meta, String(ts), 'utf-8');
        count++;
      } catch {
        // ignore
      }
    }
    if (count > 0) invalidateSourceLookup();
    return count;
  }
}
