import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface WriteResult {
  ok: boolean;
  error?: string;
  filePath: string;
}

const asyncQueues = new Map<string, Promise<unknown>>();
let lastWriteError = '';

export function getLastPersistenceError(): string {
  return lastWriteError;
}

export function clearLastPersistenceError(): void {
  lastWriteError = '';
}

export function uniqueTempPath(targetPath: string): string {
  const rand = crypto.randomBytes(6).toString('hex');
  return `${targetPath}.tmp.${process.pid}.${Date.now()}.${rand}`;
}

/**
 * Serializes async operations targeting the same logical lock key (e.g. resolved file path or domain).
 */
export function withAsyncWriteLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const normalizedKey = path.resolve(key);
  const prev = asyncQueues.get(normalizedKey) || Promise.resolve();
  const next = prev.then(
    () => fn(),
    () => fn()
  );
  const cleanup = next.finally(() => {
    if (asyncQueues.get(normalizedKey) === cleanup) {
      asyncQueues.delete(normalizedKey);
    }
  });
  asyncQueues.set(normalizedKey, cleanup);
  return next;
}

export function atomicWriteFileSync(targetPath: string, content: string | Buffer): WriteResult {
  const absTarget = path.resolve(targetPath);
  const tmpPath = uniqueTempPath(absTarget);
  try {
    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    if (typeof content === 'string') {
      fs.writeFileSync(tmpPath, content, 'utf-8');
    } else {
      fs.writeFileSync(tmpPath, content);
    }
    fs.renameSync(tmpPath, absTarget);
    return { ok: true, filePath: absTarget };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `Write failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    try {
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
    } catch {
      // ignore temp cleanup failure
    }
    return { ok: false, error: msg, filePath: absTarget };
  }
}

export function atomicWriteJsonSync(
  targetPath: string,
  data: unknown,
  indent?: number
): WriteResult {
  try {
    const serialized =
      indent !== undefined ? JSON.stringify(data, null, indent) : JSON.stringify(data);
    return atomicWriteFileSync(targetPath, serialized);
  } catch (err) {
    const absTarget = path.resolve(targetPath);
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `JSON serialization failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    return { ok: false, error: msg, filePath: absTarget };
  }
}

export function safeUnlinkSync(targetPath: string): { ok: boolean; existed: boolean; error?: string } {
  const absTarget = path.resolve(targetPath);
  if (!fs.existsSync(absTarget)) {
    return { ok: true, existed: false };
  }
  try {
    fs.unlinkSync(absTarget);
    return { ok: true, existed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastWriteError = `Delete failed for ${absTarget}: ${msg}`;
    console.error(`[persistence] ${lastWriteError}`);
    return { ok: false, existed: true, error: msg };
  }
}
