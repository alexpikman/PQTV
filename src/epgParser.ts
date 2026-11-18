import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from './config.js';
import { normalizeChannelName } from './streamParser.js';

export interface EpgSource {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface EpgProgramme {
  start: number;
  stop: number;
  title: string;
  desc: string;
}

const CACHE_TTL = 6 * 3600;
const TIME_PAST = -12 * 3600;
const TIME_FUTURE = 48 * 3600;

function safeId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, '_');
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function parseXmltvTime(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return 0;
  const m = trimmed.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})?/);
  if (m) {
    const [, y, mo, d, h, mi, sec, tz] = m;
    const tzStr = tz ? `${tz.slice(0, 3)}:${tz.slice(3)}` : '+00:00';
    const iso = `${y}-${mo}-${d}T${h}:${mi}:${sec}${tzStr}`;
    const ms = Date.parse(iso);
    if (!Number.isNaN(ms)) return Math.floor(ms / 1000);
  }
  const ms = Date.parse(trimmed);
  return Number.isNaN(ms) ? 0 : Math.floor(ms / 1000);
}

export class EpgParser {
  private static lookupCache = new Map<string, Record<string, string>>();
  private static inflightBuilds = new Map<string, Promise<string>>();

  private static getEpgFile(): string {
    return path.join(config.dataDir, 'epg.json');
  }

  private static getCacheDir(): string {
    const dir = path.join(config.cacheDir, 'epg');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  static getSources(): EpgSource[] {
    const file = this.getEpgFile();
    if (!fs.existsSync(file)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  static saveSources(epg: EpgSource[]): boolean {
    try {
      const file = this.getEpgFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(epg, null, 4), 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  private static getEnabledSources(): EpgSource[] {
    return this.getSources().filter((s) => Boolean(s.enabled));
  }

  private static sourceDir(src: EpgSource): string {
    return path.join(this.getCacheDir(), safeId(src.id || 'x'));
  }

  private static async ensureSource(src: EpgSource): Promise<string> {
    const dir = this.sourceDir(src);
    const meta = path.join(dir, '.meta');
    const now = Math.floor(Date.now() / 1000);

    if (fs.existsSync(meta) && fs.existsSync(path.join(dir, 'ch'))) {
      const ts = parseInt(fs.readFileSync(meta, 'utf-8').trim(), 10) || 0;
      if (now - ts < CACHE_TTL) {
        return dir;
      }
    }

    const existing = this.inflightBuilds.get(dir);
    if (existing) return existing;

    const task = this.rebuildSource(src).finally(() => {
      this.inflightBuilds.delete(dir);
    });
    this.inflightBuilds.set(dir, task);
    return task;
  }

  private static async rebuildSource(src: EpgSource): Promise<string> {
    const dir = this.sourceDir(src);
    try {
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
      fs.mkdirSync(path.join(dir, 'ch'), { recursive: true });

      const res = await fetch(src.url, {
        headers: { 'User-Agent': 'IPTV-Manager-EPG/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) return '';

      const rawBuf = Buffer.from(await res.arrayBuffer());
      if (rawBuf.length < 500) return '';

      let xmlText = '';
      if (rawBuf[0] === 0x1f && rawBuf[1] === 0x8b) {
        xmlText = zlib.gunzipSync(rawBuf).toString('utf-8');
      } else {
        xmlText = rawBuf.toString('utf-8');
      }

      if (xmlText.length < 200) return '';

      const total = this.parseXmltvToDir(xmlText, dir);
      if (total > 0) {
        fs.writeFileSync(path.join(dir, '.meta'), String(Math.floor(Date.now() / 1000)), 'utf-8');
        this.lookupCache.delete(dir);
        return dir;
      }
      return '';
    } catch {
      return '';
    }
  }

  private static parseXmltvToDir(xml: string, dir: string): number {
    const channels: Record<string, string[]> = {};
    const lookup: Record<string, string> = {};
    const programmesByChannel = new Map<string, EpgProgramme[]>();

    const now = Math.floor(Date.now() / 1000);
    const minTs = now + TIME_PAST;
    const maxTs = now + TIME_FUTURE;

    // Parse <channel ...>...</channel>
    const channelRe = /<channel\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/channel>/gi;
    let chMatch: RegExpExecArray | null;
    while ((chMatch = channelRe.exec(xml)) !== null) {
      const chId = decodeXmlEntities(chMatch[1]).trim();
      const body = chMatch[2];
      if (!chId) continue;
      if (!channels[chId]) channels[chId] = [];

      const dnRe = /<display-name\b[^>]*>([\s\S]*?)<\/display-name>/gi;
      let dnMatch: RegExpExecArray | null;
      while ((dnMatch = dnRe.exec(body)) !== null) {
        const txt = decodeXmlEntities(dnMatch[1]).trim();
        if (txt) {
          channels[chId].push(txt);
          const norm = normalizeChannelName(txt);
          if (norm && !lookup[norm]) {
            lookup[norm] = chId;
          }
        }
      }
    }

    // Parse <programme ...>...</programme>
    const progRe = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
    let pMatch: RegExpExecArray | null;
    let total = 0;

    while ((pMatch = progRe.exec(xml)) !== null) {
      const attrs = pMatch[1];
      const body = pMatch[2];

      const chAttr = attrs.match(/\bchannel=["']([^"']+)["']/i);
      const startAttr = attrs.match(/\bstart=["']([^"']+)["']/i);
      const stopAttr = attrs.match(/\bstop=["']([^"']+)["']/i);

      const ch = chAttr ? decodeXmlEntities(chAttr[1]).trim() : '';
      const st = startAttr ? parseXmltvTime(startAttr[1]) : 0;
      if (!ch || st <= minTs || st >= maxTs) continue;

      const stop = stopAttr ? parseXmltvTime(stopAttr[1]) : st + 3600;
      const titleMatch = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
      const descMatch = body.match(/<desc\b[^>]*>([\s\S]*?)<\/desc>/i);

      const title = titleMatch ? decodeXmlEntities(titleMatch[1]).trim().slice(0, 200) : '';
      const desc = descMatch ? decodeXmlEntities(descMatch[1]).trim().slice(0, 200) : '';

      let list = programmesByChannel.get(ch);
      if (!list) {
        list = [];
        programmesByChannel.set(ch, list);
      }
      list.push({
        start: st,
        stop: stop || st + 3600,
        title: title || '(без названия)',
        desc,
      });
      total++;
    }

    fs.writeFileSync(path.join(dir, '_lookup.json'), JSON.stringify(lookup), 'utf-8');
    fs.writeFileSync(path.join(dir, '_channels.json'), JSON.stringify(channels), 'utf-8');

    for (const [chId, progs] of programmesByChannel.entries()) {
      const safe = safeId(chId);
      if (!safe) continue;
      progs.sort((a, b) => a.start - b.start);
      fs.writeFileSync(path.join(dir, 'ch', `${safe}.json`), JSON.stringify(progs), 'utf-8');
    }

    return total;
  }

  static async findForChannel(tvgId: string, name: string): Promise<EpgProgramme[]> {
    for (const src of this.getEnabledSources()) {
      const dir = await this.ensureSource(src);
      if (!dir) continue;

      if (tvgId) {
        const chFile = path.join(dir, 'ch', `${safeId(tvgId)}.json`);
        if (fs.existsSync(chFile)) {
          try {
            const list = JSON.parse(fs.readFileSync(chFile, 'utf-8'));
            if (Array.isArray(list) && list.length > 0) return list;
          } catch {
            // ignore
          }
        }
      }

      const lookupFile = path.join(dir, '_lookup.json');
      if (!fs.existsSync(lookupFile)) continue;

      let lookup = this.lookupCache.get(dir);
      if (!lookup) {
        try {
          lookup = JSON.parse(fs.readFileSync(lookupFile, 'utf-8')) || {};
          this.lookupCache.set(dir, lookup!);
        } catch {
          continue;
        }
      }

      const noBrackets = name.replace(/[[(].*?[\])]/g, '');
      const candidates = [
        normalizeChannelName(name),
        normalizeChannelName(noBrackets),
        normalizeChannelName(noBrackets.replace(/[^\p{L}\p{N}\s]+/gu, ' ')),
      ];

      for (const cand of candidates) {
        if (cand && lookup![cand]) {
          const chFile = path.join(dir, 'ch', `${safeId(lookup![cand])}.json`);
          if (fs.existsSync(chFile)) {
            try {
              const list = JSON.parse(fs.readFileSync(chFile, 'utf-8'));
              if (Array.isArray(list) && list.length > 0) return list;
            } catch {
              // ignore
            }
          }
        }
      }
    }
    return [];
  }

  static findNowNext(
    programmes: EpgProgramme[],
    now = Math.floor(Date.now() / 1000)
  ): { current: EpgProgramme | null; next: EpgProgramme | null } {
    if (!programmes.length) return { current: null, next: null };
    let current: EpgProgramme | null = null;
    let next: EpgProgramme | null = null;
    for (const p of programmes) {
      if (p.start <= now && p.stop > now) {
        current = p;
      } else if (p.start > now) {
        next = p;
        break;
      }
    }
    return { current, next };
  }

  static clearCache(): void {
    const dir = this.getCacheDir();
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    fs.mkdirSync(dir, { recursive: true });
    this.lookupCache.clear();
  }
}
