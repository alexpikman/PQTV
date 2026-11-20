import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';

export type DiagCode =
  | 'ok'
  | '401'
  | '403'
  | '404'
  | '429'
  | '5xx'
  | 'timeout'
  | 'tls'
  | 'codec'
  | 'hls_empty'
  | 'hls_segment'
  | 'html_error'
  | 'network';

export type StreamCheckStatus = 'online' | 'offline' | 'unknown';

export interface DeepCheckOptions {
  timeoutMs?: number;
  headers?: Record<string, string>;
  userAgent?: string;
  referer?: string;
  origin?: string;
  ignoreTlsErrors?: boolean;
  checkSegments?: boolean;
  force?: boolean;
}

export interface DeepCheckResult {
  online: boolean | null;
  status: StreamCheckStatus;
  code: number;
  ms: number;
  diagCode: DiagCode;
  reason: string;
  contentType: string;
  hlsOk?: boolean;
  segmentOk?: boolean;
  segmentCode?: number;
  codecWarning?: string;
  finalUrl?: string;
  checkedAt: number;
}

export interface HttpProbeResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  finalUrl: string;
  ms: number;
}

const TLS_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_TLS_HANDSHAKE_TIMEOUT',
  'ERR_SSL_WRONG_VERSION_NUMBER',
  'ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC',
  'HOSTNAME_MISMATCH',
]);

export function classifyNetworkError(err: unknown): { diagCode: DiagCode; reason: string } {
  const rec = err as { code?: string; name?: string; message?: string } | undefined;
  const code = String(rec?.code || '').toUpperCase();
  const name = String(rec?.name || '');
  const msg = String(rec?.message || '');

  if (
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    code === 'ETIMEDOUT' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code === 'ESOCKETTIMEDOUT' ||
    /timeout/i.test(msg)
  ) {
    return { diagCode: 'timeout', reason: 'Таймаут соединения' };
  }

  if (
    TLS_ERROR_CODES.has(code) ||
    code.startsWith('ERR_TLS_') ||
    code.startsWith('ERR_SSL_') ||
    /certificate|ssl|tls|self signed|unable to verify/i.test(msg)
  ) {
    return {
      diagCode: 'tls',
      reason: `Ошибка TLS/SSL сертификата${code ? ` (${code})` : ''}`,
    };
  }

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { diagCode: 'network', reason: `Домен не найден (${code})` };
  }
  if (code === 'ECONNREFUSED') {
    return { diagCode: 'network', reason: 'Соединение отклонено (ECONNREFUSED)' };
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return { diagCode: 'network', reason: `Соединение сброшено (${code})` };
  }

  return {
    diagCode: 'network',
    reason: code ? `Сетевая ошибка (${code})` : 'Сетевая ошибка проверки',
  };
}

export function classifyHttpStatus(status: number, context = 'Поток'): { diagCode: DiagCode; reason: string } {
  if (status === 401) {
    return { diagCode: '401', reason: `${context}: HTTP 401 — Требуется авторизация` };
  }
  if (status === 403) {
    return { diagCode: '403', reason: `${context}: HTTP 403 — Доступ запрещён` };
  }
  if (status === 404 || status === 410) {
    return { diagCode: '404', reason: `${context}: HTTP ${status} — Не найден` };
  }
  if (status === 429) {
    return { diagCode: '429', reason: `${context}: HTTP 429 — Лимит запросов` };
  }
  if (status >= 500) {
    return { diagCode: '5xx', reason: `${context}: HTTP ${status} — Ошибка сервера` };
  }
  return { diagCode: 'network', reason: `${context}: HTTP ${status}` };
}

export function isBlockedHostname(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.local') || h === '0.0.0.0' || h === '::1') return true;
  if (h.startsWith('127.') || h.startsWith('169.254.') || h === 'metadata.google.internal') {
    return true;
  }
  return false;
}

export function buildOutboundHeaders(opts?: {
  headers?: Record<string, string>;
  userAgent?: string;
  referer?: string;
  origin?: string;
  defaultUa?: string;
  range?: string;
}): Record<string, string> {
  const out: Record<string, string> = {
    'User-Agent': opts?.userAgent?.trim() || opts?.defaultUa || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PQTV-Stream-Checker/2.0',
    Accept: '*/*',
    'Cache-Control': 'no-cache',
  };
  if (opts?.referer?.trim()) out.Referer = opts.referer.trim();
  if (opts?.origin?.trim()) out.Origin = opts.origin.trim();
  if (opts?.range) out.Range = opts.range;
  if (opts?.headers) {
    for (const [k, v] of Object.entries(opts.headers)) {
      const key = k.trim();
      if (!key || !v || key.toLowerCase() === 'host') continue;
      out[key] = String(v);
    }
  }
  return out;
}

export async function fetchBytesWithNode(
  rawUrl: string,
  opts: {
    timeoutMs?: number;
    maxBytes?: number;
    headers?: Record<string, string>;
    ignoreTlsErrors?: boolean;
    maxRedirects?: number;
  } = {}
): Promise<HttpProbeResponse> {
  const timeoutMs = Math.max(2000, Math.min(60000, opts.timeoutMs || 10000));
  const maxBytes = Math.max(1024, opts.maxBytes || 262144);
  const maxRedirects = opts.maxRedirects ?? 5;
  const ignoreTlsErrors = Boolean(opts.ignoreTlsErrors);
  const startedAt = Date.now();

  let currentUrl = rawUrl;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw Object.assign(new Error('Unsupported scheme'), { code: 'ERR_UNSUPPORTED_PROTOCOL' });
    }
    if (isBlockedHostname(parsed.hostname)) {
      throw Object.assign(new Error('Blocked host'), { code: 'ERR_BLOCKED_HOST' });
    }

    const res = await new Promise<
      | { kind: 'redirect'; location: string }
      | { kind: 'done'; response: HttpProbeResponse }
    >((resolve, reject) => {
      const mod = parsed.protocol === 'https:' ? https : http;
      const agent =
        parsed.protocol === 'https:' && ignoreTlsErrors
          ? new https.Agent({ rejectUnauthorized: false })
          : undefined;

      let settled = false;
      const finishErr = (e: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        reject(e);
      };

      const req = mod.request(
        parsed,
        {
          method: 'GET',
          headers: opts.headers || {},
          agent,
        },
        (incoming: IncomingMessage) => {
          const status = incoming.statusCode || 0;
          const loc = incoming.headers.location;
          if ([301, 302, 303, 307, 308].includes(status) && loc && hop < maxRedirects) {
            incoming.resume();
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve({ kind: 'redirect', location: new URL(loc, parsed).toString() });
            }
            return;
          }

          const flatHeaders: Record<string, string> = {};
          for (const [hk, hv] of Object.entries(incoming.headers)) {
            if (typeof hv === 'string') flatHeaders[hk.toLowerCase()] = hv;
            else if (Array.isArray(hv)) flatHeaders[hk.toLowerCase()] = hv.join(', ');
          }

          const chunks: Buffer[] = [];
          let totalLen = 0;
          const finishOk = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({
              kind: 'done',
              response: {
                status,
                headers: flatHeaders,
                body: Buffer.concat(chunks),
                finalUrl: currentUrl,
                ms: Date.now() - startedAt,
              },
            });
          };

          incoming.on('data', (chunk: Buffer) => {
            chunks.push(chunk);
            totalLen += chunk.length;
            if (totalLen >= maxBytes) {
              incoming.destroy();
              finishOk();
            }
          });
          incoming.on('end', finishOk);
          incoming.on('close', finishOk);
          incoming.on('error', finishErr);
        }
      );

      const timer = setTimeout(() => {
        finishErr(Object.assign(new Error('Request timeout'), { code: 'ETIMEDOUT', name: 'TimeoutError' }));
      }, timeoutMs);

      req.on('error', finishErr);
      req.end();
    });

    if (res.kind === 'redirect') {
      currentUrl = res.location;
      continue;
    }
    return res.response;
  }

  throw Object.assign(new Error('Too many redirects'), { code: 'ERR_TOO_MANY_REDIRECTS' });
}

function resolveRelativeUrl(raw: string, baseUrl: string): string {
  try {
    return new URL(raw, baseUrl).toString();
  } catch {
    return raw;
  }
}

function inspectCodecFromMaster(body: string): { hasAvc: boolean; unsupportedOnly: boolean; codecList: string[] } {
  const codecMatches = [...body.matchAll(/CODECS="([^"]+)"/gi)];
  const codecList: string[] = [];
  let hasAvc = false;
  let hasUnsupported = false;

  for (const m of codecMatches) {
    const val = m[1] || '';
    codecList.push(val);
    const low = val.toLowerCase();
    if (low.includes('avc1') || low.includes('h264')) {
      hasAvc = true;
    } else if (
      low.includes('hvc1') ||
      low.includes('hev1') ||
      low.includes('hevc') ||
      low.includes('dvh1') ||
      low.includes('dvhe') ||
      low.includes('ac-3') ||
      low.includes('ec-3')
    ) {
      hasUnsupported = true;
    }
  }
  return {
    hasAvc,
    unsupportedOnly: hasUnsupported && !hasAvc,
    codecList,
  };
}

function pickFirstVariantPlaylistUrl(masterBody: string, baseUrl: string): string {
  const lines = masterBody.split(/\r\n|\r|\n/);
  let preferUrl = '';
  let fallbackUrl = '';
  let nextIsAvc = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const low = line.toLowerCase();
      nextIsAvc = low.includes('avc1') || !low.includes('hvc1') && !low.includes('hev1');
      continue;
    }
    if (line.startsWith('#')) continue;
    const abs = resolveRelativeUrl(line, baseUrl);
    if (!fallbackUrl) fallbackUrl = abs;
    if (nextIsAvc && !preferUrl) {
      preferUrl = abs;
      break;
    }
    nextIsAvc = false;
  }
  return preferUrl || fallbackUrl;
}

function pickFirstSegmentUrl(mediaBody: string, baseUrl: string): string {
  const lines = mediaBody.split(/\r\n|\r|\n/);
  let mapUrl = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MAP:')) {
      const m = line.match(/URI="([^"]+)"/i);
      if (m && m[1]) mapUrl = resolveRelativeUrl(m[1], baseUrl);
      continue;
    }
    if (line.startsWith('#')) continue;
    return resolveRelativeUrl(line, baseUrl);
  }
  return mapUrl;
}

function looksLikeHtml(contentType: string, buf: Buffer): boolean {
  const ct = contentType.toLowerCase();
  if (ct.includes('text/html') || ct.includes('application/xhtml')) return true;
  const start = buf.subarray(0, 256).toString('utf-8').trim().toLowerCase();
  return start.startsWith('<!doctype html') || start.startsWith('<html') || start.startsWith('<head');
}

async function performDeepCheck(url: string, opts: DeepCheckOptions = {}): Promise<DeepCheckResult> {
  const t0 = Date.now();
  const timeoutMs = Math.max(3000, Math.min(30000, opts.timeoutMs || 9000));
  const checkSegments = opts.checkSegments !== false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return {
      online: false,
      status: 'offline',
      code: 0,
      ms: 0,
      diagCode: 'network',
      reason: 'Некорректный URL',
      contentType: '',
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      online: false,
      status: 'offline',
      code: 0,
      ms: 0,
      diagCode: 'network',
      reason: 'Неподдерживаемый протокол',
      contentType: '',
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }

  const reqHeaders = buildOutboundHeaders({
    headers: opts.headers,
    userAgent: opts.userAgent,
    referer: opts.referer,
    origin: opts.origin,
  });

  try {
    const initial = await fetchBytesWithNode(parsed.toString(), {
      timeoutMs,
      maxBytes: 512 * 1024,
      headers: reqHeaders,
      ignoreTlsErrors: opts.ignoreTlsErrors,
    });
    const contentType = initial.headers['content-type'] || '';

    if (initial.status < 200 || initial.status >= 400) {
      const classified = classifyHttpStatus(initial.status, 'Поток');
      return {
        online: false,
        status: 'offline',
        code: initial.status,
        ms: initial.ms,
        diagCode: classified.diagCode,
        reason: classified.reason,
        contentType,
        finalUrl: initial.finalUrl,
        checkedAt: Math.floor(Date.now() / 1000),
      };
    }

    if (initial.body.length === 0) {
      return {
        online: false,
        status: 'offline',
        code: initial.status,
        ms: initial.ms,
        diagCode: 'network',
        reason: 'Сервер вернул пустой ответ (0 байт)',
        contentType,
        finalUrl: initial.finalUrl,
        checkedAt: Math.floor(Date.now() / 1000),
      };
    }

    if (looksLikeHtml(contentType, initial.body)) {
      return {
        online: false,
        status: 'offline',
        code: initial.status,
        ms: initial.ms,
        diagCode: 'html_error',
        reason: 'Сервер вернул HTML вместо видеопотока',
        contentType,
        finalUrl: initial.finalUrl,
        checkedAt: Math.floor(Date.now() / 1000),
      };
    }

    const ctLower = contentType.toLowerCase();
    const headText = initial.body.subarray(0, 64).toString('utf-8').trimStart();
    const isHls =
      /\.m3u8?(\?|$)/i.test(initial.finalUrl) ||
      ctLower.includes('mpegurl') ||
      ctLower.includes('vnd.apple') ||
      headText.startsWith('#EXTM3U');

    if (isHls) {
      let playlistText = initial.body.toString('utf-8');
      let playlistUrl = initial.finalUrl;

      if (!playlistText.includes('#EXTM3U')) {
        return {
          online: false,
          status: 'offline',
          code: initial.status,
          ms: initial.ms,
          diagCode: 'hls_empty',
          reason: 'Ответ не является корректным HLS-плейлистом (#EXTM3U)',
          contentType,
          hlsOk: false,
          finalUrl: initial.finalUrl,
          checkedAt: Math.floor(Date.now() / 1000),
        };
      }

      let codecWarning: string | undefined;
      if (playlistText.includes('#EXT-X-STREAM-INF')) {
        const codecInfo = inspectCodecFromMaster(playlistText);
        if (codecInfo.unsupportedOnly) {
          codecWarning = `Кодек ${codecInfo.codecList.join(', ')} (HEVC/AC-3 может не играть в браузере)`;
        }
        const variantUrl = pickFirstVariantPlaylistUrl(playlistText, playlistUrl);
        if (!variantUrl) {
          return {
            online: false,
            status: 'offline',
            code: initial.status,
            ms: Date.now() - t0,
            diagCode: 'hls_empty',
            reason: 'Master HLS-плейлист не содержит потоков',
            contentType,
            hlsOk: false,
            codecWarning,
            finalUrl: playlistUrl,
            checkedAt: Math.floor(Date.now() / 1000),
          };
        }

        const variantRes = await fetchBytesWithNode(variantUrl, {
          timeoutMs,
          maxBytes: 512 * 1024,
          headers: reqHeaders,
          ignoreTlsErrors: opts.ignoreTlsErrors,
        });
        if (variantRes.status < 200 || variantRes.status >= 400) {
          const classified = classifyHttpStatus(variantRes.status, 'Вариант HLS');
          return {
            online: false,
            status: 'offline',
            code: variantRes.status,
            ms: Date.now() - t0,
            diagCode: classified.diagCode,
            reason: classified.reason,
            contentType: variantRes.headers['content-type'] || contentType,
            hlsOk: false,
            codecWarning,
            finalUrl: variantRes.finalUrl,
            checkedAt: Math.floor(Date.now() / 1000),
          };
        }
        playlistText = variantRes.body.toString('utf-8');
        playlistUrl = variantRes.finalUrl;
        if (!playlistText.includes('#EXTM3U')) {
          return {
            online: false,
            status: 'offline',
            code: variantRes.status,
            ms: Date.now() - t0,
            diagCode: 'hls_empty',
            reason: 'Вариант HLS не содержит #EXTM3U',
            contentType: variantRes.headers['content-type'] || contentType,
            hlsOk: false,
            codecWarning,
            finalUrl: playlistUrl,
            checkedAt: Math.floor(Date.now() / 1000),
          };
        }
      }

      const segmentUrl = pickFirstSegmentUrl(playlistText, playlistUrl);
      if (!segmentUrl) {
        return {
          online: false,
          status: 'offline',
          code: initial.status,
          ms: Date.now() - t0,
          diagCode: 'hls_empty',
          reason: 'HLS-плейлист пуст (нет медиасегментов)',
          contentType,
          hlsOk: true,
          segmentOk: false,
          codecWarning,
          finalUrl: playlistUrl,
          checkedAt: Math.floor(Date.now() / 1000),
        };
      }

      if (checkSegments) {
        try {
          const segRes = await fetchBytesWithNode(segmentUrl, {
            timeoutMs,
            maxBytes: 65536,
            headers: buildOutboundHeaders({
              headers: opts.headers,
              userAgent: opts.userAgent,
              referer: opts.referer,
              origin: opts.origin,
              range: 'bytes=0-65535',
            }),
            ignoreTlsErrors: opts.ignoreTlsErrors,
          });
          const segCt = segRes.headers['content-type'] || '';
          if (segRes.status < 200 || segRes.status >= 400) {
            const classified = classifyHttpStatus(segRes.status, 'Сегмент HLS');
            return {
              online: false,
              status: 'offline',
              code: segRes.status,
              segmentCode: segRes.status,
              ms: Date.now() - t0,
              diagCode: classified.diagCode,
              reason: classified.reason,
              contentType,
              hlsOk: true,
              segmentOk: false,
              codecWarning,
              finalUrl: playlistUrl,
              checkedAt: Math.floor(Date.now() / 1000),
            };
          }
          if (segRes.body.length === 0 || looksLikeHtml(segCt, segRes.body)) {
            return {
              online: false,
              status: 'offline',
              code: segRes.status,
              segmentCode: segRes.status,
              ms: Date.now() - t0,
              diagCode: looksLikeHtml(segCt, segRes.body) ? 'html_error' : 'hls_segment',
              reason: looksLikeHtml(segCt, segRes.body)
                ? 'Сегмент HLS вернул HTML вместо медиа'
                : 'Сегмент HLS пуст (0 байт)',
              contentType,
              hlsOk: true,
              segmentOk: false,
              codecWarning,
              finalUrl: playlistUrl,
              checkedAt: Math.floor(Date.now() / 1000),
            };
          }
        } catch (segErr) {
          const net = classifyNetworkError(segErr);
          return {
            online: false,
            status: 'offline',
            code: initial.status,
            ms: Date.now() - t0,
            diagCode: net.diagCode === 'network' ? 'hls_segment' : net.diagCode,
            reason: `Сегмент HLS: ${net.reason}`,
            contentType,
            hlsOk: true,
            segmentOk: false,
            codecWarning,
            finalUrl: playlistUrl,
            checkedAt: Math.floor(Date.now() / 1000),
          };
        }
      }

      return {
        online: true,
        status: 'online',
        code: initial.status,
        ms: Date.now() - t0,
        diagCode: 'ok',
        reason: codecWarning
          ? `HLS + сегменты OK (${codecWarning})`
          : 'HLS-плейлист и сегменты доступны',
        contentType,
        hlsOk: true,
        segmentOk: true,
        codecWarning,
        finalUrl: playlistUrl,
        checkedAt: Math.floor(Date.now() / 1000),
      };
    }

    // Non-HLS direct stream (MPEG-TS / MP4 / AAC / FLV)
    const looksLikeTs = /\.ts(\?|$)/i.test(initial.finalUrl) || ctLower.includes('mp2t');
    if (looksLikeTs && initial.body.length >= 188 && initial.body[0] !== 0x47) {
      // Try finding sync byte 0x47 within first 188 bytes
      const hasSync = initial.body.subarray(0, 188).includes(0x47);
      if (!hasSync) {
        return {
          online: false,
          status: 'offline',
          code: initial.status,
          ms: initial.ms,
          diagCode: 'codec',
          reason: 'Поток .ts не содержит MPEG-TS пакетов',
          contentType,
          finalUrl: initial.finalUrl,
          checkedAt: Math.floor(Date.now() / 1000),
        };
      }
    }

    return {
      online: true,
      status: 'online',
      code: initial.status,
      ms: initial.ms,
      diagCode: 'ok',
      reason: 'Поток доступен',
      contentType,
      finalUrl: initial.finalUrl,
      checkedAt: Math.floor(Date.now() / 1000),
    };
  } catch (err) {
    const net = classifyNetworkError(err);
    return {
      online: false,
      status: 'offline',
      code: 0,
      ms: Date.now() - t0,
      diagCode: net.diagCode,
      reason: net.reason,
      contentType: '',
      checkedAt: Math.floor(Date.now() / 1000),
    };
  }
}

const CHECK_CACHE_TTL_MS: Record<StreamCheckStatus, number> = {
  online: 5 * 60 * 1000,
  offline: 60 * 1000,
  unknown: 20 * 1000,
};
const CHECK_CACHE_MAX = 10000;
const checkCache = new Map<string, { result: DeepCheckResult; expiresAt: number }>();
const checkInFlight = new Map<string, Promise<DeepCheckResult>>();
const MAX_CONCURRENCY = 6;
let activeChecks = 0;
const checkQueue: Array<() => void> = [];

async function withCheckSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeChecks >= MAX_CONCURRENCY) {
    await new Promise<void>((resolve) => checkQueue.push(resolve));
  } else {
    activeChecks++;
  }
  try {
    return await task();
  } finally {
    const next = checkQueue.shift();
    if (next) next();
    else activeChecks--;
  }
}

function makeCacheKey(url: string, opts: DeepCheckOptions): string {
  const ua = opts.userAgent || '';
  const ref = opts.referer || '';
  const orig = opts.origin || '';
  const tls = opts.ignoreTlsErrors ? '1' : '0';
  return `${url}::${ua}::${ref}::${orig}::${tls}`;
}

export async function checkStreamDeep(
  url: string,
  opts: DeepCheckOptions = {}
): Promise<DeepCheckResult> {
  const cleanUrl = String(url || '').trim();
  const key = makeCacheKey(cleanUrl, opts);
  const now = Date.now();

  if (!opts.force) {
    const cached = checkCache.get(key);
    if (cached && cached.expiresAt > now) {
      checkCache.delete(key);
      checkCache.set(key, cached);
      return cached.result;
    }
  }

  const inflight = checkInFlight.get(key);
  if (inflight) return inflight;

  const promise = (async () => {
    const result = await withCheckSlot(() => performDeepCheck(cleanUrl, opts));
    if (checkCache.size >= CHECK_CACHE_MAX) {
      const oldest = checkCache.keys().next().value;
      if (oldest !== undefined) checkCache.delete(oldest);
    }
    checkCache.set(key, {
      result,
      expiresAt: Date.now() + CHECK_CACHE_TTL_MS[result.status],
    });
    return result;
  })();

  checkInFlight.set(key, promise);
  try {
    return await promise;
  } finally {
    if (checkInFlight.get(key) === promise) {
      checkInFlight.delete(key);
    }
  }
}
