import path from 'node:path';
import bcrypt from 'bcryptjs';

export interface AppConfig {
  port: number;
  adminEmail: string;
  adminPasswordHash: string;
  playlistDir: string;
  backupDir: string;
  dataDir: string;
  cacheDir: string;
  maxBackups: number;
  sessionSecret: string;
  apkUploadToken: string;
  githubToken: string;
  githubRepo: string;
  githubBranch: string;
}

const rootDir = process.cwd();

export const config: AppConfig = {
  port: Number(process.env.PORT) || 3000,
  adminEmail: process.env.ADMIN_EMAIL || 'alex.pikman@gmail.com',
  adminPasswordHash:
    process.env.ADMIN_PASSWORD_HASH ||
    '$2y$10$TDmW671RynDZatLsElwrI.f3Rp6HjPQ5rPG6wsE9FgVwvecjGzKqe',
  playlistDir: path.resolve(rootDir, process.env.PLAYLIST_DIR || './playlist'),
  backupDir: path.resolve(rootDir, process.env.BACKUP_DIR || './data/backups/playlist'),
  dataDir: path.resolve(rootDir, './data'),
  cacheDir: path.resolve(rootDir, './data/cache'),
  maxBackups: 20,
  sessionSecret: process.env.SESSION_SECRET || 'pqtv_session_secret_2026',
  apkUploadToken: process.env.APK_UPLOAD_TOKEN || 'pqtv_upload_2026_secret_change_me',
  githubToken: process.env.GITHUB_TOKEN || '',
  githubRepo: process.env.GITHUB_REPO || '',
  githubBranch: process.env.GITHUB_BRANCH || 'main',
};

export function verifyPassword(password: string, hash: string): boolean {
  if (!password || !hash) return false;
  try {
    const normalized = hash.replace(/^\$2y\$/, '$2a$');
    return bcrypt.compareSync(password, normalized);
  } catch {
    return false;
  }
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}
