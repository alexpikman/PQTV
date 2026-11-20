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

export interface InviteRecord {
  id: string; // sha256 hex of lowercase email
  email: string;
  name: string;
  playlists: string[];
  enabled: boolean;
  claimed_uid: string;
  created_at: number;
  updated_at: number;
}

export interface ChannelAlertIssue {
  name: string;
  group: string;
  reason: string;
}

export interface ChannelAlertRecord {
  id: string; // userId
  userId: string;
  userLogin: string;
  userName: string;
  totalChannels: number;
  unavailableCount: number;
  items: ChannelAlertIssue[];
  resolved: boolean;
  created_at: number;
  updated_at: number;
}

export function hashEmailId(email: string): string {
  return crypto
    .createHash('sha256')
    .update(email.trim().toLowerCase())
    .digest('hex');
}

export class UserAuth {
  private usersFile: string;
  private sessionsFile: string;
  private invitesFile: string;
  private alertsFile: string;

  constructor() {
    this.usersFile = path.join(config.dataDir, 'users.json');
    this.sessionsFile = path.join(config.dataDir, 'user_sessions.json');
    this.invitesFile = path.join(config.dataDir, 'invites.json');
    this.alertsFile = path.join(config.dataDir, 'channel_alerts.json');
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
    playlists: string[],
    enabled = true
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
      enabled: Boolean(enabled),
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

  upsertSyncedUserWithHash(input: {
    id: string;
    login: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    password_hash?: string;
    created_at?: number;
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
      if (input.password_hash) {
        users[idx].password_hash = input.password_hash;
      }
      this.saveAll(users);
      return users[idx];
    }
    const created: UserRecord = {
      id: input.id,
      login: input.login,
      password_hash: input.password_hash || '',
      name: input.name || input.login,
      playlists: cleanPlaylists,
      enabled: Boolean(input.enabled),
      created_at: input.created_at || Math.floor(Date.now() / 1000),
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

  // ===== GOOGLE EMAIL INVITES =====
  allInvites(): InviteRecord[] {
    if (!fs.existsSync(this.invitesFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.invitesFile, 'utf-8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  private saveAllInvites(invites: InviteRecord[]): boolean {
    try {
      fs.mkdirSync(path.dirname(this.invitesFile), { recursive: true });
      const tmp = `${this.invitesFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(invites, null, 2), 'utf-8');
      fs.renameSync(tmp, this.invitesFile);
      return true;
    } catch {
      return false;
    }
  }

  findInviteByEmail(email: string): InviteRecord | null {
    const clean = email.trim().toLowerCase();
    if (!clean) return null;
    const id = hashEmailId(clean);
    return (
      this.allInvites().find((inv) => inv.id === id || inv.email.toLowerCase() === clean) || null
    );
  }

  saveInvite(input: {
    email: string;
    name: string;
    playlists: string[];
    enabled: boolean;
    claimed_uid?: string;
  }): { ok: boolean; error?: string; invite?: InviteRecord } {
    const email = input.email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 160) {
      return { ok: false, error: 'Введите корректный Google Email' };
    }
    const id = hashEmailId(email);
    const now = Math.floor(Date.now() / 1000);
    const cleanName = (input.name.trim() || email.split('@')[0] || 'Пользователь').slice(0, 80);
    const cleanPlaylists = Array.isArray(input.playlists)
      ? input.playlists.filter((p) => typeof p === 'string' && p.trim().length > 0).slice(0, 20)
      : [];

    const invites = this.allInvites();
    const idx = invites.findIndex((i) => i.id === id || i.email.toLowerCase() === email);
    let saved: InviteRecord;
    if (idx >= 0) {
      invites[idx].email = email;
      invites[idx].name = cleanName;
      invites[idx].playlists = cleanPlaylists;
      invites[idx].enabled = Boolean(input.enabled);
      if (input.claimed_uid !== undefined) {
        invites[idx].claimed_uid = input.claimed_uid;
      }
      invites[idx].updated_at = now;
      saved = invites[idx];
    } else {
      saved = {
        id,
        email,
        name: cleanName,
        playlists: cleanPlaylists,
        enabled: Boolean(input.enabled),
        claimed_uid: input.claimed_uid || '',
        created_at: now,
        updated_at: now,
      };
      invites.push(saved);
    }

    if (!this.saveAllInvites(invites)) {
      return { ok: false, error: 'Ошибка сохранения приглашения' };
    }
    return { ok: true, invite: saved };
  }

  markInviteClaimed(email: string, uid: string): void {
    const clean = email.trim().toLowerCase();
    if (!clean || !uid) return;
    const invites = this.allInvites();
    const idx = invites.findIndex((i) => i.email.toLowerCase() === clean);
    if (idx >= 0 && invites[idx].claimed_uid !== uid) {
      invites[idx].claimed_uid = uid;
      invites[idx].updated_at = Math.floor(Date.now() / 1000);
      this.saveAllInvites(invites);
    }
  }

  deleteInvite(idOrEmail: string): boolean {
    const q = idOrEmail.trim().toLowerCase();
    if (!q) return false;
    const invites = this.allInvites();
    const filtered = invites.filter((i) => i.id !== q && i.email.toLowerCase() !== q);
    if (filtered.length === invites.length) return false;
    return this.saveAllInvites(filtered);
  }

  // ===== UNAVAILABLE CHANNEL ALERTS =====
  allAlerts(): ChannelAlertRecord[] {
    if (!fs.existsSync(this.alertsFile)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.alertsFile, 'utf-8'));
      const list = Array.isArray(parsed) ? (parsed as ChannelAlertRecord[]) : [];
      return list.sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
    } catch {
      return [];
    }
  }

  private saveAllAlerts(alerts: ChannelAlertRecord[]): boolean {
    try {
      fs.mkdirSync(path.dirname(this.alertsFile), { recursive: true });
      const tmp = `${this.alertsFile}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(alerts, null, 2), 'utf-8');
      fs.renameSync(tmp, this.alertsFile);
      return true;
    } catch {
      return false;
    }
  }

  upsertAlert(input: {
    userId: string;
    userLogin: string;
    userName: string;
    totalChannels: number;
    items: ChannelAlertIssue[];
  }): ChannelAlertRecord | null {
    const userId = input.userId.trim();
    if (!userId) return null;

    const cleanItems: ChannelAlertIssue[] = Array.isArray(input.items)
      ? input.items
          .filter((it) => it && typeof it.name === 'string' && it.name.trim() && typeof it.reason === 'string' && it.reason.trim())
          .slice(0, 50)
          .map((it) => ({
            name: it.name.trim().slice(0, 120),
            group: (it.group || '').trim().slice(0, 80),
            reason: it.reason.trim().slice(0, 200),
          }))
      : [];

    const alerts = this.allAlerts();
    const idx = alerts.findIndex((a) => a.id === userId);
    const now = Math.floor(Date.now() / 1000);

    // If user currently has 0 unavailable channels, auto-resolve existing alert if present
    if (cleanItems.length === 0) {
      if (idx >= 0 && !alerts[idx].resolved) {
        alerts[idx].items = [];
        alerts[idx].unavailableCount = 0;
        alerts[idx].totalChannels = Math.max(0, Number(input.totalChannels) || 0);
        alerts[idx].resolved = true;
        alerts[idx].updated_at = now;
        this.saveAllAlerts(alerts);
        return alerts[idx];
      }
      return idx >= 0 ? alerts[idx] : null;
    }

    const record: ChannelAlertRecord = {
      id: userId,
      userId,
      userLogin: (input.userLogin || userId).slice(0, 64),
      userName: (input.userName || input.userLogin || userId).slice(0, 80),
      totalChannels: Math.max(0, Number(input.totalChannels) || 0),
      unavailableCount: cleanItems.length,
      items: cleanItems,
      resolved: false,
      created_at: idx >= 0 ? alerts[idx].created_at : now,
      updated_at: now,
    };

    if (idx >= 0) {
      alerts[idx] = record;
    } else {
      alerts.push(record);
    }
    this.saveAllAlerts(alerts);
    return record;
  }

  resolveAlert(id: string, resolved = true): boolean {
    const alerts = this.allAlerts();
    const idx = alerts.findIndex((a) => a.id === id);
    if (idx < 0) return false;
    alerts[idx].resolved = Boolean(resolved);
    alerts[idx].updated_at = Math.floor(Date.now() / 1000);
    return this.saveAllAlerts(alerts);
  }

  deleteAlert(id: string): boolean {
    const alerts = this.allAlerts();
    const filtered = alerts.filter((a) => a.id !== id);
    if (filtered.length === alerts.length) return false;
    return this.saveAllAlerts(filtered);
  }
}

export const userAuth = new UserAuth();
