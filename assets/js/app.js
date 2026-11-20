document.addEventListener('DOMContentLoaded', () => {
    let currentPlaylist = null;
    let channelsData = [];
    let sourcesData = [];
    let playlistsList = [];
    const streamStatusCache = {};

    let parseContext = { playlist: null, channelIndex: -1, channelName: '' };

    // ===== SVG ICONS =====
    const I = {
        up:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>',
        down:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>',
        edit:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        search:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
        check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
        copy:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
        plus:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        file:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
        tv:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="7" width="20" height="15" rx="2"/><polyline points="17 2 12 7 7 2"/></svg>'
    };

    // ===== DOM refs =====
    const plListEl = document.getElementById('playlist-list');
    const channelsContainer = document.getElementById('channels-container');
    const plTitleEl = document.getElementById('current-playlist-title');
    const btnAddCh = document.getElementById('btn-add-channel');
    const btnCheckAll = document.getElementById('btn-check-all');
    const btnDeletePl = document.getElementById('btn-delete-playlist');
    const directBox = document.getElementById('direct-link-box');
    const directUrl = document.getElementById('direct-link-url');
    const colRight = document.getElementById('col-right');

    const formChannelContainer = document.getElementById('form-channel-container');
    const formSourceContainer = document.getElementById('form-source-container');
    const channelForm = document.getElementById('channel-form');
    const sourceForm = document.getElementById('source-form');

    const logoInput = document.getElementById('ch-logo');
    const logoPreviewBox = document.getElementById('logo-preview-box');
    const logoPreviewImg = document.getElementById('logo-preview-img');

    const screenEditor = document.getElementById('screen-editor');
    const screenParser = document.getElementById('screen-parser');
    const screenSources = document.getElementById('screen-sources');

    const navBtnEditor = document.getElementById('nav-btn-editor');
    const navBtnParser = document.getElementById('nav-btn-parser');
    const navBtnSources = document.getElementById('nav-btn-sources');

    const parseSearchInput = document.getElementById('parse-search-input');
    const btnStartParse = document.getElementById('btn-start-parse');
    const parseProgressBox = document.getElementById('parse-progress-box');
    const parseProgressStatus = document.getElementById('parse-progress-status');
    const parseProgressLog = document.getElementById('parse-progress-log');
    const parseResultsContainer = document.getElementById('parse-results-container');
    const parseTargetInfo = document.getElementById('parse-target-info');
    const parseTargetSelect = document.getElementById('parse-target-playlist');
    const sourcesListContainer = document.getElementById('sources-list-container');
    const btnAddSource = document.getElementById('btn-add-source');

    // ===== UI TOAST & MODALS (no alert/confirm/prompt) =====
    function showToast(msg, kind = 'info') {
        const stack = document.getElementById('pqtv-toast-stack');
        if (!stack) return;
        const el = document.createElement('div');
        el.className = 'pqtv-toast' + (kind === 'ok' ? ' ok' : kind === 'err' ? ' err' : '');
        el.textContent = String(msg || '');
        stack.appendChild(el);
        setTimeout(() => { el.remove(); }, 4000);
    }

    function openDialog({ title, message, promptDefault, isPrompt }) {
        return new Promise((resolve) => {
            const modal = document.getElementById('pqtv-dialog-modal');
            const titleEl = document.getElementById('pqtv-dialog-title');
            const msgEl = document.getElementById('pqtv-dialog-msg');
            const inputWrap = document.getElementById('pqtv-dialog-input-wrap');
            const inputEl = document.getElementById('pqtv-dialog-input');
            const form = document.getElementById('pqtv-dialog-form');
            const cancelBtn = document.getElementById('pqtv-dialog-cancel');
            const backdrop = document.getElementById('pqtv-dialog-backdrop');
            if (!modal || !form) { resolve(isPrompt ? null : false); return; }

            if (titleEl) titleEl.textContent = title || 'Подтверждение';
            if (msgEl) msgEl.textContent = message || '';
            if (inputWrap) inputWrap.classList.toggle('hidden', !isPrompt);
            if (inputEl) {
                inputEl.value = promptDefault || '';
                inputEl.required = Boolean(isPrompt);
            }
            modal.classList.remove('hidden');
            if (isPrompt && inputEl) setTimeout(() => inputEl.focus(), 20);

            const cleanup = (val) => {
                modal.classList.add('hidden');
                form.onsubmit = null;
                if (cancelBtn) cancelBtn.onclick = null;
                if (backdrop) backdrop.onclick = null;
                resolve(val);
            };
            form.onsubmit = (e) => {
                e.preventDefault();
                cleanup(isPrompt ? (inputEl ? inputEl.value.trim() : '') : true);
            };
            if (cancelBtn) cancelBtn.onclick = () => cleanup(isPrompt ? null : false);
            if (backdrop) backdrop.onclick = () => cleanup(isPrompt ? null : false);
        });
    }

    function uiConfirm(message, title = 'Подтверждение') {
        return openDialog({ title, message, isPrompt: false });
    }

    function uiPrompt(message, defaultVal = '', title = 'Ввод значения') {
        return openDialog({ title, message, promptDefault: defaultVal, isPrompt: true });
    }

    // ===== API =====
    function getAdminToken() {
        if (window.ADMIN_TOKEN) return window.ADMIN_TOKEN;
        try { return sessionStorage.getItem('pqtv_admin_token') || ''; } catch { return ''; }
    }

    let cloudSyncTimer = null;
    let cloudSyncRunning = false;
    let cloudSyncQueued = false;

    async function syncCloudDatabase() {
        if (!fbAdminConnected || !window.PQTVFirebase) return;
        if (cloudSyncRunning) {
            cloudSyncQueued = true;
            return;
        }
        cloudSyncRunning = true;
        try {
            const localSnapshot = await apiRequest('/api/cloud/export');
            if (!localSnapshot || !localSnapshot.ok) {
                throw new Error(localSnapshot && localSnapshot.error ? localSnapshot.error : 'Не удалось экспортировать локальную базу');
            }
            await window.PQTVFirebase.pushFullLocalToCloud(localSnapshot);
            const statusEl = document.getElementById('fb-status-text');
            if (statusEl) statusEl.textContent = 'Firestore: база синхронизирована';
        } catch (err) {
            console.error('Firestore database sync failed:', err);
            showUsersError((err && err.message) ? err.message : 'Ошибка синхронизации базы с Firestore');
        } finally {
            cloudSyncRunning = false;
            if (cloudSyncQueued) {
                cloudSyncQueued = false;
                scheduleCloudSync();
            }
        }
    }

    function scheduleCloudSync() {
        if (!fbAdminConnected) return;
        if (cloudSyncTimer) clearTimeout(cloudSyncTimer);
        cloudSyncTimer = setTimeout(() => {
            cloudSyncTimer = null;
            void syncCloudDatabase();
        }, 1200);
    }

    async function refreshAdminAfterCloudHydrate() {
        await loadPlaylists();
        if (currentPlaylist && playlistsList.includes(currentPlaylist)) {
            await loadChannels();
        } else if (playlistsList.length > 0) {
            await selectPlaylist(playlistsList[0]);
        } else {
            currentPlaylist = null;
            channelsData = [];
            renderChannels();
        }
        await Promise.all([
            loadCatalogStats().catch(() => {}),
            loadCatalogPlaylists().catch(() => {}),
            loadCatalogSources().catch(() => {}),
            loadSources().catch(() => {}),
            loadEpg().catch(() => {}),
            loadUsers().catch(() => {}),
            loadAdminAlerts().catch(() => {}),
            typeof loadHealthOverview === 'function' ? loadHealthOverview().catch(() => {}) : Promise.resolve(),
        ]);
        catalogOffset = 0;
        await loadCatalogChannels().catch(() => {});
        if (typeof window.__refreshStreamingControls === 'function') {
            await window.__refreshStreamingControls().catch(() => {});
        }
    }

    async function bootstrapCloudDatabase() {
        if (!fbAdminConnected || !window.PQTVFirebase) return;
        const statusEl = document.getElementById('fb-status-text');
        try {
            if (statusEl) statusEl.textContent = 'Firestore: проверка облачной базы...';
            const cloud = await window.PQTVFirebase.loadFullCloudSnapshot();
            if (cloud.hasCloud && cloud.snapshot) {
                const restored = await apiRequest('/api/cloud/hydrate', 'POST', cloud.snapshot);
                if (!restored || !restored.ok) {
                    if (restored && (restored._httpStatus === 409 || restored.stale)) {
                        const localRev = restored.localRevision ?? 0;
                        const cloudRev = restored.incomingRevision ?? 0;
                        const pushLocal = await uiConfirm(
                            `В Firestore сохранён более старый снимок (rev ${cloudRev}), а на сервере уже более новая версия (rev ${localRev}). Отправить локальную базу в Firestore, чтобы не вернуть удалённые данные?`,
                            'Конфликт версий базы'
                        );
                        if (pushLocal) {
                            await syncCloudDatabase();
                            if (statusEl) statusEl.textContent = `Firestore: локальная база (rev ${localRev}) отправлена в облако`;
                        } else {
                            if (statusEl) statusEl.textContent = `Локальная база сохранена (rev ${localRev}); облачный снимок пропущен`;
                            showToast('Устаревший снимок из облака отклонён, локальные данные сохранены', 'info');
                        }
                        return;
                    }
                    throw new Error(restored && restored.error ? restored.error : 'Не удалось восстановить базу из Firestore');
                }
                await refreshAdminAfterCloudHydrate();
                if (statusEl) statusEl.textContent = `Firestore: база восстановлена (rev ${restored.revision || 0})`;
                return;
            }
            await syncCloudDatabase();
        } catch (err) {
            console.error('Firestore bootstrap failed:', err);
            if (statusEl) statusEl.textContent = 'Firestore: ошибка синхронизации';
            showUsersError((err && err.message) ? err.message : 'Не удалось подключить облачную базу');
        }
    }

    async function apiRequest(url, method = 'GET', body = null) {
        const opts = { method, credentials: 'same-origin', headers: {} };
        const adminToken = getAdminToken();
        if (adminToken) opts.headers['X-Admin-Token'] = adminToken;
        if (['POST', 'PUT', 'DELETE'].includes(method)) opts.headers['X-CSRF-Token'] = window.CSRF_TOKEN || '';
        if (body) {
            opts.headers['Content-Type'] = 'application/json';
            opts.body = JSON.stringify(body);
        }
        try {
            const res = await fetch(url, opts);
            if (res.status === 401) {
                try { sessionStorage.removeItem('pqtv_admin_token'); } catch {}
                window.location.href = '/login?clear_token=1';
                return { ok: false, _httpStatus: 401 };
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                console.error(`API ${res.status} ${url}`, data);
                return Object.assign({}, data, { ok: false, _httpStatus: res.status });
            }
            if (
                fbAdminConnected &&
                (['POST', 'PUT', 'DELETE'].includes(method) ||
                    (method === 'GET' && url.startsWith('/api/source/rebuild'))) &&
                !url.startsWith('/api/cloud/hydrate')
            ) {
                scheduleCloudSync();
            }
            return data;
        } catch (e) {
            console.error(`Fetch error ${url}:`, e);
            return { ok: false, _httpStatus: 0, error: (e && e.message) ? e.message : 'Сетевая ошибка' };
        }
    }

    (function initStreamingModeControl() {
        const select = document.getElementById('streaming-mode-select');
        const httpsToggle = document.getElementById('streaming-https-toggle');
        if (!select && !httpsToggle) return;
        let currentSettings = { mode: 'auto_proxy_first', tryHttpsUpgrade: true, proxyTimeoutSec: 15 };

        async function refreshControls() {
            const res = await apiRequest('/api/settings/streaming');
            if (res && res.settings) {
                currentSettings = Object.assign({}, currentSettings, res.settings);
                if (select && currentSettings.mode && Array.from(select.options).some(option => option.value === currentSettings.mode)) {
                    select.value = currentSettings.mode;
                }
                if (httpsToggle) {
                    httpsToggle.checked = currentSettings.tryHttpsUpgrade !== false;
                }
            }
        }
        window.__refreshStreamingControls = refreshControls;
        void refreshControls();

        async function saveStreamingControls() {
            if (select) select.disabled = true;
            if (httpsToggle) httpsToggle.disabled = true;
            try {
                const payload = Object.assign({}, currentSettings, {
                    mode: select ? select.value : currentSettings.mode,
                    tryHttpsUpgrade: httpsToggle ? httpsToggle.checked : currentSettings.tryHttpsUpgrade,
                });
                const saved = await apiRequest('/api/settings/streaming', 'POST', payload);
                if (!saved || !saved.ok) throw new Error(saved && saved.error ? saved.error : 'Не удалось сохранить режим');
                currentSettings = Object.assign({}, currentSettings, saved.settings || payload);
                showToast('Настройки передачи потока сохранены', 'ok');
            } catch (err) {
                showToast((err && err.message) ? err.message : 'Ошибка сохранения режима', 'err');
            } finally {
                if (select) select.disabled = false;
                if (httpsToggle) httpsToggle.disabled = false;
            }
        }

        if (select) select.addEventListener('change', saveStreamingControls);
        if (httpsToggle) httpsToggle.addEventListener('change', saveStreamingControls);
    })();

    (function initAdminAuthControls() {
        const logoutBtn = document.getElementById('btn-admin-logout');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                try { sessionStorage.removeItem('pqtv_admin_token'); } catch {}
            });
        }
        const pwdBtn = document.getElementById('btn-admin-password');
        const pwdModal = document.getElementById('admin-password-modal');
        const pwdForm = document.getElementById('admin-password-form');
        const pwdInput = document.getElementById('admin-new-password');
        const pwdMsg = document.getElementById('admin-pwd-msg');
        const closeModal = () => { if (pwdModal) pwdModal.classList.add('hidden'); };
        if (pwdBtn && pwdModal) {
            pwdBtn.onclick = () => {
                if (pwdForm) pwdForm.reset();
                if (pwdMsg) { pwdMsg.textContent = ''; pwdMsg.classList.add('hidden'); }
                pwdModal.classList.remove('hidden');
            };
        }
        const b1 = document.getElementById('admin-pwd-backdrop');
        const b2 = document.getElementById('admin-pwd-close');
        const b3 = document.getElementById('admin-pwd-cancel');
        [b1, b2, b3].forEach(el => { if (el) el.onclick = closeModal; });
        if (pwdForm) {
            pwdForm.onsubmit = async (e) => {
                e.preventDefault();
                if (pwdMsg) { pwdMsg.textContent = ''; pwdMsg.classList.add('hidden'); }
                const password = pwdInput ? pwdInput.value : '';
                const res = await apiRequest('/api/auth/set-password', 'POST', { password });
                if (res.ok) {
                    closeModal();
                } else if (pwdMsg) {
                    pwdMsg.textContent = res.error || 'Ошибка сохранения пароля';
                    pwdMsg.classList.remove('hidden');
                }
            };
        }
    })();

    // ===== NAV =====
    const navBtnEpg = document.getElementById('nav-btn-epg');
    const navBtnHealth = document.getElementById('nav-btn-health');
    if (navBtnEditor) navBtnEditor.onclick = () => { showScreen('editor'); setNavActive('editor'); };
    if (navBtnParser) navBtnParser.onclick = () => { showScreen('parser'); setNavActive('parser'); };
    if (navBtnSources) navBtnSources.onclick = () => { showScreen('sources'); setNavActive('sources'); loadSources(); };
    if (navBtnEpg) navBtnEpg.onclick = () => { showScreen('epg'); setNavActive('epg'); loadEpg(); };
    const navBtnUsers = document.getElementById('nav-btn-users');
    if (navBtnUsers) navBtnUsers.onclick = () => { showScreen('users'); setNavActive('users'); loadUsers(); };
    const navBtnCatalog = document.getElementById('nav-btn-catalog');
    if (navBtnCatalog) navBtnCatalog.onclick = () => { showScreen('catalog'); setNavActive('catalog'); loadCatalog(); };
    if (navBtnHealth) navBtnHealth.onclick = () => { showScreen('health'); setNavActive('health'); loadHealthOverview(); };
    const navBtnApk = document.getElementById('nav-btn-apk');
    if (navBtnApk) navBtnApk.onclick = () => { showScreen('apk'); setNavActive('apk'); loadApkReleases(); };

    function setNavActive(name) {
        document.querySelectorAll('.nav-item').forEach(b => {
            b.classList.toggle('active', b.dataset.screen === name);
        });
    }

    function showScreen(name) {
        const screenEpg = document.getElementById('screen-epg');
        const screenUsers = document.getElementById('screen-users');
        const screenCatalog = document.getElementById('screen-catalog');
        const screenHealth = document.getElementById('screen-health');
        const screenApk = document.getElementById('screen-apk');
        [screenEditor, screenParser, screenSources, screenEpg, screenUsers, screenCatalog, screenHealth, screenApk].forEach(s => s && s.classList.add('hidden'));
        if (name === 'editor' && screenEditor) screenEditor.classList.remove('hidden');
        if (name === 'parser' && screenParser) screenParser.classList.remove('hidden');
        if (name === 'sources' && screenSources) screenSources.classList.remove('hidden');
        if (name === 'epg' && screenEpg) screenEpg.classList.remove('hidden');
        if (name === 'users' && screenUsers) screenUsers.classList.remove('hidden');
        if (name === 'catalog' && screenCatalog) screenCatalog.classList.remove('hidden');
        if (name === 'health' && screenHealth) screenHealth.classList.remove('hidden');
        if (name === 'apk' && screenApk) screenApk.classList.remove('hidden');
        if (name !== 'editor') closeForm();
        if (name !== 'apk' && typeof stopGithubPoll === 'function') stopGithubPoll();
    }

    // ===== PLAYLISTS =====
    async function loadPlaylists() {
        if (!plListEl) return;
        const res = await apiRequest('/api/playlists');
        playlistsList = Array.isArray(res.playlists) ? res.playlists : [];
        plListEl.innerHTML = '';

        if (playlistsList.length === 0) {
            plListEl.innerHTML = '<li style="padding:10px; color:#666; font-size:12px; cursor:default;">Нет плейлистов</li>';
        } else {
            playlistsList.forEach(name => {
                const li = document.createElement('li');
                if (name === currentPlaylist) li.classList.add('active');
                li.innerHTML = `
                    <span class="pl-name">${I.file}<span>${escapeHtml(name)}.m3u</span></span>
                    <button type="button" class="del-pl" title="Удалить плейлист">${I.trash}</button>
                `;
                li.querySelector('.pl-name').onclick = () => selectPlaylist(name);
                li.querySelector('.del-pl').onclick = (e) => { e.stopPropagation(); deletePlaylist(name); };
                plListEl.appendChild(li);
            });
        }
        populateParseTargetSelect();
    }

    function populateParseTargetSelect() {
        if (!parseTargetSelect) return;
        const prev = parseTargetSelect.value;
        parseTargetSelect.innerHTML = '';
        if (playlistsList.length === 0) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = '— нет плейлистов —';
            parseTargetSelect.appendChild(opt);
            return;
        }
        playlistsList.forEach(name => {
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name + '.m3u';
            parseTargetSelect.appendChild(opt);
        });
        if (prev && playlistsList.includes(prev)) parseTargetSelect.value = prev;
        else if (currentPlaylist && playlistsList.includes(currentPlaylist)) parseTargetSelect.value = currentPlaylist;
    }

    async function selectPlaylist(name) {
        currentPlaylist = name;
        if (plTitleEl) plTitleEl.textContent = name + '.m3u';
        if (btnAddCh) btnAddCh.classList.remove('hidden');
        if (btnCheckAll) btnCheckAll.classList.remove('hidden');
        if (btnDeletePl) btnDeletePl.classList.remove('hidden');
        if (directBox) directBox.classList.remove('hidden');
        const url = `${window.location.origin}/playlist/${encodeURIComponent(name)}.m3u`;
        if (directUrl) { directUrl.href = url; directUrl.textContent = url; }
        closeForm();
        showScreen('editor');
        setNavActive('editor');
        loadPlaylists();
        await loadChannels();
    }

    async function loadChannels() {
        if (!currentPlaylist) return;
        const res = await apiRequest(`/api/channels?playlist=${encodeURIComponent(currentPlaylist)}`);
        channelsData = Array.isArray(res.channels) ? res.channels : [];
        renderChannels();
    }

    // ===== RENDER CHANNELS =====
    function renderChannels() {
        if (!channelsContainer) return;
        if (!currentPlaylist) {
            channelsContainer.innerHTML = '<p class="placeholder-text">Выберите плейлист слева<br>или откройте «Парсинг каналов»</p>';
            return;
        }
        if (channelsData.length === 0) {
            channelsContainer.innerHTML = '<p class="placeholder-text">В этом плейлисте нет каналов</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:44px;"></th>
            <th>Канал</th>
            <th style="width:110px;">Статус</th>
            <th style="width:200px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;

        channelsData.forEach((ch, idx) => {
            const logoHtml = ch.logo
                ? `<div class="ch-logo-wrap" style="border:none;background:transparent;padding:0;"><img src="${escapeHtml(ch.logo)}" class="ch-logo" data-logo></div>`
                : `<div class="ch-logo-wrap">${I.tv}</div>`;

            const isFirst = idx === 0 ? 'disabled' : '';
            const isLast = idx === channelsData.length - 1 ? 'disabled' : '';

            const stRaw = streamStatusCache[ch.url];
            const st = typeof stRaw === 'string' ? stRaw : (stRaw && stRaw.status);
            const stReason = (stRaw && stRaw.reason) ? stRaw.reason : '';
            const stDiag = (stRaw && stRaw.diagCode && stRaw.diagCode !== 'ok') ? stRaw.diagCode : '';
            let badge = `<button class="badge-status badge-unknown" data-action="check" data-idx="${idx}">Проверить</button>`;
            if (st === 'checking') badge = `<span class="badge-status badge-checking">…</span>`;
            else if (st === 'online') badge = `<span class="badge-status badge-online" data-action="check" data-idx="${idx}" title="${escapeHtml(stReason || 'Перепроверить')}">online</span>`;
            else if (st === 'offline') badge = `<span class="badge-status badge-offline" data-action="check" data-idx="${idx}" title="${escapeHtml(stReason || 'Перепроверить')}">${escapeHtml(stDiag ? 'off:' + stDiag : 'offline')}</span>`;
            else if (st === 'unknown') badge = `<span class="badge-status badge-unknown" data-action="check" data-idx="${idx}" title="${escapeHtml(stReason || 'Не удалось подтвердить статус')}">неизвестно</span>`;

            const pausedTag = ch.paused ? ' <span class="health-badge warn" style="margin-left:6px;">Приостановлен</span>' : '';

            html += `
                <tr data-idx="${idx}">
                    <td>${logoHtml}</td>
                    <td>
                        <div class="ch-title">${escapeHtml(ch.name)}${pausedTag}</div>
                        <div class="ch-group">${escapeHtml(ch.group || '—')}</div>
                    </td>
                    <td>${badge}</td>
                    <td>
                        <div class="actions-cell">
                            <button class="icon-btn accent" data-action="parse" data-idx="${idx}" title="Искать рабочий поток">${I.search}</button>
                            <button class="icon-btn" data-action="up" data-idx="${idx}" ${isFirst} title="Выше">${I.up}</button>
                            <button class="icon-btn" data-action="down" data-idx="${idx}" ${isLast} title="Ниже">${I.down}</button>
                            <button class="icon-btn" data-action="edit" data-idx="${idx}" title="Изменить">${I.edit}</button>
                            <button class="icon-btn danger" data-action="delete" data-idx="${idx}" title="Удалить">${I.trash}</button>
                        </div>
                    </td>
                </tr>`;
        });
        html += '</tbody></table>';
        channelsContainer.innerHTML = html;

        channelsContainer.querySelectorAll('[data-logo]').forEach(img => {
            img.onerror = () => {
                const wrap = img.parentNode;
                wrap.style.border = '';
                wrap.style.background = '';
                wrap.style.padding = '';
                wrap.innerHTML = I.tv;
            };
        });

        channelsContainer.querySelectorAll('[data-action]').forEach(el => {
            el.onclick = (e) => {
                e.stopPropagation();
                const idx = parseInt(el.dataset.idx);
                const act = el.dataset.action;
                if (act === 'check') checkStream(idx);
                else if (act === 'parse') startParsingForChannel(idx);
                else if (act === 'up') moveChannel(idx, -1);
                else if (act === 'down') moveChannel(idx, 1);
                else if (act === 'edit') editChannel(idx);
                else if (act === 'delete') deleteChannel(idx);
            };
        });
    }

    async function checkStream(idx) {
        const ch = channelsData[idx];
        if (!ch || !ch.url) return;
        streamStatusCache[ch.url] = 'checking';
        renderChannels();
        try {
            const res = await apiRequest('/api/stream/check', 'POST', {
                url: ch.url,
                force: true,
                userAgent: ch.userAgent || undefined,
                referer: ch.referer || undefined,
                origin: ch.origin || undefined,
            });
            streamStatusCache[ch.url] = {
                status: res.status || (res.online === true ? 'online' : res.online === false ? 'offline' : 'unknown'),
                diagCode: res.diagCode || '',
                reason: res.reason || '',
            };
        } catch (e) { streamStatusCache[ch.url] = 'unknown'; }
        renderChannels();
    }

    if (btnCheckAll) {
        btnCheckAll.onclick = async () => {
            if (!channelsData.length) return;
            btnCheckAll.disabled = true;
            const origText = btnCheckAll.innerHTML;
            btnCheckAll.textContent = 'Проверка...';
            const uniqueChannels = new Map();
            channelsData.forEach((channel, index) => {
                if (channel.url && !uniqueChannels.has(channel.url)) uniqueChannels.set(channel.url, index);
                if (channel.url) streamStatusCache[channel.url] = 'checking';
            });
            renderChannels();
            for (const index of uniqueChannels.values()) await checkStream(index);
            btnCheckAll.disabled = false;
            btnCheckAll.innerHTML = origText;
        };
    }

    // ===== PARSING =====
    function startParsingForChannel(idx) {
        const ch = channelsData[idx];
        if (!ch) return;
        parseContext = { playlist: currentPlaylist, channelIndex: idx, channelName: ch.name };
        const elCh = document.getElementById('parse-target-channel-name');
        const elPl = document.getElementById('parse-target-playlist-name');
        if (elCh) elCh.textContent = ch.name;
        if (elPl) elPl.textContent = currentPlaylist + '.m3u';
        if (parseTargetInfo) parseTargetInfo.classList.remove('hidden');
        if (parseSearchInput) parseSearchInput.value = ch.name;
        showScreen('parser');
        setNavActive('parser');
        runParsing(ch.name);
    }

    if (btnStartParse) {
        btnStartParse.onclick = () => {
            parseContext = { playlist: null, channelIndex: -1, channelName: '' };
            if (parseTargetInfo) parseTargetInfo.classList.add('hidden');
            const q = parseSearchInput ? parseSearchInput.value.trim() : '';
            if (q) runParsing(q);
        };
    }

    async function runParsing(query) {
        if (parseProgressBox) parseProgressBox.classList.remove('hidden');
        if (parseProgressStatus) parseProgressStatus.textContent = 'Поиск ссылок по источникам...';
        if (parseProgressLog) parseProgressLog.textContent = 'Отправка запросов. Пожалуйста, подождите.';
        if (parseResultsContainer) parseResultsContainer.innerHTML = '';

        try {
            const res = await apiRequest('/api/stream/parse', 'POST', { query });
            const items = Array.isArray(res.results) ? res.results : [];

            if (items.length === 0) {
                if (parseProgressStatus) parseProgressStatus.textContent = 'Ссылок не найдено';
                if (parseProgressLog) parseProgressLog.textContent = 'Попробуйте изменить запрос или добавить источники.';
                if (parseResultsContainer) parseResultsContainer.innerHTML = '<p class="placeholder-text">Потоков не найдено</p>';
                return;
            }

            if (parseProgressStatus) parseProgressStatus.textContent = `Найдено ссылок: ${items.length}. Проверка доступности...`;

            const checks = new Map();
            const uniqueUrls = [...new Set(items.map(item => item.url).filter(Boolean))];
            let checkIndex = 0;
            await Promise.all(Array.from({ length: Math.min(6, uniqueUrls.length) }, async () => {
                while (checkIndex < uniqueUrls.length) {
                    const index = checkIndex++;
                    const url = uniqueUrls[index];
                    try {
                        const result = await apiRequest('/api/stream/check', 'POST', { url });
                        checks.set(url, result.status || (result.online === true ? 'online' : result.online === false ? 'offline' : 'unknown'));
                    } catch {
                        checks.set(url, 'unknown');
                    }
                }
            }));

            let html = `<table class="ch-table"><thead><tr>
                <th style="width:170px;">Источник</th>
                <th>Ссылка потока</th>
                <th style="width:100px;">Статус</th>
                <th style="width:170px; text-align:right;">Действие</th>
            </tr></thead><tbody>`;

            items.forEach((item, i) => {
                const status = checks.get(item.url) || 'unknown';
                const badge = status === 'online'
                    ? `<span class="badge-status badge-online">online</span>`
                    : status === 'offline'
                        ? `<span class="badge-status badge-offline">offline</span>`
                        : `<span class="badge-status badge-unknown" title="Проверка не дала достоверного результата">неизвестно</span>`;

                const enc = encodeURIComponent(item.url);
                const encName = encodeURIComponent(query);
                const btn = parseContext.channelIndex >= 0
                    ? `<button class="btn btn-primary" data-apply="${enc}" style="padding:6px 12px; font-size:12px;">${I.check} Заменить</button>`
                    : `<button class="btn btn-primary" data-add="${enc}" data-name="${encName}" style="padding:6px 12px; font-size:12px;">${I.plus} Добавить</button>`;

                html += `<tr class="parse-row" data-purl="${encodeURIComponent(item.url)}" data-pname="${escapeHtml(item.title || query)}" style="cursor:pointer;">
                    <td><span style="color:var(--muted); font-size:12px; font-weight:600;">${escapeHtml(item.source)}</span></td>
                    <td style="word-break:break-all; font-family:'SF Mono',Consolas,monospace; font-size:11.5px; color:var(--text-dim);">${escapeHtml(item.url)}</td>
                    <td>${badge}</td>
                    <td style="text-align:right;">${btn}</td>
                </tr>`;
            });
            html += '</tbody></table>';
            if (parseProgressBox) parseProgressBox.classList.add('hidden');
            parseResultsContainer.innerHTML = html;

            parseResultsContainer.querySelectorAll('.parse-row').forEach(tr => {
                tr.onclick = (e) => {
                    if (e.target.closest('button')) return;
                    openPlayerByUrl(decodeURIComponent(tr.dataset.purl), decodeURIComponent(tr.dataset.pname));
                };
            });

            parseResultsContainer.querySelectorAll('[data-apply]').forEach(b => {
                b.onclick = () => applyParsedUrl(decodeURIComponent(b.dataset.apply));
            });
            parseResultsContainer.querySelectorAll('[data-add]').forEach(b => {
                b.onclick = () => addParsedToPlaylist(
                    decodeURIComponent(b.dataset.add),
                    decodeURIComponent(b.dataset.name)
                );
            });
        } catch (e) {
            if (parseProgressStatus) parseProgressStatus.textContent = 'Ошибка при парсинге';
            console.error(e);
        }
    }

    async function applyParsedUrl(url) {
        if (!parseContext.playlist || parseContext.channelIndex < 0) return;
        const targetPl = parseContext.playlist;
        const chName = parseContext.channelName;
        channelsData[parseContext.channelIndex].url = url;
        const res = await apiRequest('/api/channels/save', 'POST', {
            playlist: targetPl,
            channels: channelsData
        });
        if (!res || !res.ok) {
            showToast((res && res.error) || 'Ошибка сохранения канала', 'err');
            await loadChannels();
            return;
        }
        showToast(`Ссылка обновлена для «${chName}»`, 'ok');
        parseContext = { playlist: null, channelIndex: -1, channelName: '' };
        if (parseTargetInfo) parseTargetInfo.classList.add('hidden');
        await selectPlaylist(targetPl || currentPlaylist);
        loadCatalog().catch(() => {});
        if (typeof loadHealthOverview === 'function') loadHealthOverview().catch(() => {});
    }

    async function addParsedToPlaylist(url, name) {
        const target = parseTargetSelect ? parseTargetSelect.value : '';
        if (!target) { showToast('Выберите плейлист назначения', 'err'); return; }

        const res = await apiRequest(`/api/channels?playlist=${encodeURIComponent(target)}`);
        let list = Array.isArray(res.channels) ? res.channels : [];

        const existing = list.find(c => (c.name || '').toLowerCase() === name.toLowerCase());
        if (existing) {
            existing.url = url;
        } else {
            list.push({ name: name, group: 'Общие', logo: '', url: url });
        }

        const save = await apiRequest('/api/channels/save', 'POST', { playlist: target, channels: list });
        if (save && save.ok) {
            if (target === currentPlaylist) await loadChannels();
            showToast(`Добавлено в «${target}.m3u»`, 'ok');
            loadCatalog().catch(() => {});
            if (typeof loadHealthOverview === 'function') loadHealthOverview().catch(() => {});
        } else {
            showToast((save && save.error) || 'Ошибка сохранения', 'err');
        }
    }

    // ===== SOURCES =====
    let indexStatusMap = {};

    async function loadSources() {
        const res = await apiRequest('/api/sources');
        sourcesData = Array.isArray(res.sources) ? res.sources : [];

        try {
            const st = await apiRequest('/api/stream/index/status');
            indexStatusMap = {};
            (st.status || []).forEach(s => { indexStatusMap[s.id] = s; });
        } catch (e) { indexStatusMap = {}; }

        renderSources();
    }

    const btnRefreshIndex = document.getElementById('btn-refresh-index');
    if (btnRefreshIndex) {
        btnRefreshIndex.onclick = async () => {
            const txt = document.getElementById('btn-refresh-text');
            btnRefreshIndex.disabled = true;
            if (txt) txt.textContent = 'Индексация...';
            try {
                const res = await apiRequest('/api/stream/index/refresh', 'POST', { mode: 'all' });
                if (!res || !res.ok) {
                    showToast((res && res.error) || 'Ошибка обновления индекса', 'err');
                    if (txt) txt.textContent = 'Обновить индекс';
                    return;
                }
                const ok = Object.values(res.results || {}).filter(r => r.ok).length;
                const total = res.total || 0;
                if (txt) txt.textContent = `Готово (${ok}/${total}, ${res.elapsed}с)`;
                await loadSources();
                loadCatalog().catch(() => {});
                setTimeout(() => { if (txt) txt.textContent = 'Обновить индекс'; }, 2500);
            } catch (e) {
                showToast('Ошибка: ' + e.message, 'err');
                if (txt) txt.textContent = 'Обновить индекс';
            } finally {
                btnRefreshIndex.disabled = false;
            }
        };
    }

    function fmtAge(sec) {
        if (!sec) return 'нет';
        if (sec < 60) return sec + ' с';
        if (sec < 3600) return Math.floor(sec / 60) + ' мин';
        if (sec < 86400) return Math.floor(sec / 3600) + ' ч';
        return Math.floor(sec / 86400) + ' дн';
    }

    function renderSources() {
        if (!sourcesListContainer) return;
        if (sourcesData.length === 0) {
            sourcesListContainer.innerHTML = '<p class="placeholder-text">Список источников пуст</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:70px;">Статус</th>
            <th>Название</th>
            <th style="width:100px;">Тип</th>
            <th style="width:180px;">Индекс</th>
            <th>URL</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;

        sourcesData.forEach((src, idx) => {
            const status = src.enabled
                ? `<span class="badge-status badge-online">Вкл</span>`
                : `<span class="badge-status badge-offline">Выкл</span>`;

            const st = indexStatusMap[src.id] || {};
            let idxInfo = '<span style="color:var(--muted); font-size:12px;">не проиндексирован</span>';
            if (st.indexed > 0) {
                const stale = st.stale ? ' <span style="color:#f59e0b;">●</span>' : ' <span style="color:#10b981;">●</span>';
                idxInfo = `<b style="color:#fff;">${st.indexed}</b> <span style="color:var(--muted); font-size:11px;">каналов</span>${stale}<br><span style="color:var(--muted-2); font-size:10.5px;">${fmtAge(st.age_seconds)} назад</span>`;
            }

            html += `<tr>
                <td>${status}</td>
                <td><b style="color:#fff;">${escapeHtml(src.name)}</b></td>
                <td><span style="font-size:11px; background:var(--surface-2); padding:3px 8px; border-radius:5px; color:var(--primary-hi); font-weight:600;">${escapeHtml(src.type)}</span></td>
                <td>${idxInfo}</td>
                <td style="word-break:break-all; font-size:11.5px; color:var(--muted);">${escapeHtml(src.url)}</td>
                <td>
                    <div class="actions-cell">
                        <button class="icon-btn" data-src-edit="${idx}" title="Изменить">${I.edit}</button>
                        <button class="icon-btn danger" data-src-del="${idx}" title="Удалить">${I.trash}</button>
                    </div>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        sourcesListContainer.innerHTML = html;

        sourcesListContainer.querySelectorAll('[data-src-edit]').forEach(b => {
            b.onclick = () => editSource(parseInt(b.dataset.srcEdit));
        });
        sourcesListContainer.querySelectorAll('[data-src-del]').forEach(b => {
            b.onclick = () => deleteSource(parseInt(b.dataset.srcDel));
        });
    }

    if (btnAddSource) {
        btnAddSource.onclick = () => {
            if (sourceForm) sourceForm.reset();
            document.getElementById('src-id').value = '';
            document.getElementById('src-form-title').textContent = 'Новый источник';
            document.getElementById('src-enabled').checked = true;
            const uaEl = document.getElementById('src-ua');
            const refEl = document.getElementById('src-ref');
            const origEl = document.getElementById('src-origin');
            const toEl = document.getElementById('src-timeout');
            const tlsEl = document.getElementById('src-ignore-tls');
            if (uaEl) uaEl.value = '';
            if (refEl) refEl.value = '';
            if (origEl) origEl.value = '';
            if (toEl) toEl.value = '';
            if (tlsEl) tlsEl.checked = false;
            if (formChannelContainer) formChannelContainer.classList.add('hidden');
            if (formSourceContainer) formSourceContainer.classList.remove('hidden');
            if (colRight) colRight.classList.remove('hidden');
        };
    }

    function editSource(idx) {
        const src = sourcesData[idx];
        if (!src) return;
        document.getElementById('src-id').value = src.id;
        document.getElementById('src-name').value = src.name;
        document.getElementById('src-type').value = src.type;
        document.getElementById('src-url').value = src.url;
        document.getElementById('src-enabled').checked = !!src.enabled;
        const uaEl = document.getElementById('src-ua');
        const refEl = document.getElementById('src-ref');
        const origEl = document.getElementById('src-origin');
        const toEl = document.getElementById('src-timeout');
        const tlsEl = document.getElementById('src-ignore-tls');
        if (uaEl) uaEl.value = src.userAgent || '';
        if (refEl) refEl.value = src.referer || '';
        if (origEl) origEl.value = src.origin || '';
        if (toEl) toEl.value = src.timeoutSec ? String(src.timeoutSec) : '';
        if (tlsEl) tlsEl.checked = !!src.ignoreTlsErrors;
        document.getElementById('src-form-title').textContent = 'Редактировать источник';
        if (formChannelContainer) formChannelContainer.classList.add('hidden');
        if (formSourceContainer) formSourceContainer.classList.remove('hidden');
        if (colRight) colRight.classList.remove('hidden');
    }

    async function deleteSource(idx) {
        const src = sourcesData[idx];
        if (!src) return;
        if (!(await uiConfirm(`Удалить источник «${src.name || src.id}» и его потоки из каталога?`))) return;
        const res = await apiRequest('/api/sources/delete', 'POST', { id: src.id });
        if (!res || !res.ok) {
            showToast((res && res.error) || 'Ошибка удаления источника', 'err');
            await loadSources();
            return;
        }
        showToast(
            `Источник удалён (потоков: ${res.removedStreams || 0}, каналов: ${res.removedChannels || 0})`,
            'ok'
        );
        await loadSources();
        loadCatalog().catch(() => {});
        if (fbAdminConnected) void syncCloudDatabase();
    }

    if (sourceForm) {
        sourceForm.onsubmit = async (e) => {
            e.preventDefault();
            const id = document.getElementById('src-id').value;
            const ua = (document.getElementById('src-ua')?.value || '').trim();
            const ref = (document.getElementById('src-ref')?.value || '').trim();
            const orig = (document.getElementById('src-origin')?.value || '').trim();
            const timeoutVal = parseInt(document.getElementById('src-timeout')?.value || '', 10) || 0;
            const ignoreTls = !!(document.getElementById('src-ignore-tls')?.checked);
            const srcData = {
                id: id || ('src_' + Date.now()),
                name: document.getElementById('src-name').value.trim(),
                type: document.getElementById('src-type').value,
                url: document.getElementById('src-url').value.trim(),
                enabled: document.getElementById('src-enabled').checked
            };
            if (ua) srcData.userAgent = ua;
            if (ref) srcData.referer = ref;
            if (orig) srcData.origin = orig;
            if (timeoutVal >= 3) srcData.timeoutSec = timeoutVal;
            if (ignoreTls) srcData.ignoreTlsErrors = true;
            const prevSources = sourcesData.slice();
            if (id) {
                const i = sourcesData.findIndex(s => s.id === id);
                if (i >= 0) sourcesData[i] = srcData;
            } else {
                sourcesData.push(srcData);
            }
            const ok = await saveSources();
            if (!ok) {
                sourcesData = prevSources;
                renderSources();
                return;
            }
            closeForm();
        };
    }

    async function saveSources() {
        const res = await apiRequest('/api/sources/save', 'POST', { sources: sourcesData });
        if (!res || !res.ok) {
            showToast((res && res.error) || 'Ошибка сохранения источников', 'err');
            await loadSources();
            return false;
        }
        await loadSources();
        loadCatalog().catch(() => {});
        return true;
    }

    // ===== EPG =====
    let epgData = [];

    async function loadEpg() {
        const res = await apiRequest('/api/epg');
        epgData = Array.isArray(res.epg) ? res.epg : [];
        renderEpg();
    }

    function renderEpg() {
        const el = document.getElementById('epg-list-container');
        if (!el) return;
        if (epgData.length === 0) {
            el.innerHTML = '<p class="placeholder-text">Список пуст. Добавьте ссылку на XMLTV-файл.</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:80px;">Статус</th>
            <th>Название</th>
            <th>URL (XMLTV)</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        epgData.forEach((epg, idx) => {
            const status = epg.enabled
                ? `<span class="badge-status badge-online">Вкл</span>`
                : `<span class="badge-status badge-offline">Выкл</span>`;
            html += `<tr>
                <td>${status}</td>
                <td><b style="color:#fff;">${escapeHtml(epg.name)}</b></td>
                <td style="word-break:break-all; font-size:12px; color:var(--muted); font-family:'SF Mono',Consolas,monospace;">${escapeHtml(epg.url)}</td>
                <td>
                    <div class="actions-cell">
                        <button class="icon-btn" data-epg-edit="${idx}" title="Изменить">${I.edit}</button>
                        <button class="icon-btn danger" data-epg-del="${idx}" title="Удалить">${I.trash}</button>
                    </div>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        el.innerHTML = html;
        el.querySelectorAll('[data-epg-edit]').forEach(b => b.onclick = () => editEpg(parseInt(b.dataset.epgEdit)));
        el.querySelectorAll('[data-epg-del]').forEach(b => b.onclick = () => deleteEpg(parseInt(b.dataset.epgDel)));
    }

    const btnAddEpg = document.getElementById('btn-add-epg');
    if (btnAddEpg) {
        btnAddEpg.onclick = () => {
            const f = document.getElementById('epg-form');
            if (f) f.reset();
            document.getElementById('epg-id').value = '';
            document.getElementById('epg-form-title').textContent = 'Новая ссылка на EPG';
            document.getElementById('epg-enabled').checked = true;
            if (formChannelContainer) formChannelContainer.classList.add('hidden');
            if (formSourceContainer) formSourceContainer.classList.add('hidden');
            const fe = document.getElementById('form-epg-container');
            if (fe) fe.classList.remove('hidden');
            if (colRight) colRight.classList.remove('hidden');
        };
    }

    function editEpg(idx) {
        const e = epgData[idx];
        if (!e) return;
        document.getElementById('epg-id').value = e.id;
        document.getElementById('epg-name').value = e.name;
        document.getElementById('epg-url').value = e.url;
        document.getElementById('epg-enabled').checked = !!e.enabled;
        document.getElementById('epg-form-title').textContent = 'Редактировать EPG';
        if (formChannelContainer) formChannelContainer.classList.add('hidden');
        if (formSourceContainer) formSourceContainer.classList.add('hidden');
        const fe = document.getElementById('form-epg-container');
        if (fe) fe.classList.remove('hidden');
        if (colRight) colRight.classList.remove('hidden');
    }

    async function deleteEpg(idx) {
        if (!(await uiConfirm('Удалить эту ссылку?'))) return;
        epgData.splice(idx, 1);
        await saveEpg();
    }

    const epgForm = document.getElementById('epg-form');
    if (epgForm) {
        epgForm.onsubmit = async (e) => {
            e.preventDefault();
            const id = document.getElementById('epg-id').value;
            const data = {
                id: id || ('epg_' + Date.now()),
                name: document.getElementById('epg-name').value.trim(),
                url: document.getElementById('epg-url').value.trim(),
                enabled: document.getElementById('epg-enabled').checked
            };
            const prevEpg = epgData.slice();
            if (id) {
                const i = epgData.findIndex(x => x.id === id);
                if (i >= 0) epgData[i] = data;
            } else {
                epgData.push(data);
            }
            const ok = await saveEpg();
            if (!ok) {
                epgData = prevEpg;
                renderEpg();
                return;
            }
            closeForm();
        };
    }

    async function saveEpg() {
        const res = await apiRequest('/api/epg/save', 'POST', { epg: epgData });
        if (!res || !res.ok) {
            showToast((res && res.error) || 'Ошибка сохранения EPG', 'err');
            await loadEpg();
            return false;
        }
        renderEpg();
        return true;
    }

    // ===== COPY CHANNEL =====
    function populateCopyTarget() {
        const sel = document.getElementById('copy-target-playlist');
        if (!sel) return;
        const prev = sel.value;
        sel.innerHTML = '<option value="">— выберите плейлист —</option>';
        playlistsList.forEach(name => {
            if (name === currentPlaylist) return;  // текущий пропускаем
            const opt = document.createElement('option');
            opt.value = name;
            opt.textContent = name + '.m3u';
            sel.appendChild(opt);
        });
        if (prev && sel.querySelector(`option[value="${prev}"]`)) sel.value = prev;
    }

    const btnCopyChannel = document.getElementById('btn-copy-channel');
    if (btnCopyChannel) {
        btnCopyChannel.onclick = async () => {
            const target = document.getElementById('copy-target-playlist').value;
            if (!target) { showToast('Выберите плейлист, куда копировать', 'err'); return; }
            if (target === currentPlaylist) { showToast('Нельзя копировать в тот же плейлист', 'err'); return; }

            const data = {
                name:  document.getElementById('ch-name').value.trim(),
                group: document.getElementById('ch-group').value.trim(),
                logo:  document.getElementById('ch-logo').value.trim(),
                url:   document.getElementById('ch-url').value.trim(),
                tvg_id: document.getElementById('channel-index').value !== '-1'
                    ? (channelsData[parseInt(document.getElementById('channel-index').value)] || {}).tvg_id || ''
                    : ''
            };
            if (!data.name || !data.url) { showToast('Сначала заполните «Название» и «URL потока»', 'err'); return; }

            const btn = btnCopyChannel;
            const txt = document.getElementById('btn-copy-channel-text');
            const origText = txt ? txt.textContent : 'Копировать';
            btn.disabled = true;
            if (txt) txt.textContent = 'Копирование...';

            try {
                // Загружаем целевой плейлист
                const res = await apiRequest(`/api/channels?playlist=${encodeURIComponent(target)}`);
                let list = Array.isArray(res.channels) ? res.channels : [];

                const lc = data.name.toLowerCase();
                const idx = list.findIndex(c => (c.name || '').toLowerCase() === lc);

                if (idx >= 0) {
                    if (!(await uiConfirm(`Канал «${data.name}» уже есть в «${target}.m3u». Заменить его?`))) {
                        if (txt) txt.textContent = origText;
                        btn.disabled = false;
                        return;
                    }
                    list[idx] = { ...list[idx], ...data };
                } else {
                    list.push(data);
                }

                const save = await apiRequest('/api/channels/save', 'POST', {
                    playlist: target,
                    channels: list
                });

                if (save.ok) {
                    if (txt) txt.textContent = '✓ Скопировано';
                    btn.style.background = 'rgba(16,185,129,0.15)';
                    btn.style.borderColor = 'rgba(16,185,129,0.4)';
                    btn.style.color = '#6ee7b7';
                    setTimeout(() => {
                        if (txt) txt.textContent = origText;
                        btn.style.background = '';
                        btn.style.borderColor = '';
                        btn.style.color = '';
                        btn.disabled = false;
                    }, 1800);
                } else {
                    showToast(save.error || 'Ошибка копирования', 'err');
                    if (txt) txt.textContent = origText;
                    btn.disabled = false;
                }
            } catch (e) {
                console.error(e);
                showToast('Ошибка: ' + e.message, 'err');
                if (txt) txt.textContent = origText;
                btn.disabled = false;
            }
        };
    }

    // ===== USERS, INVITES & CHANNEL ALERTS =====
    let usersData = [];
    let localUsersCache = [];
    let firestoreUsersCache = [];
    let invitesData = [];
    let localInvitesCache = [];
    let firestoreInvitesCache = [];
    let alertsData = [];
    let localAlertsCache = [];
    let firestoreAlertsCache = [];
    let fbAdminConnected = false;
    let fbUnsubscribe = null;
    let fbInvitesUnsubscribe = null;
    let fbAlertsUnsubscribe = null;

    function showUsersError(msg) {
        const box = document.getElementById('users-fb-error');
        if (!box) return;
        if (!msg) {
            box.textContent = '';
            box.classList.add('hidden');
        } else {
            box.textContent = msg;
            box.classList.remove('hidden');
        }
    }

    function showUserFormError(msg) {
        const box = document.getElementById('popup-user-error');
        if (!box) return;
        if (!msg) {
            box.textContent = '';
            box.classList.add('hidden');
        } else {
            box.textContent = msg;
            box.classList.remove('hidden');
        }
    }

    function mergeAndRenderUsers() {
        if (!fbAdminConnected) {
            usersData = localUsersCache.map(u => Object.assign({}, u, { inFirestore: false }));
            invitesData = localInvitesCache.map(inv => Object.assign({}, inv, { inFirestore: false }));
            renderUsers();
            renderInvites();
            return;
        }
        const localById = new Map(localUsersCache.map(u => [u.id, u]));
        const seen = new Set();
        const merged = [];
        for (const fu of firestoreUsersCache) {
            seen.add(fu.id);
            const loc = localById.get(fu.id);
            const lastPing = Math.max(fu.last_ping || 0, loc ? (loc.last_ping || 0) : 0);
            merged.push(Object.assign({}, fu, {
                online: Boolean(fu.online || (loc && loc.online)),
                last_ping: lastPing,
                last_ip: loc ? (loc.last_ip || '') : '',
                inFirestore: true
            }));
        }
        for (const lu of localUsersCache) {
            if (!seen.has(lu.id)) {
                merged.push(Object.assign({}, lu, { inFirestore: false }));
            }
        }
        usersData = merged;

        const invSeen = new Set();
        const mergedInv = [];
        for (const fi of firestoreInvitesCache) {
            invSeen.add(fi.id);
            mergedInv.push(Object.assign({}, fi, { inFirestore: true }));
        }
        for (const li of localInvitesCache) {
            if (!invSeen.has(li.id)) {
                mergedInv.push(Object.assign({}, li, { inFirestore: false }));
            }
        }
        invitesData = mergedInv;

        renderUsers();
        renderInvites();
    }

    async function loadUsers() {
        const [uRes, invRes] = await Promise.all([
            apiRequest('/api/users'),
            apiRequest('/api/invites')
        ]);
        localUsersCache = Array.isArray(uRes.users) ? uRes.users : [];
        localInvitesCache = Array.isArray(invRes.invites) ? invRes.invites : [];
        mergeAndRenderUsers();
    }

    function renderUsers() {
        const el = document.getElementById('users-list-container');
        if (!el) return;
        if (usersData.length === 0) {
            el.innerHTML = '<p class="placeholder-text">Пользователей пока нет</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:60px;">Онлайн</th>
            <th>Логин</th>
            <th>Имя</th>
            <th style="width:100px;">Плейлистов</th>
            <th style="width:100px;">Статус</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        usersData.forEach((u, idx) => {
            const onlineDot = u.online
                ? `<span class="badge-status badge-online" title="Сейчас в сети">online</span>`
                : `<span class="badge-status badge-unknown">offline</span>`;
            const status = u.enabled
                ? `<span style="color:#6ee7b7; font-size:12px;">включён</span>`
                : `<span style="color:#fca5a5; font-size:12px;">отключён</span>`;
            const subInfo = u.email
                ? `<div style="font-size:11px; color:var(--muted);">${escapeHtml(u.email)}</div>`
                : '';
            const sourceTag = fbAdminConnected
                ? `<span style="font-size:10px; color:${u.inFirestore ? 'var(--primary-hi)' : 'var(--muted)'}; margin-left:6px;">${u.inFirestore ? 'Firestore' : 'локальный'}</span>`
                : '';
            html += `<tr>
                <td>${onlineDot}</td>
                <td>
                    <b style="color:#fff; font-family:'SF Mono',Consolas,monospace;">${escapeHtml(u.login)}</b>${sourceTag}
                    ${subInfo}
                </td>
                <td>${escapeHtml(u.name || '—')}</td>
                <td>${(u.playlists || []).length}</td>
                <td>${status}</td>
                <td>
                    <div class="actions-cell">
                        <button class="icon-btn" data-user-edit="${idx}" title="Изменить">${I.edit}</button>
                        <button class="icon-btn danger" data-user-del="${idx}" title="Удалить">${I.trash}</button>
                    </div>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        el.innerHTML = html;
        el.querySelectorAll('[data-user-edit]').forEach(b => b.onclick = () => editUser(parseInt(b.dataset.userEdit)));
        el.querySelectorAll('[data-user-del]').forEach(b => b.onclick = () => deleteUser(parseInt(b.dataset.userDel)));
    }

    function renderInvites() {
        const el = document.getElementById('invites-list-container');
        if (!el) return;
        if (invitesData.length === 0) {
            el.innerHTML = '<p style="color:var(--muted); font-size:12.5px;">Приглашений по Google Email пока нет. Нажмите «Добавить пользователя» и выберите вкладку Google Email.</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th>Google Email</th>
            <th>Имя</th>
            <th>Плейлисты</th>
            <th style="width:120px;">Статус</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        invitesData.forEach((inv, idx) => {
            const claimed = Boolean(inv.claimedUid || inv.claimed_uid);
            const stateBadge = claimed
                ? `<span class="badge-status badge-online">принято</span>`
                : (inv.enabled ? `<span class="badge-status badge-unknown">ожидает</span>` : `<span class="badge-status badge-offline">выкл</span>`);
            const pls = Array.isArray(inv.playlists) && inv.playlists.length > 0
                ? inv.playlists.map(p => escapeHtml(p)).join(', ')
                : '—';
            html += `<tr>
                <td>
                    <b style="color:#fff;">${escapeHtml(inv.email || inv.id)}</b>
                    ${fbAdminConnected ? `<span style="font-size:10px; color:${inv.inFirestore ? 'var(--primary-hi)' : 'var(--muted)'}; margin-left:6px;">${inv.inFirestore ? 'Firestore' : 'локальное'}</span>` : ''}
                </td>
                <td>${escapeHtml(inv.name || '—')}</td>
                <td style="font-size:12px; color:var(--text-dim);">${pls}</td>
                <td>${stateBadge}</td>
                <td>
                    <div class="actions-cell">
                        <button class="icon-btn" data-inv-edit="${idx}" title="Изменить">${I.edit}</button>
                        <button class="icon-btn danger" data-inv-del="${idx}" title="Удалить">${I.trash}</button>
                    </div>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        el.innerHTML = html;
        el.querySelectorAll('[data-inv-edit]').forEach(b => b.onclick = () => editInvite(parseInt(b.dataset.invEdit)));
        el.querySelectorAll('[data-inv-del]').forEach(b => b.onclick = () => deleteInvite(parseInt(b.dataset.invDel)));
    }

    // ===== ADMIN CHANNEL ALERTS =====
    function mergeAndRenderAlerts() {
        const byId = new Map();
        for (const la of localAlertsCache) {
            byId.set(la.id, Object.assign({}, la, { inFirestore: false }));
        }
        if (fbAdminConnected) {
            for (const fa of firestoreAlertsCache) {
                const prev = byId.get(fa.id);
                if (!prev || (fa.updated_at || 0) >= (prev.updated_at || 0)) {
                    byId.set(fa.id, Object.assign({}, fa, { inFirestore: true }));
                }
            }
        }
        alertsData = Array.from(byId.values()).sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        const activeCount = alertsData.filter(a => !a.resolved && (a.unavailableCount || (a.items && a.items.length) || 0) > 0).length;
        const badge = document.getElementById('admin-alerts-badge');
        if (badge) {
            badge.textContent = String(activeCount);
            badge.classList.toggle('hidden', activeCount === 0);
        }
        renderAdminAlertsModal();
    }

    async function loadAdminAlerts() {
        const res = await apiRequest('/api/alerts');
        localAlertsCache = Array.isArray(res.alerts) ? res.alerts : [];
        mergeAndRenderAlerts();
    }

    function fmtDateTime(ts) {
        if (!ts) return '—';
        try {
            return new Date(ts * 1000).toLocaleString('ru-RU', {
                day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
            });
        } catch {
            return String(ts);
        }
    }

    function renderAdminAlertsModal() {
        const listEl = document.getElementById('admin-alerts-list');
        if (!listEl) return;
        if (alertsData.length === 0) {
            listEl.innerHTML = '<p class="placeholder-text" style="margin:30px 0;">Предупреждений пока нет — у всех пользователей каналы работают.</p>';
            return;
        }
        listEl.innerHTML = alertsData.map((a) => {
            const items = Array.isArray(a.items) ? a.items : [];
            const statusTag = a.resolved
                ? '<span class="badge-status badge-online">Решено</span>'
                : '<span class="badge-status badge-offline">Есть ошибки</span>';
            const itemsHtml = items.length === 0
                ? '<div style="font-size:12px; color:var(--muted);">Все каналы доступны</div>'
                : items.map(it => `
                    <div class="alert-item-row">
                        <div>
                            <b style="color:#fff;">${escapeHtml(it.name)}</b>
                            ${it.group ? `<span style="color:var(--muted); font-size:11px; margin-left:6px;">(${escapeHtml(it.group)})</span>` : ''}
                        </div>
                        <div class="alert-item-reason">${escapeHtml(it.reason)}</div>
                    </div>
                `).join('');

            return `<div class="alert-card ${a.resolved ? '' : 'unresolved'}">
                <div class="alert-card-head">
                    <div>
                        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                            <b style="color:#fff; font-size:14px;">${escapeHtml(a.userName || a.userLogin)}</b>
                            <code style="font-size:11.5px; color:var(--primary-hi);">${escapeHtml(a.userLogin)}</code>
                            ${statusTag}
                        </div>
                        <div style="font-size:11.5px; color:var(--muted); margin-top:4px;">
                            Недоступно: <b style="color:#fca5a5;">${items.length}</b> из ${a.totalChannels || 0} · Обновлено: ${fmtDateTime(a.updated_at)}
                        </div>
                    </div>
                    <div style="display:flex; gap:6px;">
                        <button type="button" class="btn btn-secondary" data-alert-resolve="${escapeHtml(a.id)}" data-alert-next="${a.resolved ? '0' : '1'}" style="padding:6px 10px; font-size:11.5px;">
                            ${a.resolved ? 'Открыть снова' : 'Отметить решённым'}
                        </button>
                        <button type="button" class="icon-btn danger" data-alert-del="${escapeHtml(a.id)}" title="Удалить отчёт">${I.trash}</button>
                    </div>
                </div>
                <div class="alert-card-items">${itemsHtml}</div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('[data-alert-resolve]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.alertResolve;
                const nextResolved = btn.dataset.alertNext === '1';
                const origTxt = btn.textContent;
                btn.disabled = true;
                if (nextResolved) btn.textContent = 'Проверка...';
                try {
                    const res = await apiRequest('/api/alerts/resolve', 'POST', { id, resolved: nextResolved });
                    if (nextResolved && res && res.stillBroken) {
                        showToast(res.message || 'Поток всё ещё не работает — статус «Решено» не применён, каналы отмечены в Контроле каналов', 'err');
                        await loadAdminAlerts();
                        if (typeof loadHealthOverview === 'function') await loadHealthOverview().catch(() => {});
                        return;
                    }
                    if (fbAdminConnected && window.PQTVFirebase) {
                        await window.PQTVFirebase.resolveAlertAdmin(id, nextResolved).catch(() => {});
                    }
                    if (nextResolved) {
                        showToast('Потоки проверены и отмечены как решённые', 'ok');
                    }
                    await loadAdminAlerts();
                    if (typeof loadHealthOverview === 'function') await loadHealthOverview().catch(() => {});
                } finally {
                    btn.disabled = false;
                    btn.textContent = origTxt;
                }
            };
        });
        listEl.querySelectorAll('[data-alert-del]').forEach(btn => {
            btn.onclick = async () => {
                const id = btn.dataset.alertDel;
                await apiRequest('/api/alerts/delete', 'POST', { id });
                if (fbAdminConnected && window.PQTVFirebase) {
                    await window.PQTVFirebase.deleteAlertAdmin(id).catch(() => {});
                }
                await loadAdminAlerts();
            };
        });
    }

    (function initAdminAlertsModal() {
        const modal = document.getElementById('admin-alerts-modal');
        const btnOpen = document.getElementById('btn-admin-alerts');
        const btnClose = document.getElementById('admin-alerts-close');
        const btnRefresh = document.getElementById('admin-alerts-refresh');
        const backdrop = document.getElementById('admin-alerts-backdrop');
        const closeModal = () => { if (modal) modal.classList.add('hidden'); };
        if (btnOpen && modal) {
            btnOpen.onclick = async () => {
                modal.classList.remove('hidden');
                await loadAdminAlerts();
            };
        }
        if (btnRefresh) btnRefresh.onclick = loadAdminAlerts;
        if (btnClose) btnClose.onclick = closeModal;
        if (backdrop) backdrop.onclick = closeModal;
        loadAdminAlerts();
    })();

    function initFirebaseUsers() {
        const statusEl = document.getElementById('fb-status-text');
        const btnConnect = document.getElementById('btn-fb-connect');
        const btnSync = document.getElementById('btn-fb-sync');
        if (!window.PQTVFirebase) {
            if (statusEl) statusEl.textContent = 'Firebase SDK недоступен (локальный режим)';
            return;
        }

        let currentSignedIn = false;
        let cloudBootstrapStarted = false;
        window.PQTVFirebase.onAuthChange((info) => {
            currentSignedIn = info.signedIn;
            showUsersError('');
            if (fbUnsubscribe) { fbUnsubscribe(); fbUnsubscribe = null; }
            if (fbInvitesUnsubscribe) { fbInvitesUnsubscribe(); fbInvitesUnsubscribe = null; }
            if (fbAlertsUnsubscribe) { fbAlertsUnsubscribe(); fbAlertsUnsubscribe = null; }

            if (info.signedIn && info.isAdmin) {
                fbAdminConnected = true;
                if (statusEl) statusEl.textContent = `Подключено: ${info.email} (облачная синхронизация активна)`;
                if (btnConnect) btnConnect.textContent = 'Выйти из Google';
                if (btnSync) btnSync.classList.remove('hidden');
                if (!cloudBootstrapStarted) {
                    cloudBootstrapStarted = true;
                    void bootstrapCloudDatabase();
                }

                fbUnsubscribe = window.PQTVFirebase.subscribeAdminUsers(
                    async (fbUsers) => {
                        firestoreUsersCache = Array.isArray(fbUsers) ? fbUsers : [];
                        try {
                            await apiRequest('/api/users/sync-from-firebase', 'POST', {
                                users: firestoreUsersCache.map(u => ({
                                    id: u.id,
                                    login: u.login,
                                    name: u.name,
                                    playlists: u.playlists || [],
                                    enabled: !!u.enabled
                                }))
                            });
                        } catch (syncErr) {
                            console.error('Sync users to server failed:', syncErr);
                        }
                        await loadUsers();
                    },
                    (err) => {
                        showUsersError('Ошибка чтения Firestore: ' + (err && err.message ? err.message : String(err)));
                    }
                );

                fbInvitesUnsubscribe = window.PQTVFirebase.subscribeAdminInvites(
                    async (fbInvites) => {
                        firestoreInvitesCache = Array.isArray(fbInvites) ? fbInvites : [];
                        try {
                            await apiRequest('/api/invites/sync-from-firebase', 'POST', {
                                invites: firestoreInvitesCache
                            });
                        } catch (syncErr) {
                            console.error('Sync invites to server failed:', syncErr);
                        }
                        await loadUsers();
                    },
                    (err) => {
                        showUsersError('Ошибка чтения приглашений Firestore: ' + (err && err.message ? err.message : String(err)));
                    }
                );

                fbAlertsUnsubscribe = window.PQTVFirebase.subscribeAdminAlerts(
                    (fbAlerts) => {
                        firestoreAlertsCache = Array.isArray(fbAlerts) ? fbAlerts : [];
                        mergeAndRenderAlerts();
                    },
                    () => {}
                );
            } else {
                fbAdminConnected = false;
                cloudBootstrapStarted = false;
                if (cloudSyncTimer) {
                    clearTimeout(cloudSyncTimer);
                    cloudSyncTimer = null;
                }
                firestoreUsersCache = [];
                firestoreInvitesCache = [];
                firestoreAlertsCache = [];
                if (btnSync) btnSync.classList.add('hidden');
                if (info.signedIn && !info.isAdmin) {
                    if (statusEl) statusEl.textContent = `Вход выполнен как ${info.email} (нет прав администратора Firestore)`;
                    if (btnConnect) btnConnect.textContent = 'Сменить Google аккаунт';
                } else {
                    if (statusEl) statusEl.textContent = 'Не подключено (локальный режим). Войдите как администратор для облачной базы.';
                    if (btnConnect) btnConnect.textContent = 'Войти в Google (Firebase)';
                }
                loadUsers();
                loadAdminAlerts();
            }
        });

        if (btnConnect) {
            btnConnect.onclick = async () => {
                showUsersError('');
                btnConnect.disabled = true;
                try {
                    if (currentSignedIn) {
                        await window.PQTVFirebase.signOutGoogle();
                    } else {
                        await window.PQTVFirebase.signInWithGoogle();
                    }
                } catch (err) {
                    showUsersError((err && err.message) ? err.message : 'Ошибка входа Google');
                } finally {
                    btnConnect.disabled = false;
                }
            };
        }

        if (btnSync) {
            btnSync.onclick = async () => {
                showUsersError('');
                btnSync.disabled = true;
                const orig = btnSync.textContent;
                btnSync.textContent = 'Импорт...';
                try {
                    const res = await apiRequest('/api/users');
                    const list = Array.isArray(res.users) ? res.users : [];
                    const count = await window.PQTVFirebase.importLocalUsers(list);
                    if (statusEl) statusEl.textContent = `Импортировано локальных пользователей в Firestore: ${count}`;
                } catch (err) {
                    showUsersError((err && err.message) ? err.message : 'Ошибка импорта');
                } finally {
                    btnSync.textContent = orig;
                    btnSync.disabled = false;
                }
            };
        }
    }
    initFirebaseUsers();

    // ===== USER POPUP MODAL =====
    function renderUserPlaylistCheckboxes(selected) {
        const box = document.getElementById('popup-user-playlists-box');
        if (!box) return;
        const set = new Set(selected || []);
        if (playlistsList.length === 0) {
            box.innerHTML = '<div style="color:var(--muted); font-size:12px;">Нет плейлистов. Создайте хотя бы один в левой панели.</div>';
            return;
        }
        box.innerHTML = playlistsList.map(name => `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 4px; cursor:pointer; font-size:13px; color:var(--text-dim);">
                <input type="checkbox" value="${escapeHtml(name)}" ${set.has(name) ? 'checked' : ''} style="width:16px; height:16px; accent-color:var(--primary);">
                <span>${escapeHtml(name)}.m3u</span>
            </label>
        `).join('');
    }

    function setUserPopupMode(mode) {
        const modeInput = document.getElementById('popup-user-mode');
        const emailWrap = document.getElementById('user-popup-email-wrap');
        const credsWrap = document.getElementById('user-popup-creds-wrap');
        const emailInput = document.getElementById('popup-user-email');
        const loginInput = document.getElementById('popup-user-login');
        if (modeInput) modeInput.value = mode;
        document.querySelectorAll('#user-popup-tabs .mode-tab').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.userMode === mode);
        });
        if (emailWrap) emailWrap.classList.toggle('hidden', mode !== 'invite');
        if (credsWrap) credsWrap.classList.toggle('hidden', mode !== 'password');
        if (emailInput) emailInput.required = (mode === 'invite');
        if (loginInput) loginInput.required = (mode === 'password');
    }

    function openUserPopup({ mode, id, email, login, name, playlists, enabled, lockMode }) {
        const modal = document.getElementById('user-popup-modal');
        const form = document.getElementById('user-popup-form');
        if (!modal || !form) return;
        form.reset();
        showUserFormError('');

        document.getElementById('popup-user-id').value = id || '';
        document.getElementById('popup-user-email').value = email || '';
        document.getElementById('popup-user-email').disabled = Boolean(lockMode && mode === 'invite');
        document.getElementById('popup-user-login').value = login || '';
        document.getElementById('popup-user-login').disabled = Boolean(id && !fbAdminConnected);
        document.getElementById('popup-user-password').value = '';
        document.getElementById('popup-user-password').required = (mode === 'password' && !id);
        document.getElementById('popup-user-pwd-hint').textContent = id ? '(оставьте пустым, чтобы не менять)' : '(минимум 4 символа)';
        document.getElementById('popup-user-name').value = name || '';
        document.getElementById('popup-user-enabled').checked = enabled !== undefined ? Boolean(enabled) : true;
        document.getElementById('user-popup-title').textContent = id ? 'Редактировать пользователя' : 'Новый пользователь';

        const tabs = document.getElementById('user-popup-tabs');
        if (tabs) tabs.classList.toggle('hidden', Boolean(lockMode));

        setUserPopupMode(mode || 'invite');
        renderUserPlaylistCheckboxes(playlists || []);
        modal.classList.remove('hidden');
    }

    function closeUserPopup() {
        const modal = document.getElementById('user-popup-modal');
        if (modal) modal.classList.add('hidden');
    }

    (function initUserPopupControls() {
        document.querySelectorAll('#user-popup-tabs .mode-tab').forEach(btn => {
            btn.onclick = () => {
                showUserFormError('');
                const mode = btn.dataset.userMode || 'invite';
                const id = document.getElementById('popup-user-id').value;
                document.getElementById('popup-user-password').required = (mode === 'password' && !id);
                setUserPopupMode(mode);
            };
        });
        const selAll = document.getElementById('popup-pl-select-all');
        const clrAll = document.getElementById('popup-pl-clear-all');
        if (selAll) selAll.onclick = () => {
            document.querySelectorAll('#popup-user-playlists-box input[type=checkbox]').forEach(cb => { cb.checked = true; });
        };
        if (clrAll) clrAll.onclick = () => {
            document.querySelectorAll('#popup-user-playlists-box input[type=checkbox]').forEach(cb => { cb.checked = false; });
        };
        ['user-popup-backdrop', 'user-popup-close', 'popup-user-cancel'].forEach(elId => {
            const el = document.getElementById(elId);
            if (el) el.onclick = closeUserPopup;
        });
    })();

    const btnAddUser = document.getElementById('btn-add-user');
    if (btnAddUser) {
        btnAddUser.onclick = () => {
            openUserPopup({
                mode: 'invite',
                id: '',
                email: '',
                login: '',
                name: '',
                playlists: [],
                enabled: true,
                lockMode: false
            });
        };
    }

    function editUser(idx) {
        const u = usersData[idx];
        if (!u) return;
        openUserPopup({
            mode: 'password',
            id: u.id,
            email: u.email || '',
            login: u.login,
            name: u.name || '',
            playlists: u.playlists || [],
            enabled: !!u.enabled,
            lockMode: true
        });
    }

    function editInvite(idx) {
        const inv = invitesData[idx];
        if (!inv) return;
        openUserPopup({
            mode: 'invite',
            id: inv.id,
            email: inv.email || '',
            login: '',
            name: inv.name || '',
            playlists: inv.playlists || [],
            enabled: !!inv.enabled,
            lockMode: true
        });
    }

    async function deleteInvite(idx) {
        const inv = invitesData[idx];
        if (!inv) return;
        if (!(await uiConfirm(`Удалить приглашение для "${inv.email || inv.id}"?`))) return;
        showUsersError('');
        try {
            if (fbAdminConnected && inv.inFirestore && window.PQTVFirebase) {
                await window.PQTVFirebase.deleteInviteAdmin(inv.id);
            }
            const existsLocally = localInvitesCache.some(li => li.id === inv.id || (li.email && li.email === inv.email));
            if (existsLocally || !fbAdminConnected) {
                const res = await apiRequest('/api/invites/delete', 'POST', { id: inv.id, email: inv.email });
                if (!res || !res.ok) {
                    showUsersError((res && res.error) || 'Ошибка удаления приглашения');
                    return;
                }
            }
            await loadUsers();
            showToast('Приглашение удалено', 'ok');
        } catch (err) {
            showUsersError((err && err.message) ? err.message : 'Ошибка удаления приглашения');
        }
    }

    async function deleteUser(idx) {
        const u = usersData[idx];
        if (!u) return;
        if (!(await uiConfirm(`Удалить пользователя "${u.login}"?`))) return;
        showUsersError('');
        try {
            if (fbAdminConnected && u.inFirestore && window.PQTVFirebase) {
                await window.PQTVFirebase.deleteUserAdmin(u.id);
            }
            const existsLocally = localUsersCache.some(lu => lu.id === u.id);
            if (existsLocally || !fbAdminConnected) {
                const res = await apiRequest('/api/users/delete', 'POST', { id: u.id });
                if (!res.ok && existsLocally) {
                    showUsersError(res.error || 'Ошибка удаления с сервера');
                    return;
                }
            }
            await loadUsers();
        } catch (err) {
            showUsersError((err && err.message) ? err.message : 'Ошибка удаления');
        }
    }

    const userPopupForm = document.getElementById('user-popup-form');
    if (userPopupForm) {
        userPopupForm.onsubmit = async (e) => {
            e.preventDefault();
            showUserFormError('');
            const id = document.getElementById('popup-user-id').value;
            const mode = document.getElementById('popup-user-mode').value || 'invite';
            const playlists = [];
            document.querySelectorAll('#popup-user-playlists-box input[type=checkbox]:checked').forEach(cb => {
                playlists.push(cb.value);
            });
            const name = document.getElementById('popup-user-name').value.trim();
            const enabled = document.getElementById('popup-user-enabled').checked;

            try {
                if (mode === 'invite') {
                    const email = document.getElementById('popup-user-email').value.trim().toLowerCase();
                    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
                        showUserFormError('Введите корректный Google Email');
                        return;
                    }
                    const res = await apiRequest('/api/invites/save', 'POST', {
                        email,
                        name,
                        playlists,
                        enabled
                    });
                    if (!res.ok) {
                        showUserFormError(res.error || 'Ошибка сохранения приглашения');
                        return;
                    }
                    if (fbAdminConnected && window.PQTVFirebase) {
                        await window.PQTVFirebase.saveInviteAdmin({
                            email,
                            name,
                            playlists,
                            enabled
                        });
                    }
                    closeUserPopup();
                    await loadUsers();
                    showToast(`Приглашение для ${email} сохранено`, 'ok');
                    return;
                }

                // Mode: Login + Password
                const payload = {
                    id: id || '',
                    login: document.getElementById('popup-user-login').value.trim(),
                    password: document.getElementById('popup-user-password').value,
                    name,
                    playlists,
                    enabled
                };

                if (!id) {
                    const res = await apiRequest('/api/users/save', 'POST', payload);
                    if (!res.ok) {
                        showUserFormError(res.error || 'Ошибка сохранения');
                        return;
                    }
                    if (fbAdminConnected && res.user && window.PQTVFirebase) {
                        await window.PQTVFirebase.saveUserAdmin({
                            id: res.user.id,
                            login: payload.login,
                            name: payload.name || payload.login,
                            playlists: payload.playlists,
                            enabled: payload.enabled,
                            role: 'user'
                        });
                    }
                } else {
                    const existing = usersData.find(u => u.id === id);
                    if (fbAdminConnected && window.PQTVFirebase) {
                        await window.PQTVFirebase.saveUserAdmin({
                            id,
                            login: payload.login,
                            name: payload.name || payload.login,
                            playlists: payload.playlists,
                            enabled: payload.enabled,
                            role: (existing && existing.role === 'admin') ? 'admin' : 'user'
                        });
                    }
                    const res = await apiRequest('/api/users/save', 'POST', payload);
                    if (!res.ok) {
                        showUserFormError(res.error || 'Ошибка сохранения на сервере');
                        return;
                    }
                }

                closeUserPopup();
                await loadUsers();
                loadPlaylists();
                showToast('Пользователь сохранён', 'ok');
            } catch (err) {
                showUserFormError((err && err.message) ? err.message : 'Ошибка сохранения');
            }
        };
    }

    // ===== CATALOG =====
    let catalogData = [];
    let catalogStats = {};
    let catalogOffset = 0;
    let catalogSearch = '';
    let catalogFilter = '';
    let catalogSources = [];
    let catalogPlaylists = [];      // доступные плейлисты из used_in
    let catalogActivePL = [];       // выбранные (пусто = все)

    async function loadCatalog() {
        // Каждый вызов независим — если один упал, остальные работают
        try { await loadCatalogStats(); } catch(e) { console.error('stats:', e); }
        try { await loadCatalogSources(); } catch(e) { console.error('sources:', e); }
        try { await loadCatalogPlaylists(); } catch(e) { console.error('playlists:', e); }
        try { await loadCatalogChannels(); } catch(e) { console.error('channels:', e); }
    }

    async function loadCatalogPlaylists() {
        const res = await apiRequest('/api/catalog/playlists');
        if (res.error) {
            console.error('playlists API error:', res.error);
            catalogPlaylists = [];
        } else {
            catalogPlaylists = res.playlists || [];
        }
        renderCatalogPlFilter();
    }

    function renderCatalogPlFilter() {
        const listEl = document.getElementById('pl-dropdown-list');
        const labelEl = document.getElementById('pl-dropdown-label');
        if (!listEl) return;

        if (catalogPlaylists.length === 0) {
            listEl.innerHTML = '<div style="padding:12px; text-align:center; color:var(--muted); font-size:12px;">Нет плейлистов</div>';
            if (labelEl) labelEl.textContent = 'Все плейлисты';
            return;
        }

        let html = '';
        catalogPlaylists.forEach(pl => {
            const cleanPl = String(pl || '').replace(/\.m3u$/i, '');
            const checked = catalogActivePL.includes(pl);
            html += `<label class="pl-dropdown-item">
                <input type="checkbox" value="${escapeHtml(pl)}" ${checked ? 'checked' : ''}>
                <span class="pl-name">${escapeHtml(cleanPl)}</span>
            </label>`;
        });
        listEl.innerHTML = html;

        // Обновляем toggle-кнопку
        if (window.__updateToggleBtn) window.__updateToggleBtn();

        // Обновляем label в кнопке
        if (labelEl) {
            if (catalogActivePL.length === 0) {
                labelEl.textContent = 'Все плейлисты';
            } else if (catalogActivePL.length === 1) {
                labelEl.textContent = String(catalogActivePL[0] || '').replace(/\.m3u$/i, '');
            } else {
                labelEl.textContent = 'Выбрано: ' + catalogActivePL.length;
            }
        }

        // Обработчики чекбоксов (только визуальное обновление, БЕЗ загрузки)
        listEl.querySelectorAll('input[type="checkbox"]').forEach(cb => {
            cb.onchange = () => {
                const pl = cb.value;
                if (cb.checked) {
                    if (!catalogActivePL.includes(pl)) catalogActivePL.push(pl);
                } else {
                    const i = catalogActivePL.indexOf(pl);
                    if (i !== -1) catalogActivePL.splice(i, 1);
                }
                renderCatalogPlFilter();
            };
        });
    }

    // Инициализация дропдауна
    (function initPlDropdown() {
        const dd = document.getElementById('pl-dropdown');
        const toggle = document.getElementById('pl-dropdown-toggle');
        const menu = document.getElementById('pl-dropdown-menu');
        const btnToggleAll = document.getElementById('pl-dropdown-toggle-all');
        if (!dd || !toggle || !menu) return;

        toggle.onclick = (e) => {
            e.stopPropagation();
            dd.classList.toggle('active');
            menu.classList.toggle('hidden');
        };

        document.addEventListener('click', (e) => {
            if (!dd.contains(e.target)) {
                dd.classList.remove('active');
                menu.classList.add('hidden');
            }
        });

        // Переключатель Все / Сбросить
        function updateToggleBtn() {
            if (!btnToggleAll) return;
            const allSelected = catalogPlaylists.length > 0 && catalogActivePL.length === catalogPlaylists.length;
            if (allSelected) {
                btnToggleAll.textContent = 'Сбросить';
                btnToggleAll.classList.add('all-active');
            } else {
                btnToggleAll.textContent = 'Выбрать все';
                btnToggleAll.classList.remove('all-active');
            }
        }
        window.__updateToggleBtn = updateToggleBtn;

        if (btnToggleAll) {
            btnToggleAll.onclick = () => {
                const allSelected = catalogPlaylists.length > 0 && catalogActivePL.length === catalogPlaylists.length;
                if (allSelected) {
                    catalogActivePL = [];
                } else {
                    catalogActivePL = catalogPlaylists.slice();
                }
                renderCatalogPlFilter();
                updateToggleBtn();
            };
        }
    })();

    // Кнопка "НАЙТИ" — применяет все фильтры
    const findBtn = document.getElementById('catalog-find-btn');
    if (findBtn) {
        findBtn.onclick = () => {
            catalogSearch = (document.getElementById('catalog-search') || {}).value || '';
            catalogFilter = (document.getElementById('catalog-filter') || {}).value || '';
            catalogOffset = 0;
            loadCatalogChannels();
            // Закрыть дропдаун если открыт
            const dd = document.getElementById('pl-dropdown');
            if (dd) dd.classList.remove('active');
            const m = document.getElementById('pl-dropdown-menu');
            if (m) m.classList.add('hidden');
        };
    }

    // Enter в поле поиска — тоже найти
    const searchInput = document.getElementById('catalog-search');
    if (searchInput) {
        searchInput.onkeydown = (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (findBtn) findBtn.click();
            }
        };
    }

    async function loadCatalogStats() {
        const res = await apiRequest('/api/catalog/stats');
        catalogStats = res || {};
        renderCatalogStats();
    }

    function renderCatalogStats() {
        const el = document.getElementById('catalog-stats');
        if (!el) return;
        el.innerHTML = `
            <div class="cat-stat-box">
                <div class="cat-stat-label">Каналов всего</div>
                <div class="cat-stat-value accent">${catalogStats.channels || 0}</div>
            </div>
            <div class="cat-stat-box">
                <div class="cat-stat-label">В моих плейлистах</div>
                <div class="cat-stat-value">${catalogStats.in_my_pl || 0}</div>
            </div>
            <div class="cat-stat-box">
                <div class="cat-stat-label">Потоков</div>
                <div class="cat-stat-value">${catalogStats.streams || 0}</div>
            </div>
            <div class="cat-stat-box">
                <div class="cat-stat-label">Online</div>
                <div class="cat-stat-value online">${catalogStats.streams_online || 0}</div>
            </div>
            <div class="cat-stat-box">
                <div class="cat-stat-label">Источников</div>
                <div class="cat-stat-value">${catalogStats.sources || 0}</div>
            </div>
        `;
    }

    async function loadCatalogChannels() {
        const params = new URLSearchParams({
            limit: '200',
            offset: catalogOffset,
            search: catalogSearch,
            filter: catalogFilter,
        });
        if (catalogActivePL.length > 0) {
            params.set('playlists', catalogActivePL.join(','));
        }
        const res = await apiRequest('/api/catalog/channels?' + params.toString());
        if (res.error) {
            console.error('channels API error:', res.error);
            const el = document.getElementById('catalog-list-container');
            if (el) el.innerHTML = '<p class="placeholder-text">Ошибка загрузки: ' + escapeHtml(res.error) + '</p>';
            return;
        }
        if (catalogOffset === 0) {
            catalogData = res.channels || [];
        } else {
            catalogData = catalogData.concat(res.channels || []);
        }
        renderCatalogChannels();

        // Кнопка "Показать ещё"
        const btn = document.getElementById('catalog-show-more');
        if (btn) {
            const hasMore = (res.channels || []).length >= 200;
            btn.classList.toggle('hidden', !hasMore);
        }
    }

    // Обработчик "Показать ещё"
    const btnMore = document.getElementById('catalog-show-more');
    if (btnMore) {
        btnMore.onclick = () => {
            catalogOffset += 200;
            loadCatalogChannels();
        };
    }

    function renderStatusBadge(online, total, offline, unknown) {
        if (total === 0) {
            return '<span class="cat-status-badge partial">нет потоков</span>';
        }
        if (online === total) {
            return '<span class="cat-status-badge online" title="' + online + ' из ' + total + ' online">online</span>';
        }
        if (offline === total) {
            return '<span class="cat-status-badge offline" title="Все потоки вернули 404 или 410">offline</span>';
        }
        if (online > 0) {
            return '<span class="cat-status-badge partial" title="' + online + ' online, ' + offline + ' offline, ' + unknown + ' неизвестно">' + online + '/' + total + '</span>';
        }
        return '<span class="cat-status-badge partial" title="Проверка не подтвердила статус потоков">неизвестно</span>';
    }

    function renderCatalogChannels() {
        const el = document.getElementById('catalog-list-container');
        if (!el) return;
        if (catalogData.length === 0) {
            el.innerHTML = '<p class="placeholder-text">Каталог пуст. Нажмите «Импорт из плейлистов» чтобы загрузить ваши каналы.</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:100px;">Код</th>
            <th>Название</th>
            <th style="min-width:180px;">Собственные плейлисты</th>
            <th style="width:120px;">Потоков</th>
            <th style="width:100px;">Online</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        catalogData.forEach((ch, i) => {
            const usedIn = Array.isArray(ch.used_in_list)
                ? ch.used_in_list.map(name => String(name).replace(/\.m3u$/i, '').trim()).filter(Boolean)
                : [];
            const inMy = usedIn.length
                ? `<div class="catalog-playlist-list">${usedIn.map(name => `<span class="cat-badge violet">${escapeHtml(name)}</span>`).join(' ')}</div>`
                : '<span class="cat-badge grey">нет</span>';
            const total = ch.streams_count || 0;
            const online = ch.streams_online || 0;
            const offline = ch.streams_offline || 0;
            const unknown = ch.streams_unknown || 0;
            html += `<tr data-idx="${i}">
                <td><span style="color:var(--muted); font-family:monospace; font-size:11px;">${escapeHtml(ch.code || '')}</span></td>
                <td>
                    <div class="ch-title">${escapeHtml(ch.name)}</div>
                    ${ch.tvg_id ? `<div class="ch-group">${escapeHtml(ch.tvg_id)}</div>` : ''}
                </td>
                <td>${inMy}</td>
                <td><b style="color:#fff;">${total}</b></td>
                <td>${renderStatusBadge(online, total, offline, unknown)}</td>
                <td style="text-align:right;">
                    <button class="icon-btn accent" data-cat-view="${ch.id}" title="Потоки">${I.search}</button>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        el.innerHTML = html;

        el.querySelectorAll('[data-cat-view]').forEach(b => {
            b.onclick = (e) => { e.stopPropagation(); viewCatalogChannel(parseInt(b.dataset.catView)); };
        });

        // === Делегирование: клик по строке → плеер (как в плейлистах) ===
        if (!el.__clickBound) {
            el.__clickBound = true;
            el.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const tr = e.target.closest('tr[data-idx]');
                if (!tr) return;
                const i = parseInt(tr.dataset.idx);
                const ch = catalogData[i];
                if (!ch) return;
                const t = getAdminToken();
                fetch('/api/catalog/channel?id=' + ch.id, {
                    credentials: 'same-origin',
                    headers: t ? { 'X-Admin-Token': t } : {}
                })
                    .then(r => r.json())
                    .then(d => {
                        if (!d || d.error) { showToast('Ошибка загрузки канала', 'err'); return; }
                        let url = '';
                        for (const s of (d.streams || [])) { if (s.status === 'online') { url = s.url; break; } }
                        if (!url && d.streams && d.streams.length) url = d.streams[0].url;
                        if (!url) { showToast('Нет потоков для этого канала', 'err'); return; }
                        openPlayerByUrl(url, d.name, d.logo || '');
                    });
            });
        }
    }

    async function viewCatalogChannel(id) {
        const ch = await apiRequest('/api/catalog/channel?id=' + id);
        if (!ch || ch.error) { showToast('Ошибка загрузки', 'err'); return; }

        const streams = ch.streams || [];

        // Список потоков
        let streamsHtml = '';
        if (streams.length === 0) {
            streamsHtml = '<p style="text-align:center; color:var(--muted); padding:20px;">Нет потоков</p>';
        } else {
            streamsHtml = '<table class="streams-table" style="width:100%; border-collapse:collapse; margin-top:14px; font-size:13px;">'
                + '<thead><tr>'
                + '<th style="text-align:left; padding:8px; color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border);">URL потока</th>'
                + '<th style="text-align:center; padding:8px; width:90px; color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border);">Статус</th>'
                + '<th style="text-align:right; padding:8px; width:100px; color:var(--muted); font-size:10.5px; text-transform:uppercase; letter-spacing:0.05em; border-bottom:1px solid var(--border);">Действие</th>'
                + '</tr></thead><tbody>';

            streams.forEach(s => {
                streamsHtml += '<tr style="border-bottom:1px solid var(--border);">'
                    + '<td style="padding:10px 8px; font-family:monospace; font-size:11.5px; word-break:break-all; color:var(--text-dim);">' + escapeHtml(s.url) + '</td>'
                    + '<td style="padding:10px 8px; text-align:center;">' + (s.status === 'online'
                        ? '<span class="cat-status-badge online">online</span>'
                        : s.status === 'offline'
                            ? '<span class="cat-status-badge offline">offline</span>'
                            : '<span class="cat-status-badge partial">неизвестно</span>') + '</td>'
                    + '<td style="padding:10px 8px; text-align:right; white-space:nowrap;">'
                    +   '<button data-play-url="' + encodeURIComponent(s.url) + '" title="Смотреть" style="background:transparent; border:none; color:#64b5f6; cursor:pointer; padding:4px; font-size:14px;">▶</button>'
                    +   '<button data-del-stream="' + s.id + '" title="Удалить" style="background:transparent; border:none; color:#ef4444; cursor:pointer; padding:4px; font-size:13px;">✕</button>'
                    + '</td>'
                    + '</tr>';
            });
            streamsHtml += '</tbody></table>';
        }

        // Дропдаун плейлистов (без .m3u)
        let plOptions = '';
        if (typeof playlistsList !== 'undefined' && playlistsList.length) {
            playlistsList.forEach(p => {
                const cleanP = String(p || '').replace(/\.m3u$/i, '');
                plOptions += '<option value="' + escapeHtml(p) + '">' + escapeHtml(cleanP) + '</option>';
            });
        }
        const usedInClean = Array.isArray(ch.used_in_list)
            ? ch.used_in_list.map(name => String(name || '').replace(/\.m3u$/i, '').trim()).filter(Boolean)
            : [];
        const ownPlaylistsHtml = usedInClean.length
            ? '<div class="catalog-playlist-list" style="margin-top:8px;">' +
                usedInClean.map(name => `<span class="cat-badge violet">${escapeHtml(name)}</span>`).join(' ') +
              '</div>'
            : '<div style="margin-top:8px;"><span class="cat-badge grey">Нет в собственных плейлистах</span></div>';

        const modal = document.createElement('div');
        modal.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:24px;';

        modal.innerHTML = `
            <div style="position:absolute;inset:0;background:rgba(0,0,0,0.75);backdrop-filter:blur(6px);"></div>
            <div style="position:relative;background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:24px;max-width:820px;width:100%;box-shadow:0 24px 80px -20px rgba(0,0,0,0.85);max-height:85vh;overflow-y:auto;">

                <button class="btn-close-cat btn-icon" style="position:absolute;top:14px;right:14px;background:transparent;border:none;color:var(--muted);cursor:pointer;padding:6px;">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px;height:18px;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>

                <div style="display:flex; gap:18px; align-items:center; margin-bottom:18px;">
                    <div style="width:96px;height:96px;flex-shrink:0;background:#05080f;border:1px solid var(--border);border-radius:14px;display:flex;align-items:center;justify-content:center;overflow:hidden;">
                        ${ch.logo ? `<img src="${escapeHtml(ch.logo)}" style="max-width:86%;max-height:86%;object-fit:contain;" onerror="this.style.display='none'">` : ''}
                    </div>
                    <div style="flex:1; min-width:0;">
                        <div style="font-size:11px; font-weight:800; letter-spacing:0.08em; color:var(--primary-hi); margin-bottom:6px;">${escapeHtml(ch.code)}</div>
                        <div style="font-size:24px; font-weight:800; color:#fff; line-height:1.2; word-break:break-word;">${escapeHtml(ch.name)}</div>
                        <div style="font-size:12px; color:var(--muted); margin-top:6px;">${streams.length} ${streams.length === 1 ? 'поток' : 'потоков'}</div>
                        ${ownPlaylistsHtml}
                    </div>
                </div>

                ${streamsHtml}

                ${plOptions ? `
                <div style="margin-top:20px; padding-top:18px; border-top:1px solid var(--border);">
                    <div style="font-size:11px; font-weight:800; letter-spacing:0.08em; color:var(--muted); text-transform:uppercase; margin-bottom:10px;">Добавить в плейлист</div>
                    <div style="display:flex; gap:10px; align-items:stretch;">
                        <select id="cat-add-pl" style="flex:1; padding:11px 14px; background:var(--bg-1); border:1px solid var(--border); color:#fff; border-radius:8px; outline:none; font-size:14px;">
                            ${plOptions}
                        </select>
                        <button id="cat-add-btn" class="btn btn-primary" style="padding:11px 24px;">Добавить</button>
                    </div>
                </div>` : ''}
            </div>
        `;
        document.body.appendChild(modal);

        const closeBtn = modal.querySelector('.btn-close-cat');
        if (closeBtn) closeBtn.onclick = () => modal.remove();
        modal.querySelector('div[style*="position:absolute;inset:0"]').onclick = () => modal.remove();

        // Воспроизвести
        modal.querySelectorAll('[data-play-url]').forEach(b => {
            b.onclick = () => {
                const url = decodeURIComponent(b.dataset.playUrl);
                modal.remove();
                openPlayerByUrl(url, ch.name, ch.logo || '');
            };
        });

        // Удалить поток
        modal.querySelectorAll('[data-del-stream]').forEach(b => {
            b.onclick = async () => {
                if (!(await uiConfirm('Удалить поток?'))) return;
                const res = await apiRequest('/api/catalog/stream/delete', 'POST', { id: +b.dataset.delStream });
                if (!res || !res.ok) {
                    showToast((res && res.error) || 'Не удалось удалить поток', 'err');
                    return;
                }
                showToast('Поток удалён', 'ok');
                modal.remove();
                if ((res.removedChannels || 0) === 0) {
                    viewCatalogChannel(id);
                }
                loadCatalog();
            };
        });

        // Добавить в плейлист
        const addBtn = modal.querySelector('#cat-add-btn');
        if (addBtn) {
            addBtn.onclick = async () => {
                const target = modal.querySelector('#cat-add-pl').value;
                if (!target) { showToast('Выберите плейлист', 'err'); return; }
                addBtn.disabled = true;
                addBtn.textContent = '...';
                const res = await apiRequest('/api/catalog/to-playlist', 'POST', {
                    channel_id: id,
                    playlist: target,
                });
                addBtn.disabled = false;
                addBtn.textContent = 'Добавить';
                if (res.ok) {
                    showToast(`«${res.name}» добавлен в ${target}.m3u`, 'ok');
                } else {
                    showToast('Ошибка: ' + (res.error || 'неизвестная'), 'err');
                }
            };
        }
    }

    async function loadCatalogSources() {
        const res = await apiRequest('/api/catalog/sources');
        catalogSources = res.sources || [];
    }

    // Обработчики
    const catSearch = document.getElementById('catalog-search');
    if (catSearch) {
        let t = null;
        catSearch.oninput = () => {
            clearTimeout(t);
            t = setTimeout(() => {
                catalogSearch = catSearch.value;
                catalogOffset = 0;
                loadCatalogChannels();
            }, 250);
        };
    }
    const catFilter = document.getElementById('catalog-filter');
    if (catFilter) {
        catFilter.onchange = () => {
            catalogFilter = catFilter.value;
            catalogOffset = 0;
            loadCatalogChannels();
        };
    }

    // Сброс всех фильтров
    (function initFilterReset() {
        const btn = document.getElementById('catalog-reset-filters');
        if (!btn) return;
        btn.onclick = () => {
            catalogSearch = '';
            catalogFilter = '';
            catalogActivePL = [];
            catalogOffset = 0;
            const s = document.getElementById('catalog-search');
            if (s) s.value = '';
            const f = document.getElementById('catalog-filter');
            if (f) f.value = '';
            renderCatalogPlFilter();
            loadCatalogChannels();
        };
    })();


    const btnCatAgg = document.getElementById('btn-catalog-aggregate');
    if (btnCatAgg) {
        btnCatAgg.onclick = async () => {
            const txt = document.getElementById('btn-catalog-aggregate-text');
            btnCatAgg.disabled = true;
            if (txt) txt.textContent = 'Собираю...';
            try {
                const res = await apiRequest('/api/catalog/aggregate', 'POST', {});
                if (res.ok) {
                    loadCatalog();
                    showToast('Сбор каналов завершён', 'ok');
                } else {
                    showToast('Ошибка: ' + (res.output || ''), 'err');
                }
            } finally {
                if (txt) txt.textContent = 'Собрать из источников';
                btnCatAgg.disabled = false;
            }
        };
    }

    const btnCatCheck = document.getElementById('btn-catalog-check');
    if (btnCatCheck) {
        btnCatCheck.onclick = async () => {
            const txt = document.getElementById('btn-catalog-check-text');
            btnCatCheck.disabled = true;
            if (txt) txt.textContent = 'Проверка...';
            const res = await apiRequest('/api/catalog/check', 'POST', { limit: 500 });
            if (txt) txt.textContent = 'Проверить потоки';
            btnCatCheck.disabled = false;
            if (res.ok) {
                loadCatalogStats();
                loadCatalogChannels();
                showToast('Проверка потоков завершена', 'ok');
            } else {
                showToast('Ошибка: ' + (res.output || ''), 'err');
            }
        };
    }

    const btnCatAddSource = document.getElementById('btn-catalog-add-source');
    if (btnCatAddSource) {
        btnCatAddSource.onclick = () => {
            const f = document.getElementById('catalog-source-form');
            if (f) f.reset();
            document.getElementById('cat-src-id').value = '';
            document.getElementById('catalog-source-form-title').textContent = 'Новый источник каталога';
            document.getElementById('cat-src-enabled').checked = true;
            if (formChannelContainer) formChannelContainer.classList.add('hidden');
            if (formSourceContainer) formSourceContainer.classList.add('hidden');
            const fe = document.getElementById('form-epg-container'); if (fe) fe.classList.add('hidden');
            const fc = document.getElementById('form-catalog-source-container');
            if (fc) fc.classList.remove('hidden');
            if (colRight) colRight.classList.remove('hidden');
        };
    }

    const catSrcForm = document.getElementById('catalog-source-form');
    if (catSrcForm) {
        catSrcForm.onsubmit = async (e) => {
            e.preventDefault();
            const id = parseInt(document.getElementById('cat-src-id').value || '0');
            const payload = {
                id: id,
                name: document.getElementById('cat-src-name').value.trim(),
                type: document.getElementById('cat-src-type').value,
                url: document.getElementById('cat-src-url').value.trim(),
                enabled: document.getElementById('cat-src-enabled').checked,
            };
            const res = await apiRequest('/api/catalog/sources/save', 'POST', payload);
            if (res.ok) {
                closeForm();
                loadCatalogSources();
                loadCatalogStats();
            } else {
                showToast(res.error || 'Ошибка', 'err');
            }
        };
    }

    // ===== CHANNEL ACTIONS =====
    async function moveChannel(idx, dir) {
        const t = idx + dir;
        if (t < 0 || t >= channelsData.length) return;
        [channelsData[idx], channelsData[t]] = [channelsData[t], channelsData[idx]];
        await saveAllChannels();
    }

    function editChannel(idx) {
        const ch = channelsData[idx];
        if (!ch) return;
        document.getElementById('channel-index').value = idx;
        document.getElementById('ch-name').value = ch.name;
        document.getElementById('ch-group').value = ch.group || '';
        document.getElementById('ch-logo').value = ch.logo || '';
        document.getElementById('ch-url').value = ch.url;
        const pausedEl = document.getElementById('ch-paused');
        const uaEl = document.getElementById('ch-ua');
        const refEl = document.getElementById('ch-ref');
        const origEl = document.getElementById('ch-orig');
        if (pausedEl) pausedEl.checked = !!ch.paused;
        if (uaEl) uaEl.value = ch.userAgent || '';
        if (refEl) refEl.value = ch.referer || '';
        if (origEl) origEl.value = ch.origin || '';
        document.getElementById('form-title').textContent = 'Редактировать канал';
        updateLogoPreview();
        populateCopyTarget();
        if (formSourceContainer) formSourceContainer.classList.add('hidden');
        if (formChannelContainer) formChannelContainer.classList.remove('hidden');
        if (colRight) colRight.classList.remove('hidden');
    }

    async function deleteChannel(idx) {
        if (!(await uiConfirm('Удалить канал?'))) return;
        channelsData.splice(idx, 1);
        await saveAllChannels();
    }

    async function saveAllChannels() {
        const res = await apiRequest('/api/channels/save', 'POST', { playlist: currentPlaylist, channels: channelsData });
        if (!res || !res.ok) {
            showToast((res && res.error) || 'Ошибка сохранения плейлиста', 'err');
            await loadChannels();
            return false;
        }
        renderChannels();
        loadCatalog().catch(() => {});
        if (typeof loadHealthOverview === 'function') loadHealthOverview().catch(() => {});
        return true;
    }

    // ===== PLAYLIST ACTIONS =====
    const btnAddPl = document.getElementById('btn-add-playlist');
    if (btnAddPl) {
        btnAddPl.onclick = async () => {
            const name = await uiPrompt('Имя нового плейлиста (латиница, цифры, _ -):', '', 'Новый плейлист');
            if (!name) return;
            const res = await apiRequest('/api/playlists', 'POST', { name });
            if (res && res.ok) {
                await selectPlaylist(name);
                loadCatalogPlaylists().catch(() => {});
            } else {
                showToast((res && res.error) || 'Ошибка создания плейлиста', 'err');
            }
        };
    }

    if (btnDeletePl) {
        btnDeletePl.onclick = () => {
            if (currentPlaylist) deletePlaylist(currentPlaylist);
        };
    }

    async function deletePlaylist(name) {
        if (!(await uiConfirm(`Удалить плейлист ${name}.m3u? Каталог и доступы пользователей будут обновлены.`))) return;
        const res = await apiRequest('/api/playlists/delete', 'POST', { name });
        if (res && res.ok) {
            if (currentPlaylist === name) {
                currentPlaylist = null;
                channelsData = [];
                if (plTitleEl) plTitleEl.textContent = 'Выберите плейлист';
                if (btnAddCh) btnAddCh.classList.add('hidden');
                if (btnCheckAll) btnCheckAll.classList.add('hidden');
                if (btnDeletePl) btnDeletePl.classList.add('hidden');
                if (directBox) directBox.classList.add('hidden');
                closeForm();
                renderChannels();
            }
            if (fbAdminConnected && window.PQTVFirebase) {
                await window.PQTVFirebase.deletePlaylistFromCloud(name).catch(() => {});
                await syncCloudDatabase().catch(() => {});
            }
            showToast(`Плейлист ${name}.m3u удалён`, 'ok');
            await Promise.all([
                loadPlaylists(),
                loadUsers().catch(() => {}),
                loadCatalog().catch(() => {}),
                typeof loadHealthOverview === 'function' ? loadHealthOverview().catch(() => {}) : Promise.resolve(),
            ]);
        } else {
            showToast((res && res.error) || 'Ошибка удаления плейлиста', 'err');
        }
    }

    // ===== CHANNEL FORM =====
    if (btnAddCh) {
        btnAddCh.onclick = () => {
            if (channelForm) channelForm.reset();
            document.getElementById('channel-index').value = -1;
            document.getElementById('form-title').textContent = 'Добавить канал';
            const pausedEl = document.getElementById('ch-paused');
            const uaEl = document.getElementById('ch-ua');
            const refEl = document.getElementById('ch-ref');
            const origEl = document.getElementById('ch-orig');
            if (pausedEl) pausedEl.checked = false;
            if (uaEl) uaEl.value = '';
            if (refEl) refEl.value = '';
            if (origEl) origEl.value = '';
            if (logoPreviewBox) logoPreviewBox.classList.add('hidden');
            const copySel = document.getElementById('copy-target-playlist');
            if (copySel) copySel.value = '';
            populateCopyTarget();
            if (formSourceContainer) formSourceContainer.classList.add('hidden');
            if (formChannelContainer) formChannelContainer.classList.remove('hidden');
            if (colRight) colRight.classList.remove('hidden');
        };
    }

    function closeForm() {
        if (colRight) colRight.classList.add('hidden');
        const fe = document.getElementById('form-epg-container');
        if (fe) fe.classList.add('hidden');
        const fc = document.getElementById('form-catalog-source-container');
        if (fc) fc.classList.add('hidden');
    }
    document.querySelectorAll('.btn-close-form, .btn-cancel-form').forEach(b => b.onclick = closeForm);

    if (logoInput) logoInput.oninput = updateLogoPreview;
    function updateLogoPreview() {
        if (!logoInput || !logoPreviewImg || !logoPreviewBox) return;
        const url = logoInput.value.trim();
        if (url) { logoPreviewImg.src = url; logoPreviewBox.classList.remove('hidden'); }
        else logoPreviewBox.classList.add('hidden');
    }

    if (channelForm) {
        channelForm.onsubmit = async (e) => {
            e.preventDefault();
            const idx = parseInt(document.getElementById('channel-index').value);
            const prev = idx >= 0 ? (channelsData[idx] || {}) : {};
            const data = {
                name: document.getElementById('ch-name').value.trim(),
                group: document.getElementById('ch-group').value.trim(),
                logo: document.getElementById('ch-logo').value.trim(),
                url: document.getElementById('ch-url').value.trim(),
                tvg_id: prev.tvg_id || '',
            };
            const paused = !!(document.getElementById('ch-paused')?.checked);
            const ua = (document.getElementById('ch-ua')?.value || '').trim();
            const ref = (document.getElementById('ch-ref')?.value || '').trim();
            const orig = (document.getElementById('ch-orig')?.value || '').trim();
            if (paused) data.paused = true;
            if (ua) data.userAgent = ua;
            if (ref) data.referer = ref;
            if (orig) data.origin = orig;
            if (idx === -1) channelsData.push(data);
            else channelsData[idx] = data;
            await saveAllChannels();
            closeForm();
        };
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;').replace(/</g, '&lt;')
            .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ===== ANDROID TV APK & OTA RELEASES =====
    function fmtBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function arrayBufferToBase64(buf) {
        const bytes = new Uint8Array(buf);
        const chunk = 0x8000;
        let binary = '';
        for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
        }
        return btoa(binary);
    }

    let ghPollTimer = null;

    function stopGithubPoll() {
        if (ghPollTimer) {
            clearInterval(ghPollTimer);
            ghPollTimer = null;
        }
    }

    async function loadApkReleases() {
        const statusBox = document.getElementById('apk-status-box');
        const listBox = document.getElementById('apk-releases-container');
        const latestBtn = document.getElementById('apk-latest-download');
        const snippetEl = document.getElementById('apk-ci-snippet');
        const verNameInput = document.getElementById('apk-ver-name');
        const verCodeInput = document.getElementById('apk-ver-code');
        const ghVerNameInput = document.getElementById('gh-ver-name');
        const ghVerCodeInput = document.getElementById('gh-ver-code');
        const ghServerUrlInput = document.getElementById('gh-server-url');

        const res = await apiRequest('/api/admin/apk/releases');
        if (!res || !res.ok) {
            if (statusBox) statusBox.textContent = 'Ошибка загрузки релизов APK';
            return;
        }

        if (verNameInput && !verNameInput.value) verNameInput.value = res.suggestedVersionName || '1.0.1';
        if (verCodeInput && !verCodeInput.value) verCodeInput.value = String(res.suggestedVersionCode || 1);
        if (ghVerNameInput && !ghVerNameInput.value) ghVerNameInput.value = res.suggestedVersionName || '1.0.1';
        if (ghVerCodeInput && !ghVerCodeInput.value) ghVerCodeInput.value = String(res.suggestedVersionCode || 1);
        if (ghServerUrlInput && !ghServerUrlInput.value) ghServerUrlInput.value = res.serverOrigin || window.location.origin;

        const latest = res.latest;
        if (statusBox) {
            if (latest) {
                const sz = latest.sizeBytes ?? latest.size ?? 0;
                statusBox.innerHTML = `
                    <div>Активная версия: <b style="color:#fff;">v${escapeHtml(latest.versionName)}</b> (code <code>${latest.versionCode}</code>)</div>
                    <div>Размер: <b>${fmtBytes(sz)}</b> · ${latest.mandatory ? '<span style="color:#fcd34d;">Обязательное обновление</span>' : 'Обычное обновление'}</div>
                    <div style="font-size:11.5px; color:var(--muted); word-break:break-all;">SHA-256: ${escapeHtml(latest.sha256 || '')}</div>
                    ${latest.changelog ? `<div style="margin-top:6px;">Изменения: ${escapeHtml(latest.changelog)}</div>` : ''}
                `;
            } else {
                statusBox.innerHTML = `
                    <div>На сервере ещё нет загруженного <code>.apk</code>.</div>
                    <div style="color:var(--muted); font-size:12px; margin-top:4px;">Подключите GitHub ниже для сборки в 1 клик или загрузите готовый <code>.apk</code> вручную — телевизоры получат обновление автоматически.</div>
                `;
            }
        }
        if (latestBtn) latestBtn.classList.toggle('hidden', !latest);

        const origin = res.serverOrigin || window.location.origin;
        const tok = res.uploadToken || '<APK_UPLOAD_TOKEN>';
        if (snippetEl) {
            snippetEl.textContent =
`# Секреты GitHub Actions (.github/workflows/build-apk.yml):
PQTV_SERVER_URL=${origin}
PQTV_UPLOAD_TOKEN=${tok}

# Ручная загрузка подписанного APK с компьютера:
curl -X POST "${origin}/api/admin/apk-upload" \\
  -H "Authorization: Bearer ${tok}" \\
  -H "Content-Type: application/vnd.android.package-archive" \\
  -H "X-Version-Name: ${res.suggestedVersionName || '1.0.1'}" \\
  -H "X-Version-Code: ${res.suggestedVersionCode || 2}" \\
  --data-binary "@app-release.apk"`;
        }

        const releases = Array.isArray(res.releases) ? res.releases : [];
        if (listBox) {
            if (releases.length === 0) {
                listBox.innerHTML = '<p class="placeholder-text" style="margin:20px 0;">Опубликованных релизов пока нет</p>';
            } else {
                let html = `<table class="ch-table"><thead><tr>
                    <th>Версия</th>
                    <th style="width:90px;">Code</th>
                    <th style="width:110px;">Размер</th>
                    <th>Изменения</th>
                    <th style="width:120px; text-align:right;">Действия</th>
                </tr></thead><tbody>`;
                releases.forEach((rel, i) => {
                    const sz = rel.sizeBytes ?? rel.size ?? 0;
                    html += `<tr>
                        <td>
                            <b style="color:#fff;">v${escapeHtml(rel.versionName)}</b>
                            ${i === 0 ? '<span class="badge-status badge-online" style="margin-left:6px;">latest</span>' : ''}
                        </td>
                        <td><code>${rel.versionCode}</code></td>
                        <td>${fmtBytes(sz)}</td>
                        <td style="font-size:12px; color:var(--text-dim);">${escapeHtml(rel.changelog || '—')}</td>
                        <td style="text-align:right;">
                            <div class="actions-cell">
                                <a class="icon-btn accent" href="/apk/${encodeURIComponent(rel.filename)}" title="Скачать APK">${I.plus}</a>
                                <button type="button" class="icon-btn danger" data-apk-del="${escapeHtml(rel.id)}" title="Удалить">${I.trash}</button>
                            </div>
                        </td>
                    </tr>`;
                });
                html += '</tbody></table>';
                listBox.innerHTML = html;
                listBox.querySelectorAll('[data-apk-del]').forEach(btn => {
                    btn.onclick = async () => {
                        if (!(await uiConfirm('Удалить этот релиз APK?'))) return;
                        const dRes = await apiRequest('/api/admin/apk/delete', 'POST', { id: btn.dataset.apkDel });
                        if (dRes.ok) {
                            showToast('Релиз удалён', 'ok');
                            loadApkReleases();
                        } else {
                            showToast(dRes.error || 'Ошибка удаления', 'err');
                        }
                    };
                });
            }
        }

        await loadGithubPanel();
    }

    function renderGithubBuildStatus(build) {
        const box = document.getElementById('gh-build-status-box');
        if (!box) return;
        if (!build || !build.buildId) {
            box.classList.add('hidden');
            return;
        }
        box.classList.remove('hidden');

        const statusLabels = {
            syncing: 'Синхронизация кода с GitHub...',
            queued: 'В очереди GitHub Actions...',
            in_progress: 'Идёт сборка APK на GitHub...',
            importing: 'Сборка завершена — импорт APK в OTA...',
            completed: 'APK успешно собран и опубликован для ТВ!',
            failed: 'Ошибка сборки на GitHub'
        };

        const isDone = build.status === 'completed';
        const isFail = build.status === 'failed';
        const color = isDone ? '#a7f3d0' : isFail ? '#fca5a5' : '#93c5fd';

        const stepsHtml = Array.isArray(build.steps) && build.steps.length
            ? `<div style="margin-top:8px; display:flex; flex-direction:column; gap:4px;">` +
              build.steps.map(st => {
                  const icon = st.conclusion === 'success' ? '✓' : st.conclusion === 'failure' ? '✕' : st.status === 'in_progress' ? '●' : '○';
                  const sColor = st.conclusion === 'success' ? '#34d399' : st.conclusion === 'failure' ? '#f87171' : st.status === 'in_progress' ? '#60a5fa' : 'var(--muted)';
                  return `<div style="font-size:11.5px; color:${sColor};">${icon} ${escapeHtml(st.name)}</div>`;
              }).join('') +
              `</div>`
            : '';

        box.innerHTML = `
            <div style="display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap;">
                <b style="color:${color};">${escapeHtml(statusLabels[build.status] || build.status)}</b>
                ${build.runUrl ? `<a href="${escapeHtml(build.runUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-hi); font-size:12px;">Логи на GitHub →</a>` : ''}
            </div>
            <div style="color:var(--muted); font-size:11.5px; margin-top:4px;">
                Версия: <b>v${escapeHtml(build.versionName)}</b> (code <code>${build.versionCode}</code>)
                ${build.syncedFiles ? ` · Синхронизировано файлов: ${build.syncedFiles}` : ''}
                ${build.runNumber ? ` · Запуск #${build.runNumber}` : ''}
            </div>
            ${build.error ? `<div style="color:#fca5a5; margin-top:6px;">${escapeHtml(build.error)}</div>` : ''}
            ${stepsHtml}
        `;
    }

    async function pollGithubBuildOnce() {
        const res = await apiRequest('/api/admin/github/status');
        if (!res || !res.ok || !res.build) return null;
        renderGithubBuildStatus(res.build);
        if (res.build.status === 'completed' || res.build.status === 'failed') {
            stopGithubPoll();
            if (res.build.status === 'completed' && res.build.imported) {
                showToast(`APK v${res.build.versionName} собран на GitHub и опубликован!`, 'ok');
                const verNameInput = document.getElementById('gh-ver-name');
                const verCodeInput = document.getElementById('gh-ver-code');
                if (verNameInput) verNameInput.value = '';
                if (verCodeInput) verCodeInput.value = '';
                await loadApkReleases();
            } else if (res.build.status === 'failed' && res.build.error) {
                showToast(res.build.error, 'err');
            }
        }
        return res.build;
    }

    async function loadGithubRuns() {
        const box = document.getElementById('gh-runs-container');
        if (!box) return;
        const res = await apiRequest('/api/admin/github/runs');
        if (!res || !res.ok) {
            box.innerHTML = '<p class="placeholder-text" style="margin:14px 0;">Не удалось получить список сборок</p>';
            return;
        }
        const runs = Array.isArray(res.runs) ? res.runs : [];
        if (runs.length === 0) {
            box.innerHTML = '<p class="placeholder-text" style="margin:14px 0;">Запусков сборки в репозитории пока нет</p>';
            return;
        }
        let html = `<table class="ch-table"><thead><tr>
            <th style="width:80px;">#</th>
            <th>Статус</th>
            <th>Ветка</th>
            <th>Дата</th>
            <th style="width:190px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        runs.forEach(r => {
            const st = r.status === 'completed' ? (r.conclusion || 'completed') : r.status;
            const badgeCls = st === 'success' ? 'badge-online' : (st === 'failure' || st === 'cancelled') ? 'badge-offline' : '';
            const dt = r.createdAt ? new Date(r.createdAt).toLocaleString('ru-RU') : '—';
            html += `<tr>
                <td><code>#${r.runNumber || r.id}</code></td>
                <td><span class="badge-status ${badgeCls}">${escapeHtml(st)}</span></td>
                <td><code>${escapeHtml(r.headBranch || 'main')}</code></td>
                <td style="font-size:12px; color:var(--text-dim);">${escapeHtml(dt)}</td>
                <td style="text-align:right;">
                    <div style="display:inline-flex; gap:6px; align-items:center;">
                        ${r.htmlUrl ? `<a class="btn btn-secondary" style="padding:5px 9px; font-size:11.5px;" href="${escapeHtml(r.htmlUrl)}" target="_blank" rel="noopener noreferrer">Логи</a>` : ''}
                        ${st === 'success' ? `<button type="button" class="btn btn-primary" style="padding:5px 10px; font-size:11.5px;" data-gh-import="${r.id}">Импорт в OTA</button>` : ''}
                    </div>
                </td>
            </tr>`;
        });
        html += '</tbody></table>';
        box.innerHTML = html;

        box.querySelectorAll('[data-gh-import]').forEach(btn => {
            btn.onclick = async () => {
                const runId = Number(btn.dataset.ghImport);
                const verName = (document.getElementById('gh-ver-name')?.value || '').trim() || '1.0.1';
                const verCode = parseInt(document.getElementById('gh-ver-code')?.value || '1', 10) || 1;
                const changelog = (document.getElementById('gh-changelog')?.value || '').trim();
                const mandatory = Boolean(document.getElementById('gh-mandatory')?.checked);
                btn.disabled = true;
                btn.textContent = 'Импорт...';
                try {
                    const impRes = await apiRequest('/api/admin/github/import', 'POST', {
                        runId,
                        versionName: verName,
                        versionCode: verCode,
                        changelog,
                        mandatory
                    });
                    if (impRes && impRes.ok) {
                        showToast(`APK v${impRes.release.versionName} импортирован в OTA`, 'ok');
                        await loadApkReleases();
                    } else {
                        showToast((impRes && impRes.error) || 'Ошибка импорта артефакта', 'err');
                    }
                } finally {
                    btn.disabled = false;
                    btn.textContent = 'Импорт в OTA';
                }
            };
        });
    }

    let cachedWorkflowManual = null;

    function showManualWorkflowHelper(info, customMsg) {
        const box = document.getElementById('gh-workflow-manual-box');
        const msgEl = document.getElementById('gh-workflow-manual-msg');
        const linkEl = document.getElementById('gh-manual-open-url');
        if (!box) return;
        const merged = info && info.manualCreateUrl ? info : cachedWorkflowManual;
        if (merged) cachedWorkflowManual = merged;
        if (customMsg && msgEl) msgEl.textContent = customMsg;
        if (linkEl && merged && merged.manualCreateUrl) {
            linkEl.href = merged.manualCreateUrl;
        }
        box.classList.remove('hidden');
    }

    async function loadGithubPanel() {
        const badge = document.getElementById('gh-conn-badge');
        const summary = document.getElementById('gh-conn-summary');
        const repoInput = document.getElementById('gh-repo');
        const branchInput = document.getElementById('gh-branch');
        const tokenInput = document.getElementById('gh-token');
        const disconnectBtn = document.getElementById('btn-gh-disconnect');
        const syncBtn = document.getElementById('btn-gh-sync');
        const buildBtn = document.getElementById('btn-gh-build');
        const manualBox = document.getElementById('gh-workflow-manual-box');

        const res = await apiRequest('/api/admin/github/config');
        const cfg = res && res.config ? res.config : { configured: false };
        if (res && res.workflowManual) cachedWorkflowManual = res.workflowManual;

        if (badge) {
            badge.textContent = cfg.configured ? 'Подключён' : 'Не настроен';
            badge.className = 'badge-status ' + (cfg.configured ? 'badge-online' : 'badge-offline');
        }
        if (summary) {
            if (cfg.configured) {
                const scopesList = Array.isArray(cfg.scopes) ? cfg.scopes : [];
                let scopeInfo = '';
                if (cfg.tokenType === 'classic') {
                    const scopeText = scopesList.length ? scopesList.join(', ') : 'нет заголовка scopes';
                    const wfWarn = cfg.hasWorkflowScope === false
                        ? ' <span style="color:#fcd34d;">(нет scope <code>workflow</code> — создайте build-apk.yml через кнопку ниже или добавьте <code>workflow</code>)</span>'
                        : '';
                    scopeInfo = `<div style="margin-top:4px;">Тип: <code>Classic PAT</code> · права: <code>${escapeHtml(scopeText)}</code>${wfWarn}</div>`;
                } else if (cfg.tokenType === 'fine-grained') {
                    scopeInfo = `<div style="margin-top:4px;">Тип: <code>Fine-grained PAT</code> (нужны права репозитория: <code>Contents</code>, <code>Actions</code> и отдельно <code>Workflows: Read &amp; Write</code>)</div>`;
                }
                summary.innerHTML = `
                    Репозиторий: <a href="${escapeHtml(cfg.htmlUrl)}" target="_blank" rel="noopener noreferrer" style="color:var(--primary-hi); font-weight:600;">${escapeHtml(cfg.repoFullName)}</a>
                    · ветка <code>${escapeHtml(cfg.branch)}</code>
                    ${cfg.login ? ` · токен от <b>@${escapeHtml(cfg.login)}</b>` : ''}
                    (${escapeHtml(cfg.tokenPreview || 'saved')})
                    ${scopeInfo}
                `;
            } else {
                summary.textContent = 'Укажите GitHub репозиторий и токен (PAT), чтобы PQTV сам синхронизировал android-tv/ и запускал облачную сборку APK.';
            }
        }
        if (manualBox) {
            if (cfg.configured && cfg.tokenType === 'classic' && cfg.hasWorkflowScope === false && cachedWorkflowManual) {
                showManualWorkflowHelper(cachedWorkflowManual, 'У текущего Classic PAT отсутствует право «workflow». Вы можете либо перевыпустить/обновить токен, либо за 10 секунд создать .github/workflows/build-apk.yml на GitHub вручную:');
            } else {
                manualBox.classList.add('hidden');
            }
        }
        if (repoInput && cfg.repoFullName && !repoInput.value) repoInput.value = cfg.repoFullName;
        if (branchInput && cfg.branch) branchInput.value = cfg.branch;
        if (tokenInput) {
            tokenInput.placeholder = cfg.configured
                ? `Сохранён (${cfg.tokenPreview}) — оставьте пустым, чтобы не менять`
                : 'ghp_... или github_pat_...';
        }
        if (disconnectBtn) disconnectBtn.classList.toggle('hidden', !(cfg.configured && cfg.source === 'saved'));
        if (syncBtn) syncBtn.disabled = !cfg.configured;
        if (buildBtn) buildBtn.disabled = !cfg.configured;

        if (cfg.configured) {
            const cur = await pollGithubBuildOnce();
            if (cur && ['syncing', 'queued', 'in_progress', 'importing'].includes(cur.status)) {
                stopGithubPoll();
                ghPollTimer = setInterval(() => { void pollGithubBuildOnce(); }, 3500);
            }
            await loadGithubRuns();
        } else {
            stopGithubPoll();
            const runsBox = document.getElementById('gh-runs-container');
            if (runsBox) {
                runsBox.innerHTML = '<p class="placeholder-text" style="margin:14px 0;">Подключите GitHub выше, чтобы видеть сборки</p>';
            }
        }
    }

    const btnGhCopyYaml = document.getElementById('btn-gh-copy-yaml');
    if (btnGhCopyYaml) {
        btnGhCopyYaml.onclick = async () => {
            if (!cachedWorkflowManual || !cachedWorkflowManual.workflowYaml) {
                showToast('YAML ещё не загружен', 'err');
                return;
            }
            try {
                await navigator.clipboard.writeText(cachedWorkflowManual.workflowYaml);
                showToast('YAML скопирован в буфер обмена', 'ok');
            } catch {
                showToast('Не удалось скопировать в буфер', 'err');
            }
        };
    }

    const ghConfigForm = document.getElementById('gh-config-form');
    if (ghConfigForm) {
        ghConfigForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btn-gh-save');
            const orig = btn ? btn.textContent : '';
            if (btn) { btn.disabled = true; btn.textContent = 'Проверка...'; }
            try {
                const payload = {
                    repo: (document.getElementById('gh-repo')?.value || '').trim(),
                    branch: (document.getElementById('gh-branch')?.value || '').trim(),
                    token: (document.getElementById('gh-token')?.value || '').trim()
                };
                const res = await apiRequest('/api/admin/github/config', 'POST', payload);
                if (res && res.ok) {
                    const tokenEl = document.getElementById('gh-token');
                    if (tokenEl) tokenEl.value = '';
                    showToast(`GitHub подключён: ${res.config.repoFullName}`, 'ok');
                    await loadGithubPanel();
                } else {
                    showToast((res && res.error) || 'Ошибка подключения GitHub', 'err');
                }
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = orig; }
            }
        };
    }

    const btnGhDisconnect = document.getElementById('btn-gh-disconnect');
    if (btnGhDisconnect) {
        btnGhDisconnect.onclick = async () => {
            if (!(await uiConfirm('Отключить сохранённый GitHub токен и репозиторий?'))) return;
            const res = await apiRequest('/api/admin/github/config', 'DELETE');
            if (res && res.ok) {
                const repoEl = document.getElementById('gh-repo');
                const tokEl = document.getElementById('gh-token');
                if (repoEl) repoEl.value = '';
                if (tokEl) tokEl.value = '';
                showToast('GitHub отключён', 'ok');
                await loadGithubPanel();
            }
        };
    }

    const btnGhSync = document.getElementById('btn-gh-sync');
    if (btnGhSync) {
        btnGhSync.onclick = async () => {
            const orig = btnGhSync.textContent;
            btnGhSync.disabled = true;
            btnGhSync.textContent = 'Отправка...';
            try {
                const res = await apiRequest('/api/admin/github/sync', 'POST', {});
                if (res && res.ok) {
                    const msg = res.skipped
                        ? 'Все файлы android-tv/ на GitHub уже актуальны'
                        : `Синхронизировано файлов с GitHub: ${res.syncedFiles}`;
                    showToast(msg, 'ok');
                    if (res.workflowWarning) showToast(res.workflowWarning, 'err');
                } else {
                    if (res && res.needsManualWorkflow) {
                        showManualWorkflowHelper(res, res.error);
                    }
                    showToast((res && res.error) || 'Ошибка синхронизации с GitHub', 'err');
                }
            } finally {
                btnGhSync.disabled = false;
                btnGhSync.textContent = orig;
            }
        };
    }

    const ghBuildForm = document.getElementById('gh-build-form');
    if (ghBuildForm) {
        ghBuildForm.onsubmit = async (e) => {
            e.preventDefault();
            const btn = document.getElementById('btn-gh-build');
            const orig = btn ? btn.textContent : '';
            if (btn) { btn.disabled = true; btn.textContent = 'Синхронизация и запуск...'; }
            try {
                const payload = {
                    versionName: (document.getElementById('gh-ver-name')?.value || '').trim(),
                    versionCode: parseInt(document.getElementById('gh-ver-code')?.value || '1', 10) || 1,
                    serverUrl: (document.getElementById('gh-server-url')?.value || '').trim(),
                    changelog: (document.getElementById('gh-changelog')?.value || '').trim(),
                    mandatory: Boolean(document.getElementById('gh-mandatory')?.checked),
                    syncProject: Boolean(document.getElementById('gh-sync-before')?.checked)
                };
                const res = await apiRequest('/api/admin/github/build', 'POST', payload);
                if (res && res.ok && res.build) {
                    showToast('Сборка APK на GitHub запущена!', 'ok');
                    renderGithubBuildStatus(res.build);
                    stopGithubPoll();
                    ghPollTimer = setInterval(() => { void pollGithubBuildOnce(); }, 3500);
                    await loadGithubRuns();
                } else {
                    if (res && res.needsManualWorkflow) {
                        showManualWorkflowHelper(res, res.error);
                    }
                    showToast((res && res.error) || 'Не удалось запустить сборку на GitHub', 'err');
                }
            } finally {
                if (btn) { btn.disabled = false; btn.textContent = orig; }
            }
        };
    }

    const btnGhRefreshRuns = document.getElementById('btn-gh-refresh-runs');
    if (btnGhRefreshRuns) {
        btnGhRefreshRuns.onclick = () => {
            void pollGithubBuildOnce();
            void loadGithubRuns();
        };
    }

    const apkUploadForm = document.getElementById('apk-upload-form');
    if (apkUploadForm) {
        apkUploadForm.onsubmit = async (e) => {
            e.preventDefault();
            const fileInput = document.getElementById('apk-file');
            const file = fileInput && fileInput.files && fileInput.files[0];
            if (!file) { showToast('Выберите .apk файл', 'err'); return; }

            const submitBtn = document.getElementById('btn-apk-upload');
            const origText = submitBtn ? submitBtn.textContent : '';
            if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Загрузка APK...'; }

            try {
                const buf = await file.arrayBuffer();
                const dataBase64 = arrayBufferToBase64(buf);
                const payload = {
                    dataBase64,
                    versionName: document.getElementById('apk-ver-name').value.trim(),
                    versionCode: parseInt(document.getElementById('apk-ver-code').value, 10) || 1,
                    changelog: document.getElementById('apk-changelog').value.trim(),
                    mandatory: document.getElementById('apk-mandatory').checked
                };
                const res = await apiRequest('/api/admin/apk-upload', 'POST', payload);
                if (res && res.ok) {
                    showToast(`APK v${res.release.versionName} опубликован для ТВ`, 'ok');
                    apkUploadForm.reset();
                    await loadApkReleases();
                } else {
                    showToast((res && res.error) || 'Ошибка загрузки APK', 'err');
                }
            } catch (err) {
                showToast('Ошибка: ' + (err && err.message ? err.message : String(err)), 'err');
            } finally {
                if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = origText; }
            }
        };
    }

    const btnDownloadAndroidProject = document.getElementById('btn-download-android-project');
    if (btnDownloadAndroidProject) {
        btnDownloadAndroidProject.onclick = async () => {
            const orig = btnDownloadAndroidProject.textContent;
            btnDownloadAndroidProject.disabled = true;
            try {
                const t = getAdminToken();
                const res = await fetch('/api/admin/apk/project.zip', {
                    credentials: 'same-origin',
                    headers: t ? { 'X-Admin-Token': t } : {}
                });
                if (!res.ok) throw new Error('HTTP ' + res.status);
                const blob = await res.blob();
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = 'pqtv-android-tv.zip';
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(url), 5000);
                showToast('Android TV проект скачан', 'ok');
            } catch (err) {
                showToast('Ошибка скачивания: ' + (err && err.message ? err.message : String(err)), 'err');
            } finally {
                btnDownloadAndroidProject.disabled = false;
                if (orig) btnDownloadAndroidProject.textContent = orig;
            }
        };
    }

    try { loadPlaylists(); } catch (e) { console.error(e); }

    // ============ PLAYER ============
    let playerHls = null;
    let playerMpegts = null;

    function openPlayerByUrl(url, name, logoUrl, tvgId) {
        if (!url) return;
        document.getElementById('player-title').textContent = name || '—';
        document.getElementById('player-url').textContent = url;

        // Сброс EPG
        const epgCurrent = document.getElementById('epg-current');
        const epgNext = document.getElementById('epg-next');
        const epgLoading = document.getElementById('epg-loading');
        if (epgCurrent) { epgCurrent.textContent = '—'; epgCurrent.title = ''; }
        if (epgNext) { epgNext.textContent = '—'; epgNext.title = ''; }
        if (epgLoading) epgLoading.style.display = '';
        loadEpgNow(tvgId || '', name || '');
        if (window.__startEpgAuto) window.__startEpgAuto(tvgId || '', name || '');

        const logo = document.getElementById('player-logo');
        const ph = document.getElementById('player-logo-placeholder');
        if (logoUrl) {
            logo.src = logoUrl;
            logo.style.display = '';
            logo.onerror = () => { logo.style.display = 'none'; if (ph) ph.style.display = ''; };
            if (ph) ph.style.display = 'none';
        } else {
            logo.style.display = 'none';
            if (ph) ph.style.display = '';
        }

        document.getElementById('player-modal').classList.remove('hidden');
        playStream(url);
    }

    function openPlayer(idx) {
        const ch = channelsData[idx];
        if (!ch) return;
        openPlayerByUrl(ch.url, ch.name, ch.logo, ch.tvg_id || '');
    }

    function closePlayer() {
        const pm = document.getElementById('player-modal');
        if (pm) pm.classList.add('hidden');
        stopPlayerStream();
        if (window.__stopEpgAuto) window.__stopEpgAuto();
        stopBlackScreenDetector();
    }

    let playerAttemptTimer = null;

    function buildStreamCandidates(rawUrl, settings) {
        const s = settings || {};
        const mode = ['auto_proxy_first', 'auto_direct_first', 'proxy_only', 'direct_only'].includes(s.mode)
            ? s.mode
            : 'auto_proxy_first';
        const tryHttps = s.tryHttpsUpgrade !== false;
        const isHttp = /^http:\/\//i.test(rawUrl);
        const httpsUrl = (tryHttps && isHttp) ? rawUrl.replace(/^http:/i, 'https:') : rawUrl;
        const isHttpsPage = window.location.protocol === 'https:';
        const canDirectPlainHttp = !isHttpsPage;

        const proxyCandidates = [];
        if (httpsUrl !== rawUrl) {
            proxyCandidates.push({
                src: '/api/stream/proxy?url=' + encodeURIComponent(httpsUrl),
                label: 'proxy HTTPS',
            });
        }
        proxyCandidates.push({
            src: '/api/stream/proxy?url=' + encodeURIComponent(rawUrl),
            label: isHttp ? 'proxy HTTP' : 'proxy',
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

    function stopPlayerStream() {
        clearTimeout(playerAttemptTimer);
        const v = document.getElementById('player-video');
        if (playerHls) { try { playerHls.destroy(); } catch (e) {} playerHls = null; }
        if (playerMpegts) { try { playerMpegts.destroy(); } catch (e) {} playerMpegts = null; }
        try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
    }

    function playStream(url) {
        stopPlayerStream();
        const v = document.getElementById('player-video');
        const overlay = document.getElementById('player-overlay');
        const text = document.getElementById('player-overlay-text');
        const playerUrlEl = document.getElementById('player-url');

        overlay.classList.remove('hidden');
        text.textContent = 'Загрузка потока...';

        const low = url.split('?')[0].toLowerCase();
        const isM3u8 = low.includes('.m3u8');
        const isTs = low.endsWith('.ts');
        let attemptIndex = 0;
        let attemptId = 0;
        let attempts = [];

        const onReady = (label) => {
            clearTimeout(playerAttemptTimer);
            overlay.classList.add('hidden');
            if (playerUrlEl && label) {
                playerUrlEl.textContent = '[' + label + '] ' + url;
            }
        };
        const onErr = (msg) => {
            clearTimeout(playerAttemptTimer);
            overlay.classList.remove('hidden');
            text.textContent = msg || 'Ошибка воспроизведения';
        };

        const attempt = (candidate) => {
            if (!candidate) {
                onErr(window.location.protocol === 'https:' && /^http:\/\//i.test(url)
                    ? 'Прямая http:// ссылка заблокирована браузером (HTTPS) — включите proxy'
                    : 'Поток недоступен или формат не поддерживается');
                return;
            }
            const source = candidate.src;
            const currentAttempt = ++attemptId;
            clearTimeout(playerAttemptTimer);
            if (playerHls) {
                try { playerHls.destroy(); } catch (e) {}
                playerHls = null;
            }
            if (playerMpegts) {
                try { playerMpegts.destroy(); } catch (e) {}
                playerMpegts = null;
            }
            try {
                v.pause();
                v.removeAttribute('src');
                v.load();
            } catch (e) {}

            text.textContent = 'Загрузка (' + candidate.label + ')...';

            const advance = (fallbackMsg) => {
                if (currentAttempt !== attemptId) return;
                clearTimeout(playerAttemptTimer);
                if (attemptIndex < attempts.length) {
                    attempt(attempts[attemptIndex++]);
                } else {
                    onErr(fallbackMsg || 'Поток недоступен или формат не поддерживается');
                }
            };

            if (attemptIndex < attempts.length) {
                playerAttemptTimer = setTimeout(() => {
                    advance('Таймаут загрузки потока');
                }, 9500);
            }

            v.onloadeddata = () => { if (currentAttempt === attemptId) onReady(candidate.label); };
            v.oncanplay = () => { if (currentAttempt === attemptId) onReady(candidate.label); };
            v.onerror = () => advance('Поток недоступен или формат не поддерживается');

            if (isM3u8 && window.Hls && window.Hls.isSupported()) {
                playerHls = new Hls({
                    enableWorker: true,
                    lowLatencyMode: false,
                    manifestLoadingTimeOut: 10000,
                    manifestLoadingMaxRetry: 1,
                    fragLoadingTimeOut: 25000
                });
                playerHls.loadSource(source);
                playerHls.attachMedia(v);
                playerHls.on(Hls.Events.MANIFEST_PARSED, () => {
                    if (currentAttempt === attemptId) v.play().catch(() => {});
                });
                playerHls.on(Hls.Events.ERROR, (evt, data) => {
                    if (!data || !data.fatal || currentAttempt !== attemptId) return;
                    advance('Ошибка HLS: ' + (data.details || 'unknown'));
                });
            } else if (isTs && window.mpegts && window.mpegts.isSupported()) {
                playerMpegts = mpegts.createPlayer({
                    type: 'mpegts',
                    url: source,
                    isLive: true
                }, {
                    enableWorker: true,
                    liveBufferLatencyChasing: true
                });
                playerMpegts.attachMediaElement(v);
                playerMpegts.load();
                playerMpegts.play().catch(() => {});
                playerMpegts.on(mpegts.Events.ERROR, (t, d) => {
                    advance('Ошибка TS: ' + d);
                });
            } else {
                v.src = source;
                v.play().catch(() => {});
            }
        };

        void apiRequest('/api/settings/streaming').then((result) => {
            const settings = result && result.settings ? result.settings : {};
            attempts = buildStreamCandidates(url, settings);
            attemptIndex = 0;
            attempt(attempts[attemptIndex++]);
        }).catch(() => {
            attempts = buildStreamCandidates(url, { mode: 'auto_proxy_first', tryHttpsUpgrade: true });
            attemptIndex = 0;
            attempt(attempts[attemptIndex++]);
        });
    }

    // ===== EPG IN PLAYER =====
    let epgRefreshTimer = null;

    function fmtTime(ts) {
        const d = new Date(ts * 1000);
        return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    }

    async function loadEpgNow(tvgId, name) {
        const current = document.getElementById('epg-current');
        const next = document.getElementById('epg-next');
        const loading = document.getElementById('epg-loading');
        if (!current || !next) return;

        if (loading) loading.style.display = '';
        current.textContent = '—';
        next.textContent = '—';

        try {
            const qs = new URLSearchParams();
            if (tvgId) qs.set('tvg_id', tvgId);
            if (name) qs.set('name', name);
            const res = await apiRequest('/api/epg/now?' + qs.toString());

            if (res.current) {
                current.textContent = res.current.title || '—';
                current.title = (res.current.desc || '') + '  [' + fmtTime(res.current.start) + '–' + fmtTime(res.current.stop) + ']';
            } else {
                current.textContent = 'нет данных';
            }
            if (res.next) {
                next.textContent = res.next.title || '—';
                next.title = (res.next.desc || '') + '  [' + fmtTime(res.next.start) + '–' + fmtTime(res.next.stop) + ']';
            } else {
                next.textContent = '—';
            }
        } catch (e) {
            current.textContent = '—';
            next.textContent = '—';
        } finally {
            if (loading) loading.style.display = 'none';
        }
    }

    function startEpgAutoRefresh(tvgId, name) {
        stopEpgAutoRefresh();
        // Обновление каждые 60 секунд, пока плеер открыт
        epgRefreshTimer = setInterval(() => {
            const pm = document.getElementById('player-modal');
            if (!pm || pm.classList.contains('hidden')) { stopEpgAutoRefresh(); return; }
            loadEpgNow(tvgId, name);
        }, 60000);
    }

    function stopEpgAutoRefresh() {
        if (epgRefreshTimer) { clearInterval(epgRefreshTimer); epgRefreshTimer = null; }
    }

    // ===== BLACK SCREEN DETECTOR =====
    let blackScreenTimer = null;
    function startBlackScreenDetector() {
        stopBlackScreenDetector();
        const v = document.getElementById('player-video');
        const toast = document.getElementById('player-toast');
        blackScreenTimer = setTimeout(() => {
            try {
                if (v && v.videoWidth === 0 && v.currentTime > 1 && !v.paused) {
                    if (toast) {
                        toast.textContent = 'Видео не отображается. Возможно, поток в формате H.265/HEVC или MPEG-2 — браузер его не воспроизводит. Попробуйте открыть ссылку в VLC.';
                        toast.style.display = 'block';
                        setTimeout(() => { toast.style.display = 'none'; }, 12000);
                    }
                }
            } catch (e) {}
        }, 8000);
    }
    function stopBlackScreenDetector() {
        if (blackScreenTimer) { clearTimeout(blackScreenTimer); blackScreenTimer = null; }
    }

    (function initPlayer() {
        const pm = document.getElementById('player-modal');
        if (!pm) return;

        const btnClose = document.getElementById('player-close');
        const btnReload = document.getElementById('player-reload');
        if (btnClose) btnClose.onclick = closePlayer;
        if (btnReload) btnReload.onclick = () => {
            const u = document.getElementById('player-url').textContent;
            if (u && u !== '—') playStream(u);
        };
        pm.querySelectorAll('[data-close-player]').forEach(el => el.onclick = closePlayer);
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !pm.classList.contains('hidden')) closePlayer();
        });

        if (channelsContainer) {
            channelsContainer.addEventListener('click', (e) => {
                if (e.target.closest('button')) return;
                const tr = e.target.closest('tr[data-idx]');
                if (!tr) return;
                openPlayer(parseInt(tr.dataset.idx));
            });
        }

        // Перехватываем openPlayer чтобы запускать таймеры
        const _origOpen = window.openPlayer || null;
    })();

    // Переопределяем playStream чтобы запускать детекторы
    const _origPlayStream = playStream;
    playStream = function(url) {
        stopBlackScreenDetector();
        startBlackScreenDetector();
        return _origPlayStream(url);
    };

    // Экспорт для внешнего запуска EPG авто-обновления
    window.__startEpgAuto = startEpgAutoRefresh;
    window.__stopEpgAuto = stopEpgAutoRefresh;

    // ===== CHANNEL HEALTH & GLOBAL REMEDIATION =====
    let healthOverviewData = null;

    const DIAG_LABELS = {
        '401': 'HTTP 401 (Авторизация)',
        '403': 'HTTP 403 (Доступ)',
        '404': 'HTTP 404/410',
        '429': 'HTTP 429 (Лимит)',
        '5xx': 'HTTP 5xx',
        timeout: 'Timeout',
        tls: 'TLS / SSL',
        codec: 'Codec / TS',
        hls_segment: 'HLS сегмент',
        hls_empty: 'HLS пуст',
        html_error: 'HTML ошибка',
        network: 'Сеть',
    };

    function updateHealthNavBadge(data) {
        const badge = document.getElementById('nav-health-badge');
        if (!badge || !data || !data.stats) return;
        const problemCount = (data.stats.stillBroken || 0) + (data.stats.offline || 0) + (data.stats.viewerReported || 0);
        badge.textContent = String(problemCount);
        badge.classList.toggle('hidden', problemCount === 0);
    }

    async function loadHealthOverview() {
        try {
            const res = await apiRequest('/api/health/overview');
            if (!res || !res.ok) return;
            healthOverviewData = res;
            updateHealthNavBadge(res);
            renderHealthView();
        } catch (err) {
            console.error('loadHealthOverview failed:', err);
        }
    }

    function renderHealthView() {
        const data = healthOverviewData;
        const statsEl = document.getElementById('health-stats');
        const diagEl = document.getElementById('health-diag-breakdown');
        const plSel = document.getElementById('health-filter-playlist');
        const listEl = document.getElementById('health-list-container');
        if (!data || !listEl) return;

        const st = data.stats || {};
        if (statsEl) {
            statsEl.innerHTML = `
                <div class="cat-stat-box"><span class="cat-stat-label">Всего каналов</span><span class="cat-stat-value">${st.totalChannels || 0}</span></div>
                <div class="cat-stat-box"><span class="cat-stat-label">Работают</span><span class="cat-stat-value online">${st.online || 0}</span></div>
                <div class="cat-stat-box"><span class="cat-stat-label">Недоступны</span><span class="cat-stat-value" style="color:#fca5a5;">${st.offline || 0}</span></div>
                <div class="cat-stat-box"><span class="cat-stat-label">Жалобы зрителей</span><span class="cat-stat-value" style="color:#fcd34d;">${st.viewerReported || 0}</span></div>
                <div class="cat-stat-box"><span class="cat-stat-label">Скрыты у зрителей</span><span class="cat-stat-value accent">${st.hiddenForViewers || 0}</span></div>
                <div class="cat-stat-box"><span class="cat-stat-label">Не работают после «Решено»</span><span class="cat-stat-value" style="color:#f87171;">${st.stillBroken || 0}</span></div>
            `;
        }

        const currentDiag = document.getElementById('health-filter-diag')?.value || '';
        if (diagEl) {
            const dc = data.diagCounts || {};
            const chips = Object.entries(dc)
                .filter(([, count]) => count > 0)
                .map(([code, count]) => {
                    const active = currentDiag === code ? 'active' : '';
                    return `<button type="button" class="health-diag-chip ${active}" data-diag-chip="${escapeHtml(code)}">${escapeHtml(DIAG_LABELS[code] || code)}: <b>${count}</b></button>`;
                });
            diagEl.innerHTML = chips.join('');
            diagEl.querySelectorAll('[data-diag-chip]').forEach((btn) => {
                btn.onclick = () => {
                    const sel = document.getElementById('health-filter-diag');
                    if (!sel) return;
                    sel.value = sel.value === btn.dataset.diagChip ? '' : btn.dataset.diagChip;
                    renderHealthView();
                };
            });
        }

        if (plSel) {
            const prevPl = plSel.value;
            const pls = Array.isArray(data.playlists) ? data.playlists : [];
            plSel.innerHTML = '<option value="">Все плейлисты</option>' +
                pls.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
            if (pls.includes(prevPl)) plSel.value = prevPl;
        }

        const filterPl = plSel ? plSel.value : '';
        const filterStatus = document.getElementById('health-filter-status')?.value ?? 'problems';
        const filterDiag = document.getElementById('health-filter-diag')?.value || '';
        const q = (document.getElementById('health-search')?.value || '').trim().toLowerCase();

        const rows = (data.channels || []).filter((ch) => {
            if (filterPl && !(ch.playlists || []).includes(filterPl)) return false;
            if (filterDiag && ch.diagCode !== filterDiag) return false;
            if (filterStatus === 'problems') {
                if (ch.overallStatus === 'online' || ch.overallStatus === 'unknown') return false;
            } else if (filterStatus === 'hidden') {
                if (!ch.hiddenForViewers) return false;
            } else if (filterStatus === 'still_broken') {
                if (!ch.stillBrokenAfterResolve) return false;
            } else if (filterStatus === 'paused') {
                if (!ch.paused) return false;
            } else if (filterStatus && ch.overallStatus !== filterStatus) {
                return false;
            }
            if (q) {
                const hay = (ch.name + ' ' + ch.primaryUrl + ' ' + ch.reason + ' ' + (ch.playlists || []).join(' ')).toLowerCase();
                if (!hay.includes(q)) return false;
            }
            return true;
        });

        if (rows.length === 0) {
            listEl.innerHTML = '<p class="placeholder-text">Каналов по выбранному фильтру не найдено</p>';
            return;
        }

        listEl.innerHTML = rows.map((ch) => {
            const badges = [];
            if (ch.stillBrokenAfterResolve) {
                badges.push('<span class="health-badge danger">Не работает после «Решено»</span>');
            }
            if (ch.paused) {
                badges.push('<span class="health-badge warn">Приостановлен</span>');
            }
            if (ch.hiddenForViewers) {
                badges.push('<span class="health-badge muted">Скрыт у зрителей</span>');
            }
            if (ch.overallStatus === 'online') {
                badges.push(`<span class="health-badge ok">Online${ch.ms ? ' · ' + ch.ms + 'ms' : ''}</span>`);
            } else if (ch.overallStatus === 'offline' || ch.overallStatus === 'still_broken') {
                badges.push(`<span class="health-badge danger">${escapeHtml(ch.diagCode || 'offline')}${ch.code ? ' · HTTP ' + ch.code : ''}</span>`);
            } else if (ch.overallStatus === 'viewer_reported') {
                badges.push(`<span class="health-badge warn">Жалобы: ${ch.viewerErrorCount}</span>`);
            } else if (ch.overallStatus === 'codec_warn') {
                badges.push('<span class="health-badge warn">Кодек HEVC/AC-3</span>');
            } else if (!ch.paused) {
                badges.push('<span class="health-badge muted">Не проверялся</span>');
            }

            const plsBadges = (ch.playlists || []).map(p => `<span class="cat-badge violet">${escapeHtml(p)}</span>`).join(' ');
            const viewerErrsHtml = (ch.viewerErrors && ch.viewerErrors.length > 0)
                ? `<div style="font-size:11.5px; color:#fcd34d; margin-top:4px;">Зрители: ${ch.viewerErrors.slice(0, 3).map(ve => `${escapeHtml(ve.userName || ve.userLogin)} (${escapeHtml(ve.reason)})`).join('; ')}</div>`
                : '';

            const encodedName = escapeHtml(ch.name);
            return `<div class="health-card ${ch.stillBrokenAfterResolve ? 'still-broken' : (ch.paused ? 'paused-card' : '')}">
                <div style="flex:1; min-width:260px;">
                    <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:4px;">
                        <b style="color:#fff; font-size:14px;">${encodedName}</b>
                        ${badges.join(' ')}
                        ${plsBadges}
                    </div>
                    <div style="font-size:12px; color:${ch.overallStatus === 'online' ? '#6ee7b7' : '#fca5a5'}; margin-bottom:4px;">
                        ${escapeHtml(ch.reason)}
                    </div>
                    <div style="font-size:11.5px; color:var(--muted); word-break:break-all;">
                        <code>${escapeHtml(ch.primaryUrl)}</code>
                    </div>
                    ${viewerErrsHtml}
                </div>
                <div class="health-actions-col">
                    <button type="button" class="btn btn-secondary" data-h-act="check" data-h-ch="${encodedName}" style="padding:6px 10px; font-size:11.5px;">Проверить</button>
                    <button type="button" class="btn btn-primary" data-h-act="replace" data-h-ch="${encodedName}" style="padding:6px 10px; font-size:11.5px;">Заменить URL</button>
                    <button type="button" class="btn btn-secondary" data-h-act="pause" data-h-paused="${ch.paused ? '0' : '1'}" data-h-ch="${encodedName}" style="padding:6px 10px; font-size:11.5px;">${ch.paused ? 'Возобновить' : 'Пауза'}</button>
                    <button type="button" class="btn btn-secondary" data-h-act="resolve" data-h-ch="${encodedName}" style="padding:6px 10px; font-size:11.5px;">Решено</button>
                    <button type="button" class="btn btn-danger" data-h-act="delete" data-h-ch="${encodedName}" style="padding:6px 10px; font-size:11.5px;">Удалить</button>
                </div>
            </div>`;
        }).join('');

        listEl.querySelectorAll('[data-h-act]').forEach((btn) => {
            btn.onclick = async () => {
                const act = btn.dataset.hAct;
                const chName = btn.dataset.hCh;
                if (!chName) return;

                if (act === 'check') {
                    btn.disabled = true;
                    btn.textContent = '...';
                    await apiRequest('/api/health/check', 'POST', { channelName: chName, force: true });
                    await loadHealthOverview();
                    return;
                }
                if (act === 'replace') {
                    openHealthReplaceModal(chName);
                    return;
                }
                if (act === 'pause') {
                    const nextPaused = btn.dataset.hPaused === '1';
                    const res = await apiRequest('/api/health/pause', 'POST', { channelName: chName, paused: nextPaused });
                    if (res && res.ok) {
                        showToast(`${chName}: ${nextPaused ? 'приостановлен во всех плейлистах' : 'возобновлён'}`, 'ok');
                        await syncLocalMutationToPlaylists();
                        await loadHealthOverview();
                    } else {
                        showToast((res && res.error) || 'Не удалось изменить статус паузы', 'err');
                    }
                    return;
                }
                if (act === 'resolve') {
                    btn.disabled = true;
                    btn.textContent = 'Проверка...';
                    const res = await apiRequest('/api/health/resolve', 'POST', { channelName: chName });
                    if (res && res.stillBroken) {
                        showToast(res.message || 'Канал всё ещё не работает — возвращён в нерабочие с меткой!', 'err');
                    } else if (res && res.ok) {
                        showToast('Поток проверен и отмечен решённым', 'ok');
                    } else {
                        showToast((res && res.error) || 'Ошибка отметки решения', 'err');
                    }
                    await Promise.all([
                        loadHealthOverview(),
                        loadAdminAlerts().catch(() => {}),
                    ]);
                    return;
                }
                if (act === 'delete') {
                    if (!(await uiConfirm(`Удалить канал «${chName}» из всех плейлистов?`))) return;
                    const res = await apiRequest('/api/health/delete-channel', 'POST', { channelName: chName });
                    if (res && res.ok) {
                        showToast(`Канал «${chName}» удалён из плейлистов: ${(res.updatedPlaylists || []).join(', ')}`, 'ok');
                        await syncLocalMutationToPlaylists();
                        await loadHealthOverview();
                    } else {
                        showToast((res && res.error) || 'Ошибка удаления канала', 'err');
                    }
                }
            };
        });
    }

    async function syncLocalMutationToPlaylists() {
        await loadPlaylists();
        if (currentPlaylist) await loadChannels();
        loadCatalog().catch(() => {});
        if (fbAdminConnected) void syncCloudDatabase();
    }

    function openHealthReplaceModal(channelName) {
        const modal = document.getElementById('health-replace-modal');
        if (!modal || !healthOverviewData) return;
        const ch = (healthOverviewData.channels || []).find(c => c.name === channelName);
        document.getElementById('health-replace-channel').value = channelName;
        document.getElementById('health-replace-title').textContent = 'Замена потока: ' + channelName;
        document.getElementById('health-replace-url').value = ch ? ch.primaryUrl : '';
        const primaryUrlObj = ch && ch.urls && ch.urls[0] ? ch.urls[0] : {};
        document.getElementById('health-replace-ua').value = primaryUrlObj.userAgent || '';
        document.getElementById('health-replace-ref').value = primaryUrlObj.referer || '';
        document.getElementById('health-replace-orig').value = primaryUrlObj.origin || '';

        const plsBox = document.getElementById('health-replace-playlists');
        if (plsBox) {
            const pls = ch ? (ch.playlists || []) : [];
            plsBox.innerHTML = pls.map(p =>
                `<label style="display:flex; align-items:center; gap:6px; font-size:12.5px; color:#fff; cursor:pointer;">
                    <input type="checkbox" name="health-pl-chk" value="${escapeHtml(p)}" checked>
                    <span>${escapeHtml(p)}</span>
                </label>`
            ).join('');
        }
        const candList = document.getElementById('health-candidates-list');
        if (candList) {
            candList.innerHTML = '<p class="placeholder-text" style="margin:14px 0;">Нажмите «Найти рабочие в источниках» для поиска и проверки альтернатив</p>';
        }
        modal.classList.remove('hidden');
    }

    (function initHealthControls() {
        const btnCheckAll = document.getElementById('btn-health-check-all');
        const btnAutoRepair = document.getElementById('btn-health-auto-repair');
        const btnRefresh = document.getElementById('btn-health-refresh');
        const selPl = document.getElementById('health-filter-playlist');
        const selSt = document.getElementById('health-filter-status');
        const selDiag = document.getElementById('health-filter-diag');
        const inpSearch = document.getElementById('health-search');

        if (selPl) selPl.onchange = renderHealthView;
        if (selSt) selSt.onchange = renderHealthView;
        if (selDiag) selDiag.onchange = renderHealthView;
        if (inpSearch) inpSearch.oninput = renderHealthView;
        if (btnRefresh) btnRefresh.onclick = loadHealthOverview;

        if (btnCheckAll) {
            btnCheckAll.onclick = async () => {
                const txt = document.getElementById('btn-health-check-all-text');
                btnCheckAll.disabled = true;
                if (txt) txt.textContent = 'Глубокая проверка...';
                try {
                    const pl = selPl ? selPl.value : '';
                    const res = await apiRequest('/api/health/check-all', 'POST', { playlist: pl || undefined, force: true });
                    showToast(`Проверено ${res.checked || 0}: ${res.online || 0} работает, ${res.offline || 0} не работает`, 'ok');
                    await loadHealthOverview();
                    scheduleCloudSync();
                } finally {
                    btnCheckAll.disabled = false;
                    if (txt) txt.textContent = 'Проверить все каналы';
                }
            };
        }

        if (btnAutoRepair) {
            btnAutoRepair.onclick = async () => {
                const txt = document.getElementById('btn-health-auto-repair-text');
                btnAutoRepair.disabled = true;
                if (txt) txt.textContent = 'Поиск и замена...';
                try {
                    const res = await apiRequest('/api/health/auto-repair', 'POST', { onlyDead: true });
                    showToast(`Сканировано ${res.scanned || 0}: заменено ${res.repairedCount || 0}, без замены ${res.unfixableCount || 0}`, res.repairedCount > 0 ? 'ok' : 'err');
                    await syncLocalMutationToPlaylists();
                    await loadHealthOverview();
                } finally {
                    btnAutoRepair.disabled = false;
                    if (txt) txt.textContent = 'Обновить неработающие URL';
                }
            };
        }

        const repModal = document.getElementById('health-replace-modal');
        const repClose = document.getElementById('health-replace-close');
        const repBack = document.getElementById('health-replace-backdrop');
        const repForm = document.getElementById('health-replace-form');
        const btnProbe = document.getElementById('health-probe-candidates');

        const closeRepModal = () => { if (repModal) repModal.classList.add('hidden'); };
        if (repClose) repClose.onclick = closeRepModal;
        if (repBack) repBack.onclick = closeRepModal;

        if (repForm) {
            repForm.onsubmit = async (e) => {
                e.preventDefault();
                const channelName = document.getElementById('health-replace-channel').value;
                const newUrl = document.getElementById('health-replace-url').value.trim();
                const userAgent = document.getElementById('health-replace-ua').value.trim();
                const referer = document.getElementById('health-replace-ref').value.trim();
                const origin = document.getElementById('health-replace-orig').value.trim();
                const checkedPls = Array.from(document.querySelectorAll('input[name="health-pl-chk"]:checked')).map(el => el.value);
                const subBtn = document.getElementById('health-replace-submit');
                if (subBtn) { subBtn.disabled = true; subBtn.textContent = 'Сохранение...'; }
                try {
                    const res = await apiRequest('/api/health/replace-url', 'POST', {
                        channelName,
                        newUrl,
                        playlists: checkedPls.length > 0 ? checkedPls : undefined,
                        userAgent,
                        referer,
                        origin,
                        unpause: true,
                    });
                    if (res && res.ok) {
                        const diagOk = res.checkResult && res.checkResult.status === 'online';
                        showToast(
                            `URL обновлён в: ${(res.updatedPlaylists || []).join(', ')} (${res.checkResult ? res.checkResult.reason : ''})`,
                            diagOk ? 'ok' : 'err'
                        );
                        closeRepModal();
                        await syncLocalMutationToPlaylists();
                        await loadHealthOverview();
                    } else {
                        showToast((res && res.error) || 'Не удалось заменить URL', 'err');
                    }
                } finally {
                    if (subBtn) { subBtn.disabled = false; subBtn.textContent = 'Сохранить и проверить'; }
                }
            };
        }

        if (btnProbe) {
            btnProbe.onclick = async () => {
                const channelName = document.getElementById('health-replace-channel').value;
                const candList = document.getElementById('health-candidates-list');
                if (!channelName || !candList) return;
                btnProbe.disabled = true;
                candList.innerHTML = '<div style="padding:12px; color:var(--muted);">Поиск альтернативных потоков и глубокая проверка сегментов...</div>';
                try {
                    const res = await apiRequest('/api/health/candidates?name=' + encodeURIComponent(channelName));
                    const cands = (res && Array.isArray(res.candidates)) ? res.candidates : [];
                    if (cands.length === 0) {
                        candList.innerHTML = '<p class="placeholder-text" style="margin:10px 0;">Альтернативных потоков в каталоге и источниках не найдено</p>';
                        return;
                    }
                    candList.innerHTML = cands.map((c, idx) => {
                        const d = c.diag || {};
                        const isOk = d.status === 'online';
                        return `<div class="health-cand-row">
                            <div style="flex:1; min-width:220px;">
                                <div style="display:flex; align-items:center; gap:6px; flex-wrap:wrap; margin-bottom:2px;">
                                    <span class="health-badge ${isOk ? 'ok' : 'danger'}">${isOk ? 'OK · ' + (d.ms || 0) + 'ms' : escapeHtml(d.diagCode || 'offline')}</span>
                                    <b style="color:#fff; font-size:12.5px;">${escapeHtml(c.source || 'Источник')}</b>
                                    <span style="font-size:11.5px; color:var(--muted);">${escapeHtml(d.reason || '')}</span>
                                </div>
                                <div style="font-size:11px; color:var(--muted); word-break:break-all;"><code>${escapeHtml(c.url)}</code></div>
                            </div>
                            <button type="button" class="btn ${isOk ? 'btn-primary' : 'btn-secondary'}" data-pick-cand="${idx}" style="padding:6px 10px; font-size:11.5px;">Выбрать</button>
                        </div>`;
                    }).join('');
                    candList.querySelectorAll('[data-pick-cand]').forEach((b) => {
                        b.onclick = () => {
                            const picked = cands[parseInt(b.dataset.pickCand, 10)];
                            if (!picked) return;
                            document.getElementById('health-replace-url').value = picked.url;
                            document.getElementById('health-replace-ua').value = picked.userAgent || '';
                            document.getElementById('health-replace-ref').value = picked.referer || '';
                            document.getElementById('health-replace-orig').value = picked.origin || '';
                        };
                    });
                } finally {
                    btnProbe.disabled = false;
                }
            };
        }

        loadHealthOverview();
    })();

    (function initBackupsAndLifecycleModal() {
        const modal = document.getElementById('backups-modal');
        const btnOpen = document.getElementById('btn-open-backups');
        const btnClose = document.getElementById('backups-modal-close');
        const backdrop = document.getElementById('backups-modal-backdrop');
        const btnReconcile = document.getElementById('btn-run-reconcile');
        const revLabel = document.getElementById('lifecycle-revision-label');
        const backupsBox = document.getElementById('backups-list-container');
        const logsBox = document.getElementById('lifecycle-logs-container');
        if (!modal || !btnOpen) return;

        const closeModal = () => modal.classList.add('hidden');
        if (btnClose) btnClose.onclick = closeModal;
        if (backdrop) backdrop.onclick = closeModal;

        async function loadModalData() {
            const [bRes, lRes] = await Promise.all([
                apiRequest('/api/playlists/backups'),
                apiRequest('/api/lifecycle/logs?limit=40'),
            ]);
            if (revLabel) {
                const rev = (lRes && (lRes.revision ?? (lRes.meta && lRes.meta.revision))) ?? '—';
                revLabel.textContent = `Ревизия базы: rev ${rev}`;
            }

            if (backupsBox) {
                const list = (bRes && Array.isArray(bRes.backups)) ? bRes.backups : [];
                if (list.length === 0) {
                    backupsBox.innerHTML = '<p class="placeholder-text" style="margin:12px 0;">Резервных копий (.bak) пока нет</p>';
                } else {
                    backupsBox.innerHTML = `<table class="ch-table"><thead><tr>
                        <th>Файл</th>
                        <th>Плейлист</th>
                        <th style="width:90px;">Размер</th>
                        <th style="width:150px;">Создана</th>
                        <th style="width:170px; text-align:right;">Действия</th>
                    </tr></thead><tbody>` + list.map((bk) => `<tr>
                        <td style="font-family:monospace; font-size:11.5px;">${escapeHtml(bk.filename)}</td>
                        <td><span class="cat-badge violet">${escapeHtml(bk.playlistName || bk.playlist || '')}</span></td>
                        <td style="font-size:12px; color:var(--muted);">${fmtBytes(bk.size)}</td>
                        <td style="font-size:12px; color:var(--muted);">${fmtDateTime(bk.createdAt ? Math.floor(bk.createdAt / 1000) : 0)}</td>
                        <td style="text-align:right; white-space:nowrap;">
                            <button type="button" class="btn btn-secondary" data-bak-restore="${escapeHtml(bk.filename)}" style="padding:4px 9px; font-size:11.5px;">Восстановить</button>
                            <button type="button" class="icon-btn danger" data-bak-del="${escapeHtml(bk.filename)}" title="Удалить">${I.trash}</button>
                        </td>
                    </tr>`).join('') + '</tbody></table>';

                    backupsBox.querySelectorAll('[data-bak-restore]').forEach((btn) => {
                        btn.onclick = async () => {
                            const fn = btn.dataset.bakRestore;
                            if (!(await uiConfirm(`Восстановить плейлист из копии ${fn}?`))) return;
                            const res = await apiRequest('/api/playlists/backups/restore', 'POST', { filename: fn });
                            if (!res || !res.ok) {
                                showToast((res && res.error) || 'Не удалось восстановить копию', 'err');
                                return;
                            }
                            showToast(`Восстановлен плейлист ${res.playlist}.m3u`, 'ok');
                            await Promise.all([
                                loadPlaylists(),
                                loadCatalog().catch(() => {}),
                                loadUsers().catch(() => {}),
                                loadHealthOverview().catch(() => {}),
                            ]);
                            if (currentPlaylist === res.playlist) await loadChannels();
                            await loadModalData();
                        };
                    });

                    backupsBox.querySelectorAll('[data-bak-del]').forEach((btn) => {
                        btn.onclick = async () => {
                            const fn = btn.dataset.bakDel;
                            if (!(await uiConfirm(`Удалить резервную копию ${fn}?`))) return;
                            const res = await apiRequest('/api/playlists/backups/delete', 'POST', { filename: fn });
                            if (!res || !res.ok) {
                                showToast((res && res.error) || 'Не удалось удалить копию', 'err');
                                return;
                            }
                            showToast('Резервная копия удалена', 'ok');
                            await loadModalData();
                        };
                    });
                }
            }

            if (logsBox) {
                const logs = (lRes && Array.isArray(lRes.logs)) ? lRes.logs : [];
                if (logs.length === 0) {
                    logsBox.innerHTML = '<p class="placeholder-text" style="margin:12px 0;">Операций пока нет</p>';
                } else {
                    logsBox.innerHTML = `<table class="ch-table"><thead><tr>
                        <th style="width:70px;">Rev</th>
                        <th style="width:150px;">Действие</th>
                        <th>Объект</th>
                        <th style="width:140px;">Время</th>
                    </tr></thead><tbody>` + logs.map((entry) => `<tr>
                        <td><span class="cat-badge violet">r${entry.revision}</span></td>
                        <td style="font-family:monospace; font-size:11.5px; color:#fff;">${escapeHtml(entry.action)}</td>
                        <td style="font-size:12px; color:var(--text-dim);">${escapeHtml(entry.target || '—')}</td>
                        <td style="font-size:11.5px; color:var(--muted);">${escapeHtml(entry.at ? new Date(entry.at).toLocaleString('ru-RU') : '—')}</td>
                    </tr>`).join('') + '</tbody></table>';
                }
            }
        }

        btnOpen.onclick = async () => {
            modal.classList.remove('hidden');
            await loadModalData();
        };

        if (btnReconcile) {
            btnReconcile.onclick = async () => {
                btnReconcile.disabled = true;
                try {
                    const res = await apiRequest('/api/catalog/reconcile', 'POST', {});
                    if (!res || !res.ok) {
                        showToast((res && res.error) || 'Ошибка синхронизации каталога', 'err');
                        return;
                    }
                    showToast(`Синхронизировано (удалено каналов: ${res.removedChannels || 0}, потоков: ${res.removedStreams || 0})`, 'ok');
                    await Promise.all([
                        loadCatalog().catch(() => {}),
                        loadHealthOverview().catch(() => {}),
                        loadModalData(),
                    ]);
                } finally {
                    btnReconcile.disabled = false;
                }
            };
        }
    })();

    // ===== СТАРТ: открываем каталог по умолчанию =====
    try {
        showScreen('catalog');
        document.querySelectorAll('.nav-item').forEach(b => {
            b.classList.toggle('active', b.dataset.screen === 'catalog');
        });
        loadCatalog();
    } catch (e) {
        console.error('boot catalog:', e);
    }
});
