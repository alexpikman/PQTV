import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';

export interface ApkRelease {
  id: string;
  versionCode: number;
  versionName: string;
  filename: string;
  size: number;
  sha256: string;
  changelog: string;
  mandatory: boolean;
  uploadedAt: number;
}

interface ApkRegistryFile {
  releases: ApkRelease[];
}

function getApkDir(): string {
  const dir = path.join(config.dataDir, 'apk');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getRegistryPath(): string {
  return path.join(getApkDir(), 'releases.json');
}

function loadRegistry(): ApkRegistryFile {
  const file = getRegistryPath();
  if (!fs.existsSync(file)) return { releases: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as ApkRegistryFile;
    if (Array.isArray(parsed.releases)) {
      return { releases: parsed.releases };
    }
  } catch {
    // ignore corrupt JSON
  }
  return { releases: [] };
}

function saveRegistry(reg: ApkRegistryFile): void {
  const file = getRegistryPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(reg, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// Validate standard APK / ZIP magic bytes ("PK\x03\x04")
export function isValidApkBuffer(buf: Buffer): boolean {
  return buf.length > 100 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04;
}

export const apkManager = {
  getReleases(): ApkRelease[] {
    const reg = loadRegistry();
    return reg.releases
      .filter((r) => fs.existsSync(path.join(getApkDir(), path.basename(r.filename))))
      .sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt);
  },

  getLatest(): ApkRelease | null {
    const all = this.getReleases();
    return all.length > 0 ? all[0] : null;
  },

  getApkFilePath(filename: string): string | null {
    const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!clean.endsWith('.apk')) return null;
    const full = path.join(getApkDir(), clean);
    return fs.existsSync(full) ? full : null;
  },

  getLatestFilePath(): { path: string; release: ApkRelease } | null {
    const latest = this.getLatest();
    if (!latest) return null;
    const full = this.getApkFilePath(latest.filename);
    if (!full) return null;
    return { path: full, release: latest };
  },

  publishApk(input: {
    buffer: Buffer;
    versionCode: number;
    versionName: string;
    changelog?: string;
    mandatory?: boolean;
  }): ApkRelease {
    const dir = getApkDir();
    const versionCode = Math.max(1, Math.floor(Number(input.versionCode) || 1));
    const safeName = (input.versionName || `1.0.${versionCode}`)
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 32) || `1.0.${versionCode}`;

    const id = `apk_v${versionCode}_${Date.now()}`;
    const filename = `pqtv-tv-v${safeName}-c${versionCode}.apk`;
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, input.buffer);
    const sha256 = crypto.createHash('sha256').update(input.buffer).digest('hex');

    const release: ApkRelease = {
      id,
      versionCode,
      versionName: safeName,
      filename,
      size: input.buffer.length,
      sha256,
      changelog: String(input.changelog || '').trim().slice(0, 1000),
      mandatory: Boolean(input.mandatory),
      uploadedAt: Math.floor(Date.now() / 1000),
    };

    const reg = loadRegistry();
    reg.releases = reg.releases.filter((r) => r.filename !== filename);
    reg.releases.push(release);
    // Keep up to 10 historical releases
    reg.releases.sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt);
    if (reg.releases.length > 10) {
      for (const old of reg.releases.slice(10)) {
        try {
          const oldPath = path.join(dir, path.basename(old.filename));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch {
          // ignore
        }
      }
      reg.releases = reg.releases.slice(0, 10);
    }
    saveRegistry(reg);
    return release;
  },

  deleteRelease(id: string): boolean {
    const reg = loadRegistry();
    const target = reg.releases.find((r) => r.id === id);
    if (!target) return false;
    reg.releases = reg.releases.filter((r) => r.id !== id);
    saveRegistry(reg);
    try {
      const full = path.join(getApkDir(), path.basename(target.filename));
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      // ignore
    }
    return true;
  },
};

// ===== ZERO-DEP ZIP ARCHIVER FOR ANDROID TV PROJECT =====
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntryInput {
  name: string;
  data: Buffer;
}

export function buildZipBuffer(entries: ZipEntryInput[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf-8');
    const uncompressed = entry.data;
    const compressed = zlib.deflateRawSync(uncompressed);
    const crc = crc32(uncompressed);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 filename flag
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(uncompressed.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    localParts.push(local, compressed);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(uncompressed.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    centralParts.push(central);
    offset += local.length + compressed.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function collectFilesRecursive(dirPath: string, basePrefix = ''): ZipEntryInput[] {
  if (!fs.existsSync(dirPath)) return [];
  const entries: ZipEntryInput[] = [];
  for (const item of fs.readdirSync(dirPath, { withFileTypes: true })) {
    if (item.name === 'build' || item.name === '.gradle' || item.name === '.idea') continue;
    const full = path.join(dirPath, item.name);
    const rel = basePrefix ? `${basePrefix}/${item.name}` : item.name;
    if (item.isDirectory()) {
      entries.push(...collectFilesRecursive(full, rel));
    } else if (item.isFile()) {
      entries.push({ name: rel, data: fs.readFileSync(full) });
    }
  }
  return entries;
}

export function buildAndroidTvProjectZip(serverOrigin: string, nextVersionCode = 1, nextVersionName = '1.0.0'): Buffer {
  const androidDir = path.resolve(process.cwd(), 'android-tv');
  const rawEntries = collectFilesRecursive(androidDir, 'pqtv-android-tv');
  const workflowFile = path.resolve(process.cwd(), '.github/workflows/build-apk.yml');
  if (fs.existsSync(workflowFile)) {
    rawEntries.push({
      name: 'pqtv-android-tv/.github/workflows/build-apk.yml',
      data: fs.readFileSync(workflowFile),
    });
  }

  const cleanOrigin = serverOrigin.replace(/\/+$/, '');
  const patched = rawEntries.map((e) => {
    if (e.name.endsWith('app/build.gradle.kts')) {
      let text = e.data.toString('utf-8');
      text = text
        .replace(/__PQTV_SERVER_URL__/g, cleanOrigin)
        .replace(/versionCode\s*=\s*\d+/, `versionCode = ${nextVersionCode}`)
        .replace(/versionName\s*=\s*"[^"]*"/, `versionName = "${nextVersionName}"`);
      return { name: e.name, data: Buffer.from(text, 'utf-8') };
    }
    return e;
  });

  return buildZipBuffer(patched);
}
