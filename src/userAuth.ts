import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, hashPassword, verifyPassword } from './config.js';
import { atomicWriteJsonSync } from './persistence.js';

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

function normalizePlaylistName(raw: string): string {
  return String(raw || '').replace(/\.m3u$/i, '').trim();
}

export class UserAuth {
  private lastError = '';

  private get usersFile(): string {
    return path.join(config.dataDir, 'users.json');
  }

  private get sessionsFile(): string {
    return path.join(config.dataDir, 'user_sessions.json');
  }

  private get invitesFile(): string {
    return path.join(config.dataDir, 'invites.json');
  }

  private get alertsFile(): string {
    return path.join(config.dataDir, 'channel_alerts.json');
  }

  getLastError(): string {
    return this.lastError;
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
    this.lastError = '';
    const res = atomicWriteJsonSync(this.usersFile, users, 4);
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка сохранения users.json';
      return false;
    }
    return true;
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
      playlists: playlists
        .filter((p) => typeof p === 'string')
        .map(normalizePlaylistName)
        .filter(Boolean),
      enabled: Boolean(enabled),
      created_at: Math.floor(Date.now() / 1000),
    };
    users.push(user);
    if (!this.saveAll(users)) {
      return { ok: false, error: this.lastError || 'Ошибка сохранения' };
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
      u.playlists = patch.playlists
        .filter((p) => typeof p === 'string')
        .map(normalizePlaylistName)
        .filter(Boolean);
    }
    if (patch.enabled !== undefined) u.enabled = Boolean(patch.enabled);
    if (patch.password) {
      if (patch.password.length < 4) {
        return { ok: false, error: 'Пароль минимум 4 символа' };
      }
      u.password_hash = hashPassword(patch.password);
    }

    if (!this.saveAll(users)) {
      return { ok: false, error: this.lastError || 'Ошибка сохранения' };
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
      ? input.playlists
          .filter((p) => typeof p === 'string')
          .map(normalizePlaylistName)
          .filter(Boolean)
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
      ? input.playlists
          .filter((p) => typeof p === 'string')
          .map(normalizePlaylistName)
          .filter(Boolean)
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
    atomicWriteJsonSync(this.sessionsFile, data);
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

  saveAllInvites(invites: InviteRecord[]): boolean {
    this.lastError = '';
    const res = atomicWriteJsonSync(this.invitesFile, invites, 2);
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка сохранения invites.json';
      return false;
    }
    return true;
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
      ? input.playlists
          .filter((p) => typeof p === 'string')
          .map(normalizePlaylistName)
          .filter(Boolean)
          .slice(0, 50)
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
      return { ok: false, error: this.lastError || 'Ошибка сохранения приглашения' };
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

  /**
   * DEF-06: Removes references to a deleted playlist from all users & invites atomically.
   */
  removePlaylistReferences(playlistName: string): {
    ok: boolean;
    cleanedUsers: number;
    cleanedInvites: number;
    updatedUserIds: string[];
    updatedInviteIds: string[];
    error?: string;
  } {
    const target = normalizePlaylistName(playlistName);
    if (!target) {
      return { ok: true, cleanedUsers: 0, cleanedInvites: 0, updatedUserIds: [], updatedInviteIds: [] };
    }

    const users = this.all();
    const updatedUserIds: string[] = [];
    for (const u of users) {
      const prev = Array.isArray(u.playlists) ? u.playlists : [];
      const next = prev
        .map(normalizePlaylistName)
        .filter((p) => p && p !== target);
      if (next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
        u.playlists = next;
        updatedUserIds.push(u.id);
      }
    }
    if (updatedUserIds.length > 0 && !this.saveAll(users)) {
      return {
        ok: false,
        cleanedUsers: 0,
        cleanedInvites: 0,
        updatedUserIds: [],
        updatedInviteIds: [],
        error: this.lastError || 'Ошибка очистки плейлиста у пользователей',
      };
    }

    const invites = this.allInvites();
    const updatedInviteIds: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const inv of invites) {
      const prev = Array.isArray(inv.playlists) ? inv.playlists : [];
      const next = prev
        .map(normalizePlaylistName)
        .filter((p) => p && p !== target);
      if (next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
        inv.playlists = next;
        inv.updated_at = now;
        updatedInviteIds.push(inv.id);
      }
    }
    if (updatedInviteIds.length > 0 && !this.saveAllInvites(invites)) {
      return {
        ok: false,
        cleanedUsers: updatedUserIds.length,
        cleanedInvites: 0,
        updatedUserIds,
        updatedInviteIds: [],
        error: this.lastError || 'Ошибка очистки плейлиста у приглашений',
      };
    }

    return {
      ok: true,
      cleanedUsers: updatedUserIds.length,
      cleanedInvites: updatedInviteIds.length,
      updatedUserIds,
      updatedInviteIds,
    };
  }

  renamePlaylistReferences(
    oldName: string,
    newName: string
  ): {
    ok: boolean;
    updatedUsers: number;
    updatedInvites: number;
    updatedUserIds: string[];
    updatedInviteIds: string[];
    error?: string;
  } {
    const fromName = normalizePlaylistName(oldName);
    const toName = normalizePlaylistName(newName);
    if (!fromName || !toName || fromName === toName) {
      return { ok: true, updatedUsers: 0, updatedInvites: 0, updatedUserIds: [], updatedInviteIds: [] };
    }

    const users = this.all();
    const updatedUserIds: string[] = [];
    for (const u of users) {
      const prev = Array.isArray(u.playlists) ? u.playlists : [];
      const seen = new Set<string>();
      const next: string[] = [];
      let changed = false;
      for (const rawPl of prev) {
        const clean = normalizePlaylistName(rawPl);
        if (!clean) continue;
        const mapped = clean === fromName ? toName : clean;
        if (clean === fromName) changed = true;
        if (!seen.has(mapped)) {
          seen.add(mapped);
          next.push(mapped);
        }
      }
      if (changed || next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
        if (changed) {
          u.playlists = next;
          updatedUserIds.push(u.id);
        }
      }
    }
    if (updatedUserIds.length > 0 && !this.saveAll(users)) {
      return {
        ok: false,
        updatedUsers: 0,
        updatedInvites: 0,
        updatedUserIds: [],
        updatedInviteIds: [],
        error: this.lastError || 'Ошибка обновления плейлиста у пользователей',
      };
    }

    const invites = this.allInvites();
    const updatedInviteIds: string[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const inv of invites) {
      const prev = Array.isArray(inv.playlists) ? inv.playlists : [];
      const seen = new Set<string>();
      const next: string[] = [];
      let changed = false;
      for (const rawPl of prev) {
        const clean = normalizePlaylistName(rawPl);
        if (!clean) continue;
        const mapped = clean === fromName ? toName : clean;
        if (clean === fromName) changed = true;
        if (!seen.has(mapped)) {
          seen.add(mapped);
          next.push(mapped);
        }
      }
      if (changed) {
        inv.playlists = next;
        inv.updated_at = now;
        updatedInviteIds.push(inv.id);
      }
    }
    if (updatedInviteIds.length > 0 && !this.saveAllInvites(invites)) {
      return {
        ok: false,
        updatedUsers: updatedUserIds.length,
        updatedInvites: 0,
        updatedUserIds,
        updatedInviteIds: [],
        error: this.lastError || 'Ошибка обновления плейлиста у приглашений',
      };
    }

    return {
      ok: true,
      updatedUsers: updatedUserIds.length,
      updatedInvites: updatedInviteIds.length,
      updatedUserIds,
      updatedInviteIds,
    };
  }

  /**
   * Prunes any stale playlist assignments from users & invites against currently active playlists.
   */
  pruneInvalidPlaylists(validPlaylists: string[]): {
    ok: boolean;
    cleanedUsers: number;
    cleanedInvites: number;
    error?: string;
  } {
    const validSet = new Set(validPlaylists.map(normalizePlaylistName).filter(Boolean));
    const users = this.all();
    let usersChanged = 0;
    for (const u of users) {
      const prev = Array.isArray(u.playlists) ? u.playlists : [];
      const next = prev.map(normalizePlaylistName).filter((p) => validSet.has(p));
      if (next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
        u.playlists = next;
        usersChanged++;
      }
    }
    if (usersChanged > 0 && !this.saveAll(users)) {
      return { ok: false, cleanedUsers: 0, cleanedInvites: 0, error: this.lastError };
    }

    const invites = this.allInvites();
    let invitesChanged = 0;
    const now = Math.floor(Date.now() / 1000);
    for (const inv of invites) {
      const prev = Array.isArray(inv.playlists) ? inv.playlists : [];
      const next = prev.map(normalizePlaylistName).filter((p) => validSet.has(p));
      if (next.length !== prev.length || next.some((v, idx) => v !== prev[idx])) {
        inv.playlists = next;
        inv.updated_at = now;
        invitesChanged++;
      }
    }
    if (invitesChanged > 0 && !this.saveAllInvites(invites)) {
      return { ok: false, cleanedUsers: usersChanged, cleanedInvites: 0, error: this.lastError };
    }

    return { ok: true, cleanedUsers: usersChanged, cleanedInvites: invitesChanged };
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

  hydrateAlerts(raw: unknown): { ok: boolean; count: number; error?: string } {
    const normalized: ChannelAlertRecord[] = [];
    const now = Math.floor(Date.now() / 1000);
    for (const item of (Array.isArray(raw) ? raw : []) as Array<Record<string, unknown>>) {
      const userId = String(item.userId || item.id || '').trim();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(userId)) continue;
      const items = Array.isArray(item.items)
        ? item.items.filter((entry) => entry && typeof entry === 'object')
            .slice(0, 50)
            .map((entry) => {
              const issue = entry as Record<string, unknown>;
              return {
                name: String(issue.name || '').trim().slice(0, 120),
                group: String(issue.group || '').trim().slice(0, 80),
                reason: String(issue.reason || '').trim().slice(0, 200),
              };
            })
            .filter((entry) => entry.name && entry.reason)
        : [];
      normalized.push({
        id: userId,
        userId,
        userLogin: String(item.userLogin || userId).trim().slice(0, 64) || userId,
        userName: String(item.userName || item.userLogin || userId).trim().slice(0, 80) || userId,
        totalChannels: Math.max(0, Math.min(50000, Math.floor(Number(item.totalChannels) || 0))),
        unavailableCount: Math.max(0, Math.min(50000, Math.floor(Number(item.unavailableCount) || items.length))),
        items,
        resolved: Boolean(item.resolved),
        created_at: Math.max(0, Math.floor(Number(item.created_at) || now)),
        updated_at: Math.max(0, Math.floor(Number(item.updated_at) || now)),
      });
    }
    if (!this.saveAllAlerts(normalized)) {
      return { ok: false, count: 0, error: this.lastError || 'Не удалось восстановить channel_alerts.json' };
    }
    return { ok: true, count: normalized.length };
  }

  private saveAllAlerts(alerts: ChannelAlertRecord[]): boolean {
    this.lastError = '';
    const res = atomicWriteJsonSync(this.alertsFile, alerts, 2);
    if (!res.ok) {
      this.lastError = res.error || 'Ошибка сохранения channel_alerts.json';
      return false;
    }
    return true;
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
          .filter(
            (it) =>
              it &&
              typeof it.name === 'string' &&
              it.name.trim() &&
              typeof it.reason === 'string' &&
              it.reason.trim()
          )
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
