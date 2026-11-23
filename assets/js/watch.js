document.addEventListener('DOMContentLoaded', () => {
    // ===== STATE =====
    let channels = [];
    let filtered = [];
    let currentGroup = '__all__';
    let searchQuery = '';
    // Определяем режим по умолчанию: mobile → list, TV/desktop → grid
    function defaultViewMode() {
        const isMobile = window.innerWidth < 900 || ('ontouchstart' in window && window.innerWidth < 1200);
        return isMobile ? 'list' : 'grid';
    }
    let viewMode = localStorage.getItem('pqtv_view') || defaultViewMode();
    let favorites = new Set();
    let hidden = new Set();
    let previewChannel = null;
    let channelMenuTarget = null;
    let epgCache = new Map();       // keyOf(ch) → {loaded, current, next}
    let epgLoadQueue = new Set();
    let serverUnavailable = [];
    let serverStats = { total: 0, available: 0, unavailable: 0 };
    const runtimeUnavailable = new Map();
    let reportTimer = null;
    let lastReportSig = '';

    const USER = window.USER_LOGIN || 'guest';
    const FAV_KEY = 'pqtv_favs_' + USER;
    const HID_KEY = 'pqtv_hidden_' + USER;

    const $ = id => document.getElementById(id);
    const gridEl = $('watch-grid');
    const catsEl = $('categories-grid');
    const searchEl = $('watch-search');
    const clockEl = $('clock');

    const previewScreen = $('preview-screen');
    const previewVideoHost = $('preview-video-host');
    const previewVideo = $('preview-video');
    const previewLogoWrap = $('preview-logo-wrap');
    const previewLogo = $('preview-logo');
    const previewPlaceholder = $('preview-placeholder');
    const previewCat = $('preview-cat');
    const previewName = $('preview-name');
    const epgCurrent = $('epg-current');
    const epgProgress = $('epg-progress');
    const epgStart = $('epg-start');
    const epgStop = $('epg-stop');
    const epgBarFill = $('epg-bar-fill');
    const previewLoading = $('preview-loading');

    const playerVideoHost = $('player-video-host');
    const playerModal = $('player-modal');

    const menu = $('channel-menu');
    const menuLogo = $('ch-menu-logo');
    const menuPh = $('ch-menu-ph');
    const menuTitle = $('ch-menu-title');
    const menuCat = $('ch-menu-cat');
    const menuFavText = $('ch-menu-fav-text');
    const menuHideText = $('ch-menu-hide-text');
    const menuProgram = $('ch-menu-program');
    const cmpCurrent = $('cmp-current');
    const cmpNext = $('cmp-next');

    const IC = {
        tv: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>',
        star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        starFill: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        // Иконки категорий
        catAll: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>',
        catStar: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
        catEye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
        catFilm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="3" width="20" height="18" rx="2"/><line x1="7" y1="3" x2="7" y2="21"/><line x1="17" y1="3" x2="17" y2="21"/><line x1="2" y1="9" x2="7" y2="9"/><line x1="2" y1="15" x2="7" y2="15"/><line x1="17" y1="9" x2="22" y2="9"/><line x1="17" y1="15" x2="22" y2="15"/></svg>',
        catNews: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-4 0V8h4"/><line x1="10" y1="7" x2="18" y2="7"/><line x1="10" y1="11" x2="18" y2="11"/><line x1="10" y1="15" x2="14" y2="15"/></svg>',
        catSport: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M2 12h20M12 2a15.3 15.3 0 0 1 0 20M12 2a15.3 15.3 0 0 0 0 20"/></svg>',
        catMusic: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
        catKids: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>',
        catDoc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>',
        catHeart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        warn: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
    };

    const GROUP_ICONS = [
        { re: /кино|фильм|movie|cinema/i,             icon: IC.catFilm },
        { re: /новост|news|информ/i,                  icon: IC.catNews },
        { re: /спорт|sport|футбол|хокке/i,            icon: IC.catSport },
        { re: /музык|music|mtv|караоке/i,             icon: IC.catMusic },
        { re: /детск|kids|мульт|cartoon/i,            icon: IC.catKids },
        { re: /документ|documentary|наука|познава/i,  icon: IC.catDoc },
        { re: /взросл|18\+|erotic|xxx/i,              icon: IC.catHeart }
    ];

    function iconForGroup(name) {
        for (const g of GROUP_ICONS) if (g.re.test(name)) return g.icon;
        return IC.catAll;
    }

    // ===== UTILS =====
    function esc(s) {
        return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function keyOf(ch) { return (ch.name || '').toLowerCase(); }
    function fmtTime(ts) {
        const d = new Date(ts * 1000);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    function getWatchToken() {
        if (window.WATCH_TOKEN) return window.WATCH_TOKEN;
        try { return sessionStorage.getItem('pqtv_watch_token') || ''; } catch { return ''; }
    }
    function authHeaders() {
        const t = getWatchToken();
        return t ? { 'X-Watch-Token': t } : {};
    }
    async function api(url) {
        try {
            const r = await fetch(url, { credentials: 'same-origin', headers: authHeaders() });
            if (r.status === 401) {
                try { sessionStorage.removeItem('pqtv_watch_token'); } catch {}
                location.href = '/login?clear_token=1';
                return {};
            }
            return await r.json();
        } catch (e) { return {}; }
    }

    function loadFavs() { try { const raw = localStorage.getItem(FAV_KEY); favorites = new Set(raw ? JSON.parse(raw) : []); } catch(e){ favorites = new Set(); } }
    function saveFavs() { try { localStorage.setItem(FAV_KEY, JSON.stringify([...favorites])); } catch(e){} }
    function loadHidden() { try { const raw = localStorage.getItem(HID_KEY); hidden = new Set(raw ? JSON.parse(raw) : []); } catch(e){ hidden = new Set(); } }
    function saveHidden() { try { localStorage.setItem(HID_KEY, JSON.stringify([...hidden])); } catch(e){} }

    // ===== CLOCK =====
    function tickClock() {
        const d = new Date();
        if (clockEl) clockEl.textContent =
            String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }
    tickClock(); setInterval(tickClock, 30000);

    // ===== VIEW MODE =====
    function applyViewMode() {
        gridEl.classList.toggle('grid-mode', viewMode === 'grid');
        gridEl.classList.toggle('list-mode', viewMode === 'list');
        const btn = $('btn-view-mode');
        if (btn) {
            const g = btn.querySelector('.icon-grid'), l = btn.querySelector('.icon-list');
            if (g) g.style.display = viewMode === 'grid' ? '' : 'none';
            if (l) l.style.display = viewMode === 'list' ? '' : 'none';
        }
    }
    const viewBtn = $('btn-view-mode');
    if (viewBtn) viewBtn.onclick = () => {
        viewMode = viewMode === 'grid' ? 'list' : 'grid';
        localStorage.setItem('pqtv_view', viewMode);
        applyViewMode();
        renderChannels();
    };
    applyViewMode();

    // Кнопка обновления плейлиста (перезагрузка с сервера)
    const refreshBtn = $('btn-refresh');
    if (refreshBtn) {
        refreshBtn.onclick = async () => {
            const svg = refreshBtn.querySelector('svg');
            if (svg) svg.style.animation = 'spin 0.8s linear infinite';
            refreshBtn.disabled = true;
            try {
                epgCache.clear();
                epgLoadQueue.clear();
                await loadChannels();
            } finally {
                if (svg) svg.style.animation = '';
                refreshBtn.disabled = false;
            }
        };
    }

    // ===== SETTINGS & TV OTA UPDATES =====
    const settingsModal = $('settings-modal');
    const setPlatformLabel = $('set-platform-label');
    const setCurrentVer = $('set-current-ver');
    const setRemoteVer = $('set-remote-ver');
    const setChangelogBox = $('set-changelog-box');
    const setViewLabel = $('set-view-label');
    const setStreamModeVal = $('set-stream-mode-val');
    const setStreamModeLabel = $('set-stream-mode-label');
    const setStreamHttpsLabel = $('set-stream-https-label');
    const setBtnStreamMode = $('set-btn-stream-mode');
    const setBtnStreamHttps = $('set-btn-stream-https');
    const setBtnCheckUpdate = $('set-btn-check-update');
    const setBtnInstallApk = $('set-btn-install-apk');
    const setBtnToggleView = $('set-btn-toggle-view');
    const tvUpdateBtn = $('tv-update-btn');
    const tvUpdateBtnText = $('tv-update-btn-text');
    const tvProgressWrap = $('tv-update-progress-wrap');
    const tvProgressLabel = $('tv-update-progress-label');
    const tvProgressFill = $('tv-update-progress-fill');

    let latestApkInfo = null;
    const STREAM_MODES = ['auto_proxy_first', 'auto_direct_first', 'proxy_only', 'direct_only'];
    const STREAM_MODE_LABELS = {
        auto_proxy_first: 'Авто (сначала proxy)',
        auto_direct_first: 'Авто (напрямую)',
        proxy_only: 'Только proxy',
        direct_only: 'Только напрямую'
    };
    let serverStreamingSettings = {
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
    let serverUiSettings = { logoEnabled: true, logoOpacity: 40, logoPulseEnabled: false, logoPulseSpeedSec: 3 };

    function sanitizeUiSettings(raw) {
        const obj = (raw && typeof raw === 'object') ? raw : {};
        const opRaw = Number(obj.logoOpacity);
        const spRaw = Number(obj.logoPulseSpeedSec);
        return {
            logoEnabled: obj.logoEnabled !== undefined ? Boolean(obj.logoEnabled) : true,
            logoOpacity: Number.isFinite(opRaw) ? Math.max(0, Math.min(100, Math.round(opRaw))) : 40,
            logoPulseEnabled: obj.logoPulseEnabled !== undefined ? Boolean(obj.logoPulseEnabled) : false,
            logoPulseSpeedSec: Number.isFinite(spRaw) ? Math.max(0, Math.min(10, Math.round(spRaw * 10) / 10)) : 3
        };
    }

    function applyUiSettings(raw) {
        if (raw && typeof raw === 'object') {
            serverUiSettings = sanitizeUiSettings(Object.assign({}, serverUiSettings, raw));
        }
        const wm = $('player-watermark');
        if (!wm) return;
        const enabled = Boolean(serverUiSettings.logoEnabled);
        wm.classList.toggle('hidden', !enabled);
        const op = Math.max(0, Math.min(1, serverUiSettings.logoOpacity / 100));
        wm.style.setProperty('--wm-opacity', String(op));
        const pulsing = Boolean(enabled && serverUiSettings.logoPulseEnabled && serverUiSettings.logoPulseSpeedSec > 0);
        wm.classList.toggle('is-pulsing', pulsing);
        if (pulsing) {
            wm.style.setProperty('--wm-pulse-dur', serverUiSettings.logoPulseSpeedSec + 's');
        }
    }

    async function loadUiSettings() {
        const res = await api('/watch/api/ui-settings?_=' + Date.now());
        if (res && res.settings) {
            applyUiSettings(res.settings);
        }
        return serverUiSettings;
    }

    function isNativeTvApp() {
        return Boolean(window.PQTVAndroid && typeof window.PQTVAndroid.isAndroidTV === 'function' && window.PQTVAndroid.isAndroidTV());
    }
    if (isNativeTvApp()) {
        document.documentElement.classList.add('is-tv');
    }
    function currentAppCode() {
        if (window.PQTVAndroid && typeof window.PQTVAndroid.getVersionCode === 'function') {
            return Number(window.PQTVAndroid.getVersionCode()) || 1;
        }
        return Number(window.APP_VERSION_CODE) || 1;
    }
    function currentAppName() {
        if (window.PQTVAndroid && typeof window.PQTVAndroid.getVersionName === 'function') {
            return String(window.PQTVAndroid.getVersionName() || '1.0.0');
        }
        return String(window.APP_VERSION || '1.0.0');
    }

    function getEffectiveStreamingSettings() {
        const localMode = !window.IS_ADMIN_VIEWER ? (localStorage.getItem('pqtv_stream_mode') || '') : '';
        const localHttps = !window.IS_ADMIN_VIEWER ? localStorage.getItem('pqtv_stream_https') : null;
        let mode = STREAM_MODES.includes(localMode)
            ? localMode
            : (STREAM_MODES.includes(serverStreamingSettings.mode) ? serverStreamingSettings.mode : 'auto_proxy_first');
        if (!STREAM_MODES.includes(localMode) && serverStreamingSettings.preferDirectOnTv && isNativeTvApp() && mode === 'auto_proxy_first') {
            mode = 'auto_direct_first';
        }
        const tryHttpsUpgrade = (localHttps === '1' || localHttps === '0')
            ? localHttps === '1'
            : (serverStreamingSettings.tryHttpsUpgrade !== false);
        return Object.assign({}, serverStreamingSettings, {
            mode,
            tryHttpsUpgrade,
            proxyTimeoutSec: Number(serverStreamingSettings.proxyTimeoutSec) || 15,
            isOverride: !window.IS_ADMIN_VIEWER && (STREAM_MODES.includes(localMode) || localHttps === '1' || localHttps === '0')
        });
    }

    function buildWatchHlsConfig(eff, isPreview) {
        const s = eff || getEffectiveStreamingSettings();
        const maxBuf = Math.max(5, Math.min(180, Number(s.hlsMaxBufferLengthSec) || 45));
        return {
            enableWorker: s.hlsUseWorkers !== false,
            lowLatencyMode: Boolean(s.hlsLowLatency),
            liveSyncDurationCount: Math.max(1, Math.min(12, Number(s.hlsLiveSyncDurationCount) || 4)),
            maxBufferLength: isPreview ? Math.min(20, maxBuf) : maxBuf,
            maxMaxBufferLength: isPreview ? Math.min(40, Math.max(20, Number(s.hlsMaxMaxBufferLengthSec) || 90)) : Math.max(maxBuf, Number(s.hlsMaxMaxBufferLengthSec) || 90),
            backBufferLength: isPreview ? Math.min(10, Number(s.hlsBackBufferLengthSec) || 15) : Math.max(0, Math.min(120, Number(s.hlsBackBufferLengthSec) || 15)),
            startFragPrefetch: s.hlsStartFragPrefetch !== false,
            manifestLoadingTimeOut: Math.max(3, Math.min(60, Number(s.hlsManifestTimeoutSec) || 12)) * 1000,
            manifestLoadingMaxRetry: Math.max(0, Math.min(10, Number(s.hlsManifestMaxRetry) ?? 3)),
            fragLoadingTimeOut: Math.max(5, Math.min(60, Number(s.hlsFragTimeoutSec) || 25)) * 1000,
            fragLoadingMaxRetry: Math.max(0, Math.min(10, Number(s.hlsFragMaxRetry) ?? 4)),
            maxBufferHole: Math.max(0.1, Math.min(5, (Number(s.hlsMaxBufferHoleMs) || 500) / 1000)),
        };
    }

    function buildWatchMpegtsConfig(eff) {
        const s = eff || getEffectiveStreamingSettings();
        return {
            enableWorker: s.mpegtsUseWorker !== false,
            enableStashBuffer: s.mpegtsStashBuffer !== false,
            stashInitialSize: Math.max(64, Math.min(2048, Number(s.mpegtsStashSizeKb) || 512)),
            liveBufferLatencyChasing: Boolean(s.mpegtsLiveLatencyChasing),
            liveBufferLatencyMaxLatency: Math.max(1, Math.min(20, Number(s.mpegtsMaxLatencySec) || 5)),
            liveBufferLatencyMinRemain: Math.max(0.5, Math.min(10, Number(s.mpegtsMinRemainSec) || 1.5)),
        };
    }

    const detectedWatchFormatCache = new Map();
    async function resolveWatchStreamKind(url, eff) {
        const hint = eff && eff.protocolHint ? eff.protocolHint : 'auto';
        if (hint === 'hls' || hint === 'mpegts' || hint === 'native') return hint;
        const low = String(url || '').split('?')[0].toLowerCase();
        if (low.includes('.m3u8')) return 'hls';
        if (low.endsWith('.ts')) return 'mpegts';
        if (/\.(mp4|webm|mkv|mov)$/i.test(low)) return 'native';
        if (detectedWatchFormatCache.has(url)) return detectedWatchFormatCache.get(url);
        try {
            const res = await fetch('/api/stream/detect?url=' + encodeURIComponent(url));
            const data = await res.json().catch(() => null);
            const kind = (data && (data.kind === 'hls' || data.kind === 'mpegts' || data.kind === 'native')) ? data.kind : 'hls';
            detectedWatchFormatCache.set(url, kind);
            return kind;
        } catch {
            return 'hls';
        }
    }

    function buildProxyCandidateUrl(targetUrl, ch) {
        let out = '/api/stream/proxy?url=' + encodeURIComponent(targetUrl);
        if (ch && typeof ch === 'object') {
            if (ch.userAgent) out += '&ua=' + encodeURIComponent(String(ch.userAgent));
            if (ch.referer) out += '&ref=' + encodeURIComponent(String(ch.referer));
            if (ch.origin) out += '&orig=' + encodeURIComponent(String(ch.origin));
        }
        return out;
    }

    function buildStreamCandidates(rawUrl, settings, ch) {
        const s = settings || getEffectiveStreamingSettings();
        const mode = STREAM_MODES.includes(s.mode) ? s.mode : 'auto_proxy_first';
        const tryHttps = s.tryHttpsUpgrade !== false;
        const isHttp = /^http:\/\//i.test(rawUrl);
        const httpsUrl = (tryHttps && isHttp) ? rawUrl.replace(/^http:/i, 'https:') : rawUrl;
        const canDirectPlainHttp = window.location.protocol !== 'https:' || isNativeTvApp();

        const proxyCandidates = [];
        if (httpsUrl !== rawUrl) {
            proxyCandidates.push({
                src: buildProxyCandidateUrl(httpsUrl, ch),
                label: 'proxy HTTPS'
            });
        }
        proxyCandidates.push({
            src: buildProxyCandidateUrl(rawUrl, ch),
            label: isHttp ? 'proxy HTTP' : 'proxy'
        });

        const directCandidates = [];
        if (httpsUrl !== rawUrl) {
            directCandidates.push({ src: httpsUrl, label: 'напрямую HTTPS' });
        }
        if (!isHttp || canDirectPlainHttp) {
            directCandidates.push({ src: rawUrl, label: isHttp ? 'напрямую HTTP' : 'напрямую HTTPS' });
        }

        const dedupe = (arr) => {
            const seen = new Set();
            return arr.filter((item) => {
                if (!item.src || seen.has(item.src)) return false;
                seen.add(item.src);
                return true;
            });
        };

        if (mode === 'proxy_only') return dedupe(proxyCandidates);
        if (mode === 'direct_only') return dedupe(directCandidates);
        if (mode === 'auto_direct_first') return dedupe([...directCandidates, ...proxyCandidates]);
        return dedupe([...proxyCandidates, ...directCandidates]);
    }

    async function loadStreamingSettings() {
        const res = await api('/watch/api/streaming-settings');
        if (res && res.settings) {
            serverStreamingSettings = Object.assign({}, serverStreamingSettings, res.settings);
            syncSettingsModalLabels();
        }
        return getEffectiveStreamingSettings();
    }

    function syncSettingsModalLabels() {
        if (setPlatformLabel) {
            setPlatformLabel.textContent = isNativeTvApp()
                ? 'Android TV (нативное APK-приложение)'
                : (document.documentElement.classList.contains('is-tv') ? 'Smart TV (браузер)' : 'Веб / PWA');
        }
        if (setCurrentVer) setCurrentVer.textContent = 'v' + currentAppName();
        if (setViewLabel) setViewLabel.textContent = 'Вид: ' + (viewMode === 'grid' ? 'Сетка' : 'Список');

        const eff = getEffectiveStreamingSettings();
        const modeText = STREAM_MODE_LABELS[eff.mode] || STREAM_MODE_LABELS.auto_proxy_first;
        if (setStreamModeVal) {
            setStreamModeVal.textContent = modeText + (eff.isOverride ? ' (локально)' : '');
        }
        if (setStreamModeLabel) {
            setStreamModeLabel.textContent = 'Поток: ' + modeText;
        }
        if (setStreamHttpsLabel) {
            setStreamHttpsLabel.textContent = 'HTTPS для http://: ' + (eff.tryHttpsUpgrade ? 'Вкл' : 'Выкл');
        }
    }

    function applyUpdateStatus(data) {
        if (!data || !data.ok) return;
        const hasApk = Boolean(data.hasApk && data.latest);
        latestApkInfo = hasApk ? data.latest : null;
        const isNative = isNativeTvApp();

        if (!hasApk) {
            if (setRemoteVer) setRemoteVer.textContent = 'APK не загружен';
            if (setChangelogBox) setChangelogBox.classList.add('hidden');
            if (setBtnInstallApk) setBtnInstallApk.classList.add('hidden');
            if (tvUpdateBtn) tvUpdateBtn.classList.add('hidden');
            return;
        }

        const remoteCode = Number(latestApkInfo.versionCode) || 0;
        const localCode = currentAppCode();
        const needsUpdate = isNative ? remoteCode > localCode : true;

        if (setRemoteVer) {
            setRemoteVer.textContent = 'v' + latestApkInfo.versionName + (isNative && remoteCode <= localCode ? ' (актуально)' : '');
        }
        if (setChangelogBox) {
            if (latestApkInfo.changelog) {
                setChangelogBox.textContent = 'Изменения: ' + latestApkInfo.changelog;
                setChangelogBox.classList.remove('hidden');
            } else {
                setChangelogBox.classList.add('hidden');
            }
        }
        if (setBtnInstallApk) {
            const btnSpan = setBtnInstallApk.querySelector('span');
            if (btnSpan) {
                btnSpan.textContent = isNative
                    ? ('Обновить до v' + latestApkInfo.versionName)
                    : ('Скачать APK v' + latestApkInfo.versionName);
            }
            setBtnInstallApk.classList.toggle('hidden', !needsUpdate);
        }
        if (tvUpdateBtn) {
            const showTopBtn = isNative ? (remoteCode > localCode) : true;
            tvUpdateBtn.classList.toggle('hidden', !showTopBtn);
            if (tvUpdateBtnText) {
                tvUpdateBtnText.textContent = isNative
                    ? ('Обновить до v' + latestApkInfo.versionName)
                    : ('APK v' + latestApkInfo.versionName);
            }
        }
    }

    async function checkTvUpdate(manual) {
        if (manual && setRemoteVer) setRemoteVer.textContent = 'Проверка...';
        try {
            const code = isNativeTvApp() ? currentAppCode() : 0;
            const res = await fetch('/api/app/version?currentCode=' + encodeURIComponent(String(code)) + '&_=' + Date.now(), {
                credentials: 'same-origin'
            });
            const data = await res.json();
            applyUpdateStatus(data);
        } catch {
            if (manual && setRemoteVer) setRemoteVer.textContent = 'Ошибка проверки';
        }
    }

    function installLatestApk() {
        if (!latestApkInfo) return;
        const url = latestApkInfo.apkUrl || '/apk/latest.apk';
        const ver = latestApkInfo.versionName || 'latest';
        if (window.PQTVAndroid && typeof window.PQTVAndroid.installUpdate === 'function') {
            window.PQTVAndroid.installUpdate(url, ver);
        } else {
            const a = document.createElement('a');
            a.href = url;
            a.download = latestApkInfo.filename || ('pqtv-v' + ver + '.apk');
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
    }

    window.onPQTVUpdateInfo = (info) => { applyUpdateStatus(info); };
    window.onPQTVDownloadProgress = (pct, state) => {
        if (!tvProgressWrap) return;
        if (state === 'error' || Number(pct) < 0) {
            tvProgressWrap.classList.remove('hidden');
            if (tvProgressLabel) tvProgressLabel.textContent = 'Ошибка загрузки APK';
            if (tvProgressFill) tvProgressFill.style.width = '0%';
            return;
        }
        tvProgressWrap.classList.remove('hidden');
        if (tvProgressLabel) {
            tvProgressLabel.textContent = state === 'ready' ? 'Загрузка завершена — запуск установки...' : ('Загрузка APK: ' + pct + '%');
        }
        if (tvProgressFill) tvProgressFill.style.width = Math.min(100, Math.max(0, Number(pct) || 0)) + '%';
    };

    function openSettingsModal() {
        if (!settingsModal) return;
        syncSettingsModalLabels();
        settingsModal.classList.remove('hidden');
        checkTvUpdate(true);
        const firstBtn = settingsModal.querySelector('button:not(.hidden)');
        if (firstBtn) setFocus(firstBtn);
    }
    function closeSettingsModal() {
        if (!settingsModal) return;
        settingsModal.classList.add('hidden');
    }

    const settingsBtn = $('btn-settings');
    if (settingsBtn) settingsBtn.onclick = openSettingsModal;
    const profileBox = $('tb-profile');
    if (profileBox) profileBox.onclick = openSettingsModal;
    if (tvUpdateBtn) tvUpdateBtn.onclick = () => {
        if (isNativeTvApp() && latestApkInfo) installLatestApk();
        else openSettingsModal();
    };
    async function cycleStreamMode() {
        const eff = getEffectiveStreamingSettings();
        const curIdx = STREAM_MODES.indexOf(eff.mode);
        if (window.IS_ADMIN_VIEWER) {
            const nextMode = STREAM_MODES[(curIdx + 1) % STREAM_MODES.length];
            const nextSettings = Object.assign({}, serverStreamingSettings, { mode: nextMode });
            try {
                const saved = await apiAdmin('/watch/api/admin/streaming-settings', 'POST', nextSettings);
                if (saved && saved.settings) serverStreamingSettings = saved.settings;
                else serverStreamingSettings = nextSettings;
                if (window.PQTVFirebase && typeof window.PQTVFirebase.saveStreamingSettingsToCloud === 'function') {
                    const isCloudAdmin = await window.PQTVFirebase.isSignedInAdmin().catch(() => false);
                    if (isCloudAdmin) {
                        await window.PQTVFirebase.saveStreamingSettingsToCloud(serverStreamingSettings).catch(() => {});
                        if (typeof saved.revision === 'number' && typeof window.PQTVFirebase.bumpCloudManifestRevision === 'function') {
                            await window.PQTVFirebase.bumpCloudManifestRevision(saved.revision).catch(() => {});
                        }
                    }
                }
            } catch {}
        } else {
            const existingOverride = localStorage.getItem('pqtv_stream_mode') || '';
            if (!existingOverride) {
                localStorage.setItem('pqtv_stream_mode', STREAM_MODES[(curIdx + 1) % STREAM_MODES.length]);
            } else if (curIdx === STREAM_MODES.length - 1) {
                localStorage.removeItem('pqtv_stream_mode');
            } else {
                localStorage.setItem('pqtv_stream_mode', STREAM_MODES[curIdx + 1]);
            }
        }
        syncSettingsModalLabels();
        if (previewChannel && playerModal.classList.contains('hidden')) {
            startPreviewStream(previewChannel);
        }
    }

    async function toggleStreamHttps() {
        const eff = getEffectiveStreamingSettings();
        const nextHttps = !eff.tryHttpsUpgrade;
        if (window.IS_ADMIN_VIEWER) {
            const nextSettings = Object.assign({}, serverStreamingSettings, { tryHttpsUpgrade: nextHttps });
            try {
                const saved = await apiAdmin('/watch/api/admin/streaming-settings', 'POST', nextSettings);
                if (saved && saved.settings) serverStreamingSettings = saved.settings;
                else serverStreamingSettings = nextSettings;
                if (window.PQTVFirebase && typeof window.PQTVFirebase.saveStreamingSettingsToCloud === 'function') {
                    const isCloudAdmin = await window.PQTVFirebase.isSignedInAdmin().catch(() => false);
                    if (isCloudAdmin) {
                        await window.PQTVFirebase.saveStreamingSettingsToCloud(serverStreamingSettings).catch(() => {});
                    }
                }
            } catch {}
        } else {
            localStorage.setItem('pqtv_stream_https', nextHttps ? '1' : '0');
        }
        syncSettingsModalLabels();
        if (previewChannel && playerModal.classList.contains('hidden')) {
            startPreviewStream(previewChannel);
        }
    }

    if (setBtnStreamMode) setBtnStreamMode.onclick = () => { void cycleStreamMode(); };
    if (setBtnStreamHttps) setBtnStreamHttps.onclick = () => { void toggleStreamHttps(); };
    if (setBtnCheckUpdate) setBtnCheckUpdate.onclick = () => {
        checkTvUpdate(true);
        if (window.PQTVAndroid && typeof window.PQTVAndroid.checkForUpdate === 'function') {
            window.PQTVAndroid.checkForUpdate();
        }
    };
    if (setBtnInstallApk) setBtnInstallApk.onclick = installLatestApk;
    if (setBtnToggleView) setBtnToggleView.onclick = () => {
        viewMode = viewMode === 'grid' ? 'list' : 'grid';
        localStorage.setItem('pqtv_view', viewMode);
        applyViewMode();
        renderChannels();
        syncSettingsModalLabels();
    };
    if (settingsModal) {
        settingsModal.querySelectorAll('[data-settings-close]').forEach(el => { el.onclick = closeSettingsModal; });
    }

    // ===== AVAILABILITY TRACKING & UNAVAILABLE MODAL =====
    const summaryCountsEl = $('watch-summary-counts');
    const unavailBtnEl = $('btn-unavailable-channels');
    const unavailCountEl = $('watch-unavail-count');
    const unavailModal = $('unavailable-modal');
    const unavailListEl = $('unavailable-list');
    const unavailSubEl = $('unavail-modal-subtitle');

    function getCombinedUnavailable(includeHidden) {
        const list = [];
        const seen = new Set();
        const addItem = (name, group, reason, extra) => {
            const cleanName = String(name || '').trim();
            if (!cleanName) return;
            const k = cleanName.toLowerCase();
            if (seen.has(k)) return;
            seen.add(k);
            list.push(Object.assign({
                name: cleanName,
                group: String(group || '').trim(),
                reason: String(reason || 'Недоступен')
            }, extra || {}));
        };

        for (const item of serverUnavailable) {
            addItem(item.name, item.group || item.playlist || '', item.reason || 'Недоступен на сервере');
        }
        for (const item of runtimeUnavailable.values()) {
            if (hidden.has((item.name || '').toLowerCase())) continue;
            addItem(item.name, item.group || '', item.reason || 'Ошибка воспроизведения');
        }
        if (includeHidden) {
            for (const ch of channels) {
                const k = keyOf(ch);
                if (hidden.has(k)) {
                    addItem(ch.name, ch.group || '', 'Скрыт пользователем', { hiddenKey: k });
                }
            }
        }
        return list;
    }

    function updateAvailabilitySummary() {
        const total = Math.max(Number(serverStats.total) || 0, channels.length);
        let available = 0;
        for (const ch of channels) {
            const k = keyOf(ch);
            if (!hidden.has(k)) available++;
        }
        if (summaryCountsEl) {
            summaryCountsEl.innerHTML = 'Доступно каналов: <strong>' + available + '</strong> из <strong>' + total + '</strong>';
        }
        const allUnavail = getCombinedUnavailable(true);
        if (unavailCountEl) unavailCountEl.textContent = String(allUnavail.length);
        if (unavailBtnEl) unavailBtnEl.classList.toggle('hidden', allUnavail.length === 0);
    }

    function scheduleUnavailableReport() {
        clearTimeout(reportTimer);
        reportTimer = setTimeout(async () => {
            const reportItems = getCombinedUnavailable(false).map(it => ({
                name: it.name,
                group: it.group || '',
                reason: it.reason
            }));
            const totalChannels = Math.max(Number(serverStats.total) || 0, channels.length + serverUnavailable.length);
            const sig = totalChannels + '|' + JSON.stringify(reportItems);
            if (sig === lastReportSig) return;
            lastReportSig = sig;

            try {
                await fetch('/watch/api/report-unavailable', {
                    method: 'POST',
                    credentials: 'same-origin',
                    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders()),
                    body: JSON.stringify({ totalChannels, items: reportItems })
                });
            } catch {}

            if (reportItems.length > 0 && window.PQTVFirebase && typeof window.PQTVFirebase.reportViewerUnavailable === 'function') {
                window.PQTVFirebase.reportViewerUnavailable({
                    userLogin: USER,
                    userName: window.USER_NAME || USER,
                    totalChannels,
                    items: reportItems
                }).catch(() => {});
            }
        }, 600);
    }

    function recordRuntimeUnavailable(ch, reason) {
        if (!ch || !ch.name) return;
        const k = keyOf(ch);
        if (hidden.has(k)) return;
        const cleanReason = String(reason || 'Ошибка воспроизведения потока');
        const prev = runtimeUnavailable.get(k);
        if (prev && prev.reason === cleanReason) return;
        runtimeUnavailable.set(k, {
            name: ch.name,
            group: ch.group || '',
            reason: cleanReason
        });
        updateAvailabilitySummary();
        scheduleUnavailableReport();
    }

    function clearRuntimeUnavailable(ch) {
        if (!ch || !ch.name) return;
        const k = keyOf(ch);
        if (!runtimeUnavailable.has(k)) return;
        runtimeUnavailable.delete(k);
        updateAvailabilitySummary();
        scheduleUnavailableReport();
    }

    function renderUnavailableModal() {
        if (!unavailListEl) return;
        const items = getCombinedUnavailable(true);
        if (unavailSubEl) {
            unavailSubEl.textContent = items.length > 0
                ? ('Отчётов об ошибках воспроизведения и скрытых каналов: ' + items.length)
                : 'Все каналы доступны';
        }
        if (items.length === 0) {
            unavailListEl.innerHTML = '<div style="padding:18px; text-align:center; color:var(--muted);">Отчётов о проблемах воспроизведения нет</div>';
            return;
        }
        unavailListEl.innerHTML = items.map(it => {
            const actionHtml = it.hiddenKey
                ? '<div class="tv-row-actions"><button type="button" class="tv-inline-btn" data-unhide-key="' + esc(it.hiddenKey) + '">Вернуть</button></div>'
                : '';
            return '<div class="tv-row-card">' +
                '<div class="tv-row-main">' +
                    '<div class="tv-row-title">' + esc(it.name) +
                        (it.group ? ' <span class="tv-badge tv-badge-blue">' + esc(it.group) + '</span>' : '') +
                    '</div>' +
                    '<div class="tv-row-reason">' + esc(it.reason) + '</div>' +
                '</div>' +
                actionHtml +
            '</div>';
        }).join('');

        unavailListEl.querySelectorAll('[data-unhide-key]').forEach(btn => {
            btn.onclick = () => {
                const k = btn.dataset.unhideKey;
                if (k && hidden.has(k)) {
                    hidden.delete(k);
                    saveHidden();
                    renderCategories();
                    renderChannels();
                    updateAvailabilitySummary();
                    renderUnavailableModal();
                }
            };
        });
    }

    function openUnavailableModal() {
        if (!unavailModal) return;
        renderUnavailableModal();
        unavailModal.classList.remove('hidden');
        const first = unavailModal.querySelector('button');
        if (first) setFocus(first);
    }

    function closeUnavailableModal() {
        if (!unavailModal) return;
        unavailModal.classList.add('hidden');
        if (unavailBtnEl && !unavailBtnEl.classList.contains('hidden')) {
            setFocus(unavailBtnEl);
        }
    }

    if (unavailBtnEl) unavailBtnEl.onclick = openUnavailableModal;
    if (unavailModal) {
        unavailModal.querySelectorAll('[data-unavail-close]').forEach(el => { el.onclick = closeUnavailableModal; });
    }

    // ===== LOAD CHANNELS =====
    async function loadChannels() {
        const res = await api('/watch/api/channels?_=' + Date.now());
        if (res && res.streaming && typeof res.streaming === 'object') {
            serverStreamingSettings = Object.assign({}, serverStreamingSettings, res.streaming);
            syncSettingsModalLabels();
        }
        if (res && res.uiSettings && typeof res.uiSettings === 'object') {
            applyUiSettings(res.uiSettings);
        }
        channels = Array.isArray(res.channels) ? res.channels : [];
        serverUnavailable = Array.isArray(res.unavailable) ? res.unavailable : [];
        serverStats = (res.stats && typeof res.stats === 'object')
            ? res.stats
            : { total: channels.length, available: channels.length, unavailable: 0 };
        const activeKeys = new Set(channels.map(c => keyOf(c)));
        for (const k of [...runtimeUnavailable.keys()]) {
            if (!activeKeys.has(k)) runtimeUnavailable.delete(k);
        }
        loadFavs();
        loadHidden();
        renderCategories();
        renderChannels();
        updateAvailabilitySummary();
        scheduleUnavailableReport();
    }

    function groupCounts() {
        const m = new Map();
        channels.forEach(ch => {
            if (hidden.has(keyOf(ch))) return;
            const g = (ch.group || '').trim() || 'Без категории';
            m.set(g, (m.get(g) || 0) + 1);
        });
        return m;
    }

    function renderCategories() {
        const counts = groupCounts();
        const favCount = channels.filter(ch => !hidden.has(keyOf(ch)) && favorites.has(keyOf(ch))).length;
        const hiddenCount = channels.filter(ch => hidden.has(keyOf(ch))).length;
        const visibleTotal = channels.length - hiddenCount;

        let html = '';

        // Избранное
        html += `<button class="cat-btn ${currentGroup === '__fav__' ? 'active' : ''}" data-group="__fav__">
            <span class="cat-icon">${IC.catStar}</span>
            <span class="cat-name">Избранное</span>
            <span class="cat-count">${favCount}</span>
        </button>`;

        // Все
        html += `<button class="cat-btn ${currentGroup === '__all__' ? 'active' : ''}" data-group="__all__">
            <span class="cat-icon">${IC.catAll}</span>
            <span class="cat-name">Все каналы</span>
            <span class="cat-count">${visibleTotal}</span>
        </button>`;

        // Категории (по алфавиту)
        const sorted = [...counts.entries()].sort((a,b) => a[0].localeCompare(b[0], 'ru'));
        sorted.forEach(([g, n]) => {
            html += `<button class="cat-btn ${currentGroup === g ? 'active' : ''}" data-group="${esc(g)}">
                <span class="cat-icon">${iconForGroup(g)}</span>
                <span class="cat-name">${esc(g)}</span>
                <span class="cat-count">${n}</span>
            </button>`;
        });

        // Скрытые (если есть)
        if (hiddenCount > 0) {
            html += `<button class="cat-btn hidden-cat ${currentGroup === '__hidden__' ? 'active' : ''}" data-group="__hidden__">
                <span class="cat-icon">${IC.catEye}</span>
                <span class="cat-name">Скрытые</span>
                <span class="cat-count">${hiddenCount}</span>
            </button>`;
        }

        catsEl.innerHTML = html;
        catsEl.querySelectorAll('.cat-btn').forEach(btn => {
            btn.onclick = () => {
                currentGroup = btn.dataset.group;
                previewChannel = null;
                renderCategories();
                renderChannels();  // updatePreview первой карточки произойдёт внутри renderChannels
            };
        });
    }

    function filterChannels() {
        const q = searchQuery.trim().toLowerCase();
        const filteredChannels = channels.filter(ch => {
            const k = keyOf(ch);
            const isHidden = hidden.has(k);

            if (currentGroup === '__hidden__') {
                if (!isHidden) return false;
            } else {
                if (isHidden) return false;
            }

            if (currentGroup === '__fav__') {
                if (!favorites.has(k)) return false;
            } else if (currentGroup !== '__all__' && currentGroup !== '__hidden__') {
                const g = (ch.group || '').trim() || 'Без категории';
                if (g !== currentGroup) return false;
            }

            if (q) {
                const hay = (ch.name + ' ' + (ch.group || '')).toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });
        return filteredChannels.sort((left, right) => {
            const leftGroup = (left.group || '').trim() || 'Без категории';
            const rightGroup = (right.group || '').trim() || 'Без категории';
            const byGroup = leftGroup.localeCompare(rightGroup, 'ru', { numeric: true, sensitivity: 'base' });
            return byGroup || String(left.name || '').localeCompare(String(right.name || ''), 'ru', { numeric: true, sensitivity: 'base' });
        });
    }

    function renderChannels() {
        filtered = filterChannels();

        if (filtered.length === 0) {
            gridEl.innerHTML = `<div class="watch-empty">${channels.length === 0 ? 'Список каналов пуст' : 'Ничего не найдено'}</div>`;
            return;
        }

        let html = '';
        filtered.forEach((ch, i) => {
            const k = keyOf(ch);
            const isFav = favorites.has(k);
            const logoSrc = ch.logo ? `<img src="${esc(ch.logo)}" data-logo="${i}" alt="">` : IC.tv;
            const cached = epgCache.get(k);
            const nowText = cached && cached.loaded
                ? (cached.current ? cached.current.title : '')
                : '...';

            html += `<div class="ch-card" data-idx="${i}" tabindex="0">
                <div class="ch-logo-wrap">${logoSrc}</div>
                <div class="ch-info">
                    <div class="ch-name">${esc(ch.name)}</div>
                    <div class="ch-now ${cached && cached.loaded ? '' : 'loading'}" data-epg-for="${i}">${esc(nowText)}</div>
                </div>
                <button class="ch-fav ${isFav ? 'active' : ''}" data-fav="${i}" tabindex="-1" title="Избранное">
                    ${isFav ? IC.starFill : IC.star}
                </button>
            </div>`;
        });
        gridEl.innerHTML = html;

        gridEl.querySelectorAll('[data-logo]').forEach(img => {
            img.onerror = () => { img.parentNode.innerHTML = IC.tv; };
        });
        gridEl.querySelectorAll('[data-fav]').forEach(btn => {
            btn.onclick = (e) => { e.stopPropagation(); const i = +btn.dataset.fav; const ch = filtered[i]; if (ch) toggleFav(keyOf(ch)); };
        });
        gridEl.querySelectorAll('.ch-card').forEach(card => {
            card.onclick = (e) => {
                if (e.target.closest('.ch-fav')) return;
                const i = +card.dataset.idx;
                const ch = filtered[i];
                if (ch) openFullscreenPlayer(ch);
            };
            card.addEventListener('focus', () => {
                const i = +card.dataset.idx;
                const ch = filtered[i];
                if (ch) updatePreview(ch);
            });
        });

        // Автопревью: показываем первый канал при любой смене категории/поиска
        if (filtered.length > 0) {
            const first = filtered[0];
            const sameAsCurrent = previewChannel && keyOf(previewChannel) === keyOf(first);
            if (!sameAsCurrent) {
                updatePreview(first);
            }
        }

        // Подгрузка EPG для всех видимых каналов (для строки в списке)
        scheduleEpgLoads();
    }

    // ===== EPG BATCH LOAD =====
    function scheduleEpgLoads() {
        // грузим EPG по 3 канала за раз, чтобы не задушить сервер
        const pending = filtered.filter(ch => {
            const k = keyOf(ch);
            return !epgCache.has(k) && !epgLoadQueue.has(k);
        });
        pending.forEach(ch => epgLoadQueue.add(keyOf(ch)));

        let running = 0;
        const MAX = 3;
        function pump() {
            while (running < MAX) {
                const nextKey = [...epgLoadQueue].find(k => !epgCache.has(k));
                if (!nextKey) break;
                epgLoadQueue.delete(nextKey);
                const ch = channels.find(c => keyOf(c) === nextKey);
                if (!ch) continue;
                running++;
                loadEpgFor(ch).finally(() => {
                    running--;
                    updateCardEpg(nextKey);
                    pump();
                });
            }
        }
        pump();
    }

    async function loadEpgFor(ch) {
        const k = keyOf(ch);
        try {
            const qs = new URLSearchParams();
            if (ch.tvg_id) qs.set('tvg_id', ch.tvg_id);
            if (ch.name) qs.set('name', ch.name);
            qs.set('_', Date.now());
            const r = await fetch('/watch/api/epg/now?' + qs.toString(), {
                credentials: 'same-origin',
                headers: authHeaders()
            });
            if (!r.ok) throw new Error();
            const d = await r.json();
            epgCache.set(k, { loaded: true, current: d.current || null, next: d.next || null });
        } catch (e) {
            epgCache.set(k, { loaded: true, current: null, next: null });
        }
    }

    function updateCardEpg(k) {
        const c = epgCache.get(k);
        if (!c) return;
        // Найти в DOM карточки с этим ключом
        gridEl.querySelectorAll('.ch-card').forEach(card => {
            const i = +card.dataset.idx;
            const ch = filtered[i];
            if (!ch || keyOf(ch) !== k) return;
            const el = card.querySelector('.ch-now');
            if (el) {
                if (c.current) {
                    el.textContent = c.current.title || '';
                    el.classList.remove('loading');
                } else {
                    el.textContent = '';
                }
            }
        });
    }

    // ===== PREVIEW =====
    // ============ PREVIEW (простая версия) ============
    let previewHls = null;
    let previewMpegts = null;
    let previewKey = null;
    let previewDebounceTimer = null;
    let previewAttemptTimer = null;
    let previewAttemptId = 0;

    function updatePreview(ch) {
        if (!ch) return;

        const newKey = keyOf(ch);
        previewChannel = ch;

        // Мгновенно — текст
        previewCat.textContent = ch.group || 'Канал';
        previewName.textContent = ch.name || '—';

        // Лого
        if (ch.logo) {
            previewLogo.src = ch.logo;
            previewLogo.style.display = '';
            previewPlaceholder.style.display = 'none';
            previewLogo.onerror = () => {
                previewLogo.style.display = 'none';
                previewPlaceholder.style.display = '';
            };
        } else {
            previewLogo.style.display = 'none';
            previewPlaceholder.style.display = '';
        }

        // EPG
        const cached = epgCache.get(newKey);
        if (cached && cached.loaded) {
            applyPreviewEpg(cached);
        } else {
            epgCurrent.textContent = 'Загрузка...';
            epgCurrent.classList.remove('empty');
            epgProgress.style.display = 'none';
            loadEpgFor(ch).then(() => {
                if (previewKey === newKey) applyPreviewEpg(epgCache.get(newKey));
            });
        }

        // Если тот же канал — не перезапускаем
        if (previewKey === newKey && previewVideoHost.classList.contains('active')) {
            previewKey = newKey;
            return;
        }
        previewKey = newKey;

        const eff = getEffectiveStreamingSettings();
        if (eff.previewEnabled === false) {
            stopPreviewStream();
            return;
        }
        const delayMs = Math.max(0, Math.min(3000, Number(eff.previewDebounceMs) ?? 450));

        clearTimeout(previewDebounceTimer);
        previewDebounceTimer = setTimeout(() => {
            if (previewKey !== newKey) return;
            startPreviewStream(ch);
        }, delayMs);
    }

    function applyPreviewEpg(c) {
        if (!c) return;
        if (c.current) {
            epgCurrent.textContent = c.current.title || '—';
            epgCurrent.classList.remove('empty');
            const now = Math.floor(Date.now() / 1000);
            const dur = c.current.stop - c.current.start;
            if (dur > 0 && now >= c.current.start && now <= c.current.stop) {
                const pct = Math.min(100, Math.max(0, ((now - c.current.start) / dur) * 100));
                epgStart.textContent = fmtTime(c.current.start);
                epgStop.textContent = fmtTime(c.current.stop);
                epgBarFill.style.width = pct + '%';
                epgProgress.style.display = '';
            } else {
                epgProgress.style.display = 'none';
            }
        } else {
            epgCurrent.textContent = 'Телепрограмма не найдена';
            epgCurrent.classList.add('empty');
            epgProgress.style.display = 'none';
        }
    }

    function stopPreviewStream() {
        clearTimeout(previewDebounceTimer);
        clearTimeout(previewAttemptTimer);
        previewAttemptId++;
        if (previewHls) { try { previewHls.destroy(); } catch(e){} previewHls = null; }
        if (previewMpegts) { try { previewMpegts.destroy(); } catch(e){} previewMpegts = null; }
        try {
            previewVideo.pause();
            previewVideo.removeAttribute('src');
            previewVideo.load();
        } catch (e) {}
        previewVideoHost.classList.remove('active');
        previewLogoWrap.classList.remove('hidden');
        if (previewLoading) previewLoading.classList.add('hidden');
    }

    function startPreviewStream(ch) {
        if (!ch || !ch.url) return;
        const eff = getEffectiveStreamingSettings();
        if (eff.previewEnabled === false) {
            stopPreviewStream();
            return;
        }
        stopPreviewStream();

        previewLoading.classList.remove('hidden');

        const url = ch.url;
        const candidates = buildStreamCandidates(url, eff, ch);
        let candidateIdx = 0;
        let resolvedKind = 'hls';

        const onReady = () => {
            clearTimeout(previewAttemptTimer);
            previewLoading.classList.add('hidden');
            previewVideoHost.classList.add('active');
            previewLogoWrap.classList.add('hidden');
        };
        const onAllFailed = () => {
            clearTimeout(previewAttemptTimer);
            previewLoading.classList.add('hidden');
            previewVideoHost.classList.remove('active');
            previewLogoWrap.classList.remove('hidden');
        };

        const tryPlay = (attemptToken) => {
            if (attemptToken !== previewAttemptId) return;
            const p = previewVideo.play();
            if (p && p.catch) {
                p.catch(err => {
                    if (attemptToken !== previewAttemptId) return;
                    if (err && err.name === 'NotAllowedError') {
                        previewVideo.muted = true;
                        previewMuted = true;
                        applyPreviewMute();
                        previewVideo.play().catch(()=>{});
                    }
                });
            }
        };

        const runAttempt = (cand) => {
            if (!cand) {
                onAllFailed();
                return;
            }
            const myAttempt = ++previewAttemptId;
            clearTimeout(previewAttemptTimer);
            if (previewHls) { try { previewHls.destroy(); } catch(e){} previewHls = null; }
            if (previewMpegts) { try { previewMpegts.destroy(); } catch(e){} previewMpegts = null; }
            try {
                previewVideo.pause();
                previewVideo.removeAttribute('src');
                previewVideo.load();
            } catch (e) {}

            let settled = false;
            const advance = () => {
                if (settled || myAttempt !== previewAttemptId) return;
                settled = true;
                clearTimeout(previewAttemptTimer);
                if (candidateIdx < candidates.length) {
                    runAttempt(candidates[candidateIdx++]);
                } else {
                    onAllFailed();
                }
            };

            const timeoutMs = Math.max(4, Math.min(60, Number(eff.attemptTimeoutSec) || 15)) * 1000;
            previewAttemptTimer = setTimeout(advance, timeoutMs);

            previewVideo.onloadeddata = () => {
                if (myAttempt !== previewAttemptId) return;
                settled = true;
                onReady();
            };
            previewVideo.oncanplay = () => {
                if (myAttempt !== previewAttemptId) return;
                settled = true;
                onReady();
            };
            previewVideo.onerror = advance;

            if (resolvedKind === 'hls' && window.Hls && window.Hls.isSupported()) {
                previewHls = new Hls(buildWatchHlsConfig(eff, true));
                previewHls.loadSource(cand.src);
                previewHls.attachMedia(previewVideo);
                previewHls.on(Hls.Events.MANIFEST_PARSED, () => tryPlay(myAttempt));
                previewHls.on(Hls.Events.ERROR, (e, d) => {
                    if (d && d.fatal) advance();
                });
            } else if (resolvedKind === 'mpegts' && window.mpegts && window.mpegts.isSupported()) {
                previewMpegts = mpegts.createPlayer({
                    type: 'mpegts',
                    url: cand.src,
                    isLive: true
                }, buildWatchMpegtsConfig(eff));
                previewMpegts.attachMediaElement(previewVideo);
                previewMpegts.load();
                previewMpegts.play().catch(()=>{});
                previewMpegts.on(mpegts.Events.ERROR, advance);
            } else {
                previewVideo.src = cand.src;
                tryPlay(myAttempt);
            }
        };

        if (candidates.length === 0) {
            onAllFailed();
            return;
        }
        const launchAttemptToken = ++previewAttemptId;
        void resolveWatchStreamKind(url, eff).then((kind) => {
            if (launchAttemptToken !== previewAttemptId) return;
            resolvedKind = kind;
            runAttempt(candidates[candidateIdx++]);
        });
    }

    // Клик по кнопке fullscreen на превью
    const previewFsBtn = $('preview-fs-btn');
    if (previewFsBtn) previewFsBtn.onclick = () => { if (previewChannel) openFullscreenPlayer(previewChannel); };

    // Preview mute
    let previewMuted = localStorage.getItem('pqtv_preview_muted') === '1';
    function applyPreviewMute() {
        previewVideo.muted = previewMuted;
        const mIcon = document.querySelector('#preview-mute-btn .ico-muted');
        const sIcon = document.querySelector('#preview-mute-btn .ico-sound');
        if (mIcon) mIcon.style.display = previewMuted ? '' : 'none';
        if (sIcon) sIcon.style.display = previewMuted ? 'none' : '';
    }
    applyPreviewMute();
    const previewMuteBtn = $('preview-mute-btn');
    if (previewMuteBtn) previewMuteBtn.onclick = () => {
        previewMuted = !previewMuted;
        localStorage.setItem('pqtv_preview_muted', previewMuted ? '1' : '0');
        applyPreviewMute();
    };

    // ===== FAVORITES =====
    function toggleFav(k) {
        if (favorites.has(k)) favorites.delete(k); else favorites.add(k);
        saveFavs();
        renderCategories();
        renderChannels();
    }

    // ===== SEARCH =====
    if (searchEl) {
        let t = null;
        searchEl.oninput = () => {
            clearTimeout(t);
            t = setTimeout(() => { searchQuery = searchEl.value; renderChannels(); }, 150);
        };
    }

    // ===== CHANNEL MENU =====
    function openChannelMenu(ch) {
        channelMenuTarget = ch;

        if (ch.logo) {
            menuLogo.src = ch.logo;
            menuLogo.style.display = '';
            menuPh.style.display = 'none';
            menuLogo.onerror = () => { menuLogo.style.display = 'none'; menuPh.style.display = ''; };
        } else {
            menuLogo.style.display = 'none';
            menuPh.style.display = '';
        }
        menuTitle.textContent = ch.name || '—';
        menuCat.textContent = ch.group || '';

        const k = keyOf(ch);
        const isFav = favorites.has(k);
        const isHidden = hidden.has(k);
        menuFavText.textContent = isFav ? 'Из избранного' : 'В избранное';
        menuHideText.textContent = isHidden ? 'Вернуть в список' : 'Скрыть из списка';

        menuProgram.classList.add('hidden');
        menu.classList.remove('hidden');
    }
    function closeChannelMenu() {
        menu.classList.add('hidden');
        channelMenuTarget = null;
    }
    menu.querySelectorAll('[data-menu-close]').forEach(el => el.onclick = closeChannelMenu);

    menu.querySelectorAll('[data-ch-action]').forEach(btn => {
        btn.onclick = async () => {
            const ch = channelMenuTarget;
            if (!ch) return;
            const act = btn.dataset.chAction;
            const k = keyOf(ch);

            if (act === 'watch') {
                closeChannelMenu();
                openFullscreenPlayer(ch);
            } else if (act === 'program') {
                menuProgram.classList.toggle('hidden');
                if (!menuProgram.classList.contains('hidden')) {
                    cmpCurrent.textContent = 'Загрузка...';
                    cmpNext.textContent = 'Загрузка...';
                    let c = epgCache.get(k);
                    if (!c || !c.loaded) { await loadEpgFor(ch); c = epgCache.get(k); }
                    cmpCurrent.textContent = (c && c.current) ? c.current.title : 'Нет данных';
                    cmpNext.textContent = (c && c.next) ? c.next.title : 'Нет данных';
                }
            } else if (act === 'fav') {
                toggleFav(k);
                closeChannelMenu();
            } else if (act === 'hide') {
                if (hidden.has(k)) hidden.delete(k); else hidden.add(k);
                saveHidden();
                renderCategories();
                renderChannels();
                updateAvailabilitySummary();
                closeChannelMenu();
            }
        };
    });

    // ===== FULLSCREEN PLAYER =====
    let hls = null, mpegtsP = null;
    let playerSessionId = 0;

    function setPlayerOverlayChannel(ch) {
        const logoImg = $('player-overlay-logo');
        const logoPh = $('player-overlay-ph');
        const titleEl = $('player-overlay-title');
        if (titleEl) titleEl.textContent = (ch && ch.name) ? ch.name : 'Канал';
        if (logoImg && logoPh) {
            logoImg.onerror = null;
            if (ch && ch.logo) {
                logoImg.src = ch.logo;
                logoImg.style.display = '';
                logoPh.style.display = 'none';
                logoImg.onerror = () => {
                    logoImg.style.display = 'none';
                    logoPh.style.display = '';
                };
            } else {
                logoImg.removeAttribute('src');
                logoImg.style.display = 'none';
                logoPh.style.display = '';
            }
        }
    }

    function setPlayerStage(stageName, state, detail) {
        const stagesEl = $('player-overlay-stages');
        if (!stagesEl) return;
        const row = stagesEl.querySelector('[data-stage="' + stageName + '"]');
        if (!row) return;
        row.setAttribute('data-state', state);
        const ico = row.querySelector('.player-stage-ico');
        if (ico) {
            if (state === 'done') ico.innerHTML = IC.check;
            else if (state === 'error') ico.innerHTML = IC.warn;
            else ico.innerHTML = '';
        }
        const detailEl = row.querySelector('.player-stage-detail');
        if (detailEl && detail !== undefined) {
            detailEl.textContent = detail || '';
        }
    }

    function resetPlayerOverlayState(ch) {
        setPlayerOverlayChannel(ch);
        setPlayerStage('prepare', 'active', '');
        setPlayerStage('connect', 'pending', '');
        setPlayerStage('buffer', 'pending', '');
        const text = $('player-overlay-text');
        const errBox = $('player-overlay-error');
        if (text) {
            text.textContent = 'Подготовка параметров потока...';
            text.classList.remove('hidden');
        }
        if (errBox) errBox.classList.add('hidden');
    }

    function openFullscreenPlayer(ch) {
        if (!ch) return;
        window.__playerChannel = ch;
        // Останавливаем превью, чтобы не тянул трафик параллельно
        stopPreviewStream();
        if (previewLoading) previewLoading.classList.add('hidden');

        applyUiSettings(serverUiSettings);
        loadUiSettings().catch(() => {});
        playerModal.classList.remove('hidden');
        document.body.classList.add('player-open');
        playStream(ch.url, ch);
    }

    function closePlayer() {
        playerModal.classList.add('hidden');
        document.body.classList.remove('player-open');
        stopStream();
        if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});

        // Возвращаем preview текущего канала
        const eff = getEffectiveStreamingSettings();
        if (previewChannel && eff.previewEnabled !== false) {
            const resumeMs = Math.max(0, Math.min(3000, Number(eff.previewResumeDelayMs) ?? 350));
            setTimeout(() => startPreviewStream(previewChannel), resumeMs);
        }
    }

    let playerAttemptTimer = null;
    let playerCodecTimer = null;

    function stopStream() {
        playerSessionId++;
        clearTimeout(playerAttemptTimer);
        clearTimeout(playerCodecTimer);
        const v = playerVideoHost.querySelector('video');
        if (hls) { try { hls.destroy(); } catch(e){} hls = null; }
        if (mpegtsP) { try { mpegtsP.destroy(); } catch(e){} mpegtsP = null; }
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch(e){} }
    }

    function describeHlsError(data) {
        const code = Number(data && data.response && data.response.code) || 0;
        const details = String((data && data.details) || 'unknown');
        if (code === 401) return 'HTTP 401 (требуется авторизация): ' + details;
        if (code === 403) return 'HTTP 403 (доступ запрещён): ' + details;
        if (code === 404 || code === 410) return 'HTTP ' + code + ' (поток не найден): ' + details;
        if (code === 429) return 'HTTP 429 (лимит запросов): ' + details;
        if (code >= 500) return 'HTTP ' + code + ' (ошибка сервера): ' + details;
        if (/timeout/i.test(details)) return 'Таймаут HLS (' + details + ')';
        if (window.Hls && data && data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
            return 'Ошибка кодека/медиа HLS: ' + details;
        }
        return 'Ошибка HLS: ' + details;
    }

    function describeMediaError(v) {
        const code = Number(v && v.error && v.error.code) || 0;
        if (code === 3) return 'Ошибка декодирования видео (несовместимый кодек)';
        if (code === 4) return 'Формат или кодек потока не поддерживается';
        if (code === 2) return 'Сетевая ошибка при загрузке потока';
        return 'Поток недоступен или формат не поддерживается';
    }

    function playStream(url, channelObj) {
        stopStream();
        const mySession = playerSessionId;
        const ch = channelObj || window.__playerChannel || previewChannel;
        const safeUrl = String(url || '').trim();

        const v = document.createElement('video');
        v.id = 'player-video';
        v.controls = true;
        v.playsInline = true;
        v.style.width = '100%';
        v.style.height = '100%';
        v.style.objectFit = 'contain';
        v.style.display = 'block';
        v.style.background = '#000';
        playerVideoHost.innerHTML = '';
        playerVideoHost.appendChild(v);

        const overlay = $('player-overlay');
        const text = $('player-overlay-text');
        const errBox = $('player-overlay-error');
        const errText = $('player-overlay-error-text');
        const toast = $('player-toast');
        overlay.classList.remove('hidden');
        resetPlayerOverlayState(ch);
        if (toast) toast.style.display = 'none';

        let attempts = [];
        let attemptIndex = 0;
        let attemptId = 0;
        let activeStage = 'prepare';
        let activeSettings = getEffectiveStreamingSettings();
        let resolvedKind = 'hls';

        const ready = () => {
            if (mySession !== playerSessionId) return;
            clearTimeout(playerAttemptTimer);
            setPlayerStage('prepare', 'done');
            setPlayerStage('connect', 'done');
            setPlayerStage('buffer', 'done', 'Готово');
            overlay.classList.add('hidden');
            clearRuntimeUnavailable(ch);
        };
        const err = (message) => {
            if (mySession !== playerSessionId) return;
            clearTimeout(playerAttemptTimer);
            const msg = message || 'Ошибка воспроизведения';
            overlay.classList.remove('hidden');
            if (activeStage === 'buffer') {
                setPlayerStage('buffer', 'error', 'Ошибка');
            } else if (activeStage === 'connect') {
                setPlayerStage('connect', 'error', 'Ошибка');
            } else {
                setPlayerStage('prepare', 'error', 'Ошибка');
            }
            if (text) text.classList.add('hidden');
            if (errText) errText.textContent = msg;
            if (errBox) errBox.classList.remove('hidden');
            recordRuntimeUnavailable(ch, msg);
        };

        if (!safeUrl) {
            err('Ссылка на поток не задана');
            return;
        }

        const enterBufferStage = (currentAttempt) => {
            if (mySession !== playerSessionId || currentAttempt !== attemptId) return;
            if (activeStage === 'buffer') return;
            activeStage = 'buffer';
            setPlayerStage('connect', 'done');
            setPlayerStage('buffer', 'active', 'Буферизация');
            if (text) text.textContent = 'Буферизация и запуск видео...';
        };

        const attempt = (candidate) => {
            if (mySession !== playerSessionId) return;
            if (!candidate) {
                err(window.location.protocol === 'https:' && !isNativeTvApp() && /^http:\/\//i.test(safeUrl)
                    ? 'Прямая http:// ссылка заблокирована браузером (HTTPS) — включите proxy'
                    : 'Поток недоступен или формат не поддерживается');
                return;
            }
            const source = candidate.src;
            const currentAttempt = ++attemptId;
            const stepLabel = (attempts.length > 1 ? (attemptIndex + '/' + attempts.length + ' · ') : '') + candidate.label + ' · ' + resolvedKind.toUpperCase();
            activeStage = 'connect';
            setPlayerStage('connect', 'active', stepLabel);
            setPlayerStage('buffer', 'pending', '');
            if (text) text.textContent = 'Подключение (' + candidate.label + ')...';

            clearTimeout(playerAttemptTimer);
            if (hls) {
                try { hls.destroy(); } catch (e) {}
                hls = null;
            }
            if (mpegtsP) {
                try { mpegtsP.destroy(); } catch (e) {}
                mpegtsP = null;
            }
            try {
                v.pause();
                v.removeAttribute('src');
                v.load();
            } catch (e) {}

            const advance = (fallbackMsg) => {
                if (mySession !== playerSessionId || currentAttempt !== attemptId) return;
                clearTimeout(playerAttemptTimer);
                if (attemptIndex < attempts.length) {
                    attempt(attempts[attemptIndex++]);
                } else {
                    err(fallbackMsg || 'Поток недоступен или формат не поддерживается');
                }
            };

            const timeoutMs = Math.max(4, Math.min(60, Number(activeSettings.attemptTimeoutSec) || 15)) * 1000;
            if (attemptIndex < attempts.length) {
                playerAttemptTimer = setTimeout(() => {
                    advance('Таймаут загрузки потока');
                }, timeoutMs);
            }

            v.onloadedmetadata = () => { enterBufferStage(currentAttempt); };
            v.onloadeddata = () => { if (mySession === playerSessionId && currentAttempt === attemptId) ready(); };
            v.oncanplay = () => { if (mySession === playerSessionId && currentAttempt === attemptId) ready(); };
            v.onerror = () => advance(describeMediaError(v));

            if (resolvedKind === 'hls' && window.Hls && window.Hls.isSupported()) {
                hls = new Hls(buildWatchHlsConfig(activeSettings, false));
                hls.loadSource(source);
                hls.attachMedia(v);
                hls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (mySession !== playerSessionId || currentAttempt !== attemptId) return;
                    enterBufferStage(currentAttempt);
                    v.play().catch(() => {});
                });
                hls.on(Hls.Events.ERROR, (event, data) => {
                    if (!data || !data.fatal || mySession !== playerSessionId || currentAttempt !== attemptId) return;
                    advance(describeHlsError(data));
                });
            } else if (resolvedKind === 'mpegts' && window.mpegts && window.mpegts.isSupported()) {
                mpegtsP = mpegts.createPlayer(
                    { type: 'mpegts', url: source, isLive: true },
                    buildWatchMpegtsConfig(activeSettings)
                );
                mpegtsP.attachMediaElement(v);
                mpegtsP.load();
                enterBufferStage(currentAttempt);
                mpegtsP.play().catch(() => {});
                mpegtsP.on(mpegts.Events.ERROR, (type, detail) => {
                    advance('Ошибка TS: ' + detail);
                });
            } else {
                v.src = source;
                v.play().catch(() => {});
            }
        };

        const startWithSettings = async (eff) => {
            if (mySession !== playerSessionId) return;
            activeSettings = eff || getEffectiveStreamingSettings();
            resolvedKind = await resolveWatchStreamKind(safeUrl, activeSettings);
            if (mySession !== playerSessionId) return;
            setPlayerStage('prepare', 'done', resolvedKind.toUpperCase());
            attempts = buildStreamCandidates(safeUrl, activeSettings, ch);
            attemptIndex = 0;
            attempt(attempts[attemptIndex++]);

            const codecDelaySec = Math.max(0, Math.min(30, Number(activeSettings.codecCheckDelaySec) ?? 8));
            if (codecDelaySec > 0) {
                clearTimeout(playerCodecTimer);
                playerCodecTimer = setTimeout(() => {
                    try {
                        if (mySession === playerSessionId && v && v.isConnected && v.videoWidth === 0 && v.currentTime > 1 && !v.paused) {
                            if (toast) {
                                toast.textContent = 'Видео не отображается. Возможно формат H.265/HEVC или MPEG-2 не поддерживается.';
                                toast.style.display = 'block';
                                setTimeout(() => { if (toast) toast.style.display = 'none'; }, 10000);
                            }
                            recordRuntimeUnavailable(ch, 'Кодек HEVC/MPEG-2 не поддерживается браузером (нет видеопотока)');
                        }
                    } catch (e) {}
                }, codecDelaySec * 1000);
            }
        };

        void loadStreamingSettings().then((eff) => {
            void startWithSettings(eff);
        }).catch(() => {
            void startWithSettings(getEffectiveStreamingSettings());
        });
    }

    // ===== FULLSCREEN =====
    function requestFS() {
        const el = document.documentElement;
        if (el.requestFullscreen) return el.requestFullscreen().catch(()=>{});
        if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
    }

    // ===== PLAYER EVENTS =====
    (function initPlayer() {
        const btnClose = $('player-close');
        const btnReload = $('player-reload');
        const isTv = document.documentElement.classList.contains('is-tv') || isNativeTvApp();
        if (isTv) {
            if (btnClose) { btnClose.disabled = true; btnClose.style.display = 'none'; }
            if (btnReload) { btnReload.disabled = true; btnReload.style.display = 'none'; }
            const toolsWrap = document.querySelector('.player-tools');
            if (toolsWrap) toolsWrap.style.display = 'none';
            return;
        }
        if (btnClose) btnClose.onclick = closePlayer;
        if (btnReload) btnReload.onclick = () => {
            const ch = window.__playerChannel;
            if (ch) playStream(ch.url, ch);
        };
    })();

    // ===== KEYBOARD =====
    // ============ SWITCH CHANNEL IN FULLSCREEN ============
    function switchChannelInPlayer(dir) {
        const current = window.__playerChannel;
        if (!current) return;
        const idx = filtered.findIndex(c => c.url === current.url && c.name === current.name);
        if (idx === -1) return;
        const next = idx + dir;
        if (next < 0 || next >= filtered.length) return;
        openFullscreenPlayer(filtered[next]);
    }

// ============ TV ADMIN: CLOUD USERS, INVITES & ALERTS ============
    const tvUsersBtn = $('tb-admin-users');
    const tvUsersModal = $('tv-users-modal');
    const tvUsersListEl = $('tv-users-list');
    const tvBtnAddUser = $('tv-btn-add-user');
    const tvBtnRefreshUsers = $('tv-btn-refresh-users');

    const tvUserPopup = $('tv-user-popup');
    const tvUserPopupTitle = $('tv-user-popup-title');
    const tvTabInvite = $('tv-tab-invite');
    const tvTabLocal = $('tv-tab-local');
    const tvFieldEmailGroup = $('tv-field-email-group');
    const tvFieldLoginGroup = $('tv-field-login-group');
    const tvFieldPasswordGroup = $('tv-field-password-group');
    const tvUId = $('tv-u-id');
    const tvUEmail = $('tv-u-email');
    const tvULogin = $('tv-u-login');
    const tvUPassword = $('tv-u-password');
    const tvUPassHint = $('tv-u-pass-hint');
    const tvUName = $('tv-u-name');
    const tvUPlaylistsBox = $('tv-u-playlists-box');
    const tvUPlAll = $('tv-u-pl-all');
    const tvUPlNone = $('tv-u-pl-none');
    const tvUEnabledBtn = $('tv-u-enabled-btn');
    const tvUEnabledState = $('tv-u-enabled-state');
    const tvUError = $('tv-u-error');
    const tvUSave = $('tv-u-save');

    const tvAlertsBtn = $('tb-admin-alerts');
    const tvAlertsBadge = $('tv-alerts-badge');
    const tvAlertsModal = $('tv-alerts-modal');
    const tvAlertsListEl = $('tv-alerts-list');
    const tvBtnRefreshAlerts = $('tv-btn-refresh-alerts');

    let tvPlaylists = [];
    let tvUsers = [];
    let tvInvites = [];
    let tvAlerts = [];
    let tvPopupMode = 'invite';
    let tvPopupEnabled = true;
    let tvPopupEditingType = null; // null | 'invite' | 'local'
    let tvPopupSelectedPlaylists = new Set();
    let tvFirebaseUsersCache = [];
    let tvFirebaseInvitesCache = [];
    let tvFirebaseAlertsCache = [];
    let tvFirebaseSubscribed = false;

    function isCloudStorageEnabled() {
        const cfg = window.PQTV_STORAGE_CONFIG;
        if (cfg && cfg.mode === 'local') return false;
        if (cfg && cfg.mode === 'cloud' && cfg.configured === false) return false;
        return Boolean(window.PQTVFirebase && typeof window.PQTVFirebase.isEnabled === 'function' ? window.PQTVFirebase.isEnabled() : true);
    }

    async function apiAdmin(url, method, body) {
        const methodUpper = String(method || 'GET').toUpperCase();
        const opts = {
            method: methodUpper,
            credentials: 'same-origin',
            headers: Object.assign({}, authHeaders())
        };
        if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(methodUpper) && isCloudStorageEnabled()) {
            if (!window.PQTVFirebase || typeof window.PQTVFirebase.getAdminIdToken !== 'function') {
                throw new Error('Firebase admin authentication is unavailable');
            }
            const firebaseIdToken = await window.PQTVFirebase.getAdminIdToken();
            if (!firebaseIdToken) throw new Error('Для изменения данных требуется администратор Firestore');
            opts.headers['X-Firebase-ID-Token'] = firebaseIdToken;
        }
        if (body !== undefined && body !== null) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        const r = await fetch(url, opts);
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
            throw new Error(data.error || ('HTTP ' + r.status));
        }
        return data;
    }

    function fmtTs(ts) {
        if (!ts) return '';
        try {
            return new Date(ts * 1000).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch { return ''; }
    }

    async function ensureTvFirebaseAdminSync() {
        if (!isCloudStorageEnabled() || !window.IS_ADMIN_VIEWER || tvFirebaseSubscribed) return;
        if (!window.PQTVFirebase || typeof window.PQTVFirebase.isSignedInAdmin !== 'function') return;
        const ok = await window.PQTVFirebase.isSignedInAdmin().catch(() => false);
        if (!ok) return;
        tvFirebaseSubscribed = true;

        window.PQTVFirebase.subscribeAdminUsers((list) => {
            tvFirebaseUsersCache = Array.isArray(list) ? list : [];
            if (tvUsersModal && !tvUsersModal.classList.contains('hidden')) {
                mergeAndRenderTvUsers();
            }
        }, () => {});

        window.PQTVFirebase.subscribeAdminInvites((list) => {
            tvFirebaseInvitesCache = Array.isArray(list) ? list : [];
            if (tvUsersModal && !tvUsersModal.classList.contains('hidden')) {
                mergeAndRenderTvUsers();
            }
        }, () => {});

        window.PQTVFirebase.subscribeAdminAlerts((list) => {
            tvFirebaseAlertsCache = Array.isArray(list) ? list : [];
            mergeAndRenderTvAlerts();
        }, () => {});
    }

    let tvLocalUsersCache = [];
    let tvLocalInvitesCache = [];
    let tvLocalAlertsCache = [];

    function mergeAndRenderTvUsers() {
        const byLogin = new Map();
        for (const u of tvLocalUsersCache) {
            byLogin.set((u.login || u.id || '').toLowerCase(), Object.assign({}, u, { inCloud: false }));
        }
        for (const fu of tvFirebaseUsersCache) {
            const key = (fu.login || fu.id || '').toLowerCase();
            const prev = byLogin.get(key);
            byLogin.set(key, Object.assign({}, prev || {}, fu, {
                online: prev ? prev.online : Boolean(fu.online),
                inCloud: true
            }));
        }
        tvUsers = [...byLogin.values()].sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

        const invById = new Map();
        for (const inv of tvLocalInvitesCache) {
            invById.set(inv.id || inv.email, Object.assign({}, inv, { inCloud: false }));
        }
        for (const finv of tvFirebaseInvitesCache) {
            const key = finv.id || finv.emailHash || finv.email;
            const prev = invById.get(key);
            invById.set(key, Object.assign({}, prev || {}, finv, {
                email: finv.email || (prev && prev.email) || '',
                inCloud: true
            }));
        }
        tvInvites = [...invById.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        renderTvUsersModal();
    }

    function mergeAndRenderTvAlerts() {
        const byKey = new Map();
        for (const a of tvLocalAlertsCache) {
            byKey.set(a.id || a.userId || a.userLogin, Object.assign({}, a));
        }
        for (const fa of tvFirebaseAlertsCache) {
            const key = fa.id || fa.uid || fa.userLogin;
            const prev = byKey.get(key);
            if (!prev || (fa.updated_at || 0) >= (prev.updated_at || 0)) {
                byKey.set(key, Object.assign({}, prev || {}, fa, { id: fa.id || fa.uid || (prev && prev.id) || key }));
            }
        }
        tvAlerts = [...byKey.values()].sort((a, b) => {
            if (Boolean(a.resolved) !== Boolean(b.resolved)) return a.resolved ? 1 : -1;
            return (b.updated_at || 0) - (a.updated_at || 0);
        });
        const activeCount = tvAlerts.filter(a => !a.resolved && (a.unavailableCount > 0 || (a.items && a.items.length > 0))).length;
        if (tvAlertsBadge) {
            tvAlertsBadge.textContent = String(activeCount);
            tvAlertsBadge.classList.toggle('hidden', activeCount === 0);
        }
        if (tvAlertsModal && !tvAlertsModal.classList.contains('hidden')) {
            renderTvAlertsModal();
        }
    }

    async function loadTvAdminUsers() {
        if (!window.IS_ADMIN_VIEWER) return;
        try {
            const data = await apiAdmin('/watch/api/admin/users');
            tvPlaylists = Array.isArray(data.playlists) ? data.playlists : [];
            tvLocalUsersCache = Array.isArray(data.users) ? data.users : [];
            tvLocalInvitesCache = Array.isArray(data.invites) ? data.invites : [];
            await ensureTvFirebaseAdminSync();
            mergeAndRenderTvUsers();
        } catch (err) {
            if (tvUsersListEl) {
                tvUsersListEl.innerHTML = '<div class="tv-form-error">Ошибка загрузки: ' + esc(err.message || 'нет доступа') + '</div>';
            }
        }
    }

    function renderTvUsersModal() {
        if (!tvUsersListEl) return;
        let html = '';

        html += '<div class="tv-section-label">Облачные приглашения Google (' + tvInvites.length + ')</div>';
        if (tvInvites.length === 0) {
            html += '<div class="tv-row-sub" style="padding:6px 4px;">Приглашений пока нет.</div>';
        } else {
            tvInvites.forEach((inv, idx) => {
                const pls = (inv.playlists || []).join(', ') || 'нет плейлистов';
                const statusBadge = inv.claimedUid
                    ? '<span class="tv-badge tv-badge-green">Активировано</span>'
                    : (inv.enabled ? '<span class="tv-badge tv-badge-amber">Ожидает входа</span>' : '<span class="tv-badge tv-badge-red">Отключено</span>');
                html += '<div class="tv-row-card">' +
                    '<div class="tv-row-main">' +
                        '<div class="tv-row-title">' + esc(inv.name || inv.email || inv.id) + ' ' + statusBadge + '</div>' +
                        '<div class="tv-row-sub">Email: ' + esc(inv.email || '—') + ' · Плейлисты: ' + esc(pls) + '</div>' +
                    '</div>' +
                    '<div class="tv-row-actions">' +
                        '<button type="button" class="tv-inline-btn" data-tv-edit-invite="' + idx + '">Изменить</button>' +
                        '<button type="button" class="tv-inline-btn tv-inline-btn-danger" data-tv-del-invite="' + idx + '">Удалить</button>' +
                    '</div>' +
                '</div>';
            });
        }

        html += '<div class="tv-section-label" style="margin-top:10px;">Пользователи (' + tvUsers.length + ')</div>';
        if (tvUsers.length === 0) {
            html += '<div class="tv-row-sub" style="padding:6px 4px;">Пользователей пока нет.</div>';
        } else {
            tvUsers.forEach((u, idx) => {
                const pls = (u.playlists || []).join(', ') || 'нет плейлистов';
                const statusBadge = !u.enabled
                    ? '<span class="tv-badge tv-badge-red">Заблокирован</span>'
                    : (u.online ? '<span class="tv-badge tv-badge-green">Онлайн</span>' : '<span class="tv-badge tv-badge-blue">Активен</span>');
                html += '<div class="tv-row-card">' +
                    '<div class="tv-row-main">' +
                        '<div class="tv-row-title">' + esc(u.name || u.login) + ' ' + statusBadge + '</div>' +
                        '<div class="tv-row-sub">Логин: ' + esc(u.login) + ' · Плейлисты: ' + esc(pls) + '</div>' +
                    '</div>' +
                    '<div class="tv-row-actions">' +
                        '<button type="button" class="tv-inline-btn" data-tv-edit-user="' + idx + '">Изменить</button>' +
                        '<button type="button" class="tv-inline-btn tv-inline-btn-danger" data-tv-del-user="' + idx + '">Удалить</button>' +
                    '</div>' +
                '</div>';
            });
        }

        tvUsersListEl.innerHTML = html;

        tvUsersListEl.querySelectorAll('[data-tv-edit-invite]').forEach(btn => {
            btn.onclick = () => {
                const inv = tvInvites[+btn.dataset.tvEditInvite];
                if (inv) openTvUserPopup('invite', inv);
            };
        });
        tvUsersListEl.querySelectorAll('[data-tv-edit-user]').forEach(btn => {
            btn.onclick = () => {
                const u = tvUsers[+btn.dataset.tvEditUser];
                if (u) openTvUserPopup('local', u);
            };
        });

        const armDelete = (btn, onConfirm) => {
            btn.onclick = async () => {
                if (btn.dataset.armed !== '1') {
                    btn.dataset.armed = '1';
                    btn.textContent = 'Точно удалить?';
                    setTimeout(() => {
                        if (btn.isConnected && btn.dataset.armed === '1') {
                            btn.dataset.armed = '';
                            btn.textContent = 'Удалить';
                        }
                    }, 4000);
                    return;
                }
                btn.disabled = true;
                await onConfirm();
            };
        };

        tvUsersListEl.querySelectorAll('[data-tv-del-invite]').forEach(btn => {
            const inv = tvInvites[+btn.dataset.tvDelInvite];
            if (!inv) return;
            armDelete(btn, async () => {
                let delRes = null;
                try {
                    delRes = await apiAdmin('/watch/api/admin/invites/delete', 'POST', { id: inv.id, email: inv.email });
                } catch {}
                if (window.PQTVFirebase && typeof window.PQTVFirebase.deleteInviteAdmin === 'function' && inv.id && /^[a-f0-9]{64}$/i.test(inv.id)) {
                    await window.PQTVFirebase.deleteInviteAdmin(inv.id).catch(() => {});
                    if (delRes && typeof delRes.revision === 'number' && typeof window.PQTVFirebase.bumpCloudManifestRevision === 'function') {
                        await window.PQTVFirebase.bumpCloudManifestRevision(delRes.revision).catch(() => {});
                    }
                }
                await loadTvAdminUsers();
            });
        });

        tvUsersListEl.querySelectorAll('[data-tv-del-user]').forEach(btn => {
            const u = tvUsers[+btn.dataset.tvDelUser];
            if (!u) return;
            armDelete(btn, async () => {
                let delRes = null;
                try {
                    delRes = await apiAdmin('/watch/api/admin/users/delete', 'POST', { id: u.id });
                } catch {}
                if (window.PQTVFirebase && typeof window.PQTVFirebase.deleteUserAdmin === 'function' && u.inCloud) {
                    await window.PQTVFirebase.deleteUserAdmin(u.id).catch(() => {});
                    if (delRes && typeof delRes.revision === 'number' && typeof window.PQTVFirebase.bumpCloudManifestRevision === 'function') {
                        await window.PQTVFirebase.bumpCloudManifestRevision(delRes.revision, { removeLocalUserId: u.id }).catch(() => {});
                    }
                }
                await loadTvAdminUsers();
            });
        });
    }

    function setTvPopupMode(mode) {
        tvPopupMode = mode === 'local' ? 'local' : 'invite';
        if (tvTabInvite) tvTabInvite.classList.toggle('active', tvPopupMode === 'invite');
        if (tvTabLocal) tvTabLocal.classList.toggle('active', tvPopupMode === 'local');
        if (tvFieldEmailGroup) tvFieldEmailGroup.classList.toggle('hidden', tvPopupMode !== 'invite');
        if (tvFieldLoginGroup) tvFieldLoginGroup.classList.toggle('hidden', tvPopupMode !== 'local');
        if (tvFieldPasswordGroup) tvFieldPasswordGroup.classList.toggle('hidden', tvPopupMode !== 'local');
    }

    function renderTvPlaylistChips() {
        if (!tvUPlaylistsBox) return;
        if (tvPlaylists.length === 0) {
            tvUPlaylistsBox.innerHTML = '<div class="tv-row-sub">Нет плейлистов на сервере</div>';
            return;
        }
        tvUPlaylistsBox.innerHTML = tvPlaylists.map(pl => {
            const sel = tvPopupSelectedPlaylists.has(pl);
            return '<button type="button" class="tv-pl-chip ' + (sel ? 'selected' : '') + '" data-tv-pl="' + esc(pl) + '">' +
                (sel ? '✓ ' : '') + esc(pl) + '</button>';
        }).join('');
        tvUPlaylistsBox.querySelectorAll('[data-tv-pl]').forEach(chip => {
            chip.onclick = () => {
                const pl = chip.dataset.tvPl;
                if (!pl) return;
                if (tvPopupSelectedPlaylists.has(pl)) tvPopupSelectedPlaylists.delete(pl);
                else tvPopupSelectedPlaylists.add(pl);
                renderTvPlaylistChips();
                const updated = tvUPlaylistsBox.querySelector('[data-tv-pl="' + CSS.escape(pl) + '"]');
                if (updated) setFocus(updated);
            };
        });
    }

    function syncTvEnabledLabel() {
        if (!tvUEnabledState) return;
        tvUEnabledState.textContent = tvPopupEnabled ? 'Включён' : 'Отключён';
        tvUEnabledState.style.color = tvPopupEnabled ? '#6ee7b7' : '#fca5a5';
    }

    function showTvPopupError(msg) {
        if (!tvUError) return;
        if (!msg) {
            tvUError.classList.add('hidden');
            tvUError.textContent = '';
        } else {
            tvUError.textContent = msg;
            tvUError.classList.remove('hidden');
        }
    }

    function openTvUserPopup(mode, record) {
        if (!tvUserPopup) return;
        showTvPopupError('');
        const isEdit = Boolean(record);
        tvPopupEditingType = isEdit ? mode : null;
        setTvPopupMode(mode);

        if (tvUserPopupTitle) {
            tvUserPopupTitle.textContent = isEdit
                ? (mode === 'invite' ? 'Редактировать приглашение Google' : 'Редактировать пользователя')
                : 'Добавить пользователя';
        }
        if (tvTabInvite && tvTabLocal) {
            tvTabInvite.disabled = isEdit && mode === 'local';
            tvTabLocal.disabled = isEdit && mode === 'invite';
        }

        if (tvUId) tvUId.value = isEdit && mode === 'local' ? (record.id || '') : '';
        if (tvUEmail) {
            tvUEmail.value = isEdit && mode === 'invite' ? (record.email || '') : '';
            tvUEmail.readOnly = isEdit && mode === 'invite' && Boolean(record.email);
        }
        if (tvULogin) {
            tvULogin.value = isEdit && mode === 'local' ? (record.login || '') : '';
            tvULogin.readOnly = isEdit && mode === 'local';
        }
        if (tvUPassword) tvUPassword.value = '';
        if (tvUPassHint) tvUPassHint.textContent = isEdit ? '(оставьте пустым, чтобы не менять)' : '';
        if (tvUName) tvUName.value = isEdit ? (record.name || '') : '';

        tvPopupSelectedPlaylists = new Set(isEdit && Array.isArray(record.playlists) ? record.playlists : []);
        tvPopupEnabled = isEdit ? Boolean(record.enabled) : true;
        syncTvEnabledLabel();
        renderTvPlaylistChips();

        tvUserPopup.classList.remove('hidden');
        const focusTarget = mode === 'invite' ? (tvUEmail || tvUName) : (isEdit ? tvUName : tvULogin);
        if (focusTarget) setFocus(focusTarget);
    }

    function closeTvUserPopup() {
        if (!tvUserPopup) return;
        tvUserPopup.classList.add('hidden');
        if (tvUsersModal && !tvUsersModal.classList.contains('hidden') && tvBtnAddUser) {
            setFocus(tvBtnAddUser);
        }
    }

    async function saveTvUserPopup() {
        showTvPopupError('');
        const playlists = [...tvPopupSelectedPlaylists];
        const name = (tvUName ? tvUName.value : '').trim();

        try {
            if (tvPopupMode === 'invite') {
                const email = (tvUEmail ? tvUEmail.value : '').trim().toLowerCase();
                if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                    showTvPopupError('Введите корректный Google Email');
                    return;
                }
                const savedInv = await apiAdmin('/watch/api/admin/invites/save', 'POST', {
                    email,
                    name: name || email.split('@')[0],
                    playlists,
                    enabled: tvPopupEnabled
                });
                if (window.PQTVFirebase && typeof window.PQTVFirebase.saveInviteAdmin === 'function') {
                    const isCloudAdmin = await window.PQTVFirebase.isSignedInAdmin().catch(() => false);
                    if (isCloudAdmin) {
                        await window.PQTVFirebase.saveInviteAdmin({
                            email,
                            name: name || email.split('@')[0],
                            playlists,
                            enabled: tvPopupEnabled
                        });
                        if (savedInv && typeof savedInv.revision === 'number' && typeof window.PQTVFirebase.bumpCloudManifestRevision === 'function') {
                            await window.PQTVFirebase.bumpCloudManifestRevision(savedInv.revision).catch(() => {});
                        }
                    }
                }
            } else {
                const id = (tvUId ? tvUId.value : '').trim();
                const login = (tvULogin ? tvULogin.value : '').trim();
                const password = tvUPassword ? tvUPassword.value : '';
                if (!id && login.length < 2) {
                    showTvPopupError('Логин должен быть не менее 2 символов');
                    return;
                }
                if (!id && password.length < 4) {
                    showTvPopupError('Пароль должен быть не менее 4 символов');
                    return;
                }
                const saved = await apiAdmin('/watch/api/admin/users/save', 'POST', {
                    id,
                    login,
                    password,
                    name: name || login,
                    playlists,
                    enabled: tvPopupEnabled
                });
                if (window.PQTVFirebase && typeof window.PQTVFirebase.saveUserAdmin === 'function') {
                    const isCloudAdmin = await window.PQTVFirebase.isSignedInAdmin().catch(() => false);
                    if (isCloudAdmin) {
                        const cloudId = id || (saved.user && saved.user.id) || '';
                        await window.PQTVFirebase.saveUserAdmin({
                            id: cloudId,
                            login: login || cloudId,
                            name: name || login || cloudId,
                            playlists,
                            enabled: tvPopupEnabled,
                            role: 'user'
                        });
                        if (saved.cloudCred && typeof window.PQTVFirebase.saveLocalUserCredentialsToCloud === 'function') {
                            await window.PQTVFirebase.saveLocalUserCredentialsToCloud([saved.cloudCred], false).catch(() => {});
                        }
                        if (typeof saved.revision === 'number' && typeof window.PQTVFirebase.bumpCloudManifestRevision === 'function') {
                            await window.PQTVFirebase.bumpCloudManifestRevision(
                                saved.revision,
                                saved.cloudCred ? { addLocalUserId: saved.cloudCred.id } : undefined
                            ).catch(() => {});
                        }
                    }
                }
            }
            closeTvUserPopup();
            await loadTvAdminUsers();
        } catch (err) {
            showTvPopupError(err && err.message ? err.message : 'Ошибка сохранения');
        }
    }

    function openTvUsersModal() {
        if (!tvUsersModal) return;
        tvUsersModal.classList.remove('hidden');
        loadTvAdminUsers();
        if (tvBtnAddUser) setFocus(tvBtnAddUser);
    }

    function closeTvUsersModal() {
        if (!tvUsersModal) return;
        tvUsersModal.classList.add('hidden');
        if (tvUsersBtn) setFocus(tvUsersBtn);
    }

    async function loadTvAlerts() {
        if (!window.IS_ADMIN_VIEWER) return;
        try {
            const data = await apiAdmin('/watch/api/admin/alerts');
            tvLocalAlertsCache = Array.isArray(data.alerts) ? data.alerts : [];
            await ensureTvFirebaseAdminSync();
            mergeAndRenderTvAlerts();
        } catch {}
    }

    function renderTvAlertsModal() {
        if (!tvAlertsListEl) return;
        if (tvAlerts.length === 0) {
            tvAlertsListEl.innerHTML = '<div style="padding:18px; text-align:center; color:var(--muted);">Отчётов об ошибках воспроизведения нет</div>';
            return;
        }
        tvAlertsListEl.innerHTML = tvAlerts.map((a, idx) => {
            const badge = a.resolved
                ? '<span class="tv-badge tv-badge-green">Решено</span>'
                : '<span class="tv-badge tv-badge-red">Проблема: ' + (a.unavailableCount || (a.items ? a.items.length : 0)) + '</span>';
            const itemsHtml = (a.items || []).map(it =>
                '<div class="tv-alert-item"><span>' + esc(it.name) + (it.group ? ' (' + esc(it.group) + ')' : '') + '</span><span>' + esc(it.reason) + '</span></div>'
            ).join('');
            return '<div class="tv-row-card" style="align-items:flex-start;">' +
                '<div class="tv-row-main">' +
                    '<div class="tv-row-title">' + esc(a.userName || a.userLogin || a.id) + ' ' + badge + '</div>' +
                    '<div class="tv-row-sub">Аккаунт: ' + esc(a.userLogin || '—') + ' · Каналов: ' + Number(a.totalChannels || 0) + (a.updated_at ? ' · ' + esc(fmtTs(a.updated_at)) : '') + '</div>' +
                    (itemsHtml ? '<div class="tv-alert-items">' + itemsHtml + '</div>' : '') +
                '</div>' +
                '<div class="tv-row-actions">' +
                    '<button type="button" class="tv-inline-btn" data-tv-alert-resolve="' + idx + '">' + (a.resolved ? 'Вернуть' : 'Решено') + '</button>' +
                    '<button type="button" class="tv-inline-btn tv-inline-btn-danger" data-tv-alert-del="' + idx + '">Удалить</button>' +
                '</div>' +
            '</div>';
        }).join('');

        tvAlertsListEl.querySelectorAll('[data-tv-alert-resolve]').forEach(btn => {
            btn.onclick = async () => {
                const a = tvAlerts[+btn.dataset.tvAlertResolve];
                if (!a) return;
                const nextResolved = !a.resolved;
                btn.disabled = true;
                btn.textContent = 'Проверка...';
                let resData = null;
                try {
                    resData = await apiAdmin('/watch/api/admin/alerts/resolve', 'POST', { id: a.id, resolved: nextResolved });
                } catch {}
                const actuallyResolved = resData ? Boolean(resData.resolved) : nextResolved;
                if (window.PQTVFirebase && typeof window.PQTVFirebase.resolveAlertAdmin === 'function') {
                    await window.PQTVFirebase.resolveAlertAdmin(a.id, actuallyResolved).catch(() => {});
                }
                await loadTvAlerts();
                if (resData && resData.stillBroken && tvAlertsListEl) {
                    const warnBanner = document.createElement('div');
                    warnBanner.className = 'tv-form-error';
                    warnBanner.style.marginBottom = '10px';
                    warnBanner.textContent = resData.message || 'Канал всё ещё не работает — отчёт оставлен открытым и помечен для админа.';
                    tvAlertsListEl.prepend(warnBanner);
                }
            };
        });

        tvAlertsListEl.querySelectorAll('[data-tv-alert-del]').forEach(btn => {
            btn.onclick = async () => {
                const a = tvAlerts[+btn.dataset.tvAlertDel];
                if (!a) return;
                try {
                    await apiAdmin('/watch/api/admin/alerts/delete', 'POST', { id: a.id });
                } catch {}
                if (window.PQTVFirebase && typeof window.PQTVFirebase.deleteAlertAdmin === 'function') {
                    await window.PQTVFirebase.deleteAlertAdmin(a.id).catch(() => {});
                }
                await loadTvAlerts();
            };
        });
    }

    function openTvAlertsModal() {
        if (!tvAlertsModal) return;
        tvAlertsModal.classList.remove('hidden');
        loadTvAlerts();
        if (tvBtnRefreshAlerts) setFocus(tvBtnRefreshAlerts);
    }

    function closeTvAlertsModal() {
        if (!tvAlertsModal) return;
        tvAlertsModal.classList.add('hidden');
        if (tvAlertsBtn) setFocus(tvAlertsBtn);
    }

    if (window.IS_ADMIN_VIEWER) {
        if (tvUsersBtn) tvUsersBtn.onclick = openTvUsersModal;
        if (tvBtnRefreshUsers) tvBtnRefreshUsers.onclick = loadTvAdminUsers;
        if (tvBtnAddUser) tvBtnAddUser.onclick = () => openTvUserPopup('invite', null);
        if (tvTabInvite) tvTabInvite.onclick = () => { if (!tvPopupEditingType) setTvPopupMode('invite'); };
        if (tvTabLocal) tvTabLocal.onclick = () => { if (!tvPopupEditingType) setTvPopupMode('local'); };
        if (tvUPlAll) tvUPlAll.onclick = () => { tvPlaylists.forEach(p => tvPopupSelectedPlaylists.add(p)); renderTvPlaylistChips(); };
        if (tvUPlNone) tvUPlNone.onclick = () => { tvPopupSelectedPlaylists.clear(); renderTvPlaylistChips(); };
        if (tvUEnabledBtn) tvUEnabledBtn.onclick = () => { tvPopupEnabled = !tvPopupEnabled; syncTvEnabledLabel(); };
        if (tvUSave) tvUSave.onclick = saveTvUserPopup;
        if (tvUsersModal) tvUsersModal.querySelectorAll('[data-tv-users-close]').forEach(el => { el.onclick = closeTvUsersModal; });
        if (tvUserPopup) tvUserPopup.querySelectorAll('[data-tv-popup-close]').forEach(el => { el.onclick = closeTvUserPopup; });

        if (tvAlertsBtn) tvAlertsBtn.onclick = openTvAlertsModal;
        if (tvBtnRefreshAlerts) tvBtnRefreshAlerts.onclick = loadTvAlerts;
        if (tvAlertsModal) tvAlertsModal.querySelectorAll('[data-tv-alerts-close]').forEach(el => { el.onclick = closeTvAlertsModal; });

        loadTvAlerts();
        setInterval(loadTvAlerts, 60000);
    }

// ============ SPATIAL NAVIGATION (стрелки по координатам) ============
    const FOCUS_SELECTOR = '.tb-btn, .tb-update-btn, .tb-install, .tb-profile, #watch-search, .tb-btn-exit, .watch-unavail-btn, .preview-btn, .cat-btn, .ch-card, .btn-ice, .group-btn, .admin-access';

    function getVisibleFocusables() {
        return Array.from(document.querySelectorAll(FOCUS_SELECTOR))
            .filter(el => {
                if (el.offsetParent === null) return false;
                if (el.disabled) return false;
                const st = window.getComputedStyle(el);
                if (st.visibility === 'hidden' || st.display === 'none') return false;
                return true;
            });
    }

    function rectCenter(el) {
        const r = el.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2, r };
    }

    // Ищем ближайший элемент в направлении dir ('up','down','left','right')
    function findNext(current, dir) {
        const all = getVisibleFocusables();
        if (all.length === 0) return null;
        if (!current || !all.includes(current)) return all[0];

        const cur = rectCenter(current);

        // Собираем кандидатов в нужном направлении
        const candidates = [];
        for (const el of all) {
            if (el === current) continue;
            const c = rectCenter(el);
            const dx = c.x - cur.x;
            const dy = c.y - cur.y;

            let ok = false;
            // Главная ось для стрелки, второстепенная — отклонение
            let mainDist, offAxis;
            if (dir === 'left') {
                ok = dx < -2;
                mainDist = -dx;
                offAxis = Math.abs(dy);
            } else if (dir === 'right') {
                ok = dx > 2;
                mainDist = dx;
                offAxis = Math.abs(dy);
            } else if (dir === 'up') {
                ok = dy < -2;
                mainDist = -dy;
                offAxis = Math.abs(dx);
            } else if (dir === 'down') {
                ok = dy > 2;
                mainDist = dy;
                offAxis = Math.abs(dx);
            }
            if (!ok) continue;

            // Не уходим слишком далеко по второстепенной оси
            // Штраф за смещение
            const score = mainDist + offAxis * 2.5;
            candidates.push({ el, score, mainDist, offAxis });
        }

        if (candidates.length === 0) return null;

        // Сначала берём те, что близко по главной оси; потом лучший score
        candidates.sort((a, b) => a.score - b.score);
        return candidates[0].el;
    }

    // Прокрутка контейнера так, чтобы элемент был виден
    function scrollIntoViewSmooth(el) {
        if (!el) return;
        // Найти ближайший скроллируемый родитель
        let p = el.parentElement;
        let scroller = null;
        while (p && p !== document.body) {
            const st = window.getComputedStyle(p);
            if ((st.overflowY === 'auto' || st.overflowY === 'scroll') && p.scrollHeight > p.clientHeight) {
                scroller = p;
                break;
            }
            p = p.parentElement;
        }
        if (!scroller) {
            // document-level скролл
            const r = el.getBoundingClientRect();
            if (r.top < 40 || r.bottom > window.innerHeight - 40) {
                el.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
            return;
        }
        const r = el.getBoundingClientRect();
        const sr = scroller.getBoundingClientRect();
        // Верхняя и нижняя видимые границы контейнера
        const topLimit = sr.top + 20;
        const botLimit = sr.bottom - 20;

        if (r.top < topLimit) {
            scroller.scrollBy({ top: r.top - topLimit - 40, behavior: 'smooth' });
        } else if (r.bottom > botLimit) {
            scroller.scrollBy({ top: r.bottom - botLimit + 40, behavior: 'smooth' });
        }
    }

    function setFocus(el) {
        if (!el) return;
        el.focus({ preventScroll: true });
        scrollIntoViewSmooth(el);
    }

    function handleModalDpad(modalEl, key, e, closeFn) {
        const cur = document.activeElement;
        const inTextInput = Boolean(cur && cur.tagName === 'INPUT');
        if (key === 'Escape' || key === 'BrowserBack' || (key === 'Backspace' && !inTextInput)) {
            e.preventDefault();
            closeFn();
            return true;
        }
        const focusables = [...modalEl.querySelectorAll('button, input')].filter(el =>
            el.offsetParent !== null && !el.disabled && !el.classList.contains('hidden') && el.type !== 'hidden'
        );
        if (focusables.length === 0) return true;
        const idx = focusables.indexOf(cur);

        if (inTextInput && (key === 'ArrowLeft' || key === 'ArrowRight')) {
            return true;
        }
        if (key === 'ArrowDown' || (!inTextInput && key === 'ArrowRight')) {
            e.preventDefault();
            setFocus(focusables[(idx + 1 + focusables.length) % focusables.length]);
            return true;
        }
        if (key === 'ArrowUp' || (!inTextInput && key === 'ArrowLeft')) {
            e.preventDefault();
            setFocus(focusables[(idx - 1 + focusables.length) % focusables.length]);
            return true;
        }
        if (key === 'Enter' && cur && cur.tagName === 'BUTTON' && focusables.includes(cur)) {
            e.preventDefault();
            cur.click();
            return true;
        }
        return true;
    }

    document.addEventListener('keydown', (e) => {
        const key = e.key;
        const playerOpen = playerModal && !playerModal.classList.contains('hidden');
        const userPopupOpen = tvUserPopup && !tvUserPopup.classList.contains('hidden');
        const usersOpen = tvUsersModal && !tvUsersModal.classList.contains('hidden');
        const alertsOpen = tvAlertsModal && !tvAlertsModal.classList.contains('hidden');
        const unavailOpen = unavailModal && !unavailModal.classList.contains('hidden');
        const menuOpen = menu && !menu.classList.contains('hidden');
        const settingsOpen = settingsModal && !settingsModal.classList.contains('hidden');

        // === Плеер открыт ===
        if (playerOpen) {
            if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
                e.preventDefault(); closePlayer(); return;
            }
            if (key === 'Enter' || key === ' ' || key === 'MediaPlayPause') {
                e.preventDefault();
                const v = playerVideoHost.querySelector('video');
                if (v) { if (v.paused) v.play().catch(()=>{}); else v.pause(); }
                return;
            }
            if (key === 'ArrowUp') {
                e.preventDefault();
                switchChannelInPlayer(-1);
                return;
            }
            if (key === 'ArrowDown') {
                e.preventDefault();
                switchChannelInPlayer(1);
                return;
            }
            if (key === 'ArrowLeft' || key === 'ArrowRight') {
                e.preventDefault();
                return;
            }
            return;
        }

        // === TV Admin / Unavailable Modals (priority top-down) ===
        if (userPopupOpen && handleModalDpad(tvUserPopup, key, e, closeTvUserPopup)) return;
        if (usersOpen && handleModalDpad(tvUsersModal, key, e, closeTvUsersModal)) return;
        if (alertsOpen && handleModalDpad(tvAlertsModal, key, e, closeTvAlertsModal)) return;
        if (unavailOpen && handleModalDpad(unavailModal, key, e, closeUnavailableModal)) return;

        // === Окно настроек и обновления ТВ открыто ===
        if (settingsOpen) {
            if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
                e.preventDefault(); closeSettingsModal(); return;
            }
            const setFocusList = [...settingsModal.querySelectorAll('button')].filter(b => b.offsetParent !== null && !b.classList.contains('hidden'));
            if (setFocusList.length === 0) return;
            const cur = document.activeElement;
            const idx = setFocusList.indexOf(cur);
            if (key === 'ArrowRight' || key === 'ArrowDown') {
                e.preventDefault();
                setFocus(setFocusList[(idx + 1 + setFocusList.length) % setFocusList.length]);
                return;
            }
            if (key === 'ArrowLeft' || key === 'ArrowUp') {
                e.preventDefault();
                setFocus(setFocusList[(idx - 1 + setFocusList.length) % setFocusList.length]);
                return;
            }
            if (key === 'Enter' && cur && setFocusList.includes(cur)) {
                e.preventDefault(); cur.click();
                return;
            }
            return;
        }

        // === Меню канала открыто — фокус только внутри него ===
        if (menuOpen) {
            if (key === 'Escape' || key === 'Backspace' || key === 'BrowserBack') {
                e.preventDefault(); closeChannelMenu(); return;
            }
            const menuFocus = [...menu.querySelectorAll('button')].filter(b => b.offsetParent !== null);
            if (menuFocus.length === 0) return;
            const cur = document.activeElement;
            const idx = menuFocus.indexOf(cur);

            if (key === 'ArrowRight' || key === 'ArrowDown') {
                e.preventDefault();
                setFocus(menuFocus[(idx + 1 + menuFocus.length) % menuFocus.length]);
                return;
            }
            if (key === 'ArrowLeft' || key === 'ArrowUp') {
                e.preventDefault();
                setFocus(menuFocus[(idx - 1 + menuFocus.length) % menuFocus.length]);
                return;
            }
            if (key === 'Enter') {
                if (cur && menuFocus.includes(cur)) { e.preventDefault(); cur.click(); }
                return;
            }
            return;
        }

        // === Главная: стрелки ===
        const NAV = ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'];
        if (!NAV.includes(key)) {
            if (key === 'Enter') {
                const a = document.activeElement;
                if (a && FOCUS_SELECTOR.split(', ').some(s => a.matches(s)) && a.id !== 'watch-search') {
                    e.preventDefault();
                    a.click();
                }
            }
            return;
        }

        e.preventDefault();
        const dir = key.replace('Arrow', '').toLowerCase();
        const cur = document.activeElement;
        const next = findNext(cur, dir);

        if (next) {
            setFocus(next);
        } else if (!cur || !cur.matches(FOCUS_SELECTOR)) {
            // Ничего не в фокусе — на первую карточку или первый элемент
            const first = document.querySelector('.ch-card') || getVisibleFocusables()[0];
            if (first) setFocus(first);
        }
    });

    // ===== PING =====
    function sendPing() {
        fetch('/watch/api/ping', { credentials: 'same-origin', headers: authHeaders() }).catch(()=>{});
        if (isCloudStorageEnabled() && window.PQTVFirebase && typeof window.PQTVFirebase.pingViewerPresence === 'function') {
            window.PQTVFirebase.pingViewerPresence().catch(()=>{});
        }
    }
    sendPing();
    setInterval(sendPing, 30000);

    // ===== CLOUD VIEWER HYDRATION =====
    let viewerCloudHydrated = false;
    function initViewerCloudHydration() {
        if (!isCloudStorageEnabled() || !window.PQTVFirebase || typeof window.PQTVFirebase.onAuthChange !== 'function') return;
        window.PQTVFirebase.onAuthChange(async (info) => {
            if (!info || !info.signedIn || viewerCloudHydrated) return;
            viewerCloudHydrated = true;
            try {
                if (typeof window.PQTVFirebase.hydrateViewerFromCloud === 'function') {
                    const res = await window.PQTVFirebase.hydrateViewerFromCloud(getWatchToken());
                    if (res && res.streaming) {
                        serverStreamingSettings = Object.assign({}, serverStreamingSettings, res.streaming);
                        syncSettingsModalLabels();
                    }
                    if (res && res.uiSettings) {
                        applyUiSettings(res.uiSettings);
                    }
                    if (res && res.restored > 0) {
                        await loadChannels();
                    }
                }
            } catch {}
        });
    }

    // ===== BOOT =====
    applyUiSettings(window.UI_SETTINGS || {});
    loadStreamingSettings().catch(() => {});
    loadUiSettings().catch(() => {});
    loadChannels();
    checkTvUpdate(false);
    initViewerCloudHydration();
});
