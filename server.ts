import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http, { IncomingMessage } from 'node:http';
import https from 'node:https';
import { PassThrough } from 'node:stream';
import express, { Request, Response, NextFunction } from 'express';
import session from 'express-session';
import { config, hashPassword, verifyPassword } from './src/config.js';
import { storage } from './src/storage.js';
import { parseM3uFile, generateM3u, Channel } from './src/m3uParser.js';
import { userAuth, hashEmailId, ChannelAlertIssue } from './src/userAuth.js';
import { StreamParser, SourceItem } from './src/streamParser.js';
import { EpgParser, EpgSource } from './src/epgParser.js';
import { catalogStore } from './src/catalogStore.js';
import { verifyFirebaseIdToken } from './src/firebaseJwt.js';
import { channelHealth, ChannelHealthState } from './src/channelHealth.js';
import {
  checkStreamDeep,
  buildOutboundHeaders,
  classifyNetworkError,
  isBlockedHostname,
} from './src/streamChecker.js';
import {
  apkManager,
  buildAndroidTvProjectZip,
  isValidApkBuffer,
  type VersionBumpType,
} from './src/apkManager.js';
import {
  getPublicGithubConfig,
  saveAndVerifyGithubConfig,
  clearGithubConfig,
  syncAndroidProjectToGithub,
  triggerGithubApkBuild,
  refreshGithubBuildStatus,
  listGithubWorkflowRuns,
  importApkFromGithubRun,
  restoreApkReleaseFromGithub,
  GithubWorkflowScopeError,
  getWorkflowManualSetupInfo,
} from './src/githubApkBuilder.js';
import { getStreamingSettings, trySaveStreamingSettings } from './src/streamingSettings.js';
import { getUiSettings, trySaveUiSettings } from './src/uiSettings.js';
import { stateLifecycle } from './src/stateLifecycle.js';
import {
  createPlaylistUnified,
  savePlaylistChannelsUnified,
  deletePlaylistUnified,
  restoreBackupUnified,
  deleteBackupUnified,
  saveAuthoritativeSourcesUnified,
  upsertCatalogSourceUnified,
  deleteSourceUnified,
  deleteStreamUnified,
  reconcileCatalogUnified,
  hydrateStateUnified,
} from './src/lifecycleCoordinator.js';

const BOOTSTRAPPED_ADMIN_EMAILS = ['alexpqtr@gmail.com', 'alex.pikman@gmail.com'];

declare module 'express-session' {
  interface SessionData {
    authenticated?: boolean;
    csrfToken?: string;
    userId?: string;
    userLogin?: string;
    userName?: string;
    userCsrf?: string;
    userStarted?: number;
  }
}

export const app = express();
const rootDir = process.cwd();

app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(rootDir, 'views'));

// Raw binary upload parser specifically for APK uploads (must precede generic json parser)
app.use(
  '/api/admin/apk-upload',
  express.raw({
    type: ['application/vnd.android.package-archive', 'application/octet-stream'],
    limit: '120mb',
  })
);
app.use('/api/admin/apk-upload', express.json({ limit: '120mb' }));

app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    const origSetHeader = res.setHeader.bind(res);
    res.setHeader = ((name: string, value: number | string | readonly string[]) => {
      if (name.toLowerCase() === 'set-cookie') {
        const addPartitioned = (v: string) =>
          /;\s*Partitioned/i.test(v) ? v : `${v}; Partitioned`;
        value = Array.isArray(value)
          ? value.map((v) => addPartitioned(String(v)))
          : addPartitioned(String(value));
      }
      return origSetHeader(name, value);
    }) as typeof res.setHeader;
  }
  next();
});

app.use(
  session({
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  })
);

app.use((req, _res, next) => {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  if (isHttps) {
    req.session.cookie.secure = true;
    req.session.cookie.sameSite = 'none';
  } else {
    req.session.cookie.secure = false;
    req.session.cookie.sameSite = 'lax';
  }
  next();
});

function assetVersion(webPath: string): number {
  const fullPath = path.join(rootDir, webPath.replace(/^\/+/, ''));
  try {
    return Math.floor(fs.statSync(fullPath).mtimeMs / 1000);
  } catch {
    return Math.floor(Date.now() / 1000);
  }
}

function getClientIp(req: Request): string {
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length > 0) {
    return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || '';
}

function getRequestOrigin(req: Request): string {
  const proto =
    typeof req.headers['x-forwarded-proto'] === 'string'
      ? req.headers['x-forwarded-proto'].split(',')[0].trim()
      : req.protocol || 'http';
  const host =
    typeof req.headers['x-forwarded-host'] === 'string'
      ? req.headers['x-forwarded-host'].split(',')[0].trim()
      : req.get('host') || `localhost:${config.port}`;
  return `${proto}://${host}`;
}

function noCacheJson(res: Response, data: unknown, status = 200): void {
  res.status(status);
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.json(data);
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const header = req.headers.cookie;
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

function ensureAdminCsrf(req: Request): string {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

function verifyAdminCsrf(req: Request, expectedOverride?: string): boolean {
  const headerToken = req.headers['x-csrf-token'];
  const token =
    typeof headerToken === 'string'
      ? headerToken
      : typeof req.body?.csrf_token === 'string'
        ? req.body.csrf_token
        : '';
  const expected = expectedOverride || req.session.csrfToken || '';
  if (!token || !expected || token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(token));
}

interface AdminTokenPayload {
  email: string;
  csrf: string;
  exp: number;
}

function createAdminToken(email: string, csrf: string): string {
  const payload: AdminTokenPayload = {
    email,
    csrf,
    exp: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyAdminToken(rawToken: unknown): AdminTokenPayload | null {
  if (typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update(data)
    .digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as AdminTokenPayload;
    if (!parsed.email || !parsed.csrf || !parsed.exp) return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

interface WatchTokenPayload {
  uid: string;
  login: string;
  isAdmin?: boolean;
  exp: number;
}

function createWatchToken(uid: string, login: string, isAdmin = false): string {
  const payload: WatchTokenPayload = {
    uid,
    login,
    isAdmin,
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600,
  };
  const data = Buffer.from(JSON.stringify(payload), 'utf-8').toString('base64url');
  const sig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update('watch:' + data)
    .digest('base64url');
  return `${data}.${sig}`;
}

function verifyWatchToken(rawToken: unknown): WatchTokenPayload | null {
  if (typeof rawToken !== 'string') return null;
  const parts = rawToken.trim().split('.');
  if (parts.length !== 2) return null;
  const [data, sig] = parts;
  if (!data || !sig) return null;
  const expectedSig = crypto
    .createHmac('sha256', config.sessionSecret)
    .update('watch:' + data)
    .digest('base64url');
  if (sig.length !== expectedSig.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expectedSig))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as WatchTokenPayload;
    if (!parsed.uid || !parsed.login || !parsed.exp) return null;
    if (parsed.exp <= Math.floor(Date.now() / 1000)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function setAuthTokenCookies(
  req: Request,
  res: Response,
  opts: { watchToken?: string; adminToken?: string }
): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = isHttps
    ? 'Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000';
  if (opts.watchToken) {
    res.append('Set-Cookie', `pqtv_watch_token=${encodeURIComponent(opts.watchToken)}; ${attrs}`);
  }
  if (opts.adminToken) {
    res.append('Set-Cookie', `pqtv_admin_token=${encodeURIComponent(opts.adminToken)}; ${attrs}`);
  }
}

function clearAuthTokenCookies(req: Request, res: Response, which: 'watch' | 'admin' | 'all'): void {
  const isHttps = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const attrs = isHttps
    ? 'Path=/; HttpOnly; SameSite=None; Secure; Max-Age=0'
    : 'Path=/; HttpOnly; SameSite=Lax; Max-Age=0';
  if (which === 'watch' || which === 'all') {
    res.append('Set-Cookie', `pqtv_watch_token=; ${attrs}`);
  }
  if (which === 'admin' || which === 'all') {
    res.append('Set-Cookie', `pqtv_admin_token=; ${attrs}`);
  }
}

function getAdminAuthFromRequest(req: Request): AdminTokenPayload | null {
  const cookies = parseCookies(req);
  const explicitCandidates = [
    req.headers['x-admin-token'],
    req.query.admin_token,
    req.body?.admin_token,
  ];
  for (const cand of explicitCandidates) {
    const parsed = verifyAdminToken(cand);
    if (parsed && isAllowedAdminEmail(parsed.email)) {
      return parsed;
    }
  }
  if (req.session.authenticated) {
    return {
      email: config.adminEmail,
      csrf: req.session.csrfToken || '',
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  }
  const cookieToken = verifyAdminToken(cookies.pqtv_admin_token);
  if (cookieToken && isAllowedAdminEmail(cookieToken.email)) {
    return cookieToken;
  }
  return null;
}

function isAllowedAdminEmail(email: string): boolean {
  const lower = email.trim().toLowerCase();
  return (
    BOOTSTRAPPED_ADMIN_EMAILS.includes(lower) || lower === config.adminEmail.trim().toLowerCase()
  );
}

const adminAuthFile = path.join(config.dataDir, 'admin_auth.json');

function getAdminPasswordHashOverride(): string {
  try {
    if (!fs.existsSync(adminAuthFile)) return '';
    const raw = JSON.parse(fs.readFileSync(adminAuthFile, 'utf-8')) as { passwordHash?: string };
    return typeof raw.passwordHash === 'string' ? raw.passwordHash : '';
  } catch {
    return '';
  }
}

function saveAdminPasswordHashOverride(passwordHash: string): boolean {
  try {
    fs.mkdirSync(path.dirname(adminAuthFile), { recursive: true });
    fs.writeFileSync(adminAuthFile, JSON.stringify({ passwordHash }, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function checkAdminPassword(pass: string): boolean {
  const overrideHash = getAdminPasswordHashOverride();
  const envPlain = process.env.ADMIN_PASSWORD || '';
  return (
    (Boolean(overrideHash) && verifyPassword(pass, overrideHash)) ||
    (envPlain.length > 0 && pass === envPlain) ||
    verifyPassword(pass, config.adminPasswordHash)
  );
}

// Authoritative server-side Firestore REST helpers (authenticated using user's own verified ID Token, zero IAM needed)
let cachedFirebaseCfg: { projectId: string; firestoreDatabaseId: string } | null = null;
function getFirebaseCfg(): { projectId: string; firestoreDatabaseId: string } | null {
  if (cachedFirebaseCfg) return cachedFirebaseCfg;
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(rootDir, 'firebase-applet-config.json'), 'utf-8')
    ) as { projectId?: string; firestoreDatabaseId?: string };
    if (raw.projectId) {
      cachedFirebaseCfg = {
        projectId: raw.projectId,
        firestoreDatabaseId: raw.firestoreDatabaseId || '(default)',
      };
      return cachedFirebaseCfg;
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchFirestoreAdminFlag(uid: string, idToken: string): Promise<boolean> {
  const cfg = getFirebaseCfg();
  if (!cfg) return false;
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/admins/${encodeURIComponent(uid)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function fetchFirestoreUserProfile(
  uid: string,
  idToken: string
): Promise<{ login?: string; name?: string; playlists?: string[]; enabled?: boolean; role?: string } | null> {
  const cfg = getFirebaseCfg();
  if (!cfg) return null;
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/users/${encodeURIComponent(uid)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as {
      fields?: Record<
        string,
        {
          stringValue?: string;
          booleanValue?: boolean;
          arrayValue?: { values?: Array<{ stringValue?: string }> };
        }
      >;
    };
    const f = doc.fields || {};
    return {
      login: f.login?.stringValue,
      name: f.name?.stringValue,
      enabled: f.enabled?.booleanValue,
      role: f.role?.stringValue,
      playlists: Array.isArray(f.playlists?.arrayValue?.values)
        ? f.playlists!.arrayValue!.values!
            .map((v) => v.stringValue || '')
            .filter(Boolean)
        : undefined,
    };
  } catch {
    return null;
  }
}

async function fetchFirestoreInvite(
  emailLower: string,
  idToken: string
): Promise<{ name?: string; playlists?: string[]; enabled?: boolean } | null> {
  const cfg = getFirebaseCfg();
  if (!cfg || !emailLower) return null;
  const emailHash = hashEmailId(emailLower);
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(cfg.projectId)}/databases/${encodeURIComponent(cfg.firestoreDatabaseId)}/documents/invites/${encodeURIComponent(emailHash)}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${idToken}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const doc = (await res.json()) as {
      fields?: Record<
        string,
        {
          stringValue?: string;
          booleanValue?: boolean;
          arrayValue?: { values?: Array<{ stringValue?: string }> };
        }
      >;
    };
    const f = doc.fields || {};
    return {
      name: f.name?.stringValue,
      enabled: f.enabled?.booleanValue,
      playlists: Array.isArray(f.playlists?.arrayValue?.values)
        ? f.playlists!.arrayValue!.values!
            .map((v) => v.stringValue || '')
            .filter(Boolean)
        : undefined,
    };
  } catch {
    return null;
  }
}

function getViewerFromRequest(req: Request): {
  userId: string;
  login: string;
  name: string;
  isAdminViewer: boolean;
  playlists: string[];
} | null {
  const cookies = parseCookies(req);
  const watchTok =
    verifyWatchToken(req.headers['x-watch-token']) ||
    verifyWatchToken(req.body?.watch_token) ||
    verifyWatchToken(cookies.pqtv_watch_token);

  // 1. Admin viewing TV directly
  const adminAuth = getAdminAuthFromRequest(req);
  if (adminAuth || watchTok?.isAdmin) {
    return {
      userId: watchTok?.uid || 'admin',
      login: watchTok?.login || adminAuth?.email || config.adminEmail,
      name: 'Администратор',
      isAdminViewer: true,
      playlists: storage.getPlaylists(),
    };
  }

  // 2. Normal session or stateless watch token
  const uid = req.session.userId || watchTok?.uid || '';
  if (!uid) return null;

  const u = userAuth.find(uid) || (watchTok?.login ? userAuth.findByLogin(watchTok.login) : null);
  if (!u || !u.enabled) return null;

  return {
    userId: u.id,
    login: u.login,
    name: u.name || u.login,
    isAdminViewer: false,
    playlists: Array.isArray(u.playlists) ? u.playlists : [],
  };
}

// Static assets
app.use('/assets', express.static(path.join(rootDir, 'assets')));
app.use('/logo', express.static(path.join(rootDir, 'logo')));
app.get('/playlist/:filename', (req, res, next) => {
  const raw = String(req.params.filename || '');
  if (!raw.endsWith('.m3u')) {
    next();
    return;
  }
  const cleanName = raw.slice(0, -4);
  if (!storage.isValidFilename(cleanName)) {
    res.status(400).send('Invalid playlist name');
    return;
  }
  const filePath = storage.getPlaylistPath(cleanName);
  if (!fs.existsSync(filePath)) {
    res.status(404).send('Playlist not found');
    return;
  }
  const active = parseM3uFile(filePath).filter((ch) => !ch.paused);
  res.setHeader('Content-Type', 'audio/x-mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.send(generateM3u(active));
});
app.use('/playlist', express.static(config.playlistDir));
app.get('/manifest.webmanifest', (_req, res) => {
  res.type('application/manifest+json');
  res.sendFile(path.join(rootDir, 'manifest.webmanifest'));
});
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript');
  res.sendFile(path.join(rootDir, 'sw.js'));
});
app.get('/favicon.ico', (_req, res) => {
  const icoPath = path.join(rootDir, 'assets/icons/icon-192.png');
  if (fs.existsSync(icoPath)) {
    res.sendFile(icoPath);
    return;
  }
  res.status(204).end();
});

function detectApkClientCode(req: Request): number {
  const qCode = Number(req.query.apk_code ?? req.query.currentCode ?? 0);
  if (Number.isFinite(qCode) && qCode > 0) return Math.floor(qCode);
  const hdrCode = Number(req.headers['x-pqtv-version-code'] || 0);
  if (Number.isFinite(hdrCode) && hdrCode > 0) return Math.floor(hdrCode);
  const ua = String(req.headers['user-agent'] || '');
  const m = ua.match(/PQTV-Code\/(\d+)/i);
  if (m) {
    const uaCode = Number(m[1]);
    if (Number.isFinite(uaCode) && uaCode > 0) return Math.floor(uaCode);
  }
  return 0;
}

function isSafeExternalApkUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'github.com' || h.endsWith('.github.com') || h.endsWith('.githubusercontent.com');
  } catch {
    return false;
  }
}

// ============ PUBLIC APK OTA UPDATE & DOWNLOAD ROUTES ============
app.get('/api/app/version', (req, res) => {
  const currentCode = detectApkClientCode(req);
  const check = apkManager.checkClientVersion(currentCode);
  const origin = getRequestOrigin(req);

  noCacheJson(res, {
    ok: true,
    hasApk: check.hasApk,
    currentCode,
    updateAvailable: check.updateAvailable,
    isBlocked: check.isBlocked,
    mustUpdate: check.mustUpdate,
    blockMode: check.blockMode,
    blockReason: check.blockReason,
    minSupportedVersionCode: check.policy.minSupportedVersionCode,
    blockedVersionCodes: check.policy.blockedVersionCodes,
    latest: check.latest
      ? {
          ...check.latest,
          apkUrl: '/apk/latest.apk',
          fullApkUrl: `${origin}/apk/latest.apk`,
        }
      : null,
    serverOrigin: origin,
    platform: {
      canBuildApkLocally: false,
      androidProjectReady: fs.existsSync(path.join(rootDir, 'android-tv/app/build.gradle.kts')),
    },
  });
});

function serveApkFile(req: Request, res: Response, filePath: string, downloadName: string): void {
  try {
    const stat = fs.statSync(filePath);
    const total = stat.size;
    res.setHeader('Content-Type', 'application/vnd.android.package-archive');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'no-cache');

    const range = req.headers.range;
    if (range) {
      const m = range.match(/bytes=(\d+)-(\d*)/);
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= 0 && start <= end && end < total) {
          res.status(206);
          res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
          res.setHeader('Content-Length', String(end - start + 1));
          fs.createReadStream(filePath, { start, end }).pipe(res);
          return;
        }
      }
    }
    res.setHeader('Content-Length', String(total));
    fs.createReadStream(filePath).pipe(res);
  } catch {
    res.status(404).send('APK not found');
  }
}

app.get('/apk/latest.apk', async (req, res) => {
  const latest = apkManager.getLatestFilePath();
  if (!latest) {
    res.status(404).send('No APK release published yet');
    return;
  }
  if (latest.path && fs.existsSync(latest.path)) {
    serveApkFile(req, res, latest.path, latest.release.filename);
    return;
  }
  const restored = await restoreApkReleaseFromGithub(latest.release).catch(() => null);
  const restoredPath = restored ? apkManager.getApkFilePath(restored.filename) : null;
  if (restoredPath) {
    serveApkFile(req, res, restoredPath, latest.release.filename);
    return;
  }
  if (latest.release.externalApkUrl && isSafeExternalApkUrl(latest.release.externalApkUrl)) {
    res.redirect(302, latest.release.externalApkUrl);
    return;
  }
  res.status(404).send('APK binary not found on server or GitHub');
});

app.get('/apk/:filename', async (req, res) => {
  const rawFilename = String(req.params.filename || '');
  const found = apkManager.getApkFilePath(rawFilename);
  if (found) {
    serveApkFile(req, res, found, path.basename(found));
    return;
  }
  const rel = apkManager.getReleaseByFilename(rawFilename);
  if (rel) {
    const restored = await restoreApkReleaseFromGithub(rel).catch(() => null);
    const restoredPath = restored ? apkManager.getApkFilePath(restored.filename) : null;
    if (restoredPath) {
      serveApkFile(req, res, restoredPath, path.basename(restoredPath));
      return;
    }
    if (rel.externalApkUrl && isSafeExternalApkUrl(rel.externalApkUrl)) {
      res.redirect(302, rel.externalApkUrl);
      return;
    }
  }
  res.status(404).send('APK not found');
});

// CI / Admin APK Upload Endpoint (supports both APK_UPLOAD_TOKEN bearer & Admin UI auth)
app.post('/api/admin/apk-upload', (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const uploadHeader = String(req.headers['x-upload-token'] || '').trim();
  const providedUploadToken = bearer || uploadHeader;

  const hasUploadToken =
    Boolean(config.apkUploadToken) &&
    providedUploadToken.length > 0 &&
    providedUploadToken === config.apkUploadToken;

  const adminAuth = getAdminAuthFromRequest(req);
  let isAdminAuthorized = false;
  if (adminAuth) {
    const csrfExpected = req.session.authenticated
      ? req.session.csrfToken || adminAuth.csrf
      : adminAuth.csrf;
    if (verifyAdminCsrf(req, csrfExpected)) {
      isAdminAuthorized = true;
    }
  }

  if (!hasUploadToken && !isAdminAuthorized) {
    noCacheJson(res, { error: 'Unauthorized APK upload' }, 401);
    return;
  }

  let apkBuffer: Buffer | null = null;
  let versionCode = Number(req.headers['x-version-code'] || req.query.versionCode || 0);
  let versionName = String(req.headers['x-version-name'] || req.query.versionName || '').trim();
  let changelog = String(req.headers['x-changelog'] || req.query.changelog || '').trim();
  let mandatory = String(req.headers['x-mandatory'] || req.query.mandatory || '') === 'true';
  let bumpRaw = String(req.headers['x-bump-type'] || req.query.bumpType || 'patch').trim();
  let manualOverride = String(req.headers['x-manual-override'] || req.query.manualOverride || '') === 'true';
  let autoBlockOlder = String(req.headers['x-auto-block-older'] || req.query.autoBlockOlder || '') === 'true';

  if (Buffer.isBuffer(req.body)) {
    apkBuffer = req.body;
  } else if (req.body && typeof req.body === 'object' && typeof req.body.dataBase64 === 'string') {
    const b64 = req.body.dataBase64.replace(/^data:[^;]+;base64,/, '');
    apkBuffer = Buffer.from(b64, 'base64');
    versionCode = Number(req.body.versionCode || versionCode);
    versionName = String(req.body.versionName || versionName).trim();
    changelog = String(req.body.changelog || changelog).trim();
    mandatory = Boolean(req.body.mandatory ?? mandatory);
    bumpRaw = String(req.body.bumpType || bumpRaw).trim();
    manualOverride = Boolean(req.body.manualOverride ?? manualOverride);
    autoBlockOlder = Boolean(req.body.autoBlockOlder ?? autoBlockOlder);
  }

  if (!apkBuffer || !isValidApkBuffer(apkBuffer)) {
    noCacheJson(
      res,
      { error: 'Некорректный файл APK (ожидается подписанный .apk архив)' },
      400
    );
    return;
  }

  const bumpType: VersionBumpType =
    bumpRaw === 'major' || bumpRaw === 'minor' ? bumpRaw : 'patch';

  const release = apkManager.publishApk({
    buffer: apkBuffer,
    versionCode: versionCode > 0 ? versionCode : undefined,
    versionName: versionName || undefined,
    bumpType,
    manualOverride: manualOverride || (versionCode > 0 && Boolean(versionName)),
    changelog,
    mandatory,
    autoBlockOlder,
    source: 'upload',
  });

  const meta = stateLifecycle.bumpRevision('apk_update', 'apk_upload', {
    versionCode: release.versionCode,
    versionName: release.versionName,
  });

  noCacheJson(res, {
    ok: true,
    release,
    policy: apkManager.getPolicy(),
    suggestions: apkManager.getAllVersionSuggestions(),
    revision: meta.revision,
  });
});

// ============ UNIFIED AUTH (ADMINS -> /editor, VIEWERS -> /watch) ============
app.get('/login', (req, res) => {
  const admin = getAdminAuthFromRequest(req);
  if (admin) {
    res.redirect('/editor');
    return;
  }
  const viewer = getViewerFromRequest(req);
  if (viewer) {
    res.redirect('/watch');
    return;
  }
  res.render('login', {
    error: '',
    loginInput: '',
    assetVersion,
  });
});

app.post('/login', (req, res) => {
  const login = String(req.body?.login || req.body?.email || '').trim();
  const pass = String(req.body?.password || '');

  // 1. Check Admin credentials first -> go straight to /editor
  if (isAllowedAdminEmail(login) && checkAdminPassword(pass)) {
    req.session.authenticated = true;
    const csrf = ensureAdminCsrf(req);
    const adminToken = createAdminToken(login, csrf);
    const watchToken = createWatchToken('admin', login, true);
    setAuthTokenCookies(req, res, { adminToken, watchToken });
    res.render('editor', {
      csrfToken: csrf,
      adminToken,
      assetVersion,
    });
    return;
  }

  // 2. Check Viewer credentials -> go to /watch
  const candidate = userAuth.findByLogin(login);
  if (candidate && !candidate.enabled) {
    res.render('login', {
      error: 'Ваш аккаунт отключён или ожидает активации администратором',
      loginInput: login,
      assetVersion,
    });
    return;
  }

  const user = userAuth.authenticate(login, pass);
  if (user) {
    req.session.userId = user.id;
    req.session.userLogin = user.login;
    req.session.userName = user.name || user.login;
    req.session.userCsrf = crypto.randomBytes(32).toString('hex');
    req.session.userStarted = Math.floor(Date.now() / 1000);
    userAuth.touchSession(user.id, getClientIp(req), String(req.headers['user-agent'] || ''));

    const watchToken = createWatchToken(user.id, user.login, false);
    setAuthTokenCookies(req, res, { watchToken });
    res.render('watch', {
      watchToken,
      uName: user.name || user.login,
      uLogin: user.login,
      isAdminViewer: false,
      appVersionName: apkManager.getLatest()?.versionName || '1.0.0',
      appVersionCode: apkManager.getLatest()?.versionCode || 1,
      uiSettings: getUiSettings(),
      assetVersion,
    });
    return;
  }

  res.render('login', {
    error: 'Неверный логин, email или пароль',
    loginInput: login,
    assetVersion,
  });
});

app.get('/logout', (req, res) => {
  req.session.authenticated = false;
  delete req.session.csrfToken;
  delete req.session.userId;
  delete req.session.userLogin;
  delete req.session.userName;
  clearAuthTokenCookies(req, res, 'all');
  res.redirect('/login?logged_out=1');
});

app.get('/watch/logout', (req, res) => {
  delete req.session.userId;
  delete req.session.userLogin;
  delete req.session.userName;
  delete req.session.userCsrf;
  delete req.session.userStarted;
  clearAuthTokenCookies(req, res, 'watch');
  res.redirect('/login?logged_out=1');
});

// Legacy POST /watch/login forwards cleanly to unified handler logic
app.post('/watch/login', (req, res, next) => {
  req.url = '/login';
  next();
});

// Unified Google Login API (auto-routes Admins -> /editor, Viewers -> /watch)
app.post('/api/auth/unified-google-login', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    noCacheJson(res, { error: 'Missing Authorization token' }, 401);
    return;
  }

  try {
    const decoded = await verifyFirebaseIdToken(token);
    if (!decoded.email_verified) {
      noCacheJson(res, { error: 'Email аккаунта Google не подтверждён' }, 403);
      return;
    }

    const emailLower = decoded.email.toLowerCase();
    const isAdmin =
      isAllowedAdminEmail(emailLower) || (await fetchFirestoreAdminFlag(decoded.uid, token));

    if (isAdmin) {
      req.session.authenticated = true;
      const csrfToken = ensureAdminCsrf(req);
      const adminToken = createAdminToken(decoded.email, csrfToken);
      const watchToken = createWatchToken(decoded.uid, decoded.email, true);
      setAuthTokenCookies(req, res, { adminToken, watchToken });

      noCacheJson(res, {
        ok: true,
        role: 'admin',
        redirectTo: '/editor',
        email: decoded.email,
        adminToken,
        csrfToken,
        watchToken,
      });
      return;
    }

    // Viewer via Google Sign-In: check Firestore profile, Firestore invite, local invite, and local synced DB
    const fsProfile = await fetchFirestoreUserProfile(decoded.uid, token);
    const fsInvite = await fetchFirestoreInvite(emailLower, token);
    const localInvite = userAuth.findInviteByEmail(emailLower);
    const fallbackLogin = (decoded.email.split('@')[0] || decoded.uid)
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 32);

    const reqPlaylists = Array.isArray(req.body?.playlists)
      ? req.body.playlists.filter(
          (p: unknown): p is string => typeof p === 'string' && storage.isValidFilename(p)
        )
      : [];

    const existing = userAuth.find(decoded.uid) || userAuth.findByLogin(fallbackLogin);
    const inviteSource = fsInvite || localInvite;

    let effectiveEnabled = fsProfile
      ? Boolean(fsProfile.enabled)
      : existing
        ? Boolean(existing.enabled)
        : false;
    let effectivePlaylists = fsProfile?.playlists ?? existing?.playlists ?? reqPlaylists;
    if (!effectiveEnabled && (!effectivePlaylists || effectivePlaylists.length === 0) && inviteSource) {
      effectiveEnabled = Boolean(inviteSource.enabled);
      effectivePlaylists = Array.isArray(inviteSource.playlists) ? inviteSource.playlists : [];
    }

    const effectiveLogin = fsProfile?.login || existing?.login || fallbackLogin;
    const effectiveName =
      fsProfile?.name ||
      (inviteSource?.name ? inviteSource.name : '') ||
      existing?.name ||
      decoded.name ||
      effectiveLogin;

    const synced = userAuth.upsertSyncedUser({
      id: decoded.uid,
      login: effectiveLogin,
      name: effectiveName,
      playlists: (effectivePlaylists || []).filter((p: string) => storage.isValidFilename(p)),
      enabled: effectiveEnabled,
    });
    if (localInvite) {
      userAuth.markInviteClaimed(emailLower, decoded.uid);
    }

    if (!synced.enabled) {
      noCacheJson(
        res,
        {
          ok: false,
          pendingApproval: true,
          error: 'Аккаунт зарегистрирован и ожидает активации администратором',
        },
        403
      );
      return;
    }

    req.session.userId = synced.id;
    req.session.userLogin = synced.login;
    req.session.userName = synced.name || synced.login;
    req.session.userCsrf = crypto.randomBytes(32).toString('hex');
    req.session.userStarted = Math.floor(Date.now() / 1000);
    userAuth.touchSession(synced.id, getClientIp(req), String(req.headers['user-agent'] || ''));

    const watchToken = createWatchToken(synced.id, synced.login, false);
    setAuthTokenCookies(req, res, { watchToken });

    noCacheJson(res, {
      ok: true,
      role: 'viewer',
      redirectTo: '/watch',
      watchToken,
      user: { id: synced.id, login: synced.login, name: synced.name },
    });
  } catch (err) {
    noCacheJson(
      res,
      { error: err instanceof Error ? err.message : 'Invalid Firebase token' },
      401
    );
  }
});

// Keep legacy endpoint aliases compatible
app.post('/api/auth/firebase-login', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    noCacheJson(res, { error: 'Missing Authorization token' }, 401);
    return;
  }
  try {
    const decoded = await verifyFirebaseIdToken(token);
    if (!decoded.email_verified) {
      noCacheJson(res, { error: 'Email аккаунта Google не подтверждён' }, 403);
      return;
    }
    const isAdmin =
      isAllowedAdminEmail(decoded.email) || (await fetchFirestoreAdminFlag(decoded.uid, token));
    if (!isAdmin) {
      noCacheJson(res, { error: 'У этого аккаунта Google нет прав администратора' }, 403);
      return;
    }
    req.session.authenticated = true;
    const csrfToken = ensureAdminCsrf(req);
    const adminToken = createAdminToken(decoded.email, csrfToken);
    const watchToken = createWatchToken(decoded.uid, decoded.email, true);
    setAuthTokenCookies(req, res, { adminToken, watchToken });
    noCacheJson(res, { ok: true, email: decoded.email, adminToken, csrfToken, watchToken });
  } catch (err) {
    noCacheJson(
      res,
      { error: err instanceof Error ? err.message : 'Invalid Firebase token' },
      401
    );
  }
});

// ============ WATCH (TV / VIEWERS) ============
app.all(['/watch', '/watch/login'], (req, res) => {
  const viewer = getViewerFromRequest(req);
  if (!viewer) {
    if (req.method === 'POST') {
      res.redirect('/login?clear_token=1');
      return;
    }
    res.render('login', {
      error: '',
      loginInput: '',
      assetVersion,
    });
    return;
  }
  if (!viewer.isAdminViewer) {
    userAuth.touchSession(viewer.userId, getClientIp(req), String(req.headers['user-agent'] || ''));
  }
  const watchToken = createWatchToken(viewer.userId, viewer.login, viewer.isAdminViewer);
  const latestApk = apkManager.getLatest();
  res.render('watch', {
    watchToken,
    uName: viewer.name,
    uLogin: viewer.login,
    isAdminViewer: viewer.isAdminViewer,
    appVersionName: latestApk?.versionName || '1.0.0',
    appVersionCode: latestApk?.versionCode || 1,
    uiSettings: getUiSettings(),
    assetVersion,
  });
});

app.post('/watch/api/firebase-session', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    noCacheJson(res, { error: 'Missing Authorization token' }, 401);
    return;
  }

  try {
    const decoded = await verifyFirebaseIdToken(token);
    if (!decoded.email_verified) {
      noCacheJson(res, { error: 'Email аккаунта Google не подтверждён' }, 403);
      return;
    }

    const emailLower = decoded.email.toLowerCase();
    const isAdmin =
      isAllowedAdminEmail(emailLower) || (await fetchFirestoreAdminFlag(decoded.uid, token));

    if (isAdmin) {
      const allPlaylists = storage.getPlaylists();
      const synced = userAuth.upsertSyncedUser({
        id: decoded.uid,
        login: String(req.body?.login || decoded.email).trim() || decoded.uid,
        name: String(req.body?.name || decoded.name || decoded.email).trim(),
        playlists: allPlaylists,
        enabled: true,
      });
      req.session.userId = synced.id;
      req.session.userLogin = synced.login;
      req.session.userName = synced.name || synced.login;
      req.session.userCsrf = crypto.randomBytes(32).toString('hex');
      req.session.userStarted = Math.floor(Date.now() / 1000);
      const watchToken = createWatchToken(synced.id, synced.login, true);
      setAuthTokenCookies(req, res, { watchToken });
      userAuth.touchSession(synced.id, getClientIp(req), String(req.headers['user-agent'] || ''));
      noCacheJson(res, {
        ok: true,
        watchToken,
        user: { id: synced.id, login: synced.login, name: synced.name },
      });
      return;
    }

    const reqPlaylists = Array.isArray(req.body?.playlists)
      ? req.body.playlists.filter(
          (p: unknown): p is string => typeof p === 'string' && storage.isValidFilename(p)
        )
      : [];
    const fallbackLogin = (decoded.email.split('@')[0] || decoded.uid)
      .replace(/[^a-zA-Z0-9_.-]/g, '_')
      .slice(0, 32);
    const fsProfile = await fetchFirestoreUserProfile(decoded.uid, token);
    const fsInvite = await fetchFirestoreInvite(emailLower, token);
    const localInvite = userAuth.findInviteByEmail(emailLower);
    const existing = userAuth.find(decoded.uid) || userAuth.findByLogin(fallbackLogin);
    const inviteSource = fsInvite || localInvite;

    let enabled = fsProfile ? Boolean(fsProfile.enabled) : Boolean(existing?.enabled);
    let resolvedPlaylists = fsProfile?.playlists || existing?.playlists || reqPlaylists;
    if (!enabled && (!resolvedPlaylists || resolvedPlaylists.length === 0) && inviteSource) {
      enabled = Boolean(inviteSource.enabled);
      resolvedPlaylists = Array.isArray(inviteSource.playlists) ? inviteSource.playlists : [];
    }

    const synced = userAuth.upsertSyncedUser({
      id: decoded.uid,
      login: fsProfile?.login || existing?.login || String(req.body?.login || fallbackLogin).trim(),
      name:
        fsProfile?.name ||
        (inviteSource?.name ? inviteSource.name : '') ||
        existing?.name ||
        String(req.body?.name || decoded.name || fallbackLogin).trim(),
      playlists: resolvedPlaylists.filter((p: string) => storage.isValidFilename(p)),
      enabled,
    });
    if (localInvite) {
      userAuth.markInviteClaimed(emailLower, decoded.uid);
    }

    if (!synced.enabled) {
      noCacheJson(
        res,
        { error: 'Аккаунт зарегистрирован и ожидает активации администратором' },
        403
      );
      return;
    }

    req.session.userId = synced.id;
    req.session.userLogin = synced.login;
    req.session.userName = synced.name || synced.login;
    req.session.userCsrf = crypto.randomBytes(32).toString('hex');
    req.session.userStarted = Math.floor(Date.now() / 1000);
    const watchToken = createWatchToken(synced.id, synced.login, false);
    setAuthTokenCookies(req, res, { watchToken });
    userAuth.touchSession(synced.id, getClientIp(req), String(req.headers['user-agent'] || ''));
    noCacheJson(res, {
      ok: true,
      watchToken,
      user: { id: synced.id, login: synced.login, name: synced.name },
    });
  } catch (err) {
    noCacheJson(
      res,
      { error: err instanceof Error ? err.message : 'Invalid Firebase token' },
      401
    );
  }
});

app.use('/watch/api', (req: Request, res: Response, next: NextFunction) => {
  const viewer = getViewerFromRequest(req);
  if (!viewer) {
    noCacheJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  (req as Request & { currentViewer: typeof viewer }).currentViewer = viewer;
  next();
});

app.get('/watch/api/channels', (req, res) => {
  const viewer = (
    req as Request & { currentViewer: NonNullable<ReturnType<typeof getViewerFromRequest>> }
  ).currentViewer;
  if (!viewer.isAdminViewer) {
    userAuth.touchSession(viewer.userId, getClientIp(req), String(req.headers['user-agent'] || ''));
  }

  const playlists = viewer.playlists;
  const availableMap = new Map<string, Channel>();
  const excludedMap = new Map<string, { name: string; group: string; reason: string; diagCode?: string; playlist: string }>();
  const playlistErrors: Array<{ name: string; group: string; reason: string; diagCode?: string; playlist?: string }> = [];

  for (const pl of playlists) {
    if (!storage.isValidFilename(pl)) {
      playlistErrors.push({
        name: `Плейлист ${pl}`,
        group: 'Плейлист',
        reason: 'Некорректное имя плейлиста',
        playlist: pl,
      });
      continue;
    }
    const filePath = storage.getPlaylistPath(pl);
    if (!fs.existsSync(filePath)) {
      playlistErrors.push({
        name: `Плейлист ${pl}.m3u`,
        group: 'Плейлист',
        reason: 'Назначенный плейлист не найден на сервере',
        playlist: pl,
      });
      continue;
    }
    const chans = parseM3uFile(filePath);
    if (chans.length === 0) {
      playlistErrors.push({
        name: `Плейлист ${pl}.m3u`,
        group: 'Плейлист',
        reason: 'Плейлист пуст (нет каналов)',
        playlist: pl,
      });
      continue;
    }
    for (const ch of chans) {
      const name = (ch.name || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (availableMap.has(key)) continue;

      const excl = channelHealth.shouldExcludeForViewer(ch);
      if (excl.excluded) {
        if (!excludedMap.has(key)) {
          excludedMap.set(key, {
            name,
            group: ch.group || '',
            reason: excl.reason || 'Канал отключён или недоступен',
            diagCode: excl.diagCode,
            playlist: pl,
          });
        }
        continue;
      }

      excludedMap.delete(key);
      const item: Channel = {
        name,
        group: ch.group || '',
        logo: ch.logo || '',
        url: ch.url || '',
        tvg_id: ch.tvg_id || '',
      };
      if (ch.userAgent) item.userAgent = ch.userAgent;
      if (ch.referer) item.referer = ch.referer;
      if (ch.origin) item.origin = ch.origin;
      availableMap.set(key, item);
    }
  }

  const all = Array.from(availableMap.values());
  const unavailable = [...playlistErrors, ...Array.from(excludedMap.values())];
  const totalCount = all.length + excludedMap.size;
  const clientApkCode = detectApkClientCode(req);
  const apkCheck = apkManager.checkClientVersion(clientApkCode);
  const origin = getRequestOrigin(req);

  noCacheJson(res, {
    channels: all,
    unavailable,
    stats: {
      total: totalCount,
      available: all.length,
      unavailable: excludedMap.size,
    },
    playlists,
    streaming: getStreamingSettings(),
    uiSettings: getUiSettings(),
    apkStatus: {
      currentCode: clientApkCode,
      hasApk: apkCheck.hasApk,
      updateAvailable: apkCheck.updateAvailable,
      isBlocked: apkCheck.isBlocked,
      mustUpdate: apkCheck.mustUpdate,
      blockMode: apkCheck.blockMode,
      blockReason: apkCheck.blockReason,
      minSupportedVersionCode: apkCheck.policy.minSupportedVersionCode,
      latest: apkCheck.latest
        ? {
            ...apkCheck.latest,
            apkUrl: '/apk/latest.apk',
            fullApkUrl: `${origin}/apk/latest.apk`,
          }
        : null,
    },
    user: {
      name: viewer.name,
      login: viewer.login,
      isAdmin: viewer.isAdminViewer,
    },
  });
});

app.get('/watch/api/streaming-settings', (_req, res) => {
  noCacheJson(res, { ok: true, settings: getStreamingSettings() });
});

app.get('/watch/api/ui-settings', (_req, res) => {
  noCacheJson(res, { ok: true, settings: getUiSettings() });
});

app.post('/watch/api/cloud/hydrate-playlists', (req, res) => {
  const viewer = (
    req as Request & { currentViewer: NonNullable<ReturnType<typeof getViewerFromRequest>> }
  ).currentViewer;

  if (req.body?.streaming) {
    const sRes = trySaveStreamingSettings(req.body.streaming);
    if (!sRes.ok) {
      noCacheJson(res, { ok: false, error: sRes.error || 'Не удалось сохранить настройки' }, 500);
      return;
    }
  }

  if (req.body?.uiSettings) {
    const uiRes = trySaveUiSettings(req.body.uiSettings);
    if (!uiRes.ok) {
      noCacheJson(res, { ok: false, error: uiRes.error || 'Не удалось сохранить настройки интерфейса' }, 500);
      return;
    }
  }

  if (req.body?.apkState && typeof req.body.apkState === 'object') {
    apkManager.hydrateState(req.body.apkState);
  }

  const incomingPlaylists = Array.isArray(req.body?.playlists) ? req.body.playlists : [];
  let restored = 0;
  for (const item of incomingPlaylists) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as { name?: unknown; channels?: unknown };
    const plName = String(raw.name || '')
      .replace(/\.m3u$/i, '')
      .trim();
    if (!plName || !storage.isValidFilename(plName)) continue;
    if (!viewer.isAdminViewer && !viewer.playlists.includes(plName)) continue;
    const channels = Array.isArray(raw.channels) ? (raw.channels as Partial<Channel>[]) : [];
    if (storage.saveChannels(plName, channels)) {
      restored++;
    }
  }

  noCacheJson(res, {
    ok: true,
    restored,
    streaming: getStreamingSettings(),
    uiSettings: getUiSettings(),
  });
});

app.post('/watch/api/report-unavailable', (req, res) => {
  const viewer = (
    req as Request & { currentViewer: NonNullable<ReturnType<typeof getViewerFromRequest>> }
  ).currentViewer;
  const totalChannels = Math.max(0, Number(req.body?.totalChannels) || 0);
  const rawItems = Array.isArray(req.body?.items) ? (req.body.items as ChannelAlertIssue[]) : [];

  const alert = userAuth.upsertAlert({
    userId: viewer.userId,
    userLogin: viewer.login,
    userName: viewer.name,
    totalChannels,
    items: rawItems,
  });

  if (rawItems.length > 0) {
    channelHealth.recordViewerReports(viewer, rawItems);
  }

  noCacheJson(res, { ok: true, alert });
});

app.all('/watch/api/ping', (req, res) => {
  const viewer = (
    req as Request & { currentViewer: NonNullable<ReturnType<typeof getViewerFromRequest>> }
  ).currentViewer;
  if (!viewer.isAdminViewer) {
    userAuth.touchSession(viewer.userId, getClientIp(req), String(req.headers['user-agent'] || ''));
  }
  noCacheJson(res, { ok: true, time: Math.floor(Date.now() / 1000) });
});

app.get('/watch/api/epg/now', async (req, res) => {
  const tvgId = String(req.query.tvg_id || '').trim();
  const name = String(req.query.name || '').trim();
  if (!name && !tvgId) {
    noCacheJson(res, { current: null, next: null });
    return;
  }
  try {
    const programmes = await EpgParser.findForChannel(tvgId, name);
    const nn = EpgParser.findNowNext(programmes);
    noCacheJson(res, { current: nn.current, next: nn.next });
  } catch {
    noCacheJson(res, { current: null, next: null });
  }
});

// ============ WATCH ADMIN ROUTES (ADMIN VIEWER ONLY — FOR TV UI) ============
function requireAdminViewer(req: Request, res: Response, next: NextFunction): void {
  const viewer = (
    req as Request & { currentViewer?: NonNullable<ReturnType<typeof getViewerFromRequest>> }
  ).currentViewer;
  if (!viewer || !viewer.isAdminViewer) {
    noCacheJson(res, { error: 'Требуются права администратора' }, 403);
    return;
  }
  next();
}

app.use('/watch/api/admin', requireAdminViewer);

app.get('/watch/api/admin/playlists', (_req, res) => {
  noCacheJson(res, { playlists: storage.getPlaylists() });
});

app.get('/watch/api/admin/users', (_req, res) => {
  const users = userAuth.all();
  const sessions = userAuth.getSessions();
  const now = Math.floor(Date.now() / 1000);
  const out = users.map((u) => {
    const s = sessions[u.id];
    const online = Boolean(s && now - (s.last_ping || 0) < 90);
    return {
      id: u.id,
      login: u.login,
      name: u.name || '',
      playlists: u.playlists || [],
      enabled: Boolean(u.enabled),
      created_at: u.created_at || 0,
      online,
      last_ping: s?.last_ping || 0,
      last_ip: s?.ip || '',
      last_ua: s?.ua || '',
    };
  });
  noCacheJson(res, {
    users: out,
    invites: userAuth.allInvites(),
    playlists: storage.getPlaylists(),
  });
});

app.post('/watch/api/admin/users/save', (req, res) => {
  const id = String(req.body?.id || '').trim();
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : [];
  const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;

  if (!id) {
    const created = userAuth.create(login, password, name, playlists, enabled);
    if (!created.ok) {
      noCacheJson(res, { error: created.error || 'Ошибка' }, 400);
      return;
    }
    const createdFull = created.user ? userAuth.find(created.user.id) : null;
    const meta = stateLifecycle.bumpRevision('users_update', created.user!.id, { action: 'create' });
    noCacheJson(res, {
      ok: true,
      user: created.user,
      revision: meta.revision,
      cloudCred: createdFull
        ? { id: createdFull.id, password_hash: createdFull.password_hash }
        : null,
    });
    return;
  }

  const existing = userAuth.find(id);
  if (!existing) {
    const synced = userAuth.upsertSyncedUser({
      id,
      login: login || id,
      name: name || login || id,
      playlists,
      enabled,
    });
    if (password) {
      const pwdRes = userAuth.update(synced.id, { password });
      if (!pwdRes.ok) {
        noCacheJson(res, { error: pwdRes.error || 'Ошибка' }, 400);
        return;
      }
    }
    const syncedFull = userAuth.find(synced.id);
    const meta = stateLifecycle.bumpRevision('users_update', synced.id, { action: 'upsert' });
    noCacheJson(res, {
      ok: true,
      user: synced,
      revision: meta.revision,
      cloudCred: syncedFull && syncedFull.password_hash
        ? { id: syncedFull.id, password_hash: syncedFull.password_hash }
        : null,
    });
    return;
  }

  const updated = userAuth.update(id, { name, playlists, enabled, password });
  if (!updated.ok) {
    noCacheJson(res, { error: updated.error || 'Ошибка' }, 400);
    return;
  }
  const updatedFull = userAuth.find(id);
  const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'update' });
  noCacheJson(res, {
    ok: true,
    revision: meta.revision,
    cloudCred: updatedFull && updatedFull.password_hash
      ? { id: updatedFull.id, password_hash: updatedFull.password_hash }
      : null,
  });
});

app.post('/watch/api/admin/users/delete', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) {
    noCacheJson(res, { error: 'Пустой ID' }, 400);
    return;
  }
  if (userAuth.delete(id)) {
    const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'delete' });
    noCacheJson(res, { ok: true, revision: meta.revision });
    return;
  }
  noCacheJson(res, { error: 'Пользователь не найден' }, 404);
});

app.post('/watch/api/admin/invites/save', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : [];
  const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;
  const saved = userAuth.saveInvite({ email, name, playlists, enabled });
  if (!saved.ok) {
    noCacheJson(res, { error: saved.error || 'Ошибка сохранения приглашения' }, 400);
    return;
  }
  const meta = stateLifecycle.bumpRevision('users_update', saved.invite!.id, { action: 'invite_save' });
  noCacheJson(res, { ok: true, invite: saved.invite, revision: meta.revision });
});

app.post('/watch/api/admin/invites/delete', (req, res) => {
  const id = String(req.body?.id || req.body?.email || '').trim();
  if (!id || !userAuth.deleteInvite(id)) {
    noCacheJson(res, { error: 'Приглашение не найдено' }, 404);
    return;
  }
  const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'invite_delete' });
  noCacheJson(res, { ok: true, revision: meta.revision });
});

app.get('/watch/api/admin/alerts', (_req, res) => {
  const alerts = userAuth.allAlerts();
  noCacheJson(res, {
    alerts,
    activeCount: alerts.filter((a) => !a.resolved && a.unavailableCount > 0).length,
  });
});

app.post('/watch/api/admin/alerts/resolve', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const resolved = req.body?.resolved !== undefined ? Boolean(req.body.resolved) : true;
  if (!id) {
    noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
    return;
  }
  if (!resolved) {
    if (!userAuth.resolveAlert(id, false)) {
      noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
      return;
    }
    noCacheJson(res, { ok: true, resolved: false, stillBroken: false });
    return;
  }
  const verifyRes = await channelHealth.resolveWithVerification({ alertId: id });
  if (!verifyRes.ok) {
    noCacheJson(res, { error: verifyRes.error || 'Предупреждение не найдено' }, 404);
    return;
  }
  noCacheJson(res, verifyRes);
});

app.post('/watch/api/admin/alerts/delete', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id || !userAuth.deleteAlert(id)) {
    noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
    return;
  }
  noCacheJson(res, { ok: true });
});

app.post('/watch/api/admin/streaming-settings', (req, res) => {
  const saved = trySaveStreamingSettings(req.body || {});
  if (!saved.ok) {
    noCacheJson(res, { ok: false, error: saved.error || 'Не удалось сохранить настройки' }, 500);
    return;
  }
  const meta = stateLifecycle.bumpRevision('health_update', 'streaming_settings');
  noCacheJson(res, { ok: true, settings: saved.settings, revision: meta.revision });
});

app.use('/watch/api', (_req, res) => {
  noCacheJson(res, { error: 'Not Found' }, 404);
});

// ============ ROOT & EDITOR ============
app.get('/', (req, res) => {
  if (getAdminAuthFromRequest(req)) {
    res.redirect('/editor');
    return;
  }
  if (getViewerFromRequest(req)) {
    res.redirect('/watch');
    return;
  }
  res.redirect('/login');
});

app.get('/editor', (req, res) => {
  const admin = getAdminAuthFromRequest(req);
  if (!admin) {
    res.redirect('/login');
    return;
  }
  req.session.authenticated = true;
  if (admin.csrf) req.session.csrfToken = admin.csrf;
  const csrf = req.session.csrfToken || ensureAdminCsrf(req);
  const adminToken = createAdminToken(admin.email, csrf);
  res.render('editor', {
    csrfToken: csrf,
    adminToken,
    assetVersion,
  });
});

app.post('/editor', (req, res) => {
  const admin = getAdminAuthFromRequest(req);
  if (admin) {
    req.session.authenticated = true;
    if (admin.csrf) req.session.csrfToken = admin.csrf;
    const csrf = req.session.csrfToken || ensureAdminCsrf(req);
    const adminToken = createAdminToken(admin.email, csrf);
    const watchToken = createWatchToken('admin', admin.email, true);
    setAuthTokenCookies(req, res, { adminToken, watchToken });
    res.render('editor', {
      csrfToken: csrf,
      adminToken,
      assetVersion,
    });
    return;
  }
  res.redirect('/login?clear_token=1');
});

// ============ PUBLIC STREAM PROXY (SSRF PROTECTION, HEADER FORWARDING, CLEAN ABORT) ============
function resolveProxyUrl(raw: string, baseOrigin: string, basePath: string): string {
  if (/^https?:\/\//i.test(raw)) return raw;
  if (raw.startsWith('//')) return 'https:' + raw;
  if (raw.startsWith('/')) return baseOrigin + raw;
  return baseOrigin + basePath + raw;
}

function findPlaylistChannelHints(targetUrl: string): {
  userAgent?: string;
  referer?: string;
  origin?: string;
} {
  const clean = targetUrl.trim();
  if (!clean) return {};
  for (const pl of storage.getPlaylists()) {
    const items = parseM3uFile(storage.getPlaylistPath(pl));
    for (const ch of items) {
      if ((ch.url || '').trim() === clean) {
        return {
          userAgent: ch.userAgent,
          referer: ch.referer,
          origin: ch.origin,
        };
      }
    }
  }
  return {};
}

function buildProxyLink(
  absUrl: string,
  hints: { ua?: string; ref?: string; orig?: string }
): string {
  const params = new URLSearchParams();
  params.set('url', absUrl);
  if (hints.ua) params.set('ua', hints.ua);
  if (hints.ref) params.set('ref', hints.ref);
  if (hints.orig) params.set('orig', hints.orig);
  return `/api/stream/proxy?${params.toString()}`;
}

interface ProxyAgentPool {
  keepAlive: boolean;
  maxSockets: number;
  httpAgent: http.Agent;
  httpsAgent: https.Agent;
  httpsInsecureAgent: https.Agent;
}

let proxyAgentPool: ProxyAgentPool | null = null;

function getProxyAgent(
  protocol: string,
  opts: { keepAlive: boolean; maxSockets: number; ignoreTlsErrors: boolean }
): http.Agent | https.Agent {
  const keepAlive = Boolean(opts.keepAlive);
  const maxSockets = Math.max(4, Math.min(200, Math.round(opts.maxSockets || 64)));
  if (
    !proxyAgentPool ||
    proxyAgentPool.keepAlive !== keepAlive ||
    proxyAgentPool.maxSockets !== maxSockets
  ) {
    if (proxyAgentPool) {
      try {
        proxyAgentPool.httpAgent.destroy();
        proxyAgentPool.httpsAgent.destroy();
        proxyAgentPool.httpsInsecureAgent.destroy();
      } catch {
        // ignore old pool destroy errors
      }
    }
    proxyAgentPool = {
      keepAlive,
      maxSockets,
      httpAgent: new http.Agent({
        keepAlive,
        keepAliveMsecs: 15000,
        maxSockets,
        maxFreeSockets: keepAlive ? Math.min(32, maxSockets) : 0,
      }),
      httpsAgent: new https.Agent({
        keepAlive,
        keepAliveMsecs: 15000,
        maxSockets,
        maxFreeSockets: keepAlive ? Math.min(32, maxSockets) : 0,
      }),
      httpsInsecureAgent: new https.Agent({
        keepAlive,
        keepAliveMsecs: 15000,
        maxSockets,
        maxFreeSockets: keepAlive ? Math.min(16, maxSockets) : 0,
        rejectUnauthorized: false,
      }),
    };
  }
  if (protocol === 'https:') {
    return opts.ignoreTlsErrors ? proxyAgentPool.httpsInsecureAgent : proxyAgentPool.httpsAgent;
  }
  return proxyAgentPool.httpAgent;
}

interface OpenedProxyUpstream {
  status: number;
  headers: Record<string, string>;
  incoming: IncomingMessage;
  finalUrl: string;
  destroyUpstream: () => void;
}

async function openProxyUpstreamOnce(
  initialUrl: string,
  opts: {
    headers: Record<string, string>;
    connectTimeoutMs: number;
    ignoreTlsErrors: boolean;
    keepAlive: boolean;
    maxSockets: number;
    maxRedirects: number;
    onAbortRegister?: (abortFn: () => void) => void;
  }
): Promise<OpenedProxyUpstream> {
  const maxRedirects = Math.max(0, Math.min(10, opts.maxRedirects));
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw Object.assign(new Error('Unsupported scheme'), { code: 'ERR_UNSUPPORTED_PROTOCOL' });
    }
    if (isBlockedHostname(parsed.hostname)) {
      throw Object.assign(new Error('Blocked host'), { code: 'ERR_BLOCKED_HOST' });
    }

    const step = await new Promise<
      | { kind: 'redirect'; location: string }
      | { kind: 'open'; opened: OpenedProxyUpstream }
    >((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? https : http;
      const agent = getProxyAgent(parsed.protocol, {
        keepAlive: opts.keepAlive,
        maxSockets: opts.maxSockets,
        ignoreTlsErrors: opts.ignoreTlsErrors,
      });

      let settled = false;
      let currentIncoming: IncomingMessage | null = null;
      const req = mod.request(
        parsed,
        {
          method: 'GET',
          headers: opts.headers,
          agent,
        },
        (incoming: IncomingMessage) => {
          currentIncoming = incoming;
          clearTimeout(connectTimer);
          const status = incoming.statusCode || 200;
          const loc = incoming.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && loc && hop < maxRedirects) {
            incoming.resume();
            if (!settled) {
              settled = true;
              resolve({ kind: 'redirect', location: new URL(loc, parsed).toString() });
            }
            return;
          }

          const flatHeaders: Record<string, string> = {};
          for (const [hk, hv] of Object.entries(incoming.headers)) {
            if (typeof hv === 'string') flatHeaders[hk.toLowerCase()] = hv;
            else if (Array.isArray(hv)) flatHeaders[hk.toLowerCase()] = hv.join(', ');
          }

          if (!settled) {
            settled = true;
            resolve({
              kind: 'open',
              opened: {
                status,
                headers: flatHeaders,
                incoming,
                finalUrl: currentUrl,
                destroyUpstream: () => {
                  try {
                    incoming.destroy();
                  } catch {
                    // ignore
                  }
                  try {
                    req.destroy();
                  } catch {
                    // ignore
                  }
                },
              },
            });
          }
        }
      );

      const abortUpstream = () => {
        clearTimeout(connectTimer);
        if (currentIncoming) {
          try {
            currentIncoming.destroy();
          } catch {
            // ignore
          }
        }
        try {
          req.destroy();
        } catch {
          // ignore
        }
      };

      if (opts.onAbortRegister) {
        opts.onAbortRegister(abortUpstream);
      }

      // Connect/header-only timeout! Cleared as soon as response headers arrive so live streams never die mid-playback.
      const connectTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          abortUpstream();
          reject(Object.assign(new Error('Upstream connect timeout'), { code: 'ETIMEDOUT', name: 'TimeoutError' }));
        }
      }, opts.connectTimeoutMs);

      req.on('error', (err) => {
        clearTimeout(connectTimer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      req.end();
    });

    if (step.kind === 'redirect') {
      currentUrl = step.location;
      continue;
    }
    return step.opened;
  }

  throw Object.assign(new Error('Too many redirects'), { code: 'ERR_TOO_MANY_REDIRECTS' });
}

async function openProxyUpstream(
  initialUrl: string,
  opts: {
    headers: Record<string, string>;
    connectTimeoutMs: number;
    ignoreTlsErrors: boolean;
    keepAlive: boolean;
    maxSockets: number;
    maxRedirects: number;
    retryCount: number;
    isClientClosed?: () => boolean;
    onAbortRegister?: (abortFn: () => void) => void;
  }
): Promise<OpenedProxyUpstream> {
  const attempts = Math.max(1, 1 + Math.max(0, Math.min(5, opts.retryCount)));
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    if (opts.isClientClosed && opts.isClientClosed()) {
      throw Object.assign(new Error('Client closed'), { code: 'ERR_CLIENT_CLOSED' });
    }
    try {
      const opened = await openProxyUpstreamOnce(initialUrl, opts);
      if (opened.status >= 502 && opened.status <= 504 && i < attempts - 1) {
        opened.destroyUpstream();
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      return opened;
    } catch (err) {
      lastErr = err;
      const code = String((err as { code?: string } | null)?.code || '');
      if (code === 'ERR_UNSUPPORTED_PROTOCOL' || code === 'ERR_BLOCKED_HOST') {
        throw err;
      }
      if (i < attempts - 1 && !(opts.isClientClosed && opts.isClientClosed())) {
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
    }
  }
  throw lastErr;
}

const detectedFormatCache = new Map<string, { kind: 'hls' | 'mpegts' | 'native'; finalUrl: string; expiresAt: number }>();

app.get('/api/stream/detect', async (req, res) => {
  const rawUrl = String(req.query.url || '').trim();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    noCacheJson(res, { ok: false, kind: 'native', error: 'Bad URL' }, 400);
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    noCacheJson(res, { ok: false, kind: 'native', error: 'Bad scheme' }, 400);
    return;
  }
  if (isBlockedHostname(parsed.hostname)) {
    noCacheJson(res, { ok: false, kind: 'native', error: 'Blocked host' }, 403);
    return;
  }

  const now = Date.now();
  const cached = detectedFormatCache.get(rawUrl);
  if (cached && cached.expiresAt > now) {
    noCacheJson(res, { ok: true, kind: cached.kind, finalUrl: cached.finalUrl, cached: true });
    return;
  }

  const streamCfg = getStreamingSettings();
  const srcOpts = StreamParser.getSourceRequestOptions(rawUrl);
  const chHints = findPlaylistChannelHints(rawUrl);
  const effectiveUa = chHints.userAgent || srcOpts.userAgent || streamCfg.proxyUserAgent || 'VLC/3.0.20 LibVLC/3.0.20';

  let clientClosed = false;
  let activeAbortFn: (() => void) | null = null;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      if (activeAbortFn) activeAbortFn();
    }
  });

  try {
    const opened = await openProxyUpstreamOnce(rawUrl, {
      headers: buildOutboundHeaders({
        headers: srcOpts.headers,
        userAgent: effectiveUa,
        referer: chHints.referer || srcOpts.referer || undefined,
        origin: chHints.origin || srcOpts.origin || undefined,
      }),
      connectTimeoutMs: Math.min(8000, Math.max(3000, (streamCfg.proxyTimeoutSec || 15) * 1000)),
      ignoreTlsErrors: srcOpts.ignoreTlsErrors,
      keepAlive: streamCfg.proxyKeepAlive,
      maxSockets: streamCfg.proxyMaxSockets,
      maxRedirects: streamCfg.proxyFollowRedirects,
      onAbortRegister: (fn) => {
        activeAbortFn = fn;
        if (clientClosed) fn();
      },
    });

    const ctype = (opened.headers['content-type'] || '').toLowerCase();
    const lowFinal = opened.finalUrl.split('?')[0].toLowerCase();
    let kind: 'hls' | 'mpegts' | 'native' | null = null;
    if (ctype.includes('mpegurl') || ctype.includes('m3u') || lowFinal.includes('.m3u8')) {
      kind = 'hls';
    } else if (ctype.includes('mp2t') || ctype.includes('mpegts') || lowFinal.endsWith('.ts')) {
      kind = 'mpegts';
    } else if (ctype.includes('mp4') || ctype.includes('webm') || ctype.includes('matroska')) {
      kind = 'native';
    }

    if (!kind) {
      const sample = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          clearTimeout(peekTimer);
          resolve(Buffer.concat(chunks));
        };
        const peekTimer = setTimeout(() => {
          opened.destroyUpstream();
          finish();
        }, 2500);
        opened.incoming.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
          bytes += chunk.length;
          if (bytes >= 512) {
            opened.destroyUpstream();
            finish();
          }
        });
        opened.incoming.on('end', finish);
        opened.incoming.on('error', finish);
        opened.incoming.on('close', finish);
      });
      const txt = sample.toString('utf-8').trimStart();
      if (txt.startsWith('#EXTM3U')) {
        kind = 'hls';
      } else if (sample.length >= 189 && sample[0] === 0x47 && sample[188] === 0x47) {
        kind = 'mpegts';
      } else if (sample.length >= 1 && sample[0] === 0x47) {
        kind = 'mpegts';
      } else {
        kind = 'native';
      }
    } else {
      opened.destroyUpstream();
    }

    if (detectedFormatCache.size >= 500) {
      const firstKey = detectedFormatCache.keys().next().value;
      if (firstKey) detectedFormatCache.delete(firstKey);
    }
    detectedFormatCache.set(rawUrl, { kind, finalUrl: opened.finalUrl, expiresAt: now + 5 * 60 * 1000 });
    if (!clientClosed) {
      noCacheJson(res, { ok: true, kind, finalUrl: opened.finalUrl, contentType: ctype });
    }
  } catch {
    if (!clientClosed) {
      noCacheJson(res, { ok: true, kind: 'native', finalUrl: rawUrl });
    }
  }
});

app.options('/api/stream/proxy', (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.status(204).end();
});

app.get('/api/stream/proxy', async (req, res) => {
  const rawUrl = String(req.query.url || '');
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    res.status(400).send('Bad URL');
    return;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    res.status(400).send('Bad scheme');
    return;
  }
  if (isBlockedHostname(parsed.hostname)) {
    res.status(403).send('Blocked host');
    return;
  }

  const streamCfg = getStreamingSettings();
  const srcOpts = StreamParser.getSourceRequestOptions(rawUrl);
  const chHints = findPlaylistChannelHints(rawUrl);
  const qUa = typeof req.query.ua === 'string' ? req.query.ua.trim() : '';
  const qRef = typeof req.query.ref === 'string' ? req.query.ref.trim() : '';
  const qOrig = typeof req.query.orig === 'string' ? req.query.orig.trim() : '';

  const effectiveUa =
    qUa ||
    chHints.userAgent ||
    srcOpts.userAgent ||
    streamCfg.proxyUserAgent ||
    String(req.headers['user-agent'] || 'VLC/3.0.20 LibVLC/3.0.20');
  const effectiveRef = qRef || chHints.referer || srcOpts.referer || '';
  const effectiveOrig = qOrig || chHints.origin || srcOpts.origin || '';
  const propagatedHints = { ua: effectiveUa, ref: effectiveRef, orig: effectiveOrig };

  const connectTimeoutMs = Math.max(
    3000,
    Math.min(60000, srcOpts.timeoutMs || (streamCfg.proxyTimeoutSec || 15) * 1000)
  );
  const upstreamHeaders = buildOutboundHeaders({
    headers: srcOpts.headers,
    userAgent: effectiveUa,
    referer: effectiveRef || undefined,
    origin: effectiveOrig || undefined,
    range: typeof req.headers.range === 'string' ? req.headers.range : undefined,
  });

  let clientClosed = false;
  let activeAbortFn: (() => void) | null = null;
  res.on('close', () => {
    if (!res.writableFinished) {
      clientClosed = true;
      if (activeAbortFn) activeAbortFn();
    }
  });

  try {
    const opened = await openProxyUpstream(rawUrl, {
      headers: upstreamHeaders,
      connectTimeoutMs,
      ignoreTlsErrors: srcOpts.ignoreTlsErrors,
      keepAlive: streamCfg.proxyKeepAlive,
      maxSockets: streamCfg.proxyMaxSockets,
      maxRedirects: streamCfg.proxyFollowRedirects,
      retryCount: streamCfg.proxyRetryCount,
      isClientClosed: () => clientClosed,
      onAbortRegister: (fn) => {
        activeAbortFn = fn;
        if (clientClosed) fn();
      },
    });

    if (clientClosed) {
      opened.destroyUpstream();
      return;
    }

    const ctype = opened.headers['content-type'] || '';
    const isOk = opened.status >= 200 && opened.status < 400;
    const isPlaylistHint = /\.m3u8?(\?|$)/i.test(rawUrl) || /\.m3u8?(\?|$)/i.test(opened.finalUrl);
    const isPlaylistContentType =
      ctype.toLowerCase().includes('mpegurl') || ctype.toLowerCase().includes('m3u');

    if (isOk && (isPlaylistHint || isPlaylistContentType)) {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;
      await new Promise<void>((resolve, reject) => {
        opened.incoming.on('data', (chunk: Buffer) => {
          totalBytes += chunk.length;
          if (totalBytes <= MAX_PLAYLIST_BYTES) chunks.push(chunk);
        });
        opened.incoming.on('end', () => resolve());
        opened.incoming.on('error', reject);
        opened.incoming.on('close', () => resolve());
      });

      if (clientClosed) return;
      const body = Buffer.concat(chunks).toString('utf-8');
      const trimmedBody = body.trimStart();
      if (trimmedBody.startsWith('#EXTM3U')) {
        const effParsed = new URL(opened.finalUrl);
        const baseOrigin = effParsed.origin;
        const basePath = effParsed.pathname.replace(/\/[^/]*$/, '/');

        const rewritten = body
          .split(/\r\n|\r|\n/)
          .map((line) => {
            const t = line.trim();
            if (!t) return line;
            if (t.startsWith('#')) {
              return line.replace(/URI="([^"]+)"/gi, (_m, u: string) => {
                const abs = resolveProxyUrl(u, baseOrigin, basePath);
                return `URI="${buildProxyLink(abs, propagatedHints)}"`;
              });
            }
            const abs = resolveProxyUrl(t, baseOrigin, basePath);
            return buildProxyLink(abs, propagatedHints);
          })
          .join('\n');

        res.status(opened.status);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Cache-Control', 'no-cache');
        res.send(rewritten);
        return;
      }

      res.status(opened.status);
      if (ctype) res.setHeader('Content-Type', ctype);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.send(body);
      return;
    }

    res.status(opened.status);
    if (ctype) res.setHeader('Content-Type', ctype);
    if (opened.headers['content-length']) res.setHeader('Content-Length', opened.headers['content-length']);
    if (opened.headers['content-range']) res.setHeader('Content-Range', opened.headers['content-range']);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', isOk ? 'public, max-age=30' : 'no-store');

    const highWaterBytes = Math.max(16384, Math.min(1024 * 1024, (streamCfg.proxyBufferKb || 128) * 1024));
    const bufferStream = new PassThrough({ highWaterMark: highWaterBytes });
    opened.incoming.on('error', () => {
      opened.destroyUpstream();
      bufferStream.destroy();
      if (!res.headersSent) res.status(502);
      res.end();
    });
    bufferStream.on('error', () => {
      opened.destroyUpstream();
      if (!res.writableEnded) res.end();
    });
    res.on('close', () => {
      if (!res.writableFinished) bufferStream.destroy();
    });
    opened.incoming.pipe(bufferStream).pipe(res);
  } catch (err) {
    if (clientClosed) return;
    const net = classifyNetworkError(err);
    const httpStatus = net.diagCode === 'timeout' ? 504 : net.diagCode === 'tls' ? 525 : 502;
    if (!res.headersSent) {
      res.status(httpStatus).send(net.reason);
    } else {
      res.end();
    }
  }
});

// ============ ADMIN API MIDDLEWARE ============
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const admin = getAdminAuthFromRequest(req);
  if (!admin) {
    noCacheJson(res, { error: 'Unauthorized' }, 401);
    return;
  }
  if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
    const csrfOk =
      (Boolean(admin.csrf) && verifyAdminCsrf(req, admin.csrf)) ||
      (Boolean(req.session.authenticated && req.session.csrfToken) &&
        verifyAdminCsrf(req, req.session.csrfToken));
    if (!csrfOk) {
      noCacheJson(res, { error: 'CSRF validation failed' }, 403);
      return;
    }
  }
  next();
});

// ============ STREAMING SETTINGS, STATE REVISION & FULL CLOUD EXPORT / HYDRATION ============
app.get('/api/state/revision', (_req, res) => {
  noCacheJson(res, { ok: true, ...stateLifecycle.getStateMeta() });
});

app.get('/api/lifecycle/logs', (req, res) => {
  const limit = Number(req.query.limit) || 100;
  noCacheJson(res, {
    ok: true,
    revision: stateLifecycle.getStateMeta().revision,
    logs: stateLifecycle.getLogs(limit),
  });
});

app.get('/api/settings/streaming', (_req, res) => {
  noCacheJson(res, { ok: true, settings: getStreamingSettings() });
});

app.post('/api/settings/streaming', (req, res) => {
  const saved = trySaveStreamingSettings(req.body || {});
  if (!saved.ok) {
    noCacheJson(res, { ok: false, error: saved.error || 'Ошибка сохранения настроек' }, 500);
    return;
  }
  const meta = stateLifecycle.bumpRevision('health_update', 'streaming_settings');
  noCacheJson(res, { ok: true, settings: saved.settings, revision: meta.revision });
});

app.get('/api/settings/ui', (_req, res) => {
  noCacheJson(res, { ok: true, settings: getUiSettings() });
});

app.post('/api/settings/ui', (req, res) => {
  const saved = trySaveUiSettings(req.body || {});
  if (!saved.ok) {
    noCacheJson(res, { ok: false, error: saved.error || 'Ошибка сохранения настроек интерфейса' }, 500);
    return;
  }
  const meta = stateLifecycle.bumpRevision('health_update', 'ui_settings');
  noCacheJson(res, { ok: true, settings: saved.settings, revision: meta.revision });
});

function findMatchingPlaylistsForChannel(name: string, url: string): {
  playlists: string[];
  allPlaylists: string[];
} {
  const allPlaylists = storage.getPlaylists();
  const normName = name.trim().toLowerCase();
  const normUrl = url.trim();
  const matched: string[] = [];

  for (const pl of allPlaylists) {
    const filePath = storage.getPlaylistPath(pl);
    if (!fs.existsSync(filePath)) continue;
    const list = parseM3uFile(filePath);
    const hit = list.some(
      (ch) =>
        (normName && ch.name.trim().toLowerCase() === normName) ||
        (normUrl && ch.url.trim() === normUrl)
    );
    if (hit) matched.push(pl);
  }
  return { playlists: matched, allPlaylists };
}

app.get('/api/channel/playlists', (req, res) => {
  const name = String(req.query.name || '').trim();
  const url = String(req.query.url || '').trim();
  const out = findMatchingPlaylistsForChannel(name, url);
  noCacheJson(res, { ok: true, playlists: out.playlists, allPlaylists: out.allPlaylists });
});

app.post('/api/channel/add-to-playlist', async (req, res) => {
  const playlist = String(req.body?.playlist || '')
    .replace(/\.m3u$/i, '')
    .trim();
  const name = String(req.body?.name || '').trim();
  const url = String(req.body?.url || '').trim();
  const group = String(req.body?.group || '').trim() || 'Общие';
  const logo = String(req.body?.logo || '').trim();
  const tvgId = String(req.body?.tvg_id || '').trim();
  const userAgent = String(req.body?.userAgent || '').trim();
  const referer = String(req.body?.referer || '').trim();
  const origin = String(req.body?.origin || '').trim();

  if (!playlist || !name || !url) {
    noCacheJson(res, { ok: false, error: 'Не указаны плейлист, название или URL канала' }, 400);
    return;
  }
  if (!storage.isValidFilename(playlist)) {
    noCacheJson(res, { ok: false, error: 'Неверное имя плейлиста' }, 400);
    return;
  }
  const filePath = storage.getPlaylistPath(playlist);
  if (!fs.existsSync(filePath)) {
    noCacheJson(res, { ok: false, error: 'Плейлист не найден' }, 404);
    return;
  }

  const list = parseM3uFile(filePath);
  const normName = name.toLowerCase();
  const duplicate = list.some(
    (item) => item.name.trim().toLowerCase() === normName || item.url.trim() === url
  );
  if (duplicate) {
    noCacheJson(res, { ok: false, error: 'Такой канал уже есть в этом плейлисте' }, 400);
    return;
  }

  const newChannel: Channel = {
    name,
    group,
    logo,
    url,
    tvg_id: tvgId,
  };
  if (userAgent) newChannel.userAgent = userAgent;
  if (referer) newChannel.referer = referer;
  if (origin) newChannel.origin = origin;

  list.push(newChannel);
  const saved = await savePlaylistChannelsUnified(playlist, list);
  if (!saved.ok) {
    noCacheJson(res, saved, saved.status);
    return;
  }

  const updated = findMatchingPlaylistsForChannel(name, url);
  noCacheJson(res, {
    ok: true,
    playlist,
    name,
    playlists: updated.playlists,
    allPlaylists: updated.allPlaylists,
    count: list.length,
    revision: saved.revision,
  });
});

app.get('/api/cloud/export', (_req, res) => {
  const playlistNames = storage.getPlaylists();
  const playlists: Record<string, Channel[]> = {};
  for (const name of playlistNames) {
    playlists[name] = parseM3uFile(storage.getPlaylistPath(name));
  }
  const ghCfg = getPublicGithubConfig();
  noCacheJson(res, {
    ok: true,
    revision: stateLifecycle.getStateMeta().revision,
    playlists,
    sources: StreamParser.getSources(),
    sourceIndex: StreamParser.exportIndexData(),
    epgSources: EpgParser.getSources(),
    catalog: catalogStore.exportRawState(),
    streamingSettings: getStreamingSettings(),
    uiSettings: getUiSettings(),
    apkState: apkManager.exportState(),
    users: userAuth.all().map((u) => ({
      id: u.id,
      login: u.login,
      name: u.name,
      playlists: u.playlists || [],
      enabled: Boolean(u.enabled),
      password_hash: u.password_hash || '',
      created_at: u.created_at || 0,
    })),
    invites: userAuth.allInvites(),
    alerts: userAuth.allAlerts(),
    channelHealth: channelHealth.exportState(),
    adminSettings: {
      githubRepo: ghCfg.repoFullName || '',
      githubBranch: ghCfg.branch || 'main',
      adminPasswordHash: getAdminPasswordHashOverride(),
    },
  });
});

app.post('/api/cloud/hydrate', async (req, res) => {
  const rawBody = (req.body || {}) as Record<string, unknown>;
  const out = await hydrateStateUnified(rawBody as Parameters<typeof hydrateStateUnified>[0]);
  if (!out.ok) {
    noCacheJson(res, out, out.status);
    return;
  }

  if (Array.isArray(rawBody.invites)) {
    const validPlaylists = new Set(storage.getPlaylists());
    for (const rawInv of rawBody.invites as Array<Record<string, unknown>>) {
      if (!rawInv || !rawInv.email) continue;
      const pls = Array.isArray(rawInv.playlists)
        ? rawInv.playlists
            .filter((p): p is string => typeof p === 'string')
            .map((p) => p.replace(/\.m3u$/i, '').trim())
            .filter((p) => validPlaylists.has(p))
        : [];
      const saved = userAuth.saveInvite({
        email: String(rawInv.email).trim().toLowerCase(),
        name: String(rawInv.name || '').trim(),
        playlists: pls,
        enabled: rawInv.enabled !== undefined ? Boolean(rawInv.enabled) : true,
        claimed_uid: typeof rawInv.claimed_uid === 'string' ? rawInv.claimed_uid : '',
      });
      if (!saved.ok && userAuth.getLastError()) {
        noCacheJson(res, { ok: false, error: userAuth.getLastError() }, 500);
        return;
      }
    }
  }

  const adminSettings = rawBody.adminSettings as { adminPasswordHash?: unknown } | undefined;
  if (adminSettings?.adminPasswordHash && typeof adminSettings.adminPasswordHash === 'string') {
    if (!saveAdminPasswordHashOverride(adminSettings.adminPasswordHash)) {
      noCacheJson(res, { ok: false, error: 'Не удалось сохранить пароль администратора на диск' }, 500);
      return;
    }
  }

  noCacheJson(res, out, 200);
});

// ============ ADMIN APK & SOURCE REBUILD ROUTES ============
app.get('/api/source/rebuild', async (_req, res) => {
  const indexRes = await StreamParser.refreshAll();
  const catRes = await reconcileCatalogUnified();
  EpgParser.clearCache();
  if (!catRes.ok) {
    noCacheJson(res, { ok: false, error: catRes.error || 'Ошибка пересборки каталога' }, catRes.status);
    return;
  }
  noCacheJson(res, { ok: true, index: indexRes, catalog: catRes, revision: catRes.revision });
});

app.get('/api/admin/apk/releases', (req, res) => {
  const releases = apkManager.getReleaseWithLocalStatus();
  const latest = apkManager.getLatest();
  const policy = apkManager.getPolicy();
  const suggestions = apkManager.getAllVersionSuggestions();
  const origin = getRequestOrigin(req);
  noCacheJson(res, {
    ok: true,
    releases,
    latest,
    policy,
    suggestions,
    serverOrigin: origin,
    uploadToken: config.apkUploadToken,
    suggestedVersionCode: suggestions.patch.versionCode,
    suggestedVersionName: suggestions.patch.versionName,
  });
});

app.post('/api/admin/apk/delete', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id || !apkManager.deleteRelease(id)) {
    noCacheJson(res, { error: 'Релиз не найден' }, 404);
    return;
  }
  const meta = stateLifecycle.bumpRevision('apk_update', 'apk_delete', { id });
  noCacheJson(res, {
    ok: true,
    policy: apkManager.getPolicy(),
    suggestions: apkManager.getAllVersionSuggestions(),
    revision: meta.revision,
  });
});

app.post('/api/admin/apk/policy', (req, res) => {
  const out = apkManager.updatePolicy({
    minSupportedVersionCode:
      req.body?.minSupportedVersionCode !== undefined
        ? Number(req.body.minSupportedVersionCode)
        : undefined,
    blockedVersionCodes: Array.isArray(req.body?.blockedVersionCodes)
      ? req.body.blockedVersionCodes
      : undefined,
    blockMode:
      req.body?.blockMode === 'hard' || req.body?.blockMode === 'soft'
        ? req.body.blockMode
        : undefined,
    blockMessage:
      typeof req.body?.blockMessage === 'string' ? req.body.blockMessage : undefined,
    blockOlderThanLatest: Boolean(req.body?.blockOlderThanLatest),
  });
  if (!out.ok) {
    noCacheJson(res, { ok: false, error: out.error || 'Ошибка обновления политики версий' }, 400);
    return;
  }
  const meta = stateLifecycle.bumpRevision('apk_update', 'apk_policy', {
    minSupportedVersionCode: out.policy.minSupportedVersionCode,
    blockMode: out.policy.blockMode,
  });
  noCacheJson(res, {
    ok: true,
    policy: out.policy,
    releases: apkManager.getReleaseWithLocalStatus(),
    suggestions: apkManager.getAllVersionSuggestions(),
    revision: meta.revision,
  });
});

app.post('/api/admin/apk/toggle-block', (req, res) => {
  const id = String(req.body?.id || '').trim();
  const blocked = Boolean(req.body?.blocked);
  const reason = typeof req.body?.reason === 'string' ? req.body.reason : undefined;
  const out = apkManager.setReleaseBlocked(id, blocked, reason);
  if (!out.ok) {
    noCacheJson(
      res,
      { ok: false, error: out.error || 'Не удалось изменить статус блокировки релиза' },
      out.error === 'Релиз не найден' ? 404 : 400
    );
    return;
  }
  const meta = stateLifecycle.bumpRevision('apk_update', 'apk_toggle_block', {
    id,
    blocked,
    versionCode: out.release?.versionCode,
  });
  noCacheJson(res, {
    ok: true,
    release: out.release,
    policy: out.policy,
    releases: apkManager.getReleaseWithLocalStatus(),
    revision: meta.revision,
  });
});

app.post('/api/admin/apk/restore', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const rel = apkManager.getReleases().find((r) => r.id === id);
  if (!rel) {
    noCacheJson(res, { ok: false, error: 'Релиз не найден' }, 404);
    return;
  }
  const restored = await restoreApkReleaseFromGithub(rel);
  if (!restored) {
    noCacheJson(
      res,
      { ok: false, error: 'Не удалось скачать APK-файл из GitHub Actions или GitHub Release (артефакт мог истечь).' },
      502
    );
    return;
  }
  noCacheJson(res, {
    ok: true,
    release: restored,
    releases: apkManager.getReleaseWithLocalStatus(),
  });
});

app.get('/api/admin/apk/project.zip', (req, res) => {
  const sug = apkManager.getNextVersionSuggestion('patch');
  const nextCode = Number(req.query.versionCode) || sug.versionCode;
  const nextName = String(req.query.versionName || '').trim() || sug.versionName;
  const origin = getRequestOrigin(req);
  const zipBuf = buildAndroidTvProjectZip(origin, nextCode, nextName);

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="pqtv-android-tv-v${nextName}.zip"`
  );
  res.setHeader('Content-Length', String(zipBuf.length));
  res.send(zipBuf);
});

// ============ ADMIN GITHUB ACTIONS APK ROUTES ============
app.get('/api/admin/github/config', (req, res) => {
  const cfg = getPublicGithubConfig();
  noCacheJson(res, {
    ok: true,
    config: cfg,
    workflowManual: cfg.configured ? getWorkflowManualSetupInfo() : null,
    serverOrigin: getRequestOrigin(req),
  });
});

app.post('/api/admin/github/config', async (req, res) => {
  try {
    const repo = String(req.body?.repo || '').trim();
    const branch = String(req.body?.branch || '').trim();
    const token = String(req.body?.token || '').trim();
    const saved = await saveAndVerifyGithubConfig({ repo, branch, token });
    noCacheJson(res, { ok: true, config: saved });
  } catch (err) {
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.delete('/api/admin/github/config', (_req, res) => {
  clearGithubConfig();
  noCacheJson(res, { ok: true, config: getPublicGithubConfig() });
});

app.post('/api/admin/github/sync', async (_req, res) => {
  try {
    const result = await syncAndroidProjectToGithub();
    noCacheJson(res, { ok: true, ...result });
  } catch (err) {
    if (err instanceof GithubWorkflowScopeError) {
      noCacheJson(
        res,
        {
          error: err.message,
          needsManualWorkflow: true,
          manualCreateUrl: err.manualCreateUrl,
          workflowYaml: err.workflowYaml,
        },
        400
      );
      return;
    }
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post('/api/admin/github/build', async (req, res) => {
  try {
    const bumpRaw = String(req.body?.bumpType || 'patch').trim();
    const bumpType: VersionBumpType =
      bumpRaw === 'major' || bumpRaw === 'minor' ? bumpRaw : 'patch';
    const manualOverride = Boolean(req.body?.manualOverride);
    const autoBlockOlder = Boolean(req.body?.autoBlockOlder);
    const versionCode = req.body?.versionCode ? Number(req.body.versionCode) : undefined;
    const versionName = req.body?.versionName ? String(req.body.versionName).trim() : undefined;
    const serverUrl = String(req.body?.serverUrl || '').trim() || getRequestOrigin(req);
    const changelog = String(req.body?.changelog || '').trim();
    const mandatory = Boolean(req.body?.mandatory);
    const syncProject = req.body?.syncProject !== false;

    const build = await triggerGithubApkBuild({
      versionName,
      versionCode,
      bumpType,
      manualOverride,
      serverUrl,
      changelog,
      mandatory,
      autoBlockOlder,
      syncProject,
    });
    noCacheJson(res, {
      ok: true,
      build,
      policy: apkManager.getPolicy(),
      suggestions: apkManager.getAllVersionSuggestions(),
    });
  } catch (err) {
    if (err instanceof GithubWorkflowScopeError) {
      noCacheJson(
        res,
        {
          error: err.message,
          needsManualWorkflow: true,
          manualCreateUrl: err.manualCreateUrl,
          workflowYaml: err.workflowYaml,
        },
        400
      );
      return;
    }
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.get('/api/admin/github/status', async (_req, res) => {
  try {
    const build = await refreshGithubBuildStatus();
    noCacheJson(res, {
      ok: true,
      build,
      policy: apkManager.getPolicy(),
      suggestions: apkManager.getAllVersionSuggestions(),
    });
  } catch (err) {
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 500);
  }
});

app.get('/api/admin/github/runs', async (_req, res) => {
  try {
    const runs = await listGithubWorkflowRuns();
    noCacheJson(res, { ok: true, runs });
  } catch (err) {
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post('/api/admin/github/import', async (req, res) => {
  try {
    const runId = Number(req.body?.runId);
    if (!Number.isFinite(runId) || runId <= 0) {
      noCacheJson(res, { error: 'Укажите корректный ID запуска GitHub Actions' }, 400);
      return;
    }
    const bumpRaw = String(req.body?.bumpType || 'patch').trim();
    const bumpType: VersionBumpType =
      bumpRaw === 'major' || bumpRaw === 'minor' ? bumpRaw : 'patch';
    const manualOverride = Boolean(req.body?.manualOverride);
    const resolved = apkManager.resolveAutoVersion({
      versionCode: req.body?.versionCode ? Number(req.body.versionCode) : undefined,
      versionName: req.body?.versionName ? String(req.body.versionName).trim() : undefined,
      bumpType,
      manualOverride,
    });
    const changelog = String(req.body?.changelog || '').trim() || 'Импортировано из GitHub Actions';
    const mandatory = Boolean(req.body?.mandatory);
    const autoBlockOlder = Boolean(req.body?.autoBlockOlder);

    const release = await importApkFromGithubRun({
      runId,
      versionName: resolved.versionName,
      versionCode: resolved.versionCode,
      changelog,
      mandatory,
      autoBlockOlder,
      manualOverride,
    });
    noCacheJson(res, {
      ok: true,
      release,
      policy: apkManager.getPolicy(),
      suggestions: apkManager.getAllVersionSuggestions(),
      revision: stateLifecycle.getStateMeta().revision,
    });
  } catch (err) {
    noCacheJson(res, { error: err instanceof Error ? err.message : String(err) }, 400);
  }
});

app.post('/api/auth/set-password', (req, res) => {
  const password = String(req.body?.password || '');
  if (password.length < 6) {
    noCacheJson(res, { error: 'Пароль должен быть не менее 6 символов' }, 400);
    return;
  }
  const hash = hashPassword(password);
  if (!saveAdminPasswordHashOverride(hash)) {
    noCacheJson(res, { error: 'Ошибка сохранения пароля' }, 500);
    return;
  }
  noCacheJson(res, { ok: true });
});

// Playlists, backups & channels
app.get('/api/playlists', (_req, res) => {
  noCacheJson(res, {
    playlists: storage.getPlaylists(),
    revision: stateLifecycle.getStateMeta().revision,
  });
});

app.post('/api/playlists', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const out = await createPlaylistUnified(name);
  noCacheJson(res, out, out.status);
});

app.post('/api/playlists/delete', async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const out = await deletePlaylistUnified(name);
  noCacheJson(res, out, out.status);
});

app.get('/api/playlists/backups', (req, res) => {
  const playlist = typeof req.query.playlist === 'string' ? req.query.playlist : undefined;
  noCacheJson(res, { ok: true, backups: storage.listBackups(playlist) });
});

app.post('/api/playlists/backups/restore', async (req, res) => {
  const filename = String(req.body?.filename || '').trim();
  const targetPlaylist =
    typeof req.body?.targetPlaylist === 'string' ? req.body.targetPlaylist : undefined;
  const out = await restoreBackupUnified(filename, targetPlaylist);
  noCacheJson(res, out, out.status);
});

app.post('/api/playlists/backups/delete', async (req, res) => {
  const filename = String(req.body?.filename || '').trim();
  const out = await deleteBackupUnified(filename);
  noCacheJson(res, out, out.status);
});

app.get('/api/channels', (req, res) => {
  const playlist = String(req.query.playlist || '');
  if (!storage.isValidFilename(playlist)) {
    noCacheJson(res, { error: 'Invalid name' }, 400);
    return;
  }
  const filePath = storage.getPlaylistPath(playlist);
  noCacheJson(res, { channels: parseM3uFile(filePath) });
});

app.post('/api/channels/save', async (req, res) => {
  const playlist = String(req.body?.playlist || '').trim();
  const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];
  const out = await savePlaylistChannelsUnified(playlist, channels);
  noCacheJson(res, out, out.status);
});

// Stream check & parse
app.post('/api/stream/check', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const hints = findPlaylistChannelHints(url);
  const userAgent = typeof req.body?.userAgent === 'string' ? req.body.userAgent : hints.userAgent;
  const referer = typeof req.body?.referer === 'string' ? req.body.referer : hints.referer;
  const origin = typeof req.body?.origin === 'string' ? req.body.origin : hints.origin;
  const ignoreTlsErrors = req.body?.ignoreTlsErrors !== undefined ? Boolean(req.body.ignoreTlsErrors) : undefined;
  const result = await catalogStore.checkStream(url, Boolean(req.body?.force), true, {
    userAgent,
    referer,
    origin,
    ignoreTlsErrors,
  });
  channelHealth.recordCheckResult(url, result);
  noCacheJson(res, result);
});

// Unified Channel Health, Viewer Exclusion & Global Remediation API
app.get('/api/health/overview', (_req, res) => {
  noCacheJson(res, channelHealth.getHealthOverview());
});

app.post('/api/health/check', async (req, res) => {
  const channelName = String(req.body?.channelName || '').trim();
  const url = String(req.body?.url || '').trim();
  const force = req.body?.force !== false;
  if (channelName) {
    const out = await channelHealth.checkChannel(channelName, force);
    noCacheJson(res, out, out.ok ? 200 : 404);
    return;
  }
  if (url) {
    const hints = findPlaylistChannelHints(url);
    const srcOpts = StreamParser.getSourceRequestOptions(url);
    const r = await checkStreamDeep(url, {
      ...srcOpts,
      userAgent: hints.userAgent || srcOpts.userAgent,
      referer: hints.referer || srcOpts.referer,
      origin: hints.origin || srcOpts.origin,
      force,
    });
    channelHealth.recordCheckResult(url, r);
    noCacheJson(res, { ok: true, result: r });
    return;
  }
  noCacheJson(res, { error: 'Укажите channelName или url' }, 400);
});

app.post('/api/health/check-all', async (req, res) => {
  const playlist = typeof req.body?.playlist === 'string' ? req.body.playlist : undefined;
  const force = req.body?.force !== false;
  const limit = Number(req.body?.limit) || 800;
  const out = await channelHealth.checkAllPlaylistChannels({ playlist, force, limit });
  noCacheJson(res, out);
});

app.get('/api/health/candidates', async (req, res) => {
  const name = String(req.query.name || '').trim();
  if (!name) {
    noCacheJson(res, { error: 'Укажите название канала' }, 400);
    return;
  }
  const out = await channelHealth.findAndProbeCandidates(name);
  noCacheJson(res, out);
});

app.post('/api/health/replace-url', async (req, res) => {
  const channelName = String(req.body?.channelName || '').trim();
  const newUrl = String(req.body?.newUrl || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : undefined;
  const userAgent = typeof req.body?.userAgent === 'string' ? req.body.userAgent : undefined;
  const referer = typeof req.body?.referer === 'string' ? req.body.referer : undefined;
  const origin = typeof req.body?.origin === 'string' ? req.body.origin : undefined;
  const unpause = req.body?.unpause !== undefined ? Boolean(req.body.unpause) : true;
  const out = await channelHealth.replaceChannelUrl({
    channelName,
    newUrl,
    playlists,
    userAgent,
    referer,
    origin,
    unpause,
  });
  if (out.ok) {
    const meta = stateLifecycle.bumpRevision('health_update', channelName, {
      action: 'replace_url',
      updatedPlaylists: out.updatedPlaylists,
    });
    noCacheJson(res, { ...out, revision: meta.revision }, 200);
    return;
  }
  const status = (out.error || '').includes('не найден')
    ? 404
    : (out.error || '').includes('Не удалось')
      ? 500
      : 400;
  noCacheJson(res, out, status);
});

app.post('/api/health/auto-repair', async (req, res) => {
  const channelNames = Array.isArray(req.body?.channelNames) ? req.body.channelNames : undefined;
  const onlyDead = req.body?.onlyDead !== undefined ? Boolean(req.body.onlyDead) : true;
  const out = await channelHealth.autoRepairChannels({ channelNames, onlyDead });
  noCacheJson(res, out);
});

app.post('/api/health/pause', (req, res) => {
  const channelName = String(req.body?.channelName || '').trim();
  const paused = Boolean(req.body?.paused);
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : undefined;
  const out = channelHealth.setChannelPaused({ channelName, paused, playlists });
  if (out.ok) {
    const meta = stateLifecycle.bumpRevision('health_update', channelName, { action: 'pause', paused });
    noCacheJson(res, { ...out, revision: meta.revision }, 200);
    return;
  }
  const status = (out.error || '').includes('не найден')
    ? 404
    : (out.error || '').includes('Не удалось')
      ? 500
      : 400;
  noCacheJson(res, out, status);
});

app.post('/api/health/delete-channel', (req, res) => {
  const channelName = String(req.body?.channelName || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : undefined;
  const out = channelHealth.deleteChannelFromPlaylists({ channelName, playlists });
  if (out.ok) {
    const meta = stateLifecycle.bumpRevision('channel_delete', channelName, {
      updatedPlaylists: out.updatedPlaylists,
    });
    noCacheJson(res, { ...out, revision: meta.revision }, 200);
    return;
  }
  const status = (out.error || '').includes('не найден')
    ? 404
    : (out.error || '').includes('Не удалось')
      ? 500
      : 400;
  noCacheJson(res, out, status);
});

app.post('/api/health/resolve', async (req, res) => {
  const channelName = typeof req.body?.channelName === 'string' ? req.body.channelName : undefined;
  const alertId = typeof req.body?.alertId === 'string' ? req.body.alertId : undefined;
  const out = await channelHealth.resolveWithVerification({ channelName, alertId });
  noCacheJson(res, out, out.ok ? 200 : 400);
});

app.post('/api/stream/parse', (req, res) => {
  const query = String(req.body?.query || '').trim();
  if (!query) {
    noCacheJson(res, { error: 'Пустой запрос' }, 400);
    return;
  }
  const results = StreamParser.search(query);
  noCacheJson(res, { results });
});

// Sources & Index
app.get('/api/sources', (_req, res) => {
  noCacheJson(res, {
    sources: StreamParser.getSources(),
    revision: stateLifecycle.getStateMeta().revision,
  });
});

app.post('/api/sources/save', async (req, res) => {
  if (!Array.isArray(req.body?.sources)) {
    noCacheJson(res, { ok: false, error: 'Ожидается массив sources' }, 400);
    return;
  }
  const out = await saveAuthoritativeSourcesUnified(req.body.sources as SourceItem[]);
  noCacheJson(res, out, out.status);
});

app.post('/api/sources/delete', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const out = await deleteSourceUnified(id);
  noCacheJson(res, out, out.status);
});

app.get('/api/stream/index/status', (_req, res) => {
  noCacheJson(res, { status: StreamParser.getIndexStatus() });
});

app.post('/api/stream/index/refresh', async (req, res) => {
  const mode = String(req.body?.mode || 'all');
  const result =
    mode === 'stale' ? await StreamParser.refreshStale() : await StreamParser.refreshAll();
  noCacheJson(res, result);
});

app.post('/api/stream/index/clear', (req, res) => {
  const id = req.body?.id ? String(req.body.id) : null;
  StreamParser.clearIndex(id);
  noCacheJson(res, { ok: true });
});

// EPG
app.get('/api/epg', (_req, res) => {
  noCacheJson(res, { epg: EpgParser.getSources() });
});

app.post('/api/epg/save', (req, res) => {
  const epg: EpgSource[] = Array.isArray(req.body?.epg) ? req.body.epg : [];
  if (!Array.isArray(req.body?.epg)) {
    noCacheJson(res, { error: 'Bad payload' }, 400);
    return;
  }
  if (EpgParser.saveSources(epg)) {
    const meta = stateLifecycle.bumpRevision('health_update', 'epg_sources');
    noCacheJson(res, { ok: true, revision: meta.revision });
    return;
  }
  noCacheJson(res, { ok: false, error: EpgParser.getLastError() || 'Ошибка сохранения' }, 500);
});

app.get('/api/epg/now', async (req, res) => {
  const tvgId = String(req.query.tvg_id || '').trim();
  const name = String(req.query.name || '').trim();
  if (!name && !tvgId) {
    noCacheJson(res, { error: 'Empty query' }, 400);
    return;
  }
  const programmes = await EpgParser.findForChannel(tvgId, name);
  const nn = EpgParser.findNowNext(programmes);
  noCacheJson(res, {
    current: nn.current,
    next: nn.next,
    total: programmes.length,
  });
});

app.post('/api/epg/cache/clear', (_req, res) => {
  EpgParser.clearCache();
  noCacheJson(res, { ok: true });
});

// Users CRUD
app.get('/api/users', (_req, res) => {
  const users = userAuth.all();
  const sessions = userAuth.getSessions();
  const now = Math.floor(Date.now() / 1000);
  const out = users.map((u) => {
    const s = sessions[u.id];
    const online = Boolean(s && now - (s.last_ping || 0) < 90);
    return {
      id: u.id,
      login: u.login,
      name: u.name || '',
      playlists: u.playlists || [],
      enabled: Boolean(u.enabled),
      created_at: u.created_at || 0,
      online,
      last_ping: s?.last_ping || 0,
      last_ip: s?.ip || '',
      last_ua: s?.ua || '',
    };
  });
  noCacheJson(res, { users: out });
});

app.post('/api/users/save', (req, res) => {
  const id = String(req.body?.id || '').trim();
  const login = String(req.body?.login || '').trim();
  const password = String(req.body?.password || '');
  const name = String(req.body?.name || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : [];
  const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;

  if (!id) {
    const created = userAuth.create(login, password, name, playlists, enabled);
    if (!created.ok) {
      const code = userAuth.getLastError() ? 500 : 400;
      noCacheJson(res, { error: created.error || 'Ошибка' }, code);
      return;
    }
    const createdFull = created.user ? userAuth.find(created.user.id) : null;
    const meta = stateLifecycle.bumpRevision('users_update', created.user!.id, { action: 'create' });
    noCacheJson(res, {
      ok: true,
      user: created.user,
      revision: meta.revision,
      cloudCred: createdFull && createdFull.password_hash
        ? { id: createdFull.id, password_hash: createdFull.password_hash }
        : null,
    });
    return;
  }

  const existing = userAuth.find(id);
  if (!existing) {
    const synced = userAuth.upsertSyncedUser({
      id,
      login: login || id,
      name: name || login || id,
      playlists,
      enabled,
    });
    if (userAuth.getLastError()) {
      noCacheJson(res, { error: userAuth.getLastError() }, 500);
      return;
    }
    if (password) {
      const pwdRes = userAuth.update(synced.id, { password });
      if (!pwdRes.ok) {
        const code = userAuth.getLastError() ? 500 : 400;
        noCacheJson(res, { error: pwdRes.error || 'Ошибка' }, code);
        return;
      }
    }
    const syncedFull = userAuth.find(synced.id);
    const meta = stateLifecycle.bumpRevision('users_update', synced.id, { action: 'upsert' });
    noCacheJson(res, {
      ok: true,
      user: synced,
      revision: meta.revision,
      cloudCred: syncedFull && syncedFull.password_hash
        ? { id: syncedFull.id, password_hash: syncedFull.password_hash }
        : null,
    });
    return;
  }

  const updated = userAuth.update(id, { name, playlists, enabled, password });
  if (!updated.ok) {
    const code = userAuth.getLastError() ? 500 : 400;
    noCacheJson(res, { error: updated.error || 'Ошибка' }, code);
    return;
  }
  const updatedFull = userAuth.find(id);
  const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'update' });
  noCacheJson(res, {
    ok: true,
    revision: meta.revision,
    cloudCred: updatedFull && updatedFull.password_hash
      ? { id: updatedFull.id, password_hash: updatedFull.password_hash }
      : null,
  });
});

app.post('/api/users/sync-from-firebase', (req, res) => {
  const list = Array.isArray(req.body?.users) ? req.body.users : [];
  let count = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const id = String((item as Record<string, unknown>).id || '').trim();
    const login = String((item as Record<string, unknown>).login || '').trim();
    if (!id || !login) continue;
    const name = String((item as Record<string, unknown>).name || login).trim();
    const playlists = Array.isArray((item as Record<string, unknown>).playlists)
      ? ((item as Record<string, unknown>).playlists as unknown[]).filter(
          (p): p is string => typeof p === 'string'
        )
      : [];
    const enabled = Boolean((item as Record<string, unknown>).enabled);
    userAuth.upsertSyncedUser({ id, login, name, playlists, enabled });
    const uErr = userAuth.getLastError();
    if (uErr) {
      noCacheJson(res, { ok: false, error: uErr }, 500);
      return;
    }
    count++;
  }
  noCacheJson(res, { ok: true, count });
});

app.post('/api/users/delete', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id) {
    noCacheJson(res, { error: 'Пустой ID' }, 400);
    return;
  }
  if (!userAuth.find(id)) {
    noCacheJson(res, { error: 'Пользователь не найден' }, 404);
    return;
  }
  if (userAuth.delete(id)) {
    const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'delete' });
    noCacheJson(res, { ok: true, revision: meta.revision });
    return;
  }
  noCacheJson(res, { error: userAuth.getLastError() || 'Ошибка сохранения при удалении' }, 500);
});

app.get('/api/users/online', (_req, res) => {
  const users = userAuth.all();
  const sessions = userAuth.getSessions();
  const now = Math.floor(Date.now() / 1000);
  const online = users
    .filter((u) => {
      const s = sessions[u.id];
      return s && now - (s.last_ping || 0) < 90;
    })
    .map((u) => ({
      id: u.id,
      login: u.login,
      name: u.name || '',
      last_ping: sessions[u.id].last_ping,
      ip: sessions[u.id].ip || '',
    }));
  noCacheJson(res, { online, count: online.length });
});

// Invites & Channel Alerts Admin API (for /editor)
app.get('/api/invites', (_req, res) => {
  noCacheJson(res, { invites: userAuth.allInvites() });
});

app.post('/api/invites/save', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  const playlists = Array.isArray(req.body?.playlists) ? req.body.playlists : [];
  const enabled = req.body?.enabled !== undefined ? Boolean(req.body.enabled) : true;
  const saved = userAuth.saveInvite({ email, name, playlists, enabled });
  if (!saved.ok) {
    const code = userAuth.getLastError() ? 500 : 400;
    noCacheJson(res, { error: saved.error || 'Ошибка сохранения приглашения' }, code);
    return;
  }
  const meta = stateLifecycle.bumpRevision('users_update', saved.invite!.id, { action: 'invite_save' });
  noCacheJson(res, { ok: true, invite: saved.invite, revision: meta.revision });
});

app.post('/api/invites/delete', (req, res) => {
  const id = String(req.body?.id || req.body?.email || '').trim();
  if (!id || !userAuth.deleteInvite(id)) {
    const code = userAuth.getLastError() ? 500 : 404;
    noCacheJson(res, { error: userAuth.getLastError() || 'Приглашение не найдено' }, code);
    return;
  }
  const meta = stateLifecycle.bumpRevision('users_update', id, { action: 'invite_delete' });
  noCacheJson(res, { ok: true, revision: meta.revision });
});

app.post('/api/invites/sync-from-firebase', (req, res) => {
  const list = Array.isArray(req.body?.invites) ? req.body.invites : [];
  let count = 0;
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const raw = item as Record<string, unknown>;
    const email = String(raw.email || '').trim().toLowerCase();
    if (!email) continue;
    const playlists = Array.isArray(raw.playlists)
      ? raw.playlists.filter((p): p is string => typeof p === 'string')
      : [];
    const saved = userAuth.saveInvite({
      email,
      name: String(raw.name || email.split('@')[0] || 'Пользователь').trim(),
      playlists,
      enabled: raw.enabled !== undefined ? Boolean(raw.enabled) : true,
      claimed_uid: typeof raw.claimedUid === 'string' ? raw.claimedUid : '',
    });
    if (!saved.ok && userAuth.getLastError()) {
      noCacheJson(res, { ok: false, error: userAuth.getLastError() }, 500);
      return;
    }
    if (saved.ok) count++;
  }
  noCacheJson(res, { ok: true, count });
});

app.get('/api/alerts', (_req, res) => {
  const alerts = userAuth.allAlerts();
  noCacheJson(res, {
    alerts,
    activeCount: alerts.filter((a) => !a.resolved && a.unavailableCount > 0).length,
  });
});

app.post('/api/alerts/resolve', async (req, res) => {
  const id = String(req.body?.id || '').trim();
  const resolved = req.body?.resolved !== undefined ? Boolean(req.body.resolved) : true;
  if (!id) {
    noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
    return;
  }
  if (!resolved) {
    if (!userAuth.resolveAlert(id, false)) {
      noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
      return;
    }
    noCacheJson(res, { ok: true, resolved: false, stillBroken: false });
    return;
  }
  const verifyRes = await channelHealth.resolveWithVerification({ alertId: id });
  if (!verifyRes.ok) {
    noCacheJson(res, { error: verifyRes.error || 'Предупреждение не найдено' }, 404);
    return;
  }
  noCacheJson(res, verifyRes);
});

app.post('/api/alerts/delete', (req, res) => {
  const id = String(req.body?.id || '').trim();
  if (!id || !userAuth.deleteAlert(id)) {
    noCacheJson(res, { error: 'Предупреждение не найдено' }, 404);
    return;
  }
  noCacheJson(res, { ok: true });
});

// Catalog endpoints (persistent disk-backed CatalogStore)
app.get('/api/catalog/stats', (_req, res) => {
  noCacheJson(res, catalogStore.stats());
});

app.get('/api/catalog/playlists', (_req, res) => {
  noCacheJson(res, { playlists: catalogStore.getUsedPlaylists() });
});

app.get('/api/catalog/channels', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 100));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const search = String(req.query.search || '').trim();
  const filter = String(req.query.filter || '').trim();
  const playlistsRaw = String(req.query.playlists || '').trim();
  const playlists = playlistsRaw
    ? playlistsRaw
        .split(',')
        .map((p) => p.trim())
        .filter(Boolean)
    : [];

  const channels = catalogStore.getChannels(limit, offset, search, filter, playlists);
  noCacheJson(res, { channels, limit, offset });
});

app.get('/api/catalog/channel', (req, res) => {
  const id = Number(req.query.id) || 0;
  const ch = catalogStore.getChannel(id);
  if (!ch) {
    noCacheJson(res, { error: 'Not found' }, 404);
    return;
  }
  noCacheJson(res, ch);
});

app.get('/api/catalog/sources', (_req, res) => {
  noCacheJson(res, { sources: catalogStore.getSources() });
});

app.post('/api/catalog/sources/save', async (req, res) => {
  const id = req.body?.id ? Number(req.body.id) || String(req.body.id) : undefined;
  const name = String(req.body?.name || '').trim();
  const type = String(req.body?.type || 'm3u').trim();
  const url = String(req.body?.url || '').trim();
  const enabled = Boolean(req.body?.enabled);

  if (!name || !url) {
    noCacheJson(res, { ok: false, error: 'Пустые поля' }, 400);
    return;
  }
  const out = await upsertCatalogSourceUnified({ id, name, type, url, enabled });
  noCacheJson(res, out, out.status);
});

app.post('/api/catalog/sources/delete', async (req, res) => {
  const rawId = req.body?.id;
  const cleanId =
    typeof rawId === 'number'
      ? rawId
      : String(rawId || '').trim();
  if (!cleanId || (typeof cleanId === 'number' && cleanId <= 0)) {
    noCacheJson(res, { ok: false, error: 'Не указан ID источника' }, 400);
    return;
  }
  const out = await deleteSourceUnified(cleanId);
  noCacheJson(res, out, out.status);
});

app.post('/api/catalog/stream/delete', async (req, res) => {
  const id = Number(req.body?.id) || 0;
  const out = await deleteStreamUnified(id);
  noCacheJson(res, out, out.status);
});

app.post('/api/catalog/check', async (req, res) => {
  const limit = Number(req.body?.limit) || 500;
  const result = await catalogStore.checkStreams(limit);
  if (!result.persisted) {
    noCacheJson(res, { ok: false, error: result.error || 'Не удалось сохранить результаты проверки' }, 500);
    return;
  }
  noCacheJson(res, {
    ok: true,
    output: `Checked ${result.checked} streams: ${result.online} online, ${result.offline} offline, ${result.unknown} unknown`,
  });
});

app.post('/api/catalog/to-playlist', async (req, res) => {
  const channelId = Number(req.body?.channel_id) || 0;
  const playlist = String(req.body?.playlist || '').trim();
  if (!channelId || !playlist) {
    noCacheJson(res, { error: 'Нет данных' }, 400);
    return;
  }
  if (!storage.isValidFilename(playlist)) {
    noCacheJson(res, { error: 'Неверное имя плейлиста' }, 400);
    return;
  }
  const ch = catalogStore.getChannel(channelId);
  if (!ch) {
    noCacheJson(res, { error: 'Канал не найден' }, 404);
    return;
  }
  let url = '';
  for (const s of ch.streams) {
    if (s.status === 'online') {
      url = s.url;
      break;
    }
  }
  if (!url && ch.streams.length > 0) url = ch.streams[0].url;
  if (!url) {
    noCacheJson(res, { error: 'Нет потоков у канала' }, 400);
    return;
  }

  const filePath = storage.getPlaylistPath(playlist);
  const list = fs.existsSync(filePath) ? parseM3uFile(filePath) : [];
  if (list.some((item) => item.name.trim().toLowerCase() === ch.name.toLowerCase())) {
    noCacheJson(res, { error: 'Такой канал уже есть в плейлисте' }, 400);
    return;
  }

  list.push({
    name: ch.name,
    group: 'Импорт',
    logo: ch.logo || '',
    url,
    tvg_id: ch.tvg_id || '',
  });

  const saved = await savePlaylistChannelsUnified(playlist, list);
  if (!saved.ok) {
    noCacheJson(res, saved, saved.status);
    return;
  }
  noCacheJson(res, { ok: true, name: ch.name, revision: saved.revision });
});

app.post('/api/catalog/aggregate', async (_req, res) => {
  const result = await catalogStore.aggregateFromSources();
  if (!result.ok) {
    noCacheJson(res, { ok: false, error: result.error || 'Ошибка агрегации каталога' }, 500);
    return;
  }
  const meta = stateLifecycle.bumpRevision('reconcile', 'aggregate', {
    addedChannels: result.addedChannels,
    addedStreams: result.addedStreams,
  });
  noCacheJson(res, {
    ok: true,
    output: `Aggregated ${result.addedChannels} channels and ${result.addedStreams} streams`,
    revision: meta.revision,
  });
});

app.post('/api/catalog/import', async (_req, res) => {
  const out = await reconcileCatalogUnified();
  if (!out.ok) {
    noCacheJson(res, out, out.status);
    return;
  }
  noCacheJson(res, {
    ...out,
    output: `Reconciled: imported ${out.imported}, removed ${out.removedChannels} channels / ${out.removedStreams} streams`,
  });
});

app.post('/api/catalog/reconcile', async (_req, res) => {
  const out = await reconcileCatalogUnified();
  noCacheJson(res, out, out.status);
});

app.use('/api', (_req, res) => {
  noCacheJson(res, { error: 'Not Found' }, 404);
});

app.use((_req, res) => {
  res.status(404).send('404 Not Found');
});

if (process.env.PQTV_NO_LISTEN !== '1') {
  app.listen(config.port, '0.0.0.0', () => {
    console.log(`PQTV server listening on http://0.0.0.0:${config.port}`);
  });
}
