import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { atomicWriteJsonSync, hasJsonStateSync, readJsonSync } from './persistence.js';

export type LifecycleAction =
  | 'playlist_create'
  | 'playlist_update'
  | 'playlist_save'
  | 'category_bulk_update'
  | 'playlist_delete'
  | 'backup_restore'
  | 'backup_delete'
  | 'source_save'
  | 'source_delete'
  | 'stream_delete'
  | 'channel_delete'
  | 'reconcile'
  | 'cloud_hydrate'
  | 'users_update'
  | 'health_update'
  | 'apk_update';

export interface StateMeta {
  revision: number;
  updatedAt: number;
  instanceId: string;
  lastAction?: LifecycleAction;
  lastTarget?: string;
}

export interface LifecycleLogEntry {
  id: string;
  ts: number;
  revision: number;
  action: LifecycleAction;
  target: string;
  details?: Record<string, unknown>;
}

const MAX_LOG_ENTRIES = 300;

class StateLifecycleManager {
  private metaCache: StateMeta | null = null;
  private lastError = '';

  private getMetaPath(): string {
    return path.join(config.dataDir, 'state_meta.json');
  }

  private getLogPath(): string {
    return path.join(config.dataDir, 'lifecycle_log.json');
  }

  getLastError(): string {
    return this.lastError;
  }

  resetCache(): void {
    this.metaCache = null;
    this.lastError = '';
  }

  getStateMeta(): StateMeta {
    if (this.metaCache) return { ...this.metaCache };
    const file = this.getMetaPath();
    if (hasJsonStateSync(file)) {
      try {
        const raw = readJsonSync<Partial<StateMeta>>(file, {});
        const meta: StateMeta = {
          revision: Math.max(0, Math.floor(Number(raw.revision) || 0)),
          updatedAt: Number(raw.updatedAt) || 0,
          instanceId:
            typeof raw.instanceId === 'string' && raw.instanceId
              ? raw.instanceId
              : crypto.randomBytes(6).toString('hex'),
          lastAction: raw.lastAction,
          lastTarget: raw.lastTarget,
        };
        this.metaCache = meta;
        return { ...meta };
      } catch {
        // fallback to default meta
      }
    }
    const fresh: StateMeta = {
      revision: 0,
      updatedAt: 0,
      instanceId: crypto.randomBytes(6).toString('hex'),
    };
    this.metaCache = fresh;
    return { ...fresh };
  }

  private saveStateMeta(meta: StateMeta): boolean {
    const res = atomicWriteJsonSync(this.getMetaPath(), meta, 2);
    if (!res.ok) {
      this.lastError = res.error || 'Не удалось сохранить state_meta.json';
      return false;
    }
    this.metaCache = { ...meta };
    return true;
  }

  bumpRevision(
    action: LifecycleAction,
    target: string,
    details?: Record<string, unknown>
  ): StateMeta {
    const current = this.getStateMeta();
    const next: StateMeta = {
      revision: current.revision + 1,
      updatedAt: Date.now(),
      instanceId: current.instanceId,
      lastAction: action,
      lastTarget: target,
    };
    this.lastError = '';
    this.saveStateMeta(next);
    this.appendLog({
      revision: next.revision,
      action,
      target,
      details,
    });
    return next;
  }

  setRevisionAtLeast(
    targetRevision: number,
    action: LifecycleAction,
    target: string,
    details?: Record<string, unknown>
  ): StateMeta {
    const current = this.getStateMeta();
    const cleanTargetRev = Math.max(0, Math.floor(Number(targetRevision) || 0));
    const nextRev = Math.max(current.revision, cleanTargetRev);
    const next: StateMeta = {
      revision: nextRev,
      updatedAt: Date.now(),
      instanceId: current.instanceId,
      lastAction: action,
      lastTarget: target,
    };
    this.lastError = '';
    this.saveStateMeta(next);
    this.appendLog({
      revision: next.revision,
      action,
      target,
      details,
    });
    return next;
  }

  getLogs(limit = 100): LifecycleLogEntry[] {
    const file = this.getLogPath();
    if (!hasJsonStateSync(file)) return [];
    try {
      const parsed = readJsonSync<unknown>(file, null);
      if (!Array.isArray(parsed)) return [];
      const max = Math.max(1, Math.min(MAX_LOG_ENTRIES, Number(limit) || 100));
      return (parsed as LifecycleLogEntry[]).slice(0, max);
    } catch {
      return [];
    }
  }

  appendLog(entry: Omit<LifecycleLogEntry, 'id' | 'ts'>): boolean {
    const existing = this.getLogs(MAX_LOG_ENTRIES);
    const record: LifecycleLogEntry = {
      id: `op_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
      ts: Date.now(),
      revision: entry.revision,
      action: entry.action,
      target: entry.target,
      details: entry.details,
    };
    const next = [record, ...existing].slice(0, MAX_LOG_ENTRIES);
    const res = atomicWriteJsonSync(this.getLogPath(), next, 2);
    if (!res.ok) {
      this.lastError = res.error || 'Не удалось записать журнал операций';
      return false;
    }
    return true;
  }
}

export const stateLifecycle = new StateLifecycleManager();
