import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, hashPassword, verifyPassword } from './config.js';

export interface UserRecord {
  id: string;
  login: string;
  password_hash: string;
  name: string;
  playlists: string[];
  enabled: boolean;
  created_at: number;
}

export interface UserSessionInfo {
  last_ping: number;
  started: number;
  ip: string;
  ua: string;
}

export class UserAuth {
  private usersFile: string;
  private sessionsFile: string;

  constructor() {
    this.usersFile = path.join(config.dataDir, 'users.json');
    this.sessionsFile = path.join(config.dataDir, 'user_sessions.json');
  }

  all(): UserRecord[] {
    if (!fs.existsSync(this.usersFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.usersFile, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  saveAll(users: UserRecord[]): boolean {
    try {
      fs.mkdirSync(path.dirname(this.usersFile), { recursive: true });
      const tmp = `${this.usersFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(users, null, 4), 'utf-8');
      fs.renameSync(tmp, this.usersFile);
      return true;
    } catch {
      return false;
    }
  }

  find(id: string): UserRecord | null {
    return this.all().find((u) => u.id === id) || null;
  }

  findByLogin(login: string): UserRecord | null {
    const lc = login.trim().toLowerCase();
    return this.all().find((u) => (u.login || '').toLowerCase() === lc) || null;
  }

  create(
    login: string,
    password: string,
    name: string,
    playlists: string[]
  ): { ok: boolean; error?: string; user?: UserRecord } {
    const cleanLogin = login.trim();
    if (cleanLogin === '' || password.length < 4) {
      return { ok: false, error: 'Логин обязателен, пароль минимум 4 символа' };
    }
    if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(cleanLogin)) {
      return { ok: false, error: 'Логин: 3–32 символа, латиница, цифры, _ - .' };
    }
    if (this.findByLogin(cleanLogin)) {
      return { ok: false, error: 'Пользователь с таким логином уже есть' };
    }

    const users = this.all();
    const user: UserRecord = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      login: cleanLogin,
      password_hash: hashPassword(password),
      name: name.trim() !== '' ? name.trim() : cleanLogin,
      playlists: playlists.filter((p) => typeof p === 'string'),
      enabled: true,
      created_at: Math.floor(Date.now() / 1000),
    };
    users.push(user);
    if (!this.saveAll(users)) {
      return { ok: false, error: 'Ошибка сохранения' };
    }
    return { ok: true, user };
  }

  update(
    id: string,
    patch: { name?: string; playlists?: string[]; enabled?: boolean; password?: string }
  ): { ok: boolean; error?: string } {
    const users = this.all();
    const idx = users.findIndex((u) => u.id === id);
    if (idx === -1) {
      return { ok: false, error: 'Пользователь не найден' };
    }
    const u = users[idx];
    if (patch.name !== undefined) u.name = patch.name.trim();
    if (Array.isArray(patch.playlists)) {
      u.playlists = patch.playlists.filter((p) => typeof p === 'string');
    }
    if (patch.enabled !== undefined) u.enabled = Boolean(patch.enabled);
    if (patch.password) {
      if (patch.password.length < 4) {
        return { ok: false, error: 'Пароль минимум 4 символа' };
      }
      u.password_hash = hashPassword(patch.password);
    }

    if (!this.saveAll(users)) {
      return { ok: false, error: 'Ошибка сохранения' };
    }
    return { ok: true };
  }

  delete(id: string): boolean {
    const users = this.all();
    const filtered = users.filter((u) => u.id !== id);
    if (filtered.length === users.length) return false;
    return this.saveAll(filtered);
  }

  upsertSyncedUser(input: {
    id: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
  }): UserRecord {
    const users = this.all();
    const idx = users.findIndex((u) => u.id === input.id);
    const cleanPlaylists = Array.isArray(input.playlists)
      ? input.playlists.filter((p) => typeof p === 'string')
      : [];
    if (idx >= 0) {
      users[idx].login = input.login || users[idx].login;
      users[idx].name = input.name || users[idx].name;
      users[idx].playlists = cleanPlaylists;
      users[idx].enabled = Boolean(input.enabled);
      this.saveAll(users);
      return users[idx];
    }
    const created: UserRecord = {
      id: input.id,
      login: input.login,
      password_hash: '',
      name: input.name || input.login,
      playlists: cleanPlaylists,
      enabled: Boolean(input.enabled),
      created_at: Math.floor(Date.now() / 1000),
    };
    users.push(created);
    this.saveAll(users);
    return created;
  }

  authenticate(login: string, password: string): UserRecord | null {
    const u = this.findByLogin(login);
    if (!u || !u.enabled) return null;
    if (!u.password_hash) return null;
    if (!verifyPassword(password, u.password_hash)) return null;
    return u;
  }

  touchSession(userId: string, ip: string, ua: string): void {
    try {
      fs.mkdirSync(path.dirname(this.sessionsFile), { recursive: true });
      const data = this.getSessions();
      const now = Math.floor(Date.now() / 1000);
      const existing = data[userId];
      data[userId] = {
        last_ping: now,
        started: existing?.started || now,
        ip: ip || '',
        ua: (ua || '').slice(0, 120),
      };
      const cutoff = now - 7 * 86400;
      for (const k of Object.keys(data)) {
        if ((data[k]?.last_ping || 0) < cutoff) {
          delete data[k];
        }
      }
      fs.writeFileSync(this.sessionsFile, JSON.stringify(data), 'utf-8');
    } catch {
      // ignore
    }
  }

  getSessions(): Record<string, UserSessionInfo> {
    if (!fs.existsSync(this.sessionsFile)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sessionsFile, 'utf-8'));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch {
      return {};
    }
  }
}

export const userAuth = new UserAuth();
