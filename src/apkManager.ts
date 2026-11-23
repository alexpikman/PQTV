import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';
import { atomicWriteJsonSync, hasJsonStateSync, readJsonSync } from './persistence.js';

export type VersionBumpType = 'patch' | 'minor' | 'major';
export type ApkBlockMode = 'hard' | 'soft';

export interface ApkRelease {
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

export interface ApkPolicy {
  lastVersionCode: number;
  lastVersionName: string;
  minSupportedVersionCode: number;
  blockedVersionCodes: number[];
  blockMode: ApkBlockMode;
  blockMessage: string;
  updatedAt: number;
}

export interface ApkStateSnapshot {
  policy: ApkPolicy;
  releases: ApkRelease[];
}

export interface ApkVersionSuggestion {
  versionCode: number;
  versionName: string;
  bump: VersionBumpType;
}

export interface ApkVersionCheckResult {
  currentCode: number;
  hasApk: boolean;
  latest: ApkRelease | null;
  updateAvailable: boolean;
  isBlocked: boolean;
  mustUpdate: boolean;
  blockMode: ApkBlockMode;
  blockReason: string;
  policy: ApkPolicy;
}

interface ApkRegistryFile {
  policy: ApkPolicy;
  releases: ApkRelease[];
}

const DEFAULT_BLOCK_MESSAGE =
  'Эта версия приложения устарела и заблокирована администратором. Пожалуйста, установите обновление.';

function createDefaultPolicy(): ApkPolicy {
  return {
    lastVersionCode: 0,
    lastVersionName: '',
    minSupportedVersionCode: 0,
    blockedVersionCodes: [],
    blockMode: 'hard',
    blockMessage: DEFAULT_BLOCK_MESSAGE,
    updatedAt: 0,
  };
}

export function parseSemverTriplet(
  raw: string
): { major: number; minor: number; patch: number } | null {
  const clean = String(raw || '')
    .trim()
    .replace(/^v/i, '');
  const m = clean.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Math.max(0, parseInt(m[1], 10) || 0);
  const minor = Math.max(0, parseInt(m[2], 10) || 0);
  const patch = Math.max(0, parseInt(m[3], 10) || 0);
  return { major, minor, patch };
}

export function formatSemverTriplet(t: {
  major: number;
  minor: number;
  patch: number;
}): string {
  return `${Math.max(0, Math.floor(t.major))}.${Math.max(0, Math.floor(t.minor))}.${Math.max(
    0,
    Math.floor(t.patch)
  )}`;
}

/**
 * Decimal 0..9 rollover versioning:
 * 1.0.0 -> 1.0.9 -> 1.1.0 -> ... -> 1.9.9 -> 2.0.0
 */
export function incrementRolloverVersion(
  currentName: string,
  bump: VersionBumpType = 'patch'
): string {
  const parsed = parseSemverTriplet(currentName);
  if (!parsed) {
    if (bump === 'major') return '2.0.0';
    if (bump === 'minor') return '1.1.0';
    return '1.0.0';
  }
  let { major, minor, patch } = parsed;
  if (bump === 'major') {
    major += 1;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    if (minor < 9) {
      minor += 1;
    } else {
      major += 1;
      minor = 0;
    }
    patch = 0;
  } else {
    if (patch < 9) {
      patch += 1;
    } else if (minor < 9) {
      minor += 1;
      patch = 0;
    } else {
      major += 1;
      minor = 0;
      patch = 0;
    }
  }
  return formatSemverTriplet({ major, minor, patch });
}

export function compareVersionNames(a: string, b: string): number {
  const pa = parseSemverTriplet(a) || { major: 0, minor: 0, patch: 0 };
  const pb = parseSemverTriplet(b) || { major: 0, minor: 0, patch: 0 };
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
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

function normalizeRelease(raw: Partial<ApkRelease>): ApkRelease | null {
  if (!raw || typeof raw !== 'object') return null;
  const versionCode = Math.max(1, Math.floor(Number(raw.versionCode) || 0));
  if (!Number.isFinite(versionCode) || versionCode < 1) return null;
  const safeName =
    String(raw.versionName || `1.0.${versionCode}`)
      .trim()
      .replace(/^v/i, '')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 32) || `1.0.${versionCode}`;
  const filename =
    path.basename(String(raw.filename || `pqtv-tv-v${safeName}-c${versionCode}.apk`)).replace(
      /[^a-zA-Z0-9._-]/g,
      ''
    ) || `pqtv-tv-v${safeName}-c${versionCode}.apk`;
  const id =
    String(raw.id || `apk_v${versionCode}_${Number(raw.uploadedAt) || Date.now()}`)
      .trim()
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 80) || `apk_v${versionCode}`;

  const out: ApkRelease = {
    id,
    versionCode,
    versionName: safeName,
    filename,
    size: Math.max(0, Math.floor(Number(raw.size) || 0)),
    sha256: String(raw.sha256 || '').slice(0, 128),
    changelog: String(raw.changelog || '').trim().slice(0, 1000),
    mandatory: Boolean(raw.mandatory),
    blocked: Boolean(raw.blocked),
    uploadedAt: Math.max(0, Math.floor(Number(raw.uploadedAt) || Math.floor(Date.now() / 1000))),
  };
  if (typeof raw.blockReason === 'string' && raw.blockReason.trim()) {
    out.blockReason = raw.blockReason.trim().slice(0, 300);
  }
  if (raw.source === 'github' || raw.source === 'upload') {
    out.source = raw.source;
  }
  if (Number.isFinite(Number(raw.githubRunId)) && Number(raw.githubRunId) > 0) {
    out.githubRunId = Math.floor(Number(raw.githubRunId));
  }
  if (typeof raw.externalApkUrl === 'string' && /^https?:\/\/.+/.test(raw.externalApkUrl.trim())) {
    out.externalApkUrl = raw.externalApkUrl.trim().slice(0, 500);
  }
  return out;
}

function normalizePolicy(
  raw: Partial<ApkPolicy> | undefined | null,
  releases: ApkRelease[]
): ApkPolicy {
  const def = createDefaultPolicy();
  const obj = raw && typeof raw === 'object' ? raw : {};

  let maxCodeFromReleases = 0;
  let maxNameFromReleases = '';
  for (const r of releases) {
    if (r.versionCode > maxCodeFromReleases) {
      maxCodeFromReleases = r.versionCode;
      maxNameFromReleases = r.versionName;
    }
  }

  const lastVersionCode = Math.max(
    0,
    Math.floor(Number(obj.lastVersionCode) || 0),
    maxCodeFromReleases
  );
  let lastVersionName = String(obj.lastVersionName || '')
    .trim()
    .replace(/^v/i, '')
    .slice(0, 32);
  if (!parseSemverTriplet(lastVersionName)) {
    lastVersionName = maxNameFromReleases || '';
  } else if (maxNameFromReleases && compareVersionNames(maxNameFromReleases, lastVersionName) > 0) {
    lastVersionName = maxNameFromReleases;
  }

  const minSupportedVersionCode = Math.max(
    0,
    Math.floor(Number(obj.minSupportedVersionCode) || 0)
  );

  const blockedSet = new Set<number>();
  if (Array.isArray(obj.blockedVersionCodes)) {
    for (const c of obj.blockedVersionCodes) {
      const num = Math.floor(Number(c));
      if (Number.isFinite(num) && num >= 1) blockedSet.add(num);
    }
  }
  for (const r of releases) {
    if (r.blocked) blockedSet.add(r.versionCode);
  }

  const blockMode: ApkBlockMode = obj.blockMode === 'soft' ? 'soft' : 'hard';
  const blockMessage =
    typeof obj.blockMessage === 'string' && obj.blockMessage.trim()
      ? obj.blockMessage.trim().slice(0, 300)
      : def.blockMessage;

  return {
    lastVersionCode,
    lastVersionName,
    minSupportedVersionCode,
    blockedVersionCodes: Array.from(blockedSet).sort((a, b) => a - b).slice(0, 100),
    blockMode,
    blockMessage,
    updatedAt: Math.max(0, Math.floor(Number(obj.updatedAt) || 0)),
  };
}

function loadRegistry(): ApkRegistryFile {
  const file = getRegistryPath();
  if (!hasJsonStateSync(file)) {
    return { policy: createDefaultPolicy(), releases: [] };
  }
  try {
    const parsed = readJsonSync<Partial<ApkRegistryFile>>(file, {});
    const releases = Array.isArray(parsed.releases)
      ? parsed.releases
          .map((r) => normalizeRelease(r))
          .filter((r): r is ApkRelease => r !== null)
      : [];
    releases.sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt);
    const policy = normalizePolicy(parsed.policy, releases);
    return { policy, releases };
  } catch {
    return { policy: createDefaultPolicy(), releases: [] };
  }
}

function saveRegistry(reg: ApkRegistryFile): boolean {
  const file = getRegistryPath();
  const normalizedReleases = reg.releases
    .map((r) => normalizeRelease(r))
    .filter((r): r is ApkRelease => r !== null)
    .sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt)
    .slice(0, 15);
  const normalizedPolicy = normalizePolicy(reg.policy, normalizedReleases);
  const out = atomicWriteJsonSync(file, { policy: normalizedPolicy, releases: normalizedReleases }, 2);
  return out.ok;
}

// Validate standard APK / ZIP magic bytes ("PK\x03\x04")
export function isValidApkBuffer(buf: Buffer): boolean {
  return (
    buf.length > 100 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    buf[2] === 0x03 &&
    buf[3] === 0x04
  );
}

function hasLocalApkFile(release: ApkRelease): boolean {
  return fs.existsSync(path.join(getApkDir(), path.basename(release.filename)));
}

function isDownloadableRelease(release: ApkRelease): boolean {
  return hasLocalApkFile(release) || Boolean(release.externalApkUrl);
}

function computeIsBlocked(
  versionCode: number,
  policy: ApkPolicy,
  release?: ApkRelease | null
): boolean {
  if (!versionCode || versionCode < 1) return false;
  if (release?.blocked) return true;
  if (policy.blockedVersionCodes.includes(versionCode)) return true;
  if (policy.minSupportedVersionCode > 0 && versionCode < policy.minSupportedVersionCode) {
    return true;
  }
  return false;
}

export const apkManager = {
  getPolicy(): ApkPolicy {
    return loadRegistry().policy;
  },

  getReleases(opts?: { includeMissingFiles?: boolean }): ApkRelease[] {
    const reg = loadRegistry();
    const includeMissing = opts?.includeMissingFiles !== false;
    return reg.releases
      .filter((r) => (includeMissing ? true : isDownloadableRelease(r)))
      .sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt);
  },

  getReleaseWithLocalStatus(): Array<
    ApkRelease & { localFileReady: boolean; effectiveBlocked: boolean; belowMinimum: boolean }
  > {
    const reg = loadRegistry();
    return reg.releases.map((r) => {
      const belowMinimum =
        reg.policy.minSupportedVersionCode > 0 &&
        r.versionCode < reg.policy.minSupportedVersionCode;
      const effectiveBlocked = computeIsBlocked(r.versionCode, reg.policy, r);
      return {
        ...r,
        localFileReady: hasLocalApkFile(r),
        effectiveBlocked,
        belowMinimum,
      };
    });
  },

  getLatest(): ApkRelease | null {
    const reg = loadRegistry();
    const downloadableActive = reg.releases.filter(
      (r) => !computeIsBlocked(r.versionCode, reg.policy, r) && isDownloadableRelease(r)
    );
    if (downloadableActive.length > 0) return downloadableActive[0];
    const anyDownloadable = reg.releases.filter((r) => isDownloadableRelease(r));
    if (anyDownloadable.length > 0) return anyDownloadable[0];
    const anyActive = reg.releases.filter(
      (r) => !computeIsBlocked(r.versionCode, reg.policy, r)
    );
    return anyActive[0] || reg.releases[0] || null;
  },

  getNextVersionSuggestion(bump: VersionBumpType = 'patch'): ApkVersionSuggestion {
    const reg = loadRegistry();
    const lastCode = reg.policy.lastVersionCode;
    const lastName = reg.policy.lastVersionName;

    if (lastCode <= 0 || !lastName) {
      if (bump === 'major') return { versionCode: 1, versionName: '2.0.0', bump };
      if (bump === 'minor') return { versionCode: 1, versionName: '1.1.0', bump };
      return { versionCode: 1, versionName: '1.0.0', bump };
    }

    return {
      versionCode: lastCode + 1,
      versionName: incrementRolloverVersion(lastName, bump),
      bump,
    };
  },

  getAllVersionSuggestions(): {
    patch: ApkVersionSuggestion;
    minor: ApkVersionSuggestion;
    major: ApkVersionSuggestion;
  } {
    return {
      patch: this.getNextVersionSuggestion('patch'),
      minor: this.getNextVersionSuggestion('minor'),
      major: this.getNextVersionSuggestion('major'),
    };
  },

  /**
   * Resolves next version automatically unless explicit manual override is requested.
   * Guarantees monotonic versionCode > policy.lastVersionCode when auto or colliding.
   */
  resolveAutoVersion(input?: {
    versionCode?: number;
    versionName?: string;
    bumpType?: VersionBumpType;
    manualOverride?: boolean;
  }): { versionCode: number; versionName: string } {
    const bump: VersionBumpType =
      input?.bumpType === 'major' || input?.bumpType === 'minor' ? input.bumpType : 'patch';
    const suggested = this.getNextVersionSuggestion(bump);
    const reg = loadRegistry();

    if (!input?.manualOverride) {
      return {
        versionCode: suggested.versionCode,
        versionName: suggested.versionName,
      };
    }

    const reqCode = Math.floor(Number(input.versionCode) || 0);
    const safeCode = reqCode > reg.policy.lastVersionCode ? reqCode : suggested.versionCode;
    const rawName = String(input.versionName || '')
      .trim()
      .replace(/^v/i, '')
      .replace(/[^a-zA-Z0-9._-]/g, '')
      .slice(0, 32);
    return {
      versionCode: safeCode,
      versionName: rawName || suggested.versionName,
    };
  },

  checkClientVersion(currentCodeRaw: number): ApkVersionCheckResult {
    const currentCode = Math.max(0, Math.floor(Number(currentCodeRaw) || 0));
    const reg = loadRegistry();
    const latest = this.getLatest();
    const hasApk = Boolean(latest && isDownloadableRelease(latest));
    const currentRelease =
      currentCode > 0 ? reg.releases.find((r) => r.versionCode === currentCode) || null : null;

    const isBlocked = currentCode > 0 && computeIsBlocked(currentCode, reg.policy, currentRelease);
    const updateAvailable = Boolean(
      latest &&
        hasApk &&
        (currentCode <= 0 || latest.versionCode > currentCode)
    );
    const mustUpdate = Boolean(
      (isBlocked && reg.policy.blockMode === 'hard') ||
        (updateAvailable && latest?.mandatory)
    );

    let blockReason = '';
    if (isBlocked) {
      if (currentRelease?.blockReason) {
        blockReason = currentRelease.blockReason;
      } else if (
        reg.policy.minSupportedVersionCode > 0 &&
        currentCode < reg.policy.minSupportedVersionCode
      ) {
        blockReason =
          reg.policy.blockMessage ||
          `Требуется версия приложения не ниже code ${reg.policy.minSupportedVersionCode}.`;
      } else {
        blockReason = reg.policy.blockMessage || DEFAULT_BLOCK_MESSAGE;
      }
    } else if (updateAvailable && latest?.mandatory) {
      blockReason = latest.changelog || 'Обязательное обновление приложения PQTV.';
    }

    return {
      currentCode,
      hasApk,
      latest,
      updateAvailable,
      isBlocked,
      mustUpdate,
      blockMode: reg.policy.blockMode,
      blockReason,
      policy: reg.policy,
    };
  },

  getApkFilePath(filename: string): string | null {
    const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '');
    if (!clean.endsWith('.apk')) return null;
    const full = path.join(getApkDir(), clean);
    return fs.existsSync(full) ? full : null;
  },

  getReleaseByFilename(filename: string): ApkRelease | null {
    const clean = path.basename(filename).replace(/[^a-zA-Z0-9._-]/g, '');
    const reg = loadRegistry();
    return reg.releases.find((r) => path.basename(r.filename) === clean) || null;
  },

  getLatestFilePath(): { path: string | null; release: ApkRelease } | null {
    const latest = this.getLatest();
    if (!latest) return null;
    const full = this.getApkFilePath(latest.filename);
    if (!full && !latest.externalApkUrl && !latest.githubRunId) return null;
    return { path: full, release: latest };
  },

  cacheApkBufferForRelease(releaseId: string, buffer: Buffer): ApkRelease | null {
    if (!isValidApkBuffer(buffer)) return null;
    const reg = loadRegistry();
    const target = reg.releases.find((r) => r.id === releaseId);
    if (!target) return null;
    const dir = getApkDir();
    const filePath = path.join(dir, path.basename(target.filename));
    fs.writeFileSync(filePath, buffer);
    target.size = buffer.length;
    target.sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    saveRegistry(reg);
    return target;
  },

  publishApk(input: {
    buffer: Buffer;
    versionCode?: number;
    versionName?: string;
    bumpType?: VersionBumpType;
    manualOverride?: boolean;
    changelog?: string;
    mandatory?: boolean;
    autoBlockOlder?: boolean;
    source?: 'github' | 'upload';
    githubRunId?: number;
    externalApkUrl?: string;
  }): ApkRelease {
    const dir = getApkDir();
    const reg = loadRegistry();

    const resolved = this.resolveAutoVersion({
      versionCode: input.versionCode,
      versionName: input.versionName,
      bumpType: input.bumpType,
      manualOverride:
        input.manualOverride ??
        Boolean(input.versionCode && input.versionCode > reg.policy.lastVersionCode),
    });

    const versionCode = resolved.versionCode;
    const safeName = resolved.versionName;
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
      blocked: false,
      source: input.source || 'upload',
      ...(input.githubRunId ? { githubRunId: Math.floor(Number(input.githubRunId)) } : {}),
      ...(input.externalApkUrl ? { externalApkUrl: String(input.externalApkUrl).trim().slice(0, 500) } : {}),
      uploadedAt: Math.floor(Date.now() / 1000),
    };

    reg.releases = reg.releases.filter(
      (r) => r.filename !== filename && r.versionCode !== versionCode
    );
    reg.releases.push(release);
    reg.releases.sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt);

    // Advance monotonic high-water mark so counters never collide or go backwards
    if (versionCode >= reg.policy.lastVersionCode) {
      reg.policy.lastVersionCode = versionCode;
      reg.policy.lastVersionName = safeName;
    }
    if (input.autoBlockOlder && versionCode > 1) {
      reg.policy.minSupportedVersionCode = Math.max(
        reg.policy.minSupportedVersionCode,
        versionCode
      );
    }
    reg.policy.blockedVersionCodes = reg.policy.blockedVersionCodes.filter(
      (c) => c !== versionCode
    );
    reg.policy.updatedAt = Math.floor(Date.now() / 1000);

    // Keep up to 15 historical releases
    if (reg.releases.length > 15) {
      for (const old of reg.releases.slice(15)) {
        try {
          const oldPath = path.join(dir, path.basename(old.filename));
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch {
          // ignore
        }
      }
      reg.releases = reg.releases.slice(0, 15);
    }
    saveRegistry(reg);
    return release;
  },

  setReleaseBlocked(
    id: string,
    blocked: boolean,
    reason?: string
  ): { ok: boolean; error?: string; release?: ApkRelease; policy?: ApkPolicy } {
    const reg = loadRegistry();
    const target = reg.releases.find((r) => r.id === id);
    if (!target) return { ok: false, error: 'Релиз не найден' };

    if (blocked) {
      const otherActive = reg.releases.some(
        (r) =>
          r.id !== id &&
          !computeIsBlocked(r.versionCode, reg.policy, r) &&
          r.versionCode > target.versionCode &&
          isDownloadableRelease(r)
      );
      const latestAny = reg.releases[0];
      if (latestAny && latestAny.id === id && !otherActive) {
        return {
          ok: false,
          error:
            'Нельзя заблокировать самую последнюю версию APK, пока не опубликована более новая — иначе телевизорам некуда будет обновиться.',
        };
      }
      target.blocked = true;
      if (reason && reason.trim()) {
        target.blockReason = reason.trim().slice(0, 300);
      }
      if (!reg.policy.blockedVersionCodes.includes(target.versionCode)) {
        reg.policy.blockedVersionCodes.push(target.versionCode);
      }
    } else {
      target.blocked = false;
      delete target.blockReason;
      reg.policy.blockedVersionCodes = reg.policy.blockedVersionCodes.filter(
        (c) => c !== target.versionCode
      );
      if (
        reg.policy.minSupportedVersionCode > 0 &&
        target.versionCode < reg.policy.minSupportedVersionCode
      ) {
        reg.policy.minSupportedVersionCode = target.versionCode;
      }
    }

    reg.policy.updatedAt = Math.floor(Date.now() / 1000);
    saveRegistry(reg);
    return { ok: true, release: target, policy: reg.policy };
  },

  updatePolicy(patch: {
    minSupportedVersionCode?: number;
    blockedVersionCodes?: number[];
    blockMode?: ApkBlockMode;
    blockMessage?: string;
    blockOlderThanLatest?: boolean;
  }): { ok: boolean; error?: string; policy: ApkPolicy } {
    const reg = loadRegistry();
    const next = { ...reg.policy };
    const latestActive = this.getLatest();

    if (patch.blockMode === 'hard' || patch.blockMode === 'soft') {
      next.blockMode = patch.blockMode;
    }
    if (typeof patch.blockMessage === 'string') {
      next.blockMessage = patch.blockMessage.trim().slice(0, 300) || DEFAULT_BLOCK_MESSAGE;
    }
    if (Array.isArray(patch.blockedVersionCodes)) {
      const set = new Set<number>();
      for (const raw of patch.blockedVersionCodes) {
        const n = Math.floor(Number(raw));
        if (Number.isFinite(n) && n >= 1) set.add(n);
      }
      if (latestActive && set.has(latestActive.versionCode)) {
        const hasOtherHigher = reg.releases.some(
          (r) => !set.has(r.versionCode) && isDownloadableRelease(r)
        );
        if (!hasOtherHigher) {
          return {
            ok: false,
            error: 'Нельзя заблокировать единственную актуальную версию APK.',
            policy: reg.policy,
          };
        }
      }
      next.blockedVersionCodes = Array.from(set).sort((a, b) => a - b).slice(0, 100);
      for (const r of reg.releases) {
        r.blocked = set.has(r.versionCode);
      }
    }

    if (patch.blockOlderThanLatest) {
      if (!latestActive) {
        return {
          ok: false,
          error: 'Сначала опубликуйте актуальную версию APK.',
          policy: reg.policy,
        };
      }
      next.minSupportedVersionCode = latestActive.versionCode;
    } else if (patch.minSupportedVersionCode !== undefined) {
      const minCode = Math.max(0, Math.floor(Number(patch.minSupportedVersionCode) || 0));
      if (latestActive && minCode > latestActive.versionCode) {
        return {
          ok: false,
          error: `Минимальная версия (${minCode}) не может быть выше последней опубликованной (${latestActive.versionCode}).`,
          policy: reg.policy,
        };
      }
      next.minSupportedVersionCode = minCode;
    }

    next.updatedAt = Math.floor(Date.now() / 1000);
    reg.policy = next;
    saveRegistry(reg);
    return { ok: true, policy: reg.policy };
  },

  deleteRelease(id: string): boolean {
    const reg = loadRegistry();
    const target = reg.releases.find((r) => r.id === id);
    if (!target) return false;
    reg.releases = reg.releases.filter((r) => r.id !== id);
    // NOTE: Do NOT decrement policy.lastVersionCode / lastVersionName so version counters remain strictly monotonic!
    reg.policy.updatedAt = Math.floor(Date.now() / 1000);
    saveRegistry(reg);
    try {
      const full = path.join(getApkDir(), path.basename(target.filename));
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch {
      // ignore
    }
    return true;
  },

  exportState(): ApkStateSnapshot {
    const reg = loadRegistry();
    return {
      policy: reg.policy,
      releases: reg.releases,
    };
  },

  hydrateState(raw: Partial<ApkStateSnapshot> | null | undefined): {
    ok: boolean;
    error?: string;
    state: ApkStateSnapshot;
  } {
    if (!raw || typeof raw !== 'object') {
      return { ok: true, state: this.exportState() };
    }
    const existing = loadRegistry();
    const incomingReleases = Array.isArray(raw.releases)
      ? raw.releases
          .map((r) => normalizeRelease(r))
          .filter((r): r is ApkRelease => r !== null)
      : [];

    // Merge incoming releases with any local disk-backed releases
    const mergedMap = new Map<string, ApkRelease>();
    for (const r of existing.releases) {
      mergedMap.set(`${r.versionCode}:${r.filename}`, r);
    }
    for (const r of incomingReleases) {
      const key = `${r.versionCode}:${r.filename}`;
      const prev = mergedMap.get(key);
      mergedMap.set(key, prev ? { ...prev, ...r } : r);
    }
    const mergedReleases = Array.from(mergedMap.values())
      .sort((a, b) => b.versionCode - a.versionCode || b.uploadedAt - a.uploadedAt)
      .slice(0, 15);

    const incomingPolicy = normalizePolicy(raw.policy, mergedReleases);
    // Keep the highest monotonic high-water mark between cloud & local
    if (existing.policy.lastVersionCode > incomingPolicy.lastVersionCode) {
      incomingPolicy.lastVersionCode = existing.policy.lastVersionCode;
      incomingPolicy.lastVersionName =
        existing.policy.lastVersionName || incomingPolicy.lastVersionName;
    }

    const ok = saveRegistry({ policy: incomingPolicy, releases: mergedReleases });
    if (!ok) {
      return {
        ok: false,
        error: 'Не удалось сохранить releases.json',
        state: this.exportState(),
      };
    }
    return { ok: true, state: this.exportState() };
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

export function buildAndroidTvProjectZip(
  serverOrigin: string,
  nextVersionCode = 1,
  nextVersionName = '1.0.0'
): Buffer {
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
