import fs from 'node:fs';

export interface Channel {
  name: string;
  group: string;
  logo: string;
  url: string;
  tvg_id: string;
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
      const tvgIdMatch = line.match(/tvg-id="([^"]*)"/);
      if (tvgIdMatch) current.tvg_id = tvgIdMatch[1];
      const logoMatch = line.match(/tvg-logo="([^"]*)"/);
      if (logoMatch) current.logo = logoMatch[1];
      const groupMatch = line.match(/group-title="([^"]*)"/);
      if (groupMatch) current.group = groupMatch[1];
      const commaIdx = line.indexOf(',');
      if (commaIdx !== -1) {
        current.name = line.slice(commaIdx + 1).trim();
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

    const attrStr = attrs.length > 0 ? ' ' + attrs.join(' ') : '';
    out += `#EXTINF:-1${attrStr},${name}\n${url}\n`;
  }
  return out;
}
