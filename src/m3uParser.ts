import fs from 'node:fs';

export interface Channel {
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

export function parseM3uContent(content: string): Channel[] {
  const lines = content.split(/\r\n|\r|\n/);
  const channels: Channel[] = [];
  let current: Channel | null = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      current = { name: '', group: '', logo: '', url: '', tvg_id: '' };
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/i);
      if (tvgIdMatch) current.tvg_id = tvgIdMatch[1];
      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      if (logoMatch) current.logo = logoMatch[1];
      const groupMatch = line.match(/group-title="([^"]*)"/i);
      if (groupMatch) current.group = groupMatch[1];
      const pausedMatch = line.match(/pqtv-paused="([^"]*)"/i);
      if (pausedMatch && (pausedMatch[1] === '1' || pausedMatch[1].toLowerCase() === 'true')) {
        current.paused = true;
      }
      const commaIdx = line.indexOf(',');
      if (commaIdx !== -1) {
        current.name = line.slice(commaIdx + 1).trim();
      }
    } else if (current !== null && line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      const eqIdx = opt.indexOf('=');
      if (eqIdx > 0) {
        const key = opt.slice(0, eqIdx).trim().toLowerCase();
        const val = opt.slice(eqIdx + 1).trim();
        if (key === 'http-user-agent' && val) current.userAgent = val;
        else if ((key === 'http-referrer' || key === 'http-referer') && val) current.referer = val;
        else if (key === 'http-origin' && val) current.origin = val;
      }
    } else if (current !== null && !line.startsWith('#')) {
      current.url = line;
      channels.push(current);
      current = null;
    }
  }

  return channels;
}

export function parseM3uFile(filePath: string): Channel[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return parseM3uContent(content);
  } catch {
    return [];
  }
}

function escapeAttr(val: string): string {
  return val.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function generateM3u(channels: Partial<Channel>[]): string {
  let out = '#EXTM3U\n';
  for (const ch of channels) {
    const name = ch.name || 'Untitled';
    const group = ch.group || '';
    const logo = ch.logo || '';
    const url = ch.url || '';
    const tvgId = ch.tvg_id || '';

    const attrs: string[] = [];
    if (tvgId !== '') attrs.push(`tvg-id="${escapeAttr(tvgId)}"`);
    if (logo !== '') attrs.push(`tvg-logo="${escapeAttr(logo)}"`);
    if (group !== '') attrs.push(`group-title="${escapeAttr(group)}"`);
    if (ch.paused) attrs.push('pqtv-paused="1"');

    const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    out += `#EXTINF:-1${attrStr},${name}\n`;
    if (ch.userAgent) out += `#EXTVLCOPT:http-user-agent=${ch.userAgent.replace(/[\r\n]+/g, ' ')}\n`;
    if (ch.referer) out += `#EXTVLCOPT:http-referrer=${ch.referer.replace(/[\r\n]+/g, ' ')}\n`;
    if (ch.origin) out += `#EXTVLCOPT:http-origin=${ch.origin.replace(/[\r\n]+/g, ' ')}\n`;
    out += `${url}\n`;
  }
  return out;
}
