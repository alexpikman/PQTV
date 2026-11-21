import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { atomicWriteJsonSync } from './persistence.js';

export type StreamDeliveryMode =
  | 'auto_proxy_first'
  | 'auto_direct_first'
  | 'proxy_only'
  | 'direct_only';

export type StreamProtocolHint = 'auto' | 'hls' | 'mpegts' | 'native';
export type StreamPresetId = 'vlc_smooth' | 'balanced' | 'low_latency' | 'custom';

export interface StreamingSettings {
  preset: StreamPresetId;
  mode: StreamDeliveryMode;
  preferDirectOnTv: boolean;
  tryHttpsUpgrade: boolean;
  protocolHint: StreamProtocolHint;
  proxyUserAgent: string;
  proxyFollowRedirects: number;
  proxyTimeoutSec: number;
  proxyKeepAlive: boolean;
  proxyMaxSockets: number;
  proxyBufferKb: number;
  proxyRetryCount: number;
  hlsUseWorkers: boolean;
  hlsLowLatency: boolean;
  hlsLiveSyncDurationCount: number;
  hlsMaxBufferLengthSec: number;
  hlsMaxMaxBufferLengthSec: number;
  hlsBackBufferLengthSec: number;
  hlsStartFragPrefetch: boolean;
  hlsManifestTimeoutSec: number;
  hlsManifestMaxRetry: number;
  hlsFragTimeoutSec: number;
  hlsFragMaxRetry: number;
  hlsMaxBufferHoleMs: number;
  mpegtsUseWorker: boolean;
  mpegtsStashBuffer: boolean;
  mpegtsStashSizeKb: number;
  mpegtsLiveLatencyChasing: boolean;
  mpegtsMaxLatencySec: number;
  mpegtsMinRemainSec: number;
  attemptTimeoutSec: number;
  previewEnabled: boolean;
  previewDebounceMs: number;
  previewResumeDelayMs: number;
  codecCheckDelaySec: number;
}

const VALID_MODES: StreamDeliveryMode[] = [
  'auto_proxy_first',
  'auto_direct_first',
  'proxy_only',
  'direct_only',
];

const VALID_PROTOCOLS: StreamProtocolHint[] = ['auto', 'hls', 'mpegts', 'native'];
const VALID_PRESETS: StreamPresetId[] = ['vlc_smooth', 'balanced', 'low_latency', 'custom'];

export const DEFAULT_STREAMING_SETTINGS: StreamingSettings = {
  preset: 'vlc_smooth',
  mode: 'auto_proxy_first',
  preferDirectOnTv: true,
  tryHttpsUpgrade: true,
  protocolHint: 'auto',
  proxyUserAgent: 'VLC/3.0.20 LibVLC/3.0.20',
  proxyFollowRedirects: 5,
  proxyTimeoutSec: 15,
  proxyKeepAlive: true,
  proxyMaxSockets: 64,
  proxyBufferKb: 128,
  proxyRetryCount: 2,
  hlsUseWorkers: true,
  hlsLowLatency: false,
  hlsLiveSyncDurationCount: 4,
  hlsMaxBufferLengthSec: 45,
  hlsMaxMaxBufferLengthSec: 90,
  hlsBackBufferLengthSec: 15,
  hlsStartFragPrefetch: true,
  hlsManifestTimeoutSec: 12,
  hlsManifestMaxRetry: 3,
  hlsFragTimeoutSec: 25,
  hlsFragMaxRetry: 4,
  hlsMaxBufferHoleMs: 500,
  mpegtsUseWorker: true,
  mpegtsStashBuffer: true,
  mpegtsStashSizeKb: 512,
  mpegtsLiveLatencyChasing: false,
  mpegtsMaxLatencySec: 5,
  mpegtsMinRemainSec: 1.5,
  attemptTimeoutSec: 15,
  previewEnabled: true,
  previewDebounceMs: 450,
  previewResumeDelayMs: 350,
  codecCheckDelaySec: 8,
};

function clampInt(val: unknown, fallback: number, min: number, max: number): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function clampFloat(val: unknown, fallback: number, min: number, max: number, decimals = 1): number {
  const n = Number(val);
  if (!Number.isFinite(n)) return fallback;
  const clamped = Math.max(min, Math.min(max, n));
  const factor = 10 ** decimals;
  return Math.round(clamped * factor) / factor;
}

function boolOr(val: unknown, fallback: boolean): boolean {
  return val !== undefined ? Boolean(val) : fallback;
}

function getSettingsPath(): string {
  return path.join(config.dataDir, 'streaming_settings.json');
}

export function sanitizeStreamingSettings(raw: unknown): StreamingSettings {
  if (!raw || typeof raw !== 'object') {
    return { ...DEFAULT_STREAMING_SETTINGS };
  }
  const obj = raw as Record<string, unknown>;
  const rawMode = String(obj.mode || '').trim() as StreamDeliveryMode;
  const rawProto = String(obj.protocolHint || '').trim() as StreamProtocolHint;
  const rawPreset = String(obj.preset || '').trim() as StreamPresetId;

  const hlsMaxBufferLengthSec = clampInt(
    obj.hlsMaxBufferLengthSec,
    DEFAULT_STREAMING_SETTINGS.hlsMaxBufferLengthSec,
    5,
    180
  );
  const hlsMaxMaxBufferLengthSec = Math.max(
    hlsMaxBufferLengthSec,
    clampInt(
      obj.hlsMaxMaxBufferLengthSec,
      DEFAULT_STREAMING_SETTINGS.hlsMaxMaxBufferLengthSec,
      10,
      360
    )
  );
  const mpegtsMinRemainSec = clampFloat(
    obj.mpegtsMinRemainSec,
    DEFAULT_STREAMING_SETTINGS.mpegtsMinRemainSec,
    0.5,
    10
  );
  const mpegtsMaxLatencySec = Math.max(
    mpegtsMinRemainSec + 0.5,
    clampFloat(
      obj.mpegtsMaxLatencySec,
      DEFAULT_STREAMING_SETTINGS.mpegtsMaxLatencySec,
      1,
      20
    )
  );

  const rawUa = typeof obj.proxyUserAgent === 'string' ? obj.proxyUserAgent.trim() : '';
  const proxyUserAgent = (rawUa || DEFAULT_STREAMING_SETTINGS.proxyUserAgent)
    .replace(/[\r\n]/g, '')
    .slice(0, 240);

  return {
    preset: VALID_PRESETS.includes(rawPreset) ? rawPreset : DEFAULT_STREAMING_SETTINGS.preset,
    mode: VALID_MODES.includes(rawMode) ? rawMode : DEFAULT_STREAMING_SETTINGS.mode,
    preferDirectOnTv: boolOr(obj.preferDirectOnTv, DEFAULT_STREAMING_SETTINGS.preferDirectOnTv),
    tryHttpsUpgrade: boolOr(obj.tryHttpsUpgrade, DEFAULT_STREAMING_SETTINGS.tryHttpsUpgrade),
    protocolHint: VALID_PROTOCOLS.includes(rawProto)
      ? rawProto
      : DEFAULT_STREAMING_SETTINGS.protocolHint,
    proxyUserAgent,
    proxyFollowRedirects: clampInt(
      obj.proxyFollowRedirects,
      DEFAULT_STREAMING_SETTINGS.proxyFollowRedirects,
      0,
      10
    ),
    proxyTimeoutSec: clampInt(
      obj.proxyTimeoutSec,
      DEFAULT_STREAMING_SETTINGS.proxyTimeoutSec,
      3,
      60
    ),
    proxyKeepAlive: boolOr(obj.proxyKeepAlive, DEFAULT_STREAMING_SETTINGS.proxyKeepAlive),
    proxyMaxSockets: clampInt(
      obj.proxyMaxSockets,
      DEFAULT_STREAMING_SETTINGS.proxyMaxSockets,
      4,
      200
    ),
    proxyBufferKb: clampInt(
      obj.proxyBufferKb,
      DEFAULT_STREAMING_SETTINGS.proxyBufferKb,
      16,
      1024
    ),
    proxyRetryCount: clampInt(
      obj.proxyRetryCount,
      DEFAULT_STREAMING_SETTINGS.proxyRetryCount,
      0,
      5
    ),
    hlsUseWorkers: boolOr(obj.hlsUseWorkers, DEFAULT_STREAMING_SETTINGS.hlsUseWorkers),
    hlsLowLatency: boolOr(obj.hlsLowLatency, DEFAULT_STREAMING_SETTINGS.hlsLowLatency),
    hlsLiveSyncDurationCount: clampInt(
      obj.hlsLiveSyncDurationCount,
      DEFAULT_STREAMING_SETTINGS.hlsLiveSyncDurationCount,
      1,
      12
    ),
    hlsMaxBufferLengthSec,
    hlsMaxMaxBufferLengthSec,
    hlsBackBufferLengthSec: clampInt(
      obj.hlsBackBufferLengthSec,
      DEFAULT_STREAMING_SETTINGS.hlsBackBufferLengthSec,
      0,
      120
    ),
    hlsStartFragPrefetch: boolOr(
      obj.hlsStartFragPrefetch,
      DEFAULT_STREAMING_SETTINGS.hlsStartFragPrefetch
    ),
    hlsManifestTimeoutSec: clampInt(
      obj.hlsManifestTimeoutSec,
      DEFAULT_STREAMING_SETTINGS.hlsManifestTimeoutSec,
      3,
      60
    ),
    hlsManifestMaxRetry: clampInt(
      obj.hlsManifestMaxRetry,
      DEFAULT_STREAMING_SETTINGS.hlsManifestMaxRetry,
      0,
      10
    ),
    hlsFragTimeoutSec: clampInt(
      obj.hlsFragTimeoutSec,
      DEFAULT_STREAMING_SETTINGS.hlsFragTimeoutSec,
      5,
      60
    ),
    hlsFragMaxRetry: clampInt(
      obj.hlsFragMaxRetry,
      DEFAULT_STREAMING_SETTINGS.hlsFragMaxRetry,
      0,
      10
    ),
    hlsMaxBufferHoleMs: clampInt(
      obj.hlsMaxBufferHoleMs,
      DEFAULT_STREAMING_SETTINGS.hlsMaxBufferHoleMs,
      100,
      5000
    ),
    mpegtsUseWorker: boolOr(obj.mpegtsUseWorker, DEFAULT_STREAMING_SETTINGS.mpegtsUseWorker),
    mpegtsStashBuffer: boolOr(obj.mpegtsStashBuffer, DEFAULT_STREAMING_SETTINGS.mpegtsStashBuffer),
    mpegtsStashSizeKb: clampInt(
      obj.mpegtsStashSizeKb,
      DEFAULT_STREAMING_SETTINGS.mpegtsStashSizeKb,
      64,
      2048
    ),
    mpegtsLiveLatencyChasing: boolOr(
      obj.mpegtsLiveLatencyChasing,
      DEFAULT_STREAMING_SETTINGS.mpegtsLiveLatencyChasing
    ),
    mpegtsMaxLatencySec,
    mpegtsMinRemainSec,
    attemptTimeoutSec: clampInt(
      obj.attemptTimeoutSec,
      DEFAULT_STREAMING_SETTINGS.attemptTimeoutSec,
      4,
      60
    ),
    previewEnabled: boolOr(obj.previewEnabled, DEFAULT_STREAMING_SETTINGS.previewEnabled),
    previewDebounceMs: clampInt(
      obj.previewDebounceMs,
      DEFAULT_STREAMING_SETTINGS.previewDebounceMs,
      0,
      3000
    ),
    previewResumeDelayMs: clampInt(
      obj.previewResumeDelayMs,
      DEFAULT_STREAMING_SETTINGS.previewResumeDelayMs,
      0,
      3000
    ),
    codecCheckDelaySec: clampInt(
      obj.codecCheckDelaySec,
      DEFAULT_STREAMING_SETTINGS.codecCheckDelaySec,
      0,
      30
    ),
  };
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

export function trySaveStreamingSettings(input: unknown): {
  ok: boolean;
  settings: StreamingSettings;
  error?: string;
} {
  const next = sanitizeStreamingSettings(input);
  const res = atomicWriteJsonSync(getSettingsPath(), next, 2);
  if (!res.ok) {
    return {
      ok: false,
      settings: next,
      error: res.error || 'Ошибка сохранения настроек потока',
    };
  }
  return { ok: true, settings: next };
}

export function saveStreamingSettings(input: unknown): StreamingSettings {
  return trySaveStreamingSettings(input).settings;
}
