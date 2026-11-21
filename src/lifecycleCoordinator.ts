import { config } from './config.js';
import { withAsyncWriteLock } from './persistence.js';
import { stateLifecycle } from './stateLifecycle.js';
import { storage } from './storage.js';
import { StreamParser, SourceItem } from './streamParser.js';
import { catalogStore, ReconcileResult } from './catalogStore.js';
import { channelHealth } from './channelHealth.js';
import { userAuth } from './userAuth.js';
import { EpgParser, EpgSource } from './epgParser.js';
import { trySaveStreamingSettings, StreamingSettings } from './streamingSettings.js';
import { trySaveUiSettings, UiSettings } from './uiSettings.js';
import { Channel } from './m3uParser.js';

export interface UnifiedOpResult {
  ok: boolean;
  status: number;
  error?: string;
  revision?: number;
  [key: string]: unknown;
}

function lockKey(): string {
  return config.dataDir;
}

export async function createPlaylistUnified(name: string): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const clean = name.replace(/\.m3u$/i, '').trim();
    if (!storage.isValidFilename(clean)) {
      return { ok: false, status: 400, error: 'Некорректное имя плейлиста' };
    }
    if (storage.playlistExists(clean)) {
      return { ok: false, status: 400, error: 'Плейлист уже существует' };
    }
    if (!storage.createPlaylist(clean)) {
      return { ok: false, status: 500, error: storage.getLastError() || 'Не удалось создать плейлист' };
    }
    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return { ok: false, status: 500, error: rec.error || 'Не удалось обновить каталог' };
    }
    const meta = stateLifecycle.bumpRevision('playlist_create', clean);
    return { ok: true, status: 200, playlist: clean, revision: meta.revision };
  });
}

export async function savePlaylistChannelsUnified(
  name: string,
  channels: Partial<Channel>[]
): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const clean = name.replace(/\.m3u$/i, '').trim();
    if (!storage.isValidFilename(clean)) {
      return { ok: false, status: 400, error: 'Некорректное имя плейлиста' };
    }
    if (!storage.saveChannels(clean, channels)) {
      return {
        ok: false,
        status: 500,
        error: storage.getLastError() || 'Не удалось сохранить каналы плейлиста',
      };
    }
    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return {
        ok: false,
        status: 500,
        error: rec.error || 'Плейлист сохранён, но каталог не обновился на диске',
      };
    }
    const healthPrune = channelHealth.pruneOrphanedIssues();
    const meta = stateLifecycle.bumpRevision('playlist_save', clean, {
      channelsCount: channels.length,
      imported: rec.imported,
      removedChannels: rec.removedChannels,
      removedStreams: rec.removedStreams,
      prunedHealthIssues: healthPrune.removed,
    });
    return {
      ok: true,
      status: 200,
      count: channels.length,
      reconcile: rec,
      revision: meta.revision,
    };
  });
}

export async function deletePlaylistUnified(name: string): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const clean = name.replace(/\.m3u$/i, '').trim();
    if (!storage.isValidFilename(clean)) {
      return { ok: false, status: 400, error: 'Некорректное имя плейлиста' };
    }
    if (!storage.playlistExists(clean)) {
      return { ok: false, status: 404, error: 'Плейлист не найден' };
    }

    if (!storage.deletePlaylist(clean)) {
      return {
        ok: false,
        status: 500,
        error: storage.getLastError() || 'Не удалось удалить файл плейлиста',
      };
    }

    const userCleanup = userAuth.removePlaylistReferences(clean);
    if (!userCleanup.ok) {
      return {
        ok: false,
        status: 500,
        error: userCleanup.error || 'Плейлист удалён, но ссылки у пользователей не очищены',
      };
    }

    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return {
        ok: false,
        status: 500,
        error: rec.error || 'Плейлист удалён, но каталог не сохранился на диск',
      };
    }

    const healthPrune = channelHealth.pruneOrphanedIssues();
    const meta = stateLifecycle.bumpRevision('playlist_delete', clean, {
      cleanedUsers: userCleanup.cleanedUsers,
      cleanedInvites: userCleanup.cleanedInvites,
      removedChannels: rec.removedChannels,
      removedStreams: rec.removedStreams,
      prunedHealthIssues: healthPrune.removed,
    });

    return {
      ok: true,
      status: 200,
      deleted: clean,
      cleanedUsers: userCleanup.cleanedUsers,
      cleanedInvites: userCleanup.cleanedInvites,
      updatedUserIds: userCleanup.updatedUserIds,
      updatedInviteIds: userCleanup.updatedInviteIds,
      removedChannels: rec.removedChannels,
      removedStreams: rec.removedStreams,
      revision: meta.revision,
    };
  });
}

export async function restoreBackupUnified(
  filename: string,
  targetPlaylist?: string
): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const res = storage.restoreBackup(filename, targetPlaylist);
    if (!res.ok) {
      return {
        ok: false,
        status: res.status || 400,
        error: res.error || 'Не удалось восстановить резервную копию',
      };
    }
    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return {
        ok: false,
        status: 500,
        error: rec.error || 'Бэкап восстановлен, но не удалось обновить каталог',
      };
    }
    const meta = stateLifecycle.bumpRevision('backup_restore', res.playlist || filename, {
      filename,
      channelsCount: res.channelsCount,
    });
    return {
      ok: true,
      status: 200,
      playlist: res.playlist,
      channelsCount: res.channelsCount,
      revision: meta.revision,
    };
  });
}

export async function deleteBackupUnified(filename: string): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const res = storage.deleteBackup(filename);
    if (!res.ok) {
      if (res.notFound) {
        return { ok: false, status: 404, error: res.error || 'Резервная копия не найдена' };
      }
      const isInvalid = (res.error || '').includes('Некорректное');
      return {
        ok: false,
        status: isInvalid ? 400 : 500,
        error: res.error || 'Не удалось удалить резервную копию',
      };
    }
    const meta = stateLifecycle.bumpRevision('backup_delete', filename);
    return { ok: true, status: 200, deleted: filename, revision: meta.revision };
  });
}

export async function saveAuthoritativeSourcesUnified(sources: SourceItem[]): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    if (!StreamParser.saveSources(sources)) {
      return {
        ok: false,
        status: 500,
        error: StreamParser.getLastError() || 'Не удалось сохранить список источников',
      };
    }
    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return {
        ok: false,
        status: 500,
        error: rec.error || 'Источники сохранены, но каталог не обновился',
      };
    }
    const meta = stateLifecycle.bumpRevision('source_save', 'sources.json', {
      count: StreamParser.getSources().length,
      removedStreams: rec.removedStreams,
      removedChannels: rec.removedChannels,
    });
    return {
      ok: true,
      status: 200,
      sources: StreamParser.getSources(),
      reconcile: rec,
      revision: meta.revision,
    };
  });
}

export async function upsertCatalogSourceUnified(input: {
  id?: number | string;
  name: string;
  type: string;
  url: string;
  enabled: boolean;
  userAgent?: string;
  referer?: string;
  origin?: string;
  timeoutSec?: number;
  ignoreTlsErrors?: boolean;
}): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const res = StreamParser.upsertCatalogSource(input);
    if (!res.ok) {
      return {
        ok: false,
        status: 500,
        error: res.error || 'Не удалось сохранить источник',
      };
    }
    const rec = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return {
        ok: false,
        status: 500,
        error: rec.error || 'Источник сохранён, но каталог не обновился',
      };
    }
    const meta = stateLifecycle.bumpRevision('source_save', res.source?.id || String(res.id || ''), {
      name: input.name,
    });
    return {
      ok: true,
      status: 200,
      id: res.id,
      source: res.source,
      revision: meta.revision,
    };
  });
}

export async function deleteSourceUnified(id: string | number): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const clean = String(id ?? '').trim();
    if (!clean) {
      return { ok: false, status: 400, error: 'Не указан ID источника' };
    }
    const res = catalogStore.deleteSource(id);
    if (!res.deleted) {
      return {
        ok: false,
        status: res.persisted ? 404 : 500,
        error: res.error || 'Источник не найден',
      };
    }
    if (!res.persisted) {
      return {
        ok: false,
        status: 500,
        error: res.error || 'Источник удалён, но каталог не удалось сохранить',
      };
    }
    const meta = stateLifecycle.bumpRevision('source_delete', res.removedSource?.id || clean, {
      catalogId: res.removedSource?.catalogId,
      removedStreams: res.removedStreams,
      removedChannels: res.removedChannels,
    });
    return {
      ok: true,
      status: 200,
      deletedId: res.removedSource?.id,
      catalogId: res.removedSource?.catalogId,
      removedStreams: res.removedStreams,
      removedChannels: res.removedChannels,
      revision: meta.revision,
    };
  });
}

export async function deleteStreamUnified(streamId: number): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    if (!Number.isInteger(streamId) || streamId <= 0) {
      return { ok: false, status: 400, error: 'Некорректный ID потока' };
    }
    const res = catalogStore.deleteStream(streamId);
    if (!res.deleted) {
      return {
        ok: false,
        status: res.persisted ? 404 : 500,
        error: res.error || 'Поток не найден',
      };
    }
    if (!res.persisted) {
      return {
        ok: false,
        status: 500,
        error: res.error || 'Не удалось сохранить удаление потока',
      };
    }
    const meta = stateLifecycle.bumpRevision('stream_delete', String(streamId), {
      removedChannels: res.removedChannels,
    });
    return {
      ok: true,
      status: 200,
      removedChannels: res.removedChannels,
      revision: meta.revision,
    };
  });
}

export async function reconcileCatalogUnified(): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const rec: ReconcileResult = catalogStore.reconcile({ save: true });
    if (!rec.persisted) {
      return { ok: false, status: 500, error: rec.error || 'Ошибка синхронизации каталога' };
    }
    const pruned = channelHealth.pruneOrphanedIssues();
    const meta = stateLifecycle.bumpRevision('reconcile', 'catalog', {
      imported: rec.imported,
      removedChannels: rec.removedChannels,
      removedStreams: rec.removedStreams,
      updatedChannels: rec.updatedChannels,
      prunedHealthIssues: pruned.removed,
    });
    return {
      ok: true,
      status: 200,
      imported: rec.imported,
      removedChannels: rec.removedChannels,
      removedStreams: rec.removedStreams,
      updatedChannels: rec.updatedChannels,
      persisted: rec.persisted,
      prunedHealthIssues: pruned.removed,
      revision: meta.revision,
    };
  });
}

export async function hydrateStateUnified(body: {
  revision?: number | null;
  force?: boolean;
  playlists?: Record<string, Partial<Channel>[]>;
  replacePlaylists?: boolean;
  sources?: SourceItem[];
  sourceIndex?: Record<string, { items?: Array<{ name: string; url: string; logo: string; group: string; tvg_id: string; userAgent?: string; referer?: string; origin?: string }>; updatedAt?: number }>;
  epgSources?: EpgSource[];
  streamingSettings?: Partial<StreamingSettings>;
  uiSettings?: Partial<UiSettings>;
  channelHealth?: { urlDiagnostics?: Record<string, never>; issues?: Record<string, never> };
  catalog?: {
    nextChannelId?: number;
    nextStreamId?: number;
    nextSourceId?: number;
    channels?: never[];
    streams?: never[];
    sources?: never[];
  };
  users?: Array<{
    id: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    password_hash?: string;
    created_at?: number;
  }>;
}): Promise<UnifiedOpResult> {
  return withAsyncWriteLock(lockKey(), async () => {
    const currentMeta = stateLifecycle.getStateMeta();
    const incomingRevision =
      body.revision !== undefined && body.revision !== null && Number.isFinite(Number(body.revision))
        ? Math.max(0, Math.floor(Number(body.revision)))
        : null;
    const force = Boolean(body.force);

    // DEF-04: Reject stale cloud snapshots from overwriting newer local mutations
    if (!force && currentMeta.revision > 0) {
      if (incomingRevision === null || incomingRevision < currentMeta.revision) {
        return {
          ok: false,
          status: 409,
          stale: true,
          localRevision: currentMeta.revision,
          incomingRevision,
          error: `Отклонён устаревший снимок из облака (облако rev=${incomingRevision ?? 0}, сервер rev=${currentMeta.revision})`,
        };
      }
    }

    // 1. Playlists: default full replacement (replacePlaylists !== false)
    let playlistsHydrated = 0;
    let playlistsRemoved = 0;
    const replacePlaylists = body.replacePlaylists !== false;
    if (body.playlists && typeof body.playlists === 'object') {
      const incomingSet = new Set<string>();
      for (const [rawName, list] of Object.entries(body.playlists)) {
        const clean = rawName.replace(/\.m3u$/i, '').trim();
        if (!storage.isValidFilename(clean) || !Array.isArray(list)) continue;
        incomingSet.add(clean);
      }

      if (replacePlaylists) {
        for (const existingPl of storage.getPlaylists()) {
          if (!incomingSet.has(existingPl)) {
            if (!storage.deletePlaylist(existingPl, { skipBackup: true })) {
              return {
                ok: false,
                status: 500,
                error: storage.getLastError() || `Не удалось удалить устаревший плейлист ${existingPl}`,
              };
            }
            playlistsRemoved++;
          }
        }
      }

      for (const [rawName, list] of Object.entries(body.playlists)) {
        const clean = rawName.replace(/\.m3u$/i, '').trim();
        if (!storage.isValidFilename(clean) || !Array.isArray(list)) continue;
        if (!storage.saveChannels(clean, list, { skipBackup: true })) {
          return {
            ok: false,
            status: 500,
            error: storage.getLastError() || `Не удалось восстановить плейлист ${clean}`,
          };
        }
        playlistsHydrated++;
      }
    }

    // 2. Authoritative Sources (StreamParser)
    let sourcesHydrated = false;
    if (Array.isArray(body.sources)) {
      if (!StreamParser.saveSources(body.sources)) {
        return {
          ok: false,
          status: 500,
          error: StreamParser.getLastError() || 'Не удалось восстановить sources.json',
        };
      }
      sourcesHydrated = true;
    }

    // 3. Source Index cache
    let indexesHydrated = 0;
    let indexesPruned = 0;
    if (body.sourceIndex && typeof body.sourceIndex === 'object') {
      const idxRes = StreamParser.hydrateIndexData(body.sourceIndex, { replaceAll: true });
      if (!idxRes.ok) {
        return {
          ok: false,
          status: 500,
          error: idxRes.error || 'Не удалось восстановить кеш индексов источников',
        };
      }
      indexesHydrated = idxRes.count;
      indexesPruned = idxRes.pruned;
    } else if (sourcesHydrated) {
      indexesPruned = StreamParser.pruneOrphanedIndexes();
    }

    // 4. EPG Sources
    let epgHydrated = false;
    if (Array.isArray(body.epgSources)) {
      if (!EpgParser.saveSources(body.epgSources)) {
        return {
          ok: false,
          status: 500,
          error: EpgParser.getLastError() || 'Не удалось восстановить epg_sources.json',
        };
      }
      epgHydrated = true;
    }

    // 5. Streaming Settings
    let streamingHydrated = false;
    if (body.streamingSettings && typeof body.streamingSettings === 'object') {
      const sRes = trySaveStreamingSettings(body.streamingSettings);
      if (!sRes.ok) {
        return {
          ok: false,
          status: 500,
          error: sRes.error || 'Не удалось восстановить streaming_settings.json',
        };
      }
      streamingHydrated = true;
    }

    // 5b. UI Settings
    if (body.uiSettings && typeof body.uiSettings === 'object') {
      const uiRes = trySaveUiSettings(body.uiSettings);
      if (!uiRes.ok) {
        return {
          ok: false,
          status: 500,
          error: uiRes.error || 'Не удалось восстановить ui_settings.json',
        };
      }
    }

    // 6. Channel Health State
    let healthHydrated = false;
    if (body.channelHealth && typeof body.channelHealth === 'object') {
      const hRes = channelHealth.hydrateState(body.channelHealth);
      if (!hRes.ok) {
        return {
          ok: false,
          status: 500,
          error: hRes.error || 'Не удалось восстановить channel_health.json',
        };
      }
      healthHydrated = true;
    }

    // 7. Catalog & Full Reconciliation
    let catalogHydrated = false;
    let reconcileSummary: ReconcileResult;
    if (body.catalog && typeof body.catalog === 'object') {
      const cRes = catalogStore.hydrateRawState(body.catalog);
      if (!cRes.ok) {
        return {
          ok: false,
          status: 500,
          error: cRes.error || 'Не удалось восстановить catalog.json',
        };
      }
      catalogHydrated = true;
      reconcileSummary = cRes.reconcile!;
    } else {
      reconcileSummary = catalogStore.reconcile({ save: true });
      if (!reconcileSummary.persisted) {
        return {
          ok: false,
          status: 500,
          error: reconcileSummary.error || 'Не удалось синхронизировать каталог после восстановления',
        };
      }
    }

    // 8. Users + prune dangling playlists
    let usersHydrated = 0;
    if (Array.isArray(body.users)) {
      for (const u of body.users) {
        if (!u || typeof u.id !== 'string' || !u.login) continue;
        userAuth.upsertSyncedUserWithHash({
          id: u.id,
          login: u.login,
          name: u.name || u.login,
          playlists: Array.isArray(u.playlists) ? u.playlists : [],
          enabled: Boolean(u.enabled),
          password_hash: typeof u.password_hash === 'string' ? u.password_hash : undefined,
          created_at: typeof u.created_at === 'number' ? u.created_at : undefined,
        });
        const uErr = userAuth.getLastError();
        if (uErr) {
          return {
            ok: false,
            status: 500,
            error: uErr,
          };
        }
        usersHydrated++;
      }
    }
    const userPrune = userAuth.pruneInvalidPlaylists(storage.getPlaylists());
    if (!userPrune.ok) {
      return {
        ok: false,
        status: 500,
        error: userPrune.error || 'Не удалось очистить устаревшие плейлисты у пользователей',
      };
    }

    const healthPrune = channelHealth.pruneOrphanedIssues();

    // 9. Advance revision
    const targetRev = incomingRevision !== null ? Math.max(currentMeta.revision, incomingRevision) : Math.max(1, currentMeta.revision);
    const meta = stateLifecycle.setRevisionAtLeast(targetRev, 'cloud_hydrate', 'cloud_snapshot', {
      playlistsHydrated,
      playlistsRemoved,
      sourcesHydrated,
      indexesHydrated,
      indexesPruned,
      reconcileRemovedChannels: reconcileSummary.removedChannels,
      reconcileRemovedStreams: reconcileSummary.removedStreams,
      prunedUsers: userPrune.cleanedUsers,
      prunedInvites: userPrune.cleanedInvites,
      prunedHealthIssues: healthPrune.removed,
    });

    return {
      ok: true,
      status: 200,
      revision: meta.revision,
      playlistsHydrated,
      playlistsRemoved,
      sourcesHydrated,
      indexesHydrated,
      indexesPruned,
      epgHydrated,
      catalogHydrated,
      reconcile: reconcileSummary,
      streamingHydrated,
      healthHydrated,
      usersHydrated,
    };
  });
}
