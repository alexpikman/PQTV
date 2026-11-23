import path from 'node:path';
import { config } from './config.js';
import { atomicWriteJsonSync, readJsonSync } from './persistence.js';

export interface UiSettings {
  logoEnabled: boolean;
  logoOpacity: number;
  logoPulseEnabled: boolean;
  logoPulseSpeedSec: number;
  logoPosition: 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right';
  logoSizePercent: number;
}

export const DEFAULT_UI_SETTINGS: UiSettings = {
  logoEnabled: true,
  logoOpacity: 40,
  logoPulseEnabled: false,
  logoPulseSpeedSec: 3,
  logoPosition: 'bottom-left',
  logoSizePercent: 100,
};

function getUiSettingsPath(): string {
  return path.join(config.dataDir, 'ui_settings.json');
}

export function sanitizeUiSettings(raw: unknown): UiSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_UI_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const logoEnabled =
    obj.logoEnabled !== undefined
      ? Boolean(obj.logoEnabled)
      : DEFAULT_UI_SETTINGS.logoEnabled;

  const opacityRaw = Number(obj.logoOpacity);
  const logoOpacity = Number.isFinite(opacityRaw)
    ? Math.max(0, Math.min(100, Math.round(opacityRaw)))
    : DEFAULT_UI_SETTINGS.logoOpacity;

  const logoPulseEnabled =
    obj.logoPulseEnabled !== undefined
      ? Boolean(obj.logoPulseEnabled)
      : DEFAULT_UI_SETTINGS.logoPulseEnabled;

  const speedRaw = Number(obj.logoPulseSpeedSec);
  const logoPulseSpeedSec = Number.isFinite(speedRaw)
    ? Math.max(0, Math.min(10, Math.round(speedRaw * 10) / 10))
    : DEFAULT_UI_SETTINGS.logoPulseSpeedSec;

  const validLogoPositions = ['bottom-left', 'bottom-right', 'top-left', 'top-right'] as const;
  const logoPosition = validLogoPositions.includes(obj.logoPosition as (typeof validLogoPositions)[number])
    ? (obj.logoPosition as (typeof validLogoPositions)[number])
    : DEFAULT_UI_SETTINGS.logoPosition;

  const sizeRaw = Number(obj.logoSizePercent);
  const logoSizePercent = Number.isFinite(sizeRaw)
    ? Math.max(50, Math.min(200, Math.round(sizeRaw / 5) * 5))
    : DEFAULT_UI_SETTINGS.logoSizePercent;

  return {
    logoEnabled,
    logoOpacity,
    logoPulseEnabled,
    logoPulseSpeedSec,
    logoPosition,
    logoSizePercent,
  };
}

export function getUiSettings(): UiSettings {
  const file = getUiSettingsPath();
  try {
    const parsed = readJsonSync<unknown>(file, null);
    if (parsed === null) return { ...DEFAULT_UI_SETTINGS };
    return sanitizeUiSettings(parsed);
  } catch {
    return { ...DEFAULT_UI_SETTINGS };
  }
}

export function trySaveUiSettings(input: unknown): {
  ok: boolean;
  settings: UiSettings;
  error?: string;
} {
  const next = sanitizeUiSettings(input);
  const res = atomicWriteJsonSync(getUiSettingsPath(), next, 2);
  if (!res.ok) {
    return { ok: false, settings: next, error: res.error || 'Ошибка сохранения настроек интерфейса' };
  }
  return { ok: true, settings: next };
}
