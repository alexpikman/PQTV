import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { parseM3uContent } from './m3uParser.js';

export interface SourceItem {
  id: string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
}

export interface IndexedChannel {
  name: string;
  url: string;
  logo: string;
  group: string;
  tvg_id: string;
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
      return true;
    } catch {
      return false;
    }
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

  private static async fetchText(url: string, timeoutMs = 20000): Promise<string | null> {
    if (!url) return null;
    try {
      const headers: Record<string, string> = {
        'User-Agent': 'IPTV-Manager-Parser/2.0',
      };
      if (url.includes('api.github.com')) {
        headers.Accept = 'application/vnd.github+json';
      }
      const res = await fetch(url, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) return null;
      return await res.text();
    } catch {
      return null;
    }
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
    let pending: { name: string; logo: string; group: string; tvg_id: string } | null = null;

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

      if (pending && (line.startsWith('http://') || line.startsWith('https://'))) {
        if (pending.name !== '') {
          items.push({
            name: pending.name,
            url: line,
            logo: pending.logo,
            group: pending.group,
            tvg_id: pending.tvg_id,
          });
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
        const body = await this.fetchText(src.url, 30000);
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
        const body = await this.fetchText(src.url, 30000);
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
}
