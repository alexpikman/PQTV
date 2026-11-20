import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { config } from './config.js';
import { apkManager, isValidApkBuffer, type ApkRelease } from './apkManager.js';

export interface GithubConfigStored {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  htmlUrl?: string;
  isPrivate?: boolean;
  login?: string;
  updatedAt: number;
}

export interface GithubPublicConfig {
  configured: boolean;
  source: 'env' | 'saved' | 'none';
  owner: string;
  repo: string;
  repoFullName: string;
  branch: string;
  htmlUrl: string;
  isPrivate: boolean;
  login: string;
  tokenPreview: string;
  updatedAt: number;
}

export interface GithubBuildStep {
  name: string;
  status: string;
  conclusion: string | null;
}

export interface GithubBuildState {
  buildId: string;
  owner: string;
  repo: string;
  branch: string;
  versionName: string;
  versionCode: number;
  serverUrl: string;
  changelog: string;
  mandatory: boolean;
  dispatchedAt: number;
  commitSha?: string;
  syncedFiles?: number;
  status: 'syncing' | 'queued' | 'in_progress' | 'importing' | 'completed' | 'failed';
  conclusion?: string | null;
  runId?: number | null;
  runNumber?: number | null;
  runUrl?: string | null;
  steps?: GithubBuildStep[];
  imported: boolean;
  release?: ApkRelease | null;
  error?: string | null;
  updatedAt: number;
}

export interface GithubWorkflowRunSummary {
  id: number;
  runNumber: number;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
  headBranch: string;
  displayTitle: string;
}

const WORKFLOW_FILE = 'build-apk.yml';
const ARTIFACT_NAME = 'pqtv-android-tv-apk';

function getConfigPath(): string {
  return path.join(config.dataDir, 'github_config.json');
}

function getBuildStatePath(): string {
  return path.join(config.dataDir, 'github_build_state.json');
}

export function parseGithubRepoInput(raw: string): { owner: string; repo: string } | null {
  let clean = String(raw || '').trim();
  if (!clean) return null;

  clean = clean
    .replace(/^git@github\.com:/i, '')
    .replace(/^https?:\/\/(www\.)?github\.com\//i, '')
    .replace(/^\/+|\/+$/g, '')
    .replace(/\.git$/i, '');

  const parts = clean.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[0].trim();
  const repo = parts[1].trim();
  if (!/^[a-zA-Z0-9_.-]+$/.test(owner) || !/^[a-zA-Z0-9_.-]+$/.test(repo)) {
    return null;
  }
  return { owner, repo };
}

function maskToken(token: string): string {
  const t = String(token || '').trim();
  if (!t) return '';
  if (t.length <= 10) return `${t.slice(0, 2)}••••${t.slice(-2)}`;
  return `${t.slice(0, 6)}••••••${t.slice(-4)}`;
}

function loadStoredConfig(): GithubConfigStored | null {
  const file = getConfigPath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as GithubConfigStored;
    if (parsed && parsed.owner && parsed.repo && parsed.token) {
      return parsed;
    }
  } catch {
    // ignore corrupt config
  }
  return null;
}

function getEffectiveConfig(): { cfg: GithubConfigStored; source: 'env' | 'saved' } | null {
  const saved = loadStoredConfig();
  if (saved) {
    return { cfg: saved, source: 'saved' };
  }
  if (config.githubToken && config.githubRepo) {
    const parsed = parseGithubRepoInput(config.githubRepo);
    if (parsed) {
      return {
        cfg: {
          owner: parsed.owner,
          repo: parsed.repo,
          branch: config.githubBranch || 'main',
          token: config.githubToken,
          htmlUrl: `https://github.com/${parsed.owner}/${parsed.repo}`,
          updatedAt: 0,
        },
        source: 'env',
      };
    }
  }
  return null;
}

export function getPublicGithubConfig(): GithubPublicConfig {
  const eff = getEffectiveConfig();
  if (!eff) {
    return {
      configured: false,
      source: 'none',
      owner: '',
      repo: '',
      repoFullName: '',
      branch: 'main',
      htmlUrl: '',
      isPrivate: false,
      login: '',
      tokenPreview: '',
      updatedAt: 0,
    };
  }
  const { cfg, source } = eff;
  return {
    configured: true,
    source,
    owner: cfg.owner,
    repo: cfg.repo,
    repoFullName: `${cfg.owner}/${cfg.repo}`,
    branch: cfg.branch || 'main',
    htmlUrl: cfg.htmlUrl || `https://github.com/${cfg.owner}/${cfg.repo}`,
    isPrivate: Boolean(cfg.isPrivate),
    login: cfg.login || '',
    tokenPreview: maskToken(cfg.token),
    updatedAt: cfg.updatedAt || 0,
  };
}

export function clearGithubConfig(): void {
  const file = getConfigPath();
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
  }
}

async function ghFetch(
  urlPath: string,
  token: string,
  init: RequestInit = {}
): Promise<{ ok: boolean; status: number; data: unknown; text: string; headers: Headers }> {
  const url = urlPath.startsWith('http') ? urlPath : `https://api.github.com${urlPath}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'PQTV-Server/1.0',
    Authorization: `Bearer ${token}`,
    ...(init.headers as Record<string, string> | undefined),
  };
  if (init.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  return { ok: res.ok, status: res.status, data, text, headers: res.headers };
}

function extractGhError(res: { status: number; data: unknown; text: string }): string {
  const obj = res.data && typeof res.data === 'object' ? (res.data as Record<string, unknown>) : null;
  const msg = typeof obj?.message === 'string' ? obj.message : res.text.slice(0, 200);
  if (res.status === 401) {
    return 'Неверный или просроченный GitHub токен (401 Bad credentials)';
  }
  if (res.status === 403) {
    return `Недостаточно прав GitHub токена (403): ${msg}`;
  }
  if (res.status === 404) {
    return `Репозиторий, ветка или workflow не найдены (404): ${msg}`;
  }
  if (res.status === 422 && /workflow/i.test(msg)) {
    return 'У GitHub токена нет права «workflow» для создания/обновления .github/workflows/build-apk.yml. Включите scope «workflow» (Classic PAT) или «Workflows: Read & Write» (Fine-grained PAT).';
  }
  return `GitHub API (${res.status}): ${msg || 'Неизвестная ошибка'}`;
}

export async function saveAndVerifyGithubConfig(input: {
  repo: string;
  branch?: string;
  token?: string;
}): Promise<GithubPublicConfig> {
  const parsed = parseGithubRepoInput(input.repo);
  if (!parsed) {
    throw new Error('Укажите репозиторий в формате owner/repo или ссылку https://github.com/owner/repo');
  }

  const existing = getEffectiveConfig();
  const cleanToken = String(input.token || '').trim() || existing?.cfg.token || '';
  if (!cleanToken) {
    throw new Error('Укажите GitHub Personal Access Token (PAT)');
  }

  const repoRes = await ghFetch(`/repos/${parsed.owner}/${parsed.repo}`, cleanToken);
  if (!repoRes.ok) {
    throw new Error(extractGhError(repoRes));
  }
  const repoData = repoRes.data as Record<string, unknown>;
  const perms = (repoData.permissions || {}) as Record<string, boolean>;
  if (perms.push === false) {
    throw new Error('У этого токена нет прав на запись (push) в репозиторий. Нужны права Contents: Read & Write и Actions/Workflows.');
  }

  let login = '';
  const userRes = await ghFetch('/user', cleanToken);
  if (userRes.ok && userRes.data && typeof userRes.data === 'object') {
    login = String((userRes.data as Record<string, unknown>).login || '');
  }

  const branch =
    String(input.branch || '').trim() ||
    String(repoData.default_branch || '') ||
    'main';

  const stored: GithubConfigStored = {
    owner: parsed.owner,
    repo: parsed.repo,
    branch,
    token: cleanToken,
    htmlUrl: String(repoData.html_url || `https://github.com/${parsed.owner}/${parsed.repo}`),
    isPrivate: Boolean(repoData.private),
    login,
    updatedAt: Math.floor(Date.now() / 1000),
  };

  fs.mkdirSync(config.dataDir, { recursive: true });
  const cfgPath = getConfigPath();
  const tmp = `${cfgPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(stored, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, cfgPath);
  try {
    fs.chmodSync(cfgPath, 0o600);
  } catch {
    // ignore chmod failures on filesystems without POSIX permissions
  }

  return getPublicGithubConfig();
}

function collectProjectSyncFiles(): Array<{ repoPath: string; data: Buffer }> {
  const files: Array<{ repoPath: string; data: Buffer }> = [];
  const androidRoot = path.resolve(process.cwd(), 'android-tv');

  const walk = (dir: string, relPrefix: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'build' || entry.name === '.gradle' || entry.name === '.idea') continue;
      const full = path.join(dir, entry.name);
      const rel = `${relPrefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push({ repoPath: rel, data: fs.readFileSync(full) });
      }
    }
  };

  walk(androidRoot, 'android-tv');

  const workflowPath = path.resolve(process.cwd(), '.github/workflows', WORKFLOW_FILE);
  if (fs.existsSync(workflowPath)) {
    files.push({
      repoPath: `.github/workflows/${WORKFLOW_FILE}`,
      data: fs.readFileSync(workflowPath),
    });
  }

  return files;
}

function computeGitBlobSha1(buf: Buffer): string {
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return crypto.createHash('sha1').update(header).update(buf).digest('hex');
}

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const current = items[idx++];
      await worker(current);
    }
  });
  await Promise.all(runners);
}

export async function syncAndroidProjectToGithub(): Promise<{
  commitSha: string;
  syncedFiles: number;
  skipped: boolean;
  workflowUpdated: boolean;
}> {
  const eff = getEffectiveConfig();
  if (!eff) {
    throw new Error('GitHub не настроен. Укажите репозиторий и токен доступа.');
  }
  const { owner, repo, branch, token } = eff.cfg;
  const files = collectProjectSyncFiles();
  if (files.length === 0) {
    throw new Error('Не найдены файлы проекта android-tv/ на сервере');
  }

  let refRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  if (!refRes.ok && (refRes.status === 404 || refRes.status === 409)) {
    // Check if repo is empty or branch doesn't exist yet
    const repoRes = await ghFetch(`/repos/${owner}/${repo}`, token);
    if (!repoRes.ok) throw new Error(extractGhError(repoRes));
    const defaultBranch = String((repoRes.data as Record<string, unknown>).default_branch || 'main');

    const defRef = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`, token);
    if (!defRef.ok) {
      // Repository is completely empty — create initial README commit
      const initRes = await ghFetch(`/repos/${owner}/${repo}/contents/README.md`, token, {
        method: 'PUT',
        body: JSON.stringify({
          message: 'chore: initialize PQTV repository',
          content: Buffer.from('# PQTV\n', 'utf-8').toString('base64'),
          branch,
        }),
      });
      if (!initRes.ok) throw new Error(extractGhError(initRes));
    } else if (branch !== defaultBranch) {
      // Create requested branch from default branch head
      const defSha = String(((defRef.data as Record<string, unknown>).object as Record<string, unknown>).sha);
      const mkRef = await ghFetch(`/repos/${owner}/${repo}/git/refs`, token, {
        method: 'POST',
        body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: defSha }),
      });
      if (!mkRef.ok) throw new Error(extractGhError(mkRef));
    }
    refRes = await ghFetch(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, token);
  }
  if (!refRes.ok) {
    throw new Error(extractGhError(refRes));
  }

  const headCommitSha = String(
    ((refRes.data as Record<string, unknown>).object as Record<string, unknown>).sha
  );
  const commitRes = await ghFetch(`/repos/${owner}/${repo}/git/commits/${headCommitSha}`, token);
  if (!commitRes.ok) throw new Error(extractGhError(commitRes));
  const baseTreeSha = String(
    ((commitRes.data as Record<string, unknown>).tree as Record<string, unknown>).sha
  );

  // Check remote tree to skip unchanged files
  const remoteMap = new Map<string, string>();
  const treeListRes = await ghFetch(
    `/repos/${owner}/${repo}/git/trees/${baseTreeSha}?recursive=1`,
    token
  );
  if (treeListRes.ok && treeListRes.data && typeof treeListRes.data === 'object') {
    const treeEntries = (treeListRes.data as Record<string, unknown>).tree;
    if (Array.isArray(treeEntries)) {
      for (const item of treeEntries) {
        if (item && typeof item === 'object') {
          const obj = item as Record<string, unknown>;
          if (obj.type === 'blob' && typeof obj.path === 'string' && typeof obj.sha === 'string') {
            remoteMap.set(obj.path, obj.sha);
          }
        }
      }
    }
  }

  const changedFiles = files.filter((f) => remoteMap.get(f.repoPath) !== computeGitBlobSha1(f.data));
  if (changedFiles.length === 0) {
    return {
      commitSha: headCommitSha,
      syncedFiles: 0,
      skipped: true,
      workflowUpdated: false,
    };
  }

  const workflowUpdated = changedFiles.some((f) => f.repoPath === `.github/workflows/${WORKFLOW_FILE}`);
  const treeItems: Array<{ path: string; mode: string; type: string; sha: string }> = [];

  await runWithConcurrency(changedFiles, 4, async (f) => {
    const blobRes = await ghFetch(`/repos/${owner}/${repo}/git/blobs`, token, {
      method: 'POST',
      body: JSON.stringify({
        content: f.data.toString('base64'),
        encoding: 'base64',
      }),
    });
    if (!blobRes.ok) {
      throw new Error(extractGhError(blobRes));
    }
    const sha = String((blobRes.data as Record<string, unknown>).sha);
    treeItems.push({
      path: f.repoPath,
      mode: '100644',
      type: 'blob',
      sha,
    });
  });

  const newTreeRes = await ghFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: treeItems,
    }),
  });
  if (!newTreeRes.ok) throw new Error(extractGhError(newTreeRes));
  const newTreeSha = String((newTreeRes.data as Record<string, unknown>).sha);

  const newCommitRes = await ghFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({
      message: `chore(android-tv): sync PQTV Android TV project (${changedFiles.length} files)`,
      tree: newTreeSha,
      parents: [headCommitSha],
    }),
  });
  if (!newCommitRes.ok) throw new Error(extractGhError(newCommitRes));
  const newCommitSha = String((newCommitRes.data as Record<string, unknown>).sha);

  const patchRefRes = await ghFetch(
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
    token,
    {
      method: 'PATCH',
      body: JSON.stringify({ sha: newCommitSha }),
    }
  );
  if (!patchRefRes.ok) throw new Error(extractGhError(patchRefRes));

  if (workflowUpdated) {
    // Give GitHub Actions a short moment to index the new/updated workflow file
    await new Promise((resolve) => setTimeout(resolve, 1800));
  }

  return {
    commitSha: newCommitSha,
    syncedFiles: changedFiles.length,
    skipped: false,
    workflowUpdated,
  };
}

function loadBuildState(): GithubBuildState | null {
  const file = getBuildStatePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8')) as GithubBuildState;
  } catch {
    return null;
  }
}

function saveBuildState(state: GithubBuildState): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = getBuildStatePath();
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

// Extract the first .apk entry from a ZIP buffer using Central Directory offsets (supports streaming data descriptors)
export function extractApkFromArtifactZip(zipBuf: Buffer): Buffer | null {
  let eocdOffset = -1;
  const minOffset = Math.max(0, zipBuf.length - 65557);
  for (let i = zipBuf.length - 22; i >= minOffset; i--) {
    if (
      zipBuf[i] === 0x50 &&
      zipBuf[i + 1] === 0x4b &&
      zipBuf[i + 2] === 0x05 &&
      zipBuf[i + 3] === 0x06
    ) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) return null;

  const totalEntries = zipBuf.readUInt16LE(eocdOffset + 10);
  const cdOffset = zipBuf.readUInt32LE(eocdOffset + 16);
  let cursor = cdOffset;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > zipBuf.length) break;
    if (zipBuf.readUInt32LE(cursor) !== 0x02014b50) break;

    const method = zipBuf.readUInt16LE(cursor + 10);
    const compressedSize = zipBuf.readUInt32LE(cursor + 20);
    const nameLen = zipBuf.readUInt16LE(cursor + 28);
    const extraLen = zipBuf.readUInt16LE(cursor + 30);
    const commentLen = zipBuf.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuf.readUInt32LE(cursor + 42);
    const name = zipBuf.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf-8');

    cursor += 46 + nameLen + extraLen + commentLen;

    if (!name.toLowerCase().endsWith('.apk')) continue;
    if (localHeaderOffset + 30 > zipBuf.length) continue;
    if (zipBuf.readUInt32LE(localHeaderOffset) !== 0x04034b50) continue;

    const localNameLen = zipBuf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = zipBuf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > zipBuf.length) continue;

    const rawSlice = zipBuf.subarray(dataStart, dataEnd);
    if (method === 0) {
      return Buffer.from(rawSlice);
    }
    if (method === 8) {
      return zlib.inflateRawSync(rawSlice);
    }
  }
  return null;
}

export async function importApkFromGithubRun(opts: {
  runId: number;
  versionName: string;
  versionCode: number;
  changelog?: string;
  mandatory?: boolean;
}): Promise<ApkRelease> {
  const eff = getEffectiveConfig();
  if (!eff) throw new Error('GitHub не настроен');
  const { owner, repo, token } = eff.cfg;

  const existing = apkManager
    .getReleases()
    .find((r) => r.versionCode === opts.versionCode && r.versionName === opts.versionName);
  if (existing) {
    return existing;
  }

  const artRes = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${opts.runId}/artifacts`, token);
  if (!artRes.ok) throw new Error(extractGhError(artRes));

  const artifacts = ((artRes.data as Record<string, unknown>)?.artifacts || []) as Array<
    Record<string, unknown>
  >;
  const target =
    artifacts.find((a) => String(a.name || '') === ARTIFACT_NAME) ||
    artifacts.find((a) => String(a.name || '').toLowerCase().includes('apk')) ||
    artifacts[0];
  if (!target) {
    throw new Error('Артефакт APK не найден в завершённой сборке GitHub Actions');
  }

  const downloadUrl = `https://api.github.com/repos/${owner}/${repo}/actions/artifacts/${target.id}/zip`;
  const redirRes = await fetch(downloadUrl, {
    redirect: 'manual',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'PQTV-Server/1.0',
      Authorization: `Bearer ${token}`,
    },
  });

  let zipRes: globalThis.Response;
  if (redirRes.status >= 300 && redirRes.status < 400) {
    const loc = redirRes.headers.get('location');
    if (!loc) throw new Error('GitHub не вернул ссылку на скачивание артефакта');
    // Fetch signed storage URL WITHOUT GitHub Authorization header
    zipRes = await fetch(loc);
  } else if (redirRes.ok) {
    zipRes = redirRes;
  } else {
    throw new Error(`Ошибка скачивания артефакта (${redirRes.status})`);
  }

  if (!zipRes.ok) {
    throw new Error(`Ошибка загрузки ZIP артефакта (${zipRes.status})`);
  }

  const zipBuf = Buffer.from(await zipRes.arrayBuffer());
  const apkBuf = extractApkFromArtifactZip(zipBuf);
  if (!apkBuf || !isValidApkBuffer(apkBuf)) {
    throw new Error('Внутри артефакта GitHub не найден корректный .apk файл');
  }

  return apkManager.publishApk({
    buffer: apkBuf,
    versionCode: opts.versionCode,
    versionName: opts.versionName,
    changelog: opts.changelog || 'Собрано через GitHub Actions',
    mandatory: Boolean(opts.mandatory),
  });
}

let activePollTimer: ReturnType<typeof setInterval> | null = null;
let pollInFlight = false;

function stopBackgroundPoller(): void {
  if (activePollTimer) {
    clearInterval(activePollTimer);
    activePollTimer = null;
  }
}

function startBackgroundPoller(): void {
  if (activePollTimer) return;
  activePollTimer = setInterval(() => {
    void refreshGithubBuildStatus().catch(() => {
      // ignore background polling errors
    });
  }, 6000);
  activePollTimer.unref?.();
}

export async function triggerGithubApkBuild(input: {
  versionName: string;
  versionCode: number;
  serverUrl: string;
  changelog?: string;
  mandatory?: boolean;
  syncProject?: boolean;
}): Promise<GithubBuildState> {
  const eff = getEffectiveConfig();
  if (!eff) {
    throw new Error('GitHub не настроен. Укажите репозиторий и токен доступа.');
  }
  const { owner, repo, branch, token } = eff.cfg;

  const versionName = String(input.versionName || '').trim() || '1.0.1';
  const versionCode = Math.max(1, Math.floor(Number(input.versionCode) || 1));
  const serverUrl = String(input.serverUrl || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\/.+/.test(serverUrl)) {
    throw new Error('Укажите корректный URL сервера PQTV (начинающийся с http:// или https://)');
  }
  const changelog = String(input.changelog || '').trim() || 'Обновление приложения для Android TV';
  const mandatory = Boolean(input.mandatory);

  let commitSha: string | undefined;
  let syncedFiles = 0;

  if (input.syncProject !== false) {
    const syncRes = await syncAndroidProjectToGithub();
    commitSha = syncRes.commitSha;
    syncedFiles = syncRes.syncedFiles;
  }

  const dispatchedAt = Date.now();
  const dispatchRes = await ghFetch(
    `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
    token,
    {
      method: 'POST',
      body: JSON.stringify({
        ref: branch,
        inputs: {
          version_name: versionName,
          version_code: String(versionCode),
          server_url: serverUrl,
          changelog,
        },
      }),
    }
  );
  if (!dispatchRes.ok) {
    throw new Error(extractGhError(dispatchRes));
  }

  const state: GithubBuildState = {
    buildId: `gh_${dispatchedAt}`,
    owner,
    repo,
    branch,
    versionName,
    versionCode,
    serverUrl,
    changelog,
    mandatory,
    dispatchedAt,
    commitSha,
    syncedFiles,
    status: 'queued',
    conclusion: null,
    runId: null,
    runNumber: null,
    runUrl: `https://github.com/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}`,
    steps: [],
    imported: false,
    release: null,
    error: null,
    updatedAt: dispatchedAt,
  };
  saveBuildState(state);
  startBackgroundPoller();

  // Quick look-up after 1.5s to capture runId immediately if GitHub created it fast
  await new Promise((r) => setTimeout(r, 1500));
  return refreshGithubBuildStatus();
}

export async function refreshGithubBuildStatus(): Promise<GithubBuildState> {
  const state = loadBuildState();
  if (!state) {
    return {
      buildId: '',
      owner: '',
      repo: '',
      branch: '',
      versionName: '',
      versionCode: 0,
      serverUrl: '',
      changelog: '',
      mandatory: false,
      dispatchedAt: 0,
      status: 'completed',
      imported: false,
      updatedAt: 0,
    };
  }

  if (state.status === 'completed' || state.status === 'failed') {
    stopBackgroundPoller();
    return state;
  }

  // Timeout guard after 20 minutes
  if (Date.now() - state.dispatchedAt > 20 * 60 * 1000) {
    state.status = 'failed';
    state.error = 'Превышено время ожидания сборки GitHub Actions (20 мин)';
    state.updatedAt = Date.now();
    saveBuildState(state);
    stopBackgroundPoller();
    return state;
  }

  if (pollInFlight) return state;
  pollInFlight = true;

  try {
    const eff = getEffectiveConfig();
    if (!eff) {
      stopBackgroundPoller();
      return state;
    }
    const { owner, repo, token } = eff.cfg;

    let runObj: Record<string, unknown> | null = null;
    if (state.runId) {
      const rRes = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${state.runId}`, token);
      if (rRes.ok && rRes.data && typeof rRes.data === 'object') {
        runObj = rRes.data as Record<string, unknown>;
      }
    } else {
      const listRes = await ghFetch(
        `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?event=workflow_dispatch&branch=${encodeURIComponent(state.branch)}&per_page=10`,
        token
      );
      if (listRes.ok && listRes.data && typeof listRes.data === 'object') {
        const runs = ((listRes.data as Record<string, unknown>).workflow_runs || []) as Array<
          Record<string, unknown>
        >;
        // Find newest run created around or after dispatch time
        const matched = runs.find((r) => {
          const created = Date.parse(String(r.created_at || ''));
          return Number.isFinite(created) && created >= state.dispatchedAt - 15000;
        });
        if (matched) {
          runObj = matched;
          state.runId = Number(matched.id);
          state.runNumber = Number(matched.run_number || 0) || null;
          state.runUrl = String(matched.html_url || state.runUrl || '');
        }
      }
    }

    if (runObj) {
      const ghStatus = String(runObj.status || 'queued');
      const ghConclusion = runObj.conclusion ? String(runObj.conclusion) : null;
      state.conclusion = ghConclusion;
      state.runUrl = String(runObj.html_url || state.runUrl || '');

      if (state.runId) {
        const jobsRes = await ghFetch(`/repos/${owner}/${repo}/actions/runs/${state.runId}/jobs`, token);
        if (jobsRes.ok && jobsRes.data && typeof jobsRes.data === 'object') {
          const jobs = ((jobsRes.data as Record<string, unknown>).jobs || []) as Array<
            Record<string, unknown>
          >;
          const firstJob = jobs[0];
          if (firstJob && Array.isArray(firstJob.steps)) {
            state.steps = firstJob.steps.map((s) => {
              const step = s as Record<string, unknown>;
              return {
                name: String(step.name || ''),
                status: String(step.status || ''),
                conclusion: step.conclusion ? String(step.conclusion) : null,
              };
            });
          }
        }
      }

      if (ghStatus !== 'completed') {
        state.status = ghStatus === 'in_progress' ? 'in_progress' : 'queued';
      } else if (ghConclusion === 'success') {
        if (!state.imported && state.runId) {
          state.status = 'importing';
          state.updatedAt = Date.now();
          saveBuildState(state);
          const release = await importApkFromGithubRun({
            runId: state.runId,
            versionName: state.versionName,
            versionCode: state.versionCode,
            changelog: state.changelog,
            mandatory: state.mandatory,
          });
          state.imported = true;
          state.release = release;
        }
        state.status = 'completed';
        stopBackgroundPoller();
      } else {
        state.status = 'failed';
        state.error = `Сборка на GitHub завершилась со статусом: ${ghConclusion || 'error'}`;
        stopBackgroundPoller();
      }
    }

    state.updatedAt = Date.now();
    saveBuildState(state);
    return state;
  } catch (err) {
    state.status = 'failed';
    state.error = err instanceof Error ? err.message : String(err);
    state.updatedAt = Date.now();
    saveBuildState(state);
    stopBackgroundPoller();
    return state;
  } finally {
    pollInFlight = false;
  }
}

export async function listGithubWorkflowRuns(): Promise<GithubWorkflowRunSummary[]> {
  const eff = getEffectiveConfig();
  if (!eff) return [];
  const { owner, repo, token } = eff.cfg;
  const res = await ghFetch(
    `/repos/${owner}/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=8`,
    token
  );
  if (!res.ok || !res.data || typeof res.data !== 'object') {
    return [];
  }
  const runs = ((res.data as Record<string, unknown>).workflow_runs || []) as Array<
    Record<string, unknown>
  >;
  return runs.map((r) => ({
    id: Number(r.id),
    runNumber: Number(r.run_number || 0),
    status: String(r.status || ''),
    conclusion: r.conclusion ? String(r.conclusion) : null,
    htmlUrl: String(r.html_url || ''),
    createdAt: String(r.created_at || ''),
    updatedAt: String(r.updated_at || ''),
    headBranch: String(r.head_branch || ''),
    displayTitle: String(r.display_title || r.name || 'Build PQTV APK'),
  }));
}
