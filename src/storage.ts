import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Channel, generateM3u } from './m3uParser.js';

export class Storage {
  private playlistDir: string;
  private backupDir: string;
  private maxBackups: number;

  constructor() {
    this.playlistDir = config.playlistDir;
    this.backupDir = config.backupDir;
    this.maxBackups = config.maxBackups;
  }

  isValidFilename(name: string): boolean {
    return /^[a-zA-Z0-9_-]{1,64}$/.test(name);
  }

  getPlaylistPath(name: string): string {
    return path.join(this.playlistDir, `${name}.m3u`);
  }

  getPlaylists(): string[] {
    if (!fs.existsSync(this.playlistDir)) return [];
    return fs
      .readdirSync(this.playlistDir)
      .filter((f) => f.endsWith('.m3u'))
      .map((f) => path.basename(f, '.m3u'))
      .sort();
  }

  createPlaylist(name: string): boolean {
    if (!this.isValidFilename(name)) return false;
    if (!fs.existsSync(this.playlistDir)) {
      fs.mkdirSync(this.playlistDir, { recursive: true });
    }
    const filePath = this.getPlaylistPath(name);
    if (fs.existsSync(filePath)) return false;
    try {
      fs.writeFileSync(filePath, '#EXTM3U\n', 'utf-8');
      return true;
    } catch {
      return false;
    }
  }

  deletePlaylist(name: string): boolean {
    if (!this.isValidFilename(name)) return false;
    const filePath = this.getPlaylistPath(name);
    if (!fs.existsSync(filePath)) return false;
    this.makeBackup(name);
    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  saveChannels(name: string, channels: Partial<Channel>[]): boolean {
    if (!this.isValidFilename(name)) return false;
    if (!fs.existsSync(this.playlistDir)) {
      fs.mkdirSync(this.playlistDir, { recursive: true });
    }
    const filePath = this.getPlaylistPath(name);
    if (fs.existsSync(filePath)) {
      this.makeBackup(name);
    }
    const content = generateM3u(channels);
    const tmpPath = `${filePath}.tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    try {
      fs.writeFileSync(tmpPath, content, 'utf-8');
      fs.renameSync(tmpPath, filePath);
      return true;
    } catch {
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      return false;
    }
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
      const dest = path.join(this.backupDir, `${name}.m3u.${stamp}.bak`);
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
    } catch {
      // ignore backup failure
    }
  }
}

export const storage = new Storage();
