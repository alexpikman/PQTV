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
        catHeart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>'
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
    const setBtnCheckUpdate = $('set-btn-check-update');
    const setBtnInstallApk = $('set-btn-install-apk');
    const setBtnToggleView = $('set-btn-toggle-view');
    const tvUpdateBtn = $('tv-update-btn');
    const tvUpdateBtnText = $('tv-update-btn-text');
    const tvProgressWrap = $('tv-update-progress-wrap');
    const tvProgressLabel = $('tv-update-progress-label');
    const tvProgressFill = $('tv-update-progress-fill');

    let latestApkInfo = null;

    function isNativeTvApp() {
        return Boolean(window.PQTVAndroid && typeof window.PQTVAndroid.isAndroidTV === 'function' && window.PQTVAndroid.isAndroidTV());
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

    function syncSettingsModalLabels() {
        if (setPlatformLabel) {
            setPlatformLabel.textContent = isNativeTvApp()
                ? 'Android TV (нативное APK-приложение)'
                : (document.documentElement.classList.contains('is-tv') ? 'Smart TV (браузер)' : 'Веб / PWA');
        }
        if (setCurrentVer) setCurrentVer.textContent = 'v' + currentAppName();
        if (setViewLabel) setViewLabel.textContent = 'Вид: ' + (viewMode === 'grid' ? 'Сетка' : 'Список');
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

    // ===== LOAD CHANNELS =====
    async function loadChannels() {
        const res = await api('/watch/api/channels?_=' + Date.now());
        channels = Array.isArray(res.channels) ? res.channels : [];
        loadFavs();
        loadHidden();
        renderCategories();
        renderChannels();
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
        return channels.filter(ch => {
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

        // Debounce — запускаем через 500мс
        clearTimeout(previewDebounceTimer);
        previewDebounceTimer = setTimeout(() => {
            if (previewKey !== newKey) return;
            startPreviewStream(ch);
        }, 500);
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
        stopPreviewStream();

        previewLoading.classList.remove('hidden');

        const url = ch.url;
        const low = url.split('?')[0].toLowerCase();
        const isM3u8 = low.includes('.m3u8');
        const isTs = low.endsWith('.ts');
        const proxied = '/api/stream/proxy?url=' + encodeURIComponent(url);

        let ready = false;
        const onReady = () => {
            if (ready) return;
            ready = true;
            previewLoading.classList.add('hidden');
            previewVideoHost.classList.add('active');
            previewLogoWrap.classList.add('hidden');
        };
        const onErr = () => {
            previewLoading.classList.add('hidden');
            previewVideoHost.classList.remove('active');
            previewLogoWrap.classList.remove('hidden');
        };

        const timeoutId = setTimeout(onErr, 10000);

        previewVideo.onloadeddata = () => { clearTimeout(timeoutId); onReady(); };
        previewVideo.oncanplay = () => { clearTimeout(timeoutId); onReady(); };
        previewVideo.onerror = () => { clearTimeout(timeoutId); onErr(); };

        // Пытаемся играть
        const tryPlay = () => {
            const p = previewVideo.play();
            if (p && p.catch) {
                p.catch(err => {
                    if (err && err.name === 'NotAllowedError') {
                        previewVideo.muted = true;
                        previewMuted = true;
                        applyPreviewMute();
                        previewVideo.play().catch(()=>{});
                    }
                });
            }
        };

        if (isM3u8 && window.Hls && window.Hls.isSupported()) {
            previewHls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 15,
                maxBufferLength: 20,
                manifestLoadingTimeOut: 10000,
                fragLoadingTimeOut: 20000
            });
            previewHls.loadSource(proxied);
            previewHls.attachMedia(previewVideo);
            previewHls.on(Hls.Events.MANIFEST_PARSED, tryPlay);
            previewHls.on(Hls.Events.ERROR, (e, d) => {
                if (d && d.fatal) { clearTimeout(timeoutId); onErr(); }
            });
        } else if (isTs && window.mpegts && window.mpegts.isSupported()) {
            previewMpegts = mpegts.createPlayer({
                type: 'mpegts',
                url: proxied,
                isLive: true
            }, { enableWorker: true, liveBufferLatencyChasing: true });
            previewMpegts.attachMediaElement(previewVideo);
            previewMpegts.load();
            previewMpegts.play().catch(()=>{});
            previewMpegts.on(mpegts.Events.ERROR, () => { clearTimeout(timeoutId); onErr(); });
        } else {
            previewVideo.src = proxied;
            tryPlay();
        }
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
                closeChannelMenu();
            }
        };
    });

    // ===== FULLSCREEN PLAYER =====
    let hls = null, mpegtsP = null;

    function openFullscreenPlayer(ch) {
        // Останавливаем превью, чтобы не тянул трафик параллельно
        stopPreviewStream();
        if (previewLoading) previewLoading.classList.add('hidden');

        playerModal.classList.remove('hidden');
        document.body.classList.add('player-open');
        playStream(ch.url);
    }

    function closePlayer() {
        playerModal.classList.add('hidden');
        document.body.classList.remove('player-open');
        stopStream();
        if (document.fullscreenElement) document.exitFullscreen().catch(()=>{});

        // Возвращаем preview текущего канала
        if (previewChannel) {
            // Небольшая задержка, чтобы освободились ресурсы прокси
            setTimeout(() => startPreviewStream(previewChannel), 300);
        }
    }

    function stopStream() {
        const v = playerVideoHost.querySelector('video');
        if (hls) { try { hls.destroy(); } catch(e){} hls = null; }
        if (mpegtsP) { try { mpegtsP.destroy(); } catch(e){} mpegtsP = null; }
        if (v) { try { v.pause(); v.removeAttribute('src'); v.load(); } catch(e){} }
        // Отвязать от плеера (переносим обратно нельзя — создаём новый)
    }

    function playStream(url) {
        stopStream();
        // Создаём новый video внутри playerVideoHost
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
        const toast = $('player-toast');
        overlay.classList.remove('hidden');
        text.textContent = 'Загрузка потока...';
        if (toast) toast.style.display = 'none';

        const proxied = '/api/stream/proxy?url=' + encodeURIComponent(url);
        const low = url.split('?')[0].toLowerCase();
        const isM3u8 = low.includes('.m3u8');
        const isTs = low.endsWith('.ts');

        const ready = () => overlay.classList.add('hidden');
        const err = (m) => { overlay.classList.remove('hidden'); text.textContent = m || 'Ошибка воспроизведения'; };
        v.onloadeddata = ready;
        v.oncanplay = ready;
        v.onerror = () => err('Поток недоступен или формат не поддерживается');

        if (isM3u8 && window.Hls && window.Hls.isSupported()) {
            hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                manifestLoadingTimeOut: 15000,
                manifestLoadingMaxRetry: 2,
                fragLoadingTimeOut: 30000,
                maxBufferLength: 30,
                maxMaxBufferLength: 60
            });
            hls.loadSource(proxied);
            hls.attachMedia(v);
            hls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(()=>{}));
            let ec = 0;
            hls.on(Hls.Events.ERROR, (e, d) => {
                if (!d) return;
                const ig = ['bufferAppendError','bufferAppendingError','bufferStalledError','fragParsingError','fragLoadError','levelLoadError'];
                if (ig.includes(d.details) && !d.fatal) { ec++; if (ec === 6) { try { hls.startLoad(); } catch(x){} } return; }
                if (d.fatal) err('Ошибка HLS: ' + (d.details || 'unknown'));
            });
        } else if (isTs && window.mpegts && window.mpegts.isSupported()) {
            mpegtsP = mpegts.createPlayer({ type: 'mpegts', url: proxied, isLive: true }, { enableWorker: true, liveBufferLatencyChasing: true });
            mpegtsP.attachMediaElement(v);
            mpegtsP.load();
            mpegtsP.play().catch(()=>{});
            mpegtsP.on(mpegts.Events.ERROR, (t, d) => err('Ошибка TS: ' + d));
        } else {
            v.src = proxied;
            v.play().catch(()=>{});
        }

        setTimeout(() => {
            try {
                if (v && v.videoWidth === 0 && v.currentTime > 1 && !v.paused && toast) {
                    toast.textContent = 'Видео не отображается. Возможно формат H.265/HEVC или MPEG-2 не поддерживается.';
                    toast.style.display = 'block';
                    setTimeout(() => { toast.style.display = 'none'; }, 10000);
                }
            } catch (e) {}
        }, 8000);
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
        if (btnClose) btnClose.onclick = closePlayer;
        if (btnReload) btnReload.onclick = () => {
            const ch = window.__playerChannel;
            if (ch) playStream(ch.url);
        };
    })();

    // Запоминаем активный канал плеера, чтобы reload работал
    const _origOpenFull = openFullscreenPlayer;
    openFullscreenPlayer = function(ch) {
        window.__playerChannel = ch;
        _origOpenFull(ch);
    };

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

// ============ SPATIAL NAVIGATION (стрелки по координатам) ============
    const FOCUS_SELECTOR = '.tb-btn, .tb-update-btn, .tb-install, .tb-profile, #watch-search, .tb-btn-exit, .preview-btn, .cat-btn, .ch-card, .btn-ice, .group-btn, .admin-access';

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
        const W = window.innerWidth;
        const H = window.innerHeight;

        // Собираем кандидатов в нужном направлении
        const candidates = [];
        for (const el of all) {
            if (el === current) continue;
            const c = rectCenter(el);
            let dx = c.x - cur.x;
            let dy = c.y - cur.y;

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

    document.addEventListener('keydown', (e) => {
        const key = e.key;
        const playerOpen = playerModal && !playerModal.classList.contains('hidden');
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


    function focusCard(el) {
        if (!el) return;
        el.focus({ preventScroll: false });
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
    function getCols(cards) {
        if (cards.length < 2) return 1;
        const top = cards[0].offsetTop;
        let n = 0;
        for (const c of cards) { if (c.offsetTop === top) n++; else break; }
        return Math.max(1, n);
    }

    // ===== PING =====
    function sendPing() {
        fetch('/watch/api/ping', { credentials: 'same-origin', headers: authHeaders() }).catch(()=>{});
        if (window.PQTVFirebase && typeof window.PQTVFirebase.pingViewerPresence === 'function') {
            window.PQTVFirebase.pingViewerPresence().catch(()=>{});
        }
    }
    sendPing();
    setInterval(sendPing, 30000);

    // ===== BOOT =====
    loadChannels();
    checkTvUpdate(false);
});
