import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { atomicWriteJsonSync } from './persistence.js';

export interface ChannelCategory {
  id: string;
  name: string;
  created_at?: number;
}

class CategoriesStore {
  private lastError = '';

  private getFilePath(): string {
    return path.join(config.dataDir, 'categories.json');
  }

  public getLastError(): string {
    return this.lastError;
  }

  private readAll(): ChannelCategory[] {
    try {
      const fp = this.getFilePath();
      if (!fs.existsSync(fp)) return [];
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as unknown;
      const arr = Array.isArray(raw)
        ? raw
        : raw && typeof raw === 'object' && Array.isArray((raw as { categories?: unknown }).categories)
          ? (raw as { categories: unknown[] }).categories
          : [];
      const out: ChannelCategory[] = [];
      const seenNames = new Set<string>();
      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;
        const rec = item as Record<string, unknown>;
        const id = String(rec.id || '').trim();
        const name = String(rec.name || '').trim().slice(0, 80);
        if (!id || !name) continue;
        const norm = name.toLocaleLowerCase('ru');
        if (seenNames.has(norm)) continue;
        seenNames.add(norm);
        out.push({
          id,
          name,
          created_at: Number(rec.created_at) || undefined,
        });
      }
      return out.sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    } catch {
      return [];
    }
  }

  private writeAll(list: ChannelCategory[]): boolean {
    this.lastError = '';
    const sorted = [...list].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    const res = atomicWriteJsonSync(this.getFilePath(), { categories: sorted }, 2);
    if (!res.ok) {
      this.lastError = res.error || 'Не удалось сохранить categories.json';
      return false;
    }
    return true;
  }

  public list(): ChannelCategory[] {
    return this.readAll();
  }

  public create(rawName: string, preferredId?: string): { ok: boolean; category?: ChannelCategory; error?: string } {
    const name = String(rawName || '').trim();
    if (!name || name.length > 80) {
      return { ok: false, error: 'Название категории должно содержать от 1 до 80 символов' };
    }
    const list = this.readAll();
    const norm = name.toLocaleLowerCase('ru');
    if (list.some((c) => c.name.toLocaleLowerCase('ru') === norm)) {
      return { ok: false, error: 'Категория с таким названием уже существует' };
    }
    const cleanId =
      typeof preferredId === 'string' && /^[a-zA-Z0-9_-]{3,80}$/.test(preferredId.trim())
        ? preferredId.trim()
        : `cat_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
    const item: ChannelCategory = {
      id: cleanId,
      name,
      created_at: Math.floor(Date.now() / 1000),
    };
    list.push(item);
    if (!this.writeAll(list)) {
      return { ok: false, error: this.lastError };
    }
    return { ok: true, category: item };
  }

  public remove(id: string): { ok: boolean; removed?: boolean; error?: string } {
    const cleanId = String(id || '').trim();
    if (!cleanId) return { ok: false, error: 'Не указан ID категории' };
    const list = this.readAll();
    const filtered = list.filter((c) => c.id !== cleanId);
    if (filtered.length === list.length) {
      return { ok: true, removed: false };
    }
    if (!this.writeAll(filtered)) {
      return { ok: false, error: this.lastError };
    }
    return { ok: true, removed: true };
  }

  public hydrate(rawList: unknown): boolean {
    if (!Array.isArray(rawList)) return true;
    const out: ChannelCategory[] = [];
    const seen = new Set<string>();
    for (const raw of rawList) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const id = String(rec.id || '').trim();
      const name = String(rec.name || '').trim().slice(0, 80);
      if (!id || !name) continue;
      const norm = name.toLocaleLowerCase('ru');
      if (seen.has(norm)) continue;
      seen.add(norm);
      out.push({
        id,
        name,
        created_at: Number(rec.created_at) || undefined,
      });
    }
    return this.writeAll(out);
  }
}

export const categoriesStore = new CategoriesStore();
