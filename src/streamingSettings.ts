import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export type StreamDeliveryMode =
  | 'auto_proxy_first'
  | 'auto_direct_first'
  | 'proxy_only'
  | 'direct_only';

export interface StreamingSettings {
  mode: StreamDeliveryMode;
  tryHttpsUpgrade: boolean;
  proxyTimeoutSec: number;
}

const VALID_MODES: StreamDeliveryMode[] = [
  'auto_proxy_first',
  'auto_direct_first',
  'proxy_only',
  'direct_only',
];

export const DEFAULT_STREAMING_SETTINGS: StreamingSettings = {
  mode: 'auto_proxy_first',
  tryHttpsUpgrade: true,
  proxyTimeoutSec: 15,
};

function getSettingsPath(): string {
  return path.join(config.dataDir, 'streaming_settings.json');
}

export function sanitizeStreamingSettings(raw: unknown): StreamingSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STREAMING_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const rawMode = String(obj.mode || '').trim() as StreamDeliveryMode;
  const mode = VALID_MODES.includes(rawMode) ? rawMode : DEFAULT_STREAMING_SETTINGS.mode;
  const tryHttpsUpgrade =
    obj.tryHttpsUpgrade !== undefined
      ? Boolean(obj.tryHttpsUpgrade)
      : DEFAULT_STREAMING_SETTINGS.tryHttpsUpgrade;
  const timeoutRaw = Number(obj.proxyTimeoutSec);
  const proxyTimeoutSec = Number.isFinite(timeoutRaw)
    ? Math.max(3, Math.min(60, Math.round(timeoutRaw)))
    : DEFAULT_STREAMING_SETTINGS.proxyTimeoutSec;

  return { mode, tryHttpsUpgrade, proxyTimeoutSec };
}

export function getStreamingSettings(): StreamingSettings {
  const file = getSettingsPath();
  if (!fs.existsSync(file)) {
    return { ...DEFAULT_STREAMING_SETTINGS };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
    return sanitizeStreamingSettings(parsed);
  } catch {
    return { ...DEFAULT_STREAMING_SETTINGS };
  }
}

export function saveStreamingSettings(input: unknown): StreamingSettings {
  const next = sanitizeStreamingSettings(input);
  try {
    const file = getSettingsPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch {
    // ignore disk error
  }
  return next;
}
