import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Channel, parseM3uFile } from './m3uParser.js';
import { storage } from './storage.js';
import { StreamParser } from './streamParser.js';
import { checkStreamDeep, DeepCheckResult, DiagCode } from './streamChecker.js';
import { catalogStore } from './catalogStore.js';
import { userAuth } from './userAuth.js';

export type ResolveCheckStatus = 'none' | 'verified_ok' | 'still_broken_after_resolve';

export interface UrlDiagnosticEntry {
  url: string;
  online: boolean | null;
  status: 'online' | 'offline' | 'unknown';
  code: number;
  ms: number;
  diagCode: DiagCode;
  reason: string;
  contentType: string;
  hlsOk?: boolean;
  segmentOk?: boolean;
  codecWarning?: string;
  checkedAt: number;
}

export interface ViewerErrorReport {
  userId: string;
  userLogin: string;
  userName: string;
  reason: string;
  diagCode: DiagCode;
  reportedAt: number;
}

export interface ChannelIssueRecord {
  channelKey: string;
  channelName: string;
  resolved: boolean;
  resolveCheckStatus: ResolveCheckStatus;
  resolveCheckMessage: string;
  resolveAttemptedAt: number;
  updatedAt: number;
  viewerErrors: ViewerErrorReport[];
}

export interface ChannelHealthState {
  urlDiagnostics: Record<string, UrlDiagnosticEntry>;
  issues: Record<string, ChannelIssueRecord>;
}

const MAX_URL_DIAGNOSTICS = 2500;

function inferDiagCodeFromReason(reason: string): DiagCode {
  const low = reason.toLowerCase();
  if (low.includes('401')) return '401';
  if (low.includes('403') || low.includes('доступ')) return '403';
  if (low.includes('404') || low.includes('410') || low.includes('не найден')) return '404';
  if (low.includes('429') || low.includes('лимит')) return '429';
  if (low.includes('timeout') || low.includes('таймаут')) return 'timeout';
  if (low.includes('tls') || low.includes('ssl') || low.includes('сертификат')) return 'tls';
  if (low.includes('hevc') || low.includes('codec') || low.includes('кодек') || low.includes('декоди')) return 'codec';
  if (low.includes('html')) return 'html_error';
  if (low.includes('сегмент')) return 'hls_segment';
  if (low.includes('пуст')) return 'hls_empty';
  return 'network';
}

class ChannelHealthManager {
  private filePath = path.join(config.dataDir, 'channel_health.json');
  private loaded = false;
  private urlDiagnostics: Record<string, UrlDiagnosticEntry> = {};
  private issues: Record<string, ChannelIssueRecord> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  private ensureLoaded(): void {
    if (this.loaded) return;
    this.loaded = true;
    if (!fs.existsSync(this.filePath)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as Partial<ChannelHealthState>;
      if (raw.urlDiagnostics && typeof raw.urlDiagnostics === 'object') {
        this.urlDiagnostics = raw.urlDiagnostics;
      }
      if (raw.issues && typeof raw.issues === 'object') {
        this.issues = raw.issues;
      }
    } catch {
      // ignore corrupt health file
    }
  }

  private saveToDisk(): void {
    try {
      this.pruneDiagnostics();
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(
        tmp,
        JSON.stringify({
          urlDiagnostics: this.urlDiagnostics,
          issues: this.issues,
        }),
        'utf-8'
      );
      fs.renameSync(tmp, this.filePath);
    } catch {
      // ignore write error
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveToDisk();
    }, 350);
  }

  private pruneDiagnostics(): void {
    const entries = Object.entries(this.urlDiagnostics);
    if (entries.length <= MAX_URL_DIAGNOSTICS) return;
    entries.sort((a, b) => (b[1]?.checkedAt || 0) - (a[1]?.checkedAt || 0));
    this.urlDiagnostics = Object.fromEntries(entries.slice(0, MAX_URL_DIAGNOSTICS));
  }

  buildChannelCheckOpts(ch: Pick<Channel, 'url' | 'userAgent' | 'referer' | 'origin'>, force = false) {
    const srcOpts = StreamParser.getSourceRequestOptions(ch.url);
    return {
      timeoutMs: srcOpts.timeoutMs,
      headers: srcOpts.headers,
      userAgent: ch.userAgent || srcOpts.userAgent,
      referer: ch.referer || srcOpts.referer,
      origin: ch.origin || srcOpts.origin,
      ignoreTlsErrors: srcOpts.ignoreTlsErrors,
      checkSegments: true,
      force,
    };
  }

  recordCheckResult(url: string, res: DeepCheckResult, channelName?: string): UrlDiagnosticEntry {
    this.ensureLoaded();
    const cleanUrl = String(url || '').trim();
    const entry: UrlDiagnosticEntry = {
      url: cleanUrl,
      online: res.online,
      status: res.status,
      code: res.code,
      ms: res.ms,
      diagCode: res.diagCode,
      reason: res.reason,
      contentType: res.contentType || '',
      hlsOk: res.hlsOk,
      segmentOk: res.segmentOk,
      codecWarning: res.codecWarning,
      checkedAt: res.checkedAt || Math.floor(Date.now() / 1000),
    };
    if (cleanUrl) {
      this.urlDiagnostics[cleanUrl] = entry;
    }
    if (channelName && res.status === 'online') {
      const key = channelName.trim().toLowerCase();
      const issue = this.issues[key];
      if (issue && issue.resolveCheckStatus === 'still_broken_after_resolve') {
        // Keep still_broken badge until admin explicitly re-verifies or clears it,
        // unless we want to keep track; let resolveWithVerification clear it.
      }
    }
    this.scheduleSave();
    return entry;
  }

  recordViewerReports(
    viewer: { userId: string; login: string; name: string },
    items: Array<{ name: string; group?: string; reason: string }>
  ): void {
    this.ensureLoaded();
    const now = Math.floor(Date.now() / 1000);
    let changed = false;

    for (const item of items) {
      const name = String(item?.name || '').trim();
      const reason = String(item?.reason || '').trim();
      if (!name || !reason) continue;
      const key = name.toLowerCase();
      const diagCode = inferDiagCodeFromReason(reason);

      let issue = this.issues[key];
      if (!issue) {
        issue = {
          channelKey: key,
          channelName: name,
          resolved: false,
          resolveCheckStatus: 'none',
          resolveCheckMessage: '',
          resolveAttemptedAt: 0,
          updatedAt: now,
          viewerErrors: [],
        };
        this.issues[key] = issue;
      }

      const existingErrIdx = issue.viewerErrors.findIndex((e) => e.userId === viewer.userId);
      const errEntry: ViewerErrorReport = {
        userId: viewer.userId,
        userLogin: viewer.login,
        userName: viewer.name,
        reason: reason.slice(0, 200),
        diagCode,
        reportedAt: now,
      };
      if (existingErrIdx >= 0) {
        issue.viewerErrors[existingErrIdx] = errEntry;
      } else {
        issue.viewerErrors.unshift(errEntry);
        if (issue.viewerErrors.length > 10) {
          issue.viewerErrors = issue.viewerErrors.slice(0, 10);
        }
      }
      issue.resolved = false;
      issue.updatedAt = now;
      changed = true;
    }

    if (changed) this.saveToDisk();
  }

  shouldExcludeForViewer(ch: Channel): {
    excluded: boolean;
    reason?: string;
    diagCode?: string;
  } {
    this.ensureLoaded();
    if (ch.paused) {
      return {
        excluded: true,
        diagCode: 'paused',
        reason: 'Канал приостановлен администратором',
      };
    }

    const cleanUrl = (ch.url || '').trim();
    if (!cleanUrl) {
      return {
        excluded: true,
        diagCode: 'network',
        reason: 'Отсутствует ссылка на поток',
      };
    }

    const diag = this.urlDiagnostics[cleanUrl];
    if (diag && diag.status === 'offline') {
      return {
        excluded: true,
        diagCode: diag.diagCode || 'network',
        reason: diag.reason || 'Поток недоступен',
      };
    }

    const issue = this.issues[ch.name.trim().toLowerCase()];
    if (issue && issue.resolveCheckStatus === 'still_broken_after_resolve') {
      return {
        excluded: true,
        diagCode: diag?.diagCode || 'network',
        reason: issue.resolveCheckMessage || diag?.reason || 'Не работает после проверки',
      };
    }

    return { excluded: false };
  }

  private collectChannelPlaylistOccurrences(targetKey?: string) {
    const playlists = storage.getPlaylists();
    const map = new Map<
      string,
      {
        channelKey: string;
        name: string;
        group: string;
        logo: string;
        tvg_id: string;
        playlists: string[];
        entries: Array<{ playlist: string; index: number; channel: Channel }>;
      }
    >();

    for (const pl of playlists) {
      const items = parseM3uFile(storage.getPlaylistPath(pl));
      for (let i = 0; i < items.length; i++) {
        const ch = items[i];
        const name = (ch.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        if (targetKey && key !== targetKey) continue;

        let bucket = map.get(key);
        if (!bucket) {
          bucket = {
            channelKey: key,
            name,
            group: ch.group || '',
            logo: ch.logo || '',
            tvg_id: ch.tvg_id || '',
            playlists: [],
            entries: [],
          };
          map.set(key, bucket);
        }
        if (!bucket.playlists.includes(pl)) bucket.playlists.push(pl);
        if (!bucket.logo && ch.logo) bucket.logo = ch.logo;
        if (!bucket.group && ch.group) bucket.group = ch.group;
        if (!bucket.tvg_id && ch.tvg_id) bucket.tvg_id = ch.tvg_id;
        bucket.entries.push({ playlist: pl, index: i, channel: ch });
      }
    }
    return map;
  }

  getHealthOverview() {
    this.ensureLoaded();
    const map = this.collectChannelPlaylistOccurrences();
    const alerts = userAuth.allAlerts();

    // Merge active viewer alerts into viewerErrors view so Admin sees everything unified
    const alertErrorsByChannel = new Map<string, ViewerErrorReport[]>();
    for (const al of alerts) {
      if (al.resolved) continue;
      for (const it of al.items || []) {
        const key = (it.name || '').trim().toLowerCase();
        if (!key) continue;
        const arr = alertErrorsByChannel.get(key) || [];
        arr.push({
          userId: al.userId,
          userLogin: al.userLogin,
          userName: al.userName,
          reason: it.reason,
          diagCode: inferDiagCodeFromReason(it.reason),
          reportedAt: al.updated_at || al.created_at || 0,
        });
        alertErrorsByChannel.set(key, arr);
      }
    }

    const diagCounts: Record<string, number> = {
      '401': 0,
      '403': 0,
      '404': 0,
      '429': 0,
      '5xx': 0,
      timeout: 0,
      tls: 0,
      codec: 0,
      hls_empty: 0,
      hls_segment: 0,
      html_error: 0,
      network: 0,
    };

    const channels: Array<{
      channelKey: string;
      name: string;
      group: string;
      logo: string;
      tvg_id: string;
      playlists: string[];
      primaryUrl: string;
      urls: Array<{
        url: string;
        playlists: string[];
        paused: boolean;
        userAgent?: string;
        referer?: string;
        origin?: string;
        diag: UrlDiagnosticEntry | null;
      }>;
      paused: boolean;
      allPaused: boolean;
      hiddenForViewers: boolean;
      stillBrokenAfterResolve: boolean;
      resolveCheckStatus: ResolveCheckStatus;
      resolveCheckMessage: string;
      resolveAttemptedAt: number;
      overallStatus:
        | 'still_broken'
        | 'paused'
        | 'offline'
        | 'viewer_reported'
        | 'codec_warn'
        | 'online'
        | 'unknown';
      diagCode: string;
      reason: string;
      code: number;
      ms: number;
      segmentOk?: boolean;
      codecWarning?: string;
      checkedAt: number;
      viewerErrors: ViewerErrorReport[];
      viewerErrorCount: number;
    }> = [];

    let onlineCount = 0;
    let offlineCount = 0;
    let pausedCount = 0;
    let hiddenCount = 0;
    let viewerReportedCount = 0;
    let stillBrokenCount = 0;
    let codecWarnCount = 0;
    let unknownCount = 0;

    for (const bucket of map.values()) {
      const issue = this.issues[bucket.channelKey];
      const byUrl = new Map<
        string,
        {
          url: string;
          playlists: string[];
          paused: boolean;
          userAgent?: string;
          referer?: string;
          origin?: string;
          diag: UrlDiagnosticEntry | null;
        }
      >();

      let allPaused = true;
      let anyPaused = false;
      let anyVisibleForViewers = false;

      for (const ent of bucket.entries) {
        const isPaused = Boolean(ent.channel.paused);
        if (isPaused) anyPaused = true;
        else allPaused = false;

        const excl = this.shouldExcludeForViewer(ent.channel);
        if (!excl.excluded) anyVisibleForViewers = true;

        const cleanUrl = (ent.channel.url || '').trim();
        let uItem = byUrl.get(cleanUrl);
        if (!uItem) {
          uItem = {
            url: cleanUrl,
            playlists: [],
            paused: isPaused,
            userAgent: ent.channel.userAgent,
            referer: ent.channel.referer,
            origin: ent.channel.origin,
            diag: this.urlDiagnostics[cleanUrl] || null,
          };
          byUrl.set(cleanUrl, uItem);
        }
        if (!uItem.playlists.includes(ent.playlist)) {
          uItem.playlists.push(ent.playlist);
        }
        uItem.paused = uItem.paused && isPaused;
      }

      const urlList = Array.from(byUrl.values());
      const primary = urlList[0];
      const bestDiag =
        urlList.find((u) => u.diag?.status === 'online')?.diag ||
        urlList.find((u) => u.diag?.status === 'offline')?.diag ||
        primary?.diag ||
        null;

      const stillBroken = issue?.resolveCheckStatus === 'still_broken_after_resolve';
      const combinedViewerErrors = new Map<string, ViewerErrorReport>();
      for (const ve of issue?.viewerErrors || []) {
        if (!issue?.resolved) {
          combinedViewerErrors.set(`${ve.userId}:${ve.reason}`, ve);
        }
      }
      for (const ve of alertErrorsByChannel.get(bucket.channelKey) || []) {
        combinedViewerErrors.set(`${ve.userId}:${ve.reason}`, ve);
      }
      const viewerErrors = Array.from(combinedViewerErrors.values()).sort(
        (a, b) => b.reportedAt - a.reportedAt
      );

      const allOffline =
        !allPaused &&
        urlList.some((u) => !u.paused) &&
        urlList.filter((u) => !u.paused).every((u) => u.diag?.status === 'offline');
      const hiddenForViewers = !anyVisibleForViewers;

      let overallStatus:
        | 'still_broken'
        | 'paused'
        | 'offline'
        | 'viewer_reported'
        | 'codec_warn'
        | 'online'
        | 'unknown' = 'unknown';

      if (stillBroken) {
        overallStatus = 'still_broken';
        stillBrokenCount++;
      } else if (allPaused) {
        overallStatus = 'paused';
      } else if (allOffline) {
        overallStatus = 'offline';
        offlineCount++;
      } else if (viewerErrors.length > 0) {
        overallStatus = 'viewer_reported';
      } else if (bestDiag?.codecWarning) {
        overallStatus = 'codec_warn';
        codecWarnCount++;
      } else if (bestDiag?.status === 'online') {
        overallStatus = 'online';
        onlineCount++;
      } else {
        unknownCount++;
      }

      if (anyPaused || allPaused) pausedCount++;
      if (hiddenForViewers) hiddenCount++;
      if (viewerErrors.length > 0) viewerReportedCount++;

      const diagCode =
        allPaused
          ? 'paused'
          : bestDiag?.diagCode || viewerErrors[0]?.diagCode || 'unknown';
      if (diagCode in diagCounts) {
        diagCounts[diagCode]++;
      }

      const reason =
        stillBroken
          ? issue?.resolveCheckMessage || bestDiag?.reason || 'Не работает после нажатия «Решено»'
          : allPaused
            ? 'Канал приостановлен администратором'
            : bestDiag?.status === 'offline'
              ? bestDiag.reason
              : viewerErrors[0]?.reason || bestDiag?.reason || 'Ещё не проверялся';

      channels.push({
        channelKey: bucket.channelKey,
        name: bucket.name,
        group: bucket.group,
        logo: bucket.logo,
        tvg_id: bucket.tvg_id,
        playlists: bucket.playlists,
        primaryUrl: primary?.url || '',
        urls: urlList,
        paused: allPaused,
        allPaused,
        hiddenForViewers,
        stillBrokenAfterResolve: stillBroken,
        resolveCheckStatus: issue?.resolveCheckStatus || 'none',
        resolveCheckMessage: issue?.resolveCheckMessage || '',
        resolveAttemptedAt: issue?.resolveAttemptedAt || 0,
        overallStatus,
        diagCode,
        reason,
        code: bestDiag?.code || 0,
        ms: bestDiag?.ms || 0,
        segmentOk: bestDiag?.segmentOk,
        codecWarning: bestDiag?.codecWarning,
        checkedAt: bestDiag?.checkedAt || 0,
        viewerErrors,
        viewerErrorCount: viewerErrors.length,
      });
    }

    const priorityWeight: Record<string, number> = {
      still_broken: 0,
      offline: 1,
      viewer_reported: 2,
      paused: 3,
      codec_warn: 4,
      unknown: 5,
      online: 6,
    };

    channels.sort((a, b) => {
      const wa = priorityWeight[a.overallStatus] ?? 9;
      const wb = priorityWeight[b.overallStatus] ?? 9;
      if (wa !== wb) return wa - wb;
      return a.name.localeCompare(b.name, 'ru');
    });

    return {
      ok: true,
      stats: {
        totalChannels: channels.length,
        online: onlineCount,
        offline: offlineCount,
        paused: pausedCount,
        hiddenForViewers: hiddenCount,
        viewerReported: viewerReportedCount,
        stillBroken: stillBrokenCount,
        codecWarn: codecWarnCount,
        unknown: unknownCount,
      },
      diagCounts,
      playlists: storage.getPlaylists(),
      channels,
    };
  }

  async checkChannel(channelName: string, force = true) {
    this.ensureLoaded();
    const key = channelName.trim().toLowerCase();
    const map = this.collectChannelPlaylistOccurrences(key);
    const bucket = map.get(key);
    if (!bucket) {
      return { ok: false, error: 'Канал не найден в плейлистах' };
    }

    const results: Array<{ url: string; playlists: string[]; result: DeepCheckResult }> = [];
    const checkedByUrl = new Map<string, DeepCheckResult>();

    for (const ent of bucket.entries) {
      const url = (ent.channel.url || '').trim();
      if (!url) continue;
      let res = checkedByUrl.get(url);
      if (!res) {
        res = await checkStreamDeep(url, this.buildChannelCheckOpts(ent.channel, force));
        checkedByUrl.set(url, res);
        this.recordCheckResult(url, res, bucket.name);
        await catalogStore.checkStream(url, force, false, this.buildChannelCheckOpts(ent.channel, force));
      }
      const existing = results.find((r) => r.url === url);
      if (existing) {
        if (!existing.playlists.includes(ent.playlist)) existing.playlists.push(ent.playlist);
      } else {
        results.push({ url, playlists: [ent.playlist], result: res });
      }
    }

    this.saveToDisk();
    return {
      ok: true,
      channelName: bucket.name,
      results,
      anyOnline: results.some((r) => r.result.status === 'online'),
    };
  }

  async checkAllPlaylistChannels(opts: { playlist?: string; force?: boolean; limit?: number } = {}) {
    this.ensureLoaded();
    const targetPl = (opts.playlist || '').trim().replace(/\.m3u$/i, '');
    const force = opts.force !== false;
    const limit = Math.max(1, Math.min(2000, opts.limit || 800));

    const urlToChannel = new Map<string, Channel>();
    for (const pl of storage.getPlaylists()) {
      if (targetPl && pl !== targetPl) continue;
      for (const ch of parseM3uFile(storage.getPlaylistPath(pl))) {
        if (ch.paused) continue;
        const u = (ch.url || '').trim();
        if (u && !urlToChannel.has(u)) {
          urlToChannel.set(u, ch);
        }
      }
    }

    const entries = Array.from(urlToChannel.entries()).slice(0, limit);
    let online = 0;
    let offline = 0;
    let unknown = 0;
    const batchSize = 6;

    for (let i = 0; i < entries.length; i += batchSize) {
      const batch = entries.slice(i, i + batchSize);
      const checked = await Promise.all(
        batch.map(async ([url, ch]) => {
          const checkOpts = this.buildChannelCheckOpts(ch, force);
          const res = await checkStreamDeep(url, checkOpts);
          this.recordCheckResult(url, res, ch.name);
          await catalogStore.checkStream(url, force, false, checkOpts);
          return res;
        })
      );
      for (const r of checked) {
        if (r.status === 'online') online++;
        else if (r.status === 'offline') offline++;
        else unknown++;
      }
    }

    this.saveToDisk();
    return { ok: true, checked: entries.length, online, offline, unknown };
  }

  async replaceChannelUrl(input: {
    channelName: string;
    newUrl: string;
    playlists?: string[];
    userAgent?: string;
    referer?: string;
    origin?: string;
    unpause?: boolean;
  }) {
    this.ensureLoaded();
    const key = input.channelName.trim().toLowerCase();
    const newUrl = input.newUrl.trim();
    if (!key || !newUrl) {
      return { ok: false, error: 'Укажите название канала и новую ссылку' };
    }

    const targetPlaylists =
      Array.isArray(input.playlists) && input.playlists.length > 0
        ? new Set(input.playlists.map((p) => p.replace(/\.m3u$/i, '').trim()))
        : null;

    const updatedPlaylists: string[] = [];
    for (const pl of storage.getPlaylists()) {
      if (targetPlaylists && !targetPlaylists.has(pl)) continue;
      const items = parseM3uFile(storage.getPlaylistPath(pl));
      let modified = false;
      for (const ch of items) {
        if ((ch.name || '').trim().toLowerCase() === key) {
          ch.url = newUrl;
          if (input.unpause !== false) {
            delete ch.paused;
          }
          if (input.userAgent !== undefined) {
            if (input.userAgent.trim()) ch.userAgent = input.userAgent.trim();
            else delete ch.userAgent;
          }
          if (input.referer !== undefined) {
            if (input.referer.trim()) ch.referer = input.referer.trim();
            else delete ch.referer;
          }
          if (input.origin !== undefined) {
            if (input.origin.trim()) ch.origin = input.origin.trim();
            else delete ch.origin;
          }
          modified = true;
        }
      }
      if (modified && storage.saveChannels(pl, items)) {
        updatedPlaylists.push(pl);
      }
    }

    if (updatedPlaylists.length === 0) {
      return { ok: false, error: 'Канал не найден в выбранных плейлистах' };
    }

    catalogStore.importFromPlaylists();

    // Immediately verify new stream URL
    const checkResult = await checkStreamDeep(newUrl, {
      ...StreamParser.getSourceRequestOptions(newUrl),
      userAgent: input.userAgent || undefined,
      referer: input.referer || undefined,
      origin: input.origin || undefined,
      force: true,
    });
    this.recordCheckResult(newUrl, checkResult, input.channelName);

    const now = Math.floor(Date.now() / 1000);
    if (checkResult.status === 'online') {
      const existingIssue = this.issues[key];
      if (existingIssue) {
        existingIssue.resolved = true;
        existingIssue.resolveCheckStatus = 'verified_ok';
        existingIssue.resolveCheckMessage = 'URL заменён и подтверждён проверкой';
        existingIssue.updatedAt = now;
      }
    } else if (this.issues[key]) {
      this.issues[key].resolved = false;
      this.issues[key].resolveCheckStatus = 'still_broken_after_resolve';
      this.issues[key].resolveCheckMessage = checkResult.reason;
      this.issues[key].updatedAt = now;
    }

    this.saveToDisk();
    return {
      ok: true,
      updatedPlaylists,
      checkResult,
    };
  }

  setChannelPaused(input: { channelName: string; paused: boolean; playlists?: string[] }) {
    this.ensureLoaded();
    const key = input.channelName.trim().toLowerCase();
    const paused = Boolean(input.paused);
    if (!key) return { ok: false, error: 'Не указано имя канала' };

    const targetPlaylists =
      Array.isArray(input.playlists) && input.playlists.length > 0
        ? new Set(input.playlists.map((p) => p.replace(/\.m3u$/i, '').trim()))
        : null;

    const updatedPlaylists: string[] = [];
    for (const pl of storage.getPlaylists()) {
      if (targetPlaylists && !targetPlaylists.has(pl)) continue;
      const items = parseM3uFile(storage.getPlaylistPath(pl));
      let modified = false;
      for (const ch of items) {
        if ((ch.name || '').trim().toLowerCase() === key) {
          if (paused) ch.paused = true;
          else delete ch.paused;
          modified = true;
        }
      }
      if (modified && storage.saveChannels(pl, items)) {
        updatedPlaylists.push(pl);
      }
    }

    if (updatedPlaylists.length === 0) {
      return { ok: false, error: 'Канал не найден в плейлистах' };
    }

    return { ok: true, paused, updatedPlaylists };
  }

  deleteChannelFromPlaylists(input: { channelName: string; playlists?: string[] }) {
    this.ensureLoaded();
    const key = input.channelName.trim().toLowerCase();
    if (!key) return { ok: false, error: 'Не указано имя канала' };

    const targetPlaylists =
      Array.isArray(input.playlists) && input.playlists.length > 0
        ? new Set(input.playlists.map((p) => p.replace(/\.m3u$/i, '').trim()))
        : null;

    const updatedPlaylists: string[] = [];
    for (const pl of storage.getPlaylists()) {
      if (targetPlaylists && !targetPlaylists.has(pl)) continue;
      const items = parseM3uFile(storage.getPlaylistPath(pl));
      const filtered = items.filter((ch) => (ch.name || '').trim().toLowerCase() !== key);
      if (filtered.length !== items.length) {
        if (storage.saveChannels(pl, filtered)) {
          updatedPlaylists.push(pl);
        }
      }
    }

    if (updatedPlaylists.length === 0) {
      return { ok: false, error: 'Канал не найден в плейлистах' };
    }

    // Remove channel issue if it no longer exists in any playlist
    const remaining = this.collectChannelPlaylistOccurrences(key);
    if (!remaining.has(key)) {
      delete this.issues[key];
      this.saveToDisk();
    }

    catalogStore.importFromPlaylists();
    return { ok: true, updatedPlaylists };
  }

  async resolveWithVerification(input: { channelName?: string; alertId?: string }) {
    this.ensureLoaded();
    const now = Math.floor(Date.now() / 1000);
    const channelNamesToVerify: string[] = [];

    if (input.channelName && input.channelName.trim()) {
      channelNamesToVerify.push(input.channelName.trim());
    }

    let alertRecord: ReturnType<typeof userAuth.allAlerts>[number] | null = null;
    if (input.alertId && input.alertId.trim()) {
      alertRecord = userAuth.allAlerts().find((a) => a.id === input.alertId!.trim()) || null;
      if (!alertRecord && channelNamesToVerify.length === 0) {
        return { ok: false, error: 'Предупреждение не найдено' };
      }
      if (alertRecord) {
        for (const it of alertRecord.items || []) {
          const n = (it.name || '').trim();
          if (n && !channelNamesToVerify.some((x) => x.toLowerCase() === n.toLowerCase())) {
            channelNamesToVerify.push(n);
          }
        }
      }
    }

    const failedChannels: Array<{
      name: string;
      url: string;
      code: number;
      diagCode: DiagCode;
      reason: string;
    }> = [];
    const verifiedWorking: string[] = [];

    for (const chName of channelNamesToVerify) {
      const key = chName.trim().toLowerCase();
      const occ = this.collectChannelPlaylistOccurrences(key).get(key);
      if (!occ) {
        // Channel was already deleted from playlists
        delete this.issues[key];
        continue;
      }

      const activeEntries = occ.entries.filter((e) => !e.channel.paused);
      if (activeEntries.length === 0) {
        // All occurrences paused -> excluded from viewers safely
        this.issues[key] = {
          channelKey: key,
          channelName: occ.name,
          resolved: true,
          resolveCheckStatus: 'verified_ok',
          resolveCheckMessage: 'Канал приостановлен',
          resolveAttemptedAt: now,
          updatedAt: now,
          viewerErrors: this.issues[key]?.viewerErrors || [],
        };
        continue;
      }

      let channelFailed: {
        name: string;
        url: string;
        code: number;
        diagCode: DiagCode;
        reason: string;
      } | null = null;

      const checkedUrls = new Map<string, DeepCheckResult>();
      for (const ent of activeEntries) {
        const u = (ent.channel.url || '').trim();
        let res = checkedUrls.get(u);
        if (!res) {
          res = await checkStreamDeep(u, this.buildChannelCheckOpts(ent.channel, true));
          checkedUrls.set(u, res);
          this.recordCheckResult(u, res, occ.name);
        }
        if (res.status !== 'online') {
          channelFailed = {
            name: occ.name,
            url: u,
            code: res.code,
            diagCode: res.diagCode,
            reason: res.reason,
          };
        }
      }

      if (channelFailed) {
        failedChannels.push(channelFailed);
        const prev = this.issues[key];
        this.issues[key] = {
          channelKey: key,
          channelName: occ.name,
          resolved: false,
          resolveCheckStatus: 'still_broken_after_resolve',
          resolveCheckMessage: `Не работает после «Решено»: ${channelFailed.reason}`,
          resolveAttemptedAt: now,
          updatedAt: now,
          viewerErrors: prev?.viewerErrors || [],
        };
      } else {
        verifiedWorking.push(occ.name);
        const prev = this.issues[key];
        this.issues[key] = {
          channelKey: key,
          channelName: occ.name,
          resolved: true,
          resolveCheckStatus: 'verified_ok',
          resolveCheckMessage: 'Проверено: поток работает',
          resolveAttemptedAt: now,
          updatedAt: now,
          viewerErrors: prev?.viewerErrors || [],
        };
      }
    }

    // Keep alert unresolved if ANY channel still failed, otherwise resolve alert
    if (alertRecord) {
      if (failedChannels.length > 0) {
        userAuth.resolveAlert(alertRecord.id, false);
      } else {
        userAuth.resolveAlert(alertRecord.id, true);
      }
    } else if (channelNamesToVerify.length === 1 && failedChannels.length === 0) {
      // Also resolve single-item alerts mentioning only this channel if it was verified OK
      const targetKey = channelNamesToVerify[0].trim().toLowerCase();
      for (const al of userAuth.allAlerts()) {
        if (al.resolved) continue;
        const onlyThis =
          al.items.length > 0 &&
          al.items.every((it) => (it.name || '').trim().toLowerCase() === targetKey);
        if (onlyThis) {
          userAuth.resolveAlert(al.id, true);
        }
      }
    }

    this.saveToDisk();

    if (failedChannels.length > 0) {
      return {
        ok: true,
        resolved: false,
        stillBroken: true,
        failedChannels,
        verifiedWorking,
        message: `Поток всё ещё не работает (${failedChannels.map((f) => `${f.name}: ${f.reason}`).join('; ')}). Канал оставлен в списке как нерабочий.`,
      };
    }

    return {
      ok: true,
      resolved: true,
      stillBroken: false,
      failedChannels: [],
      verifiedWorking,
      message: 'Поток проверен и подтверждён как рабочий.',
    };
  }

  async findAndProbeCandidates(channelName: string) {
    this.ensureLoaded();
    const key = channelName.trim().toLowerCase();
    const occ = this.collectChannelPlaylistOccurrences(key).get(key);
    const currentUrls = occ ? occ.entries.map((e) => e.channel.url) : [];
    const candidates = catalogStore.findAlternativeStreams(
      occ?.name || channelName,
      occ?.tvg_id || '',
      currentUrls
    );

    const probed = await Promise.all(
      candidates.slice(0, 12).map(async (cand) => {
        const res = await checkStreamDeep(cand.url, {
          ...StreamParser.getSourceRequestOptions(cand.url),
          userAgent: cand.userAgent,
          referer: cand.referer,
          origin: cand.origin,
          force: true,
        });
        this.recordCheckResult(cand.url, res, cand.name);
        return {
          ...cand,
          diag: res,
        };
      })
    );

    probed.sort((a, b) => {
      const aOk = a.diag.status === 'online' ? 1 : 0;
      const bOk = b.diag.status === 'online' ? 1 : 0;
      if (aOk !== bOk) return bOk - aOk;
      return (a.diag.ms || 99999) - (b.diag.ms || 99999);
    });

    this.saveToDisk();
    return { ok: true, channelName: occ?.name || channelName, candidates: probed };
  }

  async autoRepairChannels(opts: { channelNames?: string[]; onlyDead?: boolean } = {}) {
    this.ensureLoaded();
    const overview = this.getHealthOverview();
    const targetSet =
      Array.isArray(opts.channelNames) && opts.channelNames.length > 0
        ? new Set(opts.channelNames.map((n) => n.trim().toLowerCase()))
        : null;

    const toFix = overview.channels.filter((ch) => {
      if (ch.paused) return false;
      if (targetSet && !targetSet.has(ch.channelKey)) return false;
      if (opts.onlyDead !== false && !targetSet) {
        return (
          ch.overallStatus === 'offline' ||
          ch.overallStatus === 'still_broken' ||
          ch.overallStatus === 'viewer_reported'
        );
      }
      return ch.overallStatus !== 'online';
    });

    const repaired: Array<{ name: string; oldUrl: string; newUrl: string; source: string; playlists: string[] }> = [];
    const unfixable: Array<{ name: string; reason: string }> = [];

    for (const ch of toFix) {
      const currentUrls = ch.urls.map((u) => u.url);
      const candidates = catalogStore.findAlternativeStreams(ch.name, ch.tvg_id, currentUrls);
      let fixedWith: { url: string; source: string; userAgent?: string; referer?: string; origin?: string } | null = null;

      for (const cand of candidates.slice(0, 8)) {
        const res = await checkStreamDeep(cand.url, {
          ...StreamParser.getSourceRequestOptions(cand.url),
          userAgent: cand.userAgent,
          referer: cand.referer,
          origin: cand.origin,
          force: true,
        });
        this.recordCheckResult(cand.url, res, ch.name);
        if (res.status === 'online' && res.segmentOk !== false) {
          fixedWith = cand;
          break;
        }
      }

      if (fixedWith) {
        const rep = await this.replaceChannelUrl({
          channelName: ch.name,
          newUrl: fixedWith.url,
          userAgent: fixedWith.userAgent,
          referer: fixedWith.referer,
          origin: fixedWith.origin,
          unpause: false,
        });
        if (rep.ok) {
          repaired.push({
            name: ch.name,
            oldUrl: ch.primaryUrl,
            newUrl: fixedWith.url,
            source: fixedWith.source,
            playlists: rep.updatedPlaylists || [],
          });
        }
      } else {
        unfixable.push({
          name: ch.name,
          reason: candidates.length === 0 ? 'Нет альтернатив в источниках' : 'Альтернативы не работают',
        });
      }
    }

    this.saveToDisk();
    return {
      ok: true,
      scanned: toFix.length,
      repairedCount: repaired.length,
      unfixableCount: unfixable.length,
      repaired,
      unfixable,
    };
  }

  exportState(): ChannelHealthState {
    this.ensureLoaded();
    this.pruneDiagnostics();
    return {
      urlDiagnostics: this.urlDiagnostics,
      issues: this.issues,
    };
  }

  hydrateState(raw: Partial<ChannelHealthState> | null | undefined): boolean {
    if (!raw || typeof raw !== 'object') return false;
    this.urlDiagnostics =
      raw.urlDiagnostics && typeof raw.urlDiagnostics === 'object' ? raw.urlDiagnostics : {};
    this.issues = raw.issues && typeof raw.issues === 'object' ? raw.issues : {};
    this.loaded = true;
    this.saveToDisk();
    return true;
  }
}

export const channelHealth = new ChannelHealthManager();
