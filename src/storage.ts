import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Channel, generateM3u, parseM3uContent } from './m3uParser.js';
import { atomicWriteFileSync, safeUnlinkSync } from './persistence.js';

export interface PlaylistBackupInfo {
  filename: string;
  playlistName: string;
  createdAt: number;
  size: number;
  channelsCount: number;
}

export class Storage {
  private lastError = '';

  private get playlistDir(): string {
    return config.playlistDir;
  }

  private get backupDir(): string {
    return config.backupDir;
  }

  private get maxBackups(): number {
    return config.maxBackups;
  }

  getLastError(): string {
    return this.lastError;
  }

  isValidFilename(name: string): boolean {
    return /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/.test(name) && !name.includes('..');
  }

  isValidBackupFilename(filename: string): boolean {
    return (
      /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*\.m3u\.[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{6}(?:_[a-zA-Z0-9]+)?\.bak$/.test(
        filename
      ) && !filename.includes('..') && !filename.includes('/') && !filename.includes('\\')
    );
  }

  getPlaylistPath(name: string): string {
    return path.join(this.playlistDir, `${name}.m3u`);
  }

  playlistExists(name: string): boolean {
    if (!this.isValidFilename(name)) return false;
    return fs.existsSync(this.getPlaylistPath(name));
  }

  getPlaylists(): string[] {
    if (!fs.existsSync(this.playlistDir)) return [];
    return fs
      .readdirSync(this.playlistDir)
      .filter((f) => f.endsWith('.m3u'))
      .map((f) => path.basename(f, '.m3u'))
      .sort();
  }

  getChannels(name: string): Channel[] {
    if (!this.isValidFilename(name)) return [];
    const filePath = this.getPlaylistPath(name);
    if (!fs.existsSync(filePath)) return [];
    try {
      return parseM3uContent(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return [];
    }
  }

  createPlaylist(name: string): boolean {
    this.lastError = '';
    if (!this.isValidFilename(name)) {
      this.lastError = 'Некорректное имя плейлиста';
      return false;
    }
    const filePath = this.getPlaylistPath(name);
    if (fs.existsSync(filePath)) {
      this.lastError = 'Плейлист уже существует';
      return false;
    }
    const res = atomicWriteFileSync(filePath, '#EXTM3U\n');
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка создания файла плейлиста';
      return false;
    }
    return true;
  }

  deletePlaylist(name: string, opts?: { skipBackup?: boolean }): boolean {
    this.lastError = '';
    if (!this.isValidFilename(name)) {
      this.lastError = 'Некорректное имя плейлиста';
      return false;
    }
    const filePath = this.getPlaylistPath(name);
    if (!fs.existsSync(filePath)) {
      this.lastError = 'Плейлист не найден';
      return false;
    }
    if (!opts?.skipBackup) {
      this.makeBackup(name);
    }
    const res = safeUnlinkSync(filePath);
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка удаления файла плейлиста';
      return false;
    }
    return true;
  }

  saveChannels(
    name: string,
    channels: Partial<Channel>[],
    opts?: { skipBackup?: boolean }
  ): boolean {
    this.lastError = '';
    if (!this.isValidFilename(name)) {
      this.lastError = 'Некорректное имя плейлиста';
      return false;
    }
    const filePath = this.getPlaylistPath(name);
    if (fs.existsSync(filePath) && !opts?.skipBackup) {
      this.makeBackup(name);
    }
    const content = generateM3u(channels);
    const res = atomicWriteFileSync(filePath, content);
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка сохранения плейлиста';
      return false;
    }
    return true;
  }

  listBackups(playlistName?: string): PlaylistBackupInfo[] {
    if (!fs.existsSync(this.backupDir)) return [];
    const cleanFilter = playlistName ? playlistName.replace(/\.m3u$/i, '').trim() : '';
    const entries = fs
      .readdirSync(this.backupDir)
      .filter((f) => f.endsWith('.bak') && f.includes('.m3u.'));

    const out: PlaylistBackupInfo[] = [];
    for (const filename of entries) {
      const m3uIdx = filename.indexOf('.m3u.');
      if (m3uIdx <= 0) continue;
      const plName = filename.slice(0, m3uIdx);
      if (cleanFilter && plName !== cleanFilter) continue;
      const fullPath = path.join(this.backupDir, filename);
      try {
        const st = fs.statSync(fullPath);
        if (!st.isFile()) continue;
        let channelsCount = 0;
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          channelsCount = parseM3uContent(content).length;
        } catch {
          channelsCount = 0;
        }
        out.push({
          filename,
          playlistName: plName,
          createdAt: Math.floor(st.mtimeMs),
          size: st.size,
          channelsCount,
        });
      } catch {
        // ignore unreadable stat
      }
    }

    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  restoreBackup(
    filename: string,
    targetPlaylistName?: string
  ): { ok: boolean; status?: number; playlist?: string; channelsCount?: number; error?: string } {
    this.lastError = '';
    const cleanFile = path.basename(String(filename || '').trim());
    if (!cleanFile || !this.isValidBackupFilename(cleanFile)) {
      return { ok: false, status: 400, error: 'Некорректное имя файла резервной копии' };
    }
    const fullPath = path.join(this.backupDir, cleanFile);
    if (!fs.existsSync(fullPath)) {
      return { ok: false, status: 404, error: 'Резервная копия не найдена' };
    }
    const m3uIdx = cleanFile.indexOf('.m3u.');
    const derivedName = m3uIdx > 0 ? cleanFile.slice(0, m3uIdx) : '';
    const destName = (targetPlaylistName || derivedName).replace(/\.m3u$/i, '').trim();
    if (!this.isValidFilename(destName)) {
      return { ok: false, status: 400, error: 'Некорректное имя целевого плейлиста' };
    }
    try {
      const content = fs.readFileSync(fullPath, 'utf-8');
      const channels = parseM3uContent(content);
      if (!this.saveChannels(destName, channels)) {
        return {
          ok: false,
          status: 500,
          error: this.lastError || 'Не удалось восстановить плейлист на диск',
        };
      }
      return { ok: true, playlist: destName, channelsCount: channels.length };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      return { ok: false, status: 500, error: msg };
    }
  }

  deleteBackup(filename: string): { ok: boolean; notFound?: boolean; error?: string } {
    this.lastError = '';
    const cleanFile = path.basename(String(filename || '').trim());
    if (!cleanFile || !this.isValidBackupFilename(cleanFile)) {
      return { ok: false, error: 'Некорректное имя файла резервной копии' };
    }
    const fullPath = path.join(this.backupDir, cleanFile);
    if (!fs.existsSync(fullPath)) {
      return { ok: false, notFound: true, error: 'Резервная копия не найдена' };
    }
    const res = safeUnlinkSync(fullPath);
    if (!res.ok) {
      this.lastError = res.error || 'Не удалось удалить резервную копию';
      return { ok: false, error: this.lastError };
    }
    return { ok: true };
  }

  private makeBackup(name: string): void {
    const source = this.getPlaylistPath(name);
    if (!fs.existsSync(source)) return;
    try {
      if (!fs.existsSync(this.backupDir)) {
        fs.mkdirSync(this.backupDir, { recursive: true });
      }
      const now = new Date();
      const pad = (n: number) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
      let dest = path.join(this.backupDir, `${name}.m3u.${stamp}.bak`);
      if (fs.existsSync(dest)) {
        dest = path.join(
          this.backupDir,
          `${name}.m3u.${stamp}_${Math.random().toString(36).slice(2, 6)}.bak`
        );
      }
      fs.copyFileSync(source, dest);

      const prefix = `${name}.m3u.`;
      const backups = fs
        .readdirSync(this.backupDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith('.bak'))
        .map((f) => ({
          fullPath: path.join(this.backupDir, f),
          mtime: fs.statSync(path.join(this.backupDir, f)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime);

      if (backups.length > this.maxBackups) {
        for (const old of backups.slice(this.maxBackups)) {
          try {
            fs.unlinkSync(old.fullPath);
          } catch {
            // ignore
          }
        }
      }
    } catch (err) {
      console.error(`[storage] Backup creation failed for ${name}:`, err);
    }
  }
}

export const storage = new Storage();
