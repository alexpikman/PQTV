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
                return {};
            }
            if (!res.ok) {
                console.error(`API ${res.status} ${url}`);
                try { return await res.json(); } catch { return {}; }
            }
            return await res.json();
        } catch (e) {
            console.error(`Fetch error ${url}:`, e);
            return {};
        }
    }

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
    if (navBtnEditor) navBtnEditor.onclick = () => { showScreen('editor'); setNavActive('editor'); };
    if (navBtnParser) navBtnParser.onclick = () => { showScreen('parser'); setNavActive('parser'); };
    if (navBtnSources) navBtnSources.onclick = () => { showScreen('sources'); setNavActive('sources'); loadSources(); };
    if (navBtnEpg) navBtnEpg.onclick = () => { showScreen('epg'); setNavActive('epg'); loadEpg(); };
    const navBtnUsers = document.getElementById('nav-btn-users');
    if (navBtnUsers) navBtnUsers.onclick = () => { showScreen('users'); setNavActive('users'); loadUsers(); };
    const navBtnCatalog = document.getElementById('nav-btn-catalog');
    if (navBtnCatalog) navBtnCatalog.onclick = () => { showScreen('catalog'); setNavActive('catalog'); loadCatalog(); };
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
        const screenApk = document.getElementById('screen-apk');
        [screenEditor, screenParser, screenSources, screenEpg, screenUsers, screenCatalog, screenApk].forEach(s => s && s.classList.add('hidden'));
        if (name === 'editor' && screenEditor) screenEditor.classList.remove('hidden');
        if (name === 'parser' && screenParser) screenParser.classList.remove('hidden');
        if (name === 'sources' && screenSources) screenSources.classList.remove('hidden');
        if (name === 'epg' && screenEpg) screenEpg.classList.remove('hidden');
        if (name === 'users' && screenUsers) screenUsers.classList.remove('hidden');
        if (name === 'catalog' && screenCatalog) screenCatalog.classList.remove('hidden');
        if (name === 'apk' && screenApk) screenApk.classList.remove('hidden');
        if (name !== 'editor') closeForm();
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

            const st = streamStatusCache[ch.url];
            let badge = `<button class="badge-status badge-unknown" data-action="check" data-idx="${idx}">Проверить</button>`;
            if (st === 'checking') badge = `<span class="badge-status badge-checking">…</span>`;
            else if (st === 'online') badge = `<span class="badge-status badge-online" data-action="check" data-idx="${idx}" title="Перепроверить">online</span>`;
            else if (st === 'offline') badge = `<span class="badge-status badge-offline" data-action="check" data-idx="${idx}" title="Перепроверить">offline</span>`;

            html += `
                <tr data-idx="${idx}">
                    <td>${logoHtml}</td>
                    <td>
                        <div class="ch-title">${escapeHtml(ch.name)}</div>
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
            const res = await apiRequest('/api/stream/check', 'POST', { url: ch.url });
            streamStatusCache[ch.url] = res.online ? 'online' : 'offline';
        } catch (e) { streamStatusCache[ch.url] = 'offline'; }
        renderChannels();
    }

    if (btnCheckAll) {
        btnCheckAll.onclick = async () => {
            if (!channelsData.length) return;
            btnCheckAll.disabled = true;
            const origText = btnCheckAll.innerHTML;
            btnCheckAll.textContent = 'Проверка...';
            channelsData.forEach(c => streamStatusCache[c.url] = 'checking');
            renderChannels();
            for (let i = 0; i < channelsData.length; i++) await checkStream(i);
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

            const checks = await Promise.all(items.map(item =>
                apiRequest('/api/stream/check', 'POST', { url: item.url })
                    .then(r => !!r.online).catch(() => false)
            ));

            let html = `<table class="ch-table"><thead><tr>
                <th style="width:170px;">Источник</th>
                <th>Ссылка потока</th>
                <th style="width:100px;">Статус</th>
                <th style="width:170px; text-align:right;">Действие</th>
            </tr></thead><tbody>`;

            items.forEach((item, i) => {
                const online = checks[i];
                const badge = online
                    ? `<span class="badge-status badge-online">online</span>`
                    : `<span class="badge-status badge-offline">offline</span>`;

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
        await apiRequest('/api/channels/save', 'POST', {
            playlist: targetPl,
            channels: channelsData
        });
        showToast(`Ссылка обновлена для «${chName}»`, 'ok');
        parseContext = { playlist: null, channelIndex: -1, channelName: '' };
        if (parseTargetInfo) parseTargetInfo.classList.add('hidden');
        await selectPlaylist(targetPl || currentPlaylist);
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
        if (save.ok) {
            if (target === currentPlaylist) await loadChannels();
            showToast(`Добавлено в «${target}.m3u»`, 'ok');
        } else {
            showToast('Ошибка сохранения', 'err');
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
                const ok = Object.values(res.results || {}).filter(r => r.ok).length;
                const total = res.total || 0;
                if (txt) txt.textContent = `Готово (${ok}/${total}, ${res.elapsed}с)`;
                await loadSources();
                setTimeout(() => { if (txt) txt.textContent = 'Обновить индекс'; }, 2500);
            } catch (e) {
                showToast('Ошибка: ' + e.message, 'err');
                if (txt) txt.textContent = 'Обновить индекс';
            }
            btnRefreshIndex.disabled = false;
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
        document.getElementById('src-form-title').textContent = 'Редактировать источник';
        if (formChannelContainer) formChannelContainer.classList.add('hidden');
        if (formSourceContainer) formSourceContainer.classList.remove('hidden');
        if (colRight) colRight.classList.remove('hidden');
    }

    async function deleteSource(idx) {
        if (!(await uiConfirm('Удалить этот источник?'))) return;
        sourcesData.splice(idx, 1);
        await saveSources();
    }

    if (sourceForm) {
        sourceForm.onsubmit = async (e) => {
            e.preventDefault();
            const id = document.getElementById('src-id').value;
            const srcData = {
                id: id || ('src_' + Date.now()),
                name: document.getElementById('src-name').value.trim(),
                type: document.getElementById('src-type').value,
                url: document.getElementById('src-url').value.trim(),
                enabled: document.getElementById('src-enabled').checked
            };
            if (id) {
                const i = sourcesData.findIndex(s => s.id === id);
                if (i >= 0) sourcesData[i] = srcData;
            } else {
                sourcesData.push(srcData);
            }
            await saveSources();
            closeForm();
        };
    }

    async function saveSources() {
        await apiRequest('/api/sources/save', 'POST', { sources: sourcesData });
        renderSources();
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
            if (id) {
                const i = epgData.findIndex(x => x.id === id);
                if (i >= 0) epgData[i] = data;
            } else {
                epgData.push(data);
            }
            await saveEpg();
            closeForm();
        };
    }

    async function saveEpg() {
        await apiRequest('/api/epg/save', 'POST', { epg: epgData });
        renderEpg();
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
                await apiRequest('/api/alerts/resolve', 'POST', { id, resolved: nextResolved });
                if (fbAdminConnected && window.PQTVFirebase) {
                    await window.PQTVFirebase.resolveAlertAdmin(id, nextResolved).catch(() => {});
                }
                await loadAdminAlerts();
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
            await apiRequest('/api/invites/delete', 'POST', { id: inv.id, email: inv.email });
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
            const checked = catalogActivePL.includes(pl);
            html += `<label class="pl-dropdown-item">
                <input type="checkbox" value="${escapeHtml(pl)}" ${checked ? 'checked' : ''}>
                <span class="pl-name">${escapeHtml(pl)}.m3u</span>
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
                labelEl.textContent = catalogActivePL[0] + '.m3u';
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

    function renderStatusBadge(online, total) {
        if (total === 0) {
            return '<span class="cat-status-badge offline">нет</span>';
        }
        if (online === 0) {
            return '<span class="cat-status-badge offline">offline</span>';
        }
        if (online === total) {
            return '<span class="cat-status-badge online" title="' + online + ' из ' + total + ' online">online</span>';
        }
        return '<span class="cat-status-badge partial" title="' + online + ' из ' + total + ' online">' + online + '/' + total + '</span>';
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
            <th style="width:100px;">Мой пл.</th>
            <th style="width:120px;">Потоков</th>
            <th style="width:100px;">Online</th>
            <th style="width:100px; text-align:right;">Действия</th>
        </tr></thead><tbody>`;
        catalogData.forEach((ch, i) => {
            const inMy = ch.in_my_pl ? '<span class="cat-badge violet">да</span>' : '<span class="cat-badge grey">нет</span>';
            const total = ch.streams_count || 0;
            const online = ch.streams_online || 0;
            html += `<tr data-idx="${i}">
                <td><span style="color:var(--muted); font-family:monospace; font-size:11px;">${escapeHtml(ch.code || '')}</span></td>
                <td>
                    <div class="ch-title">${escapeHtml(ch.name)}</div>
                    ${ch.tvg_id ? `<div class="ch-group">${escapeHtml(ch.tvg_id)}</div>` : ''}
                </td>
                <td>${inMy}</td>
                <td><b style="color:#fff;">${total}</b></td>
                <td>${renderStatusBadge(online, total)}</td>
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
                        for (const s of (d.streams || [])) { if (s.online) { url = s.url; break; } }
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
                    + '<td style="padding:10px 8px; text-align:center;">' + (s.online
                        ? '<span class="cat-status-badge online">online</span>'
                        : '<span class="cat-status-badge offline">offline</span>') + '</td>'
                    + '<td style="padding:10px 8px; text-align:right; white-space:nowrap;">'
                    +   '<button data-play-url="' + encodeURIComponent(s.url) + '" title="Смотреть" style="background:transparent; border:none; color:#64b5f6; cursor:pointer; padding:4px; font-size:14px;">▶</button>'
                    +   '<button data-del-stream="' + s.id + '" title="Удалить" style="background:transparent; border:none; color:#ef4444; cursor:pointer; padding:4px; font-size:13px;">✕</button>'
                    + '</td>'
                    + '</tr>';
            });
            streamsHtml += '</tbody></table>';
        }

        // Дропдаун плейлистов
        let plOptions = '';
        if (typeof playlistsList !== 'undefined' && playlistsList.length) {
            playlistsList.forEach(p => {
                plOptions += '<option value="' + escapeHtml(p) + '">' + escapeHtml(p) + '.m3u</option>';
            });
        }

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
                await apiRequest('/api/catalog/stream/delete', 'POST', { id: +b.dataset.delStream });
                modal.remove();
                viewCatalogChannel(id);
                loadCatalogStats();
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
        await apiRequest('/api/channels/save', 'POST', { playlist: currentPlaylist, channels: channelsData });
        renderChannels();
    }

    // ===== PLAYLIST ACTIONS =====
    const btnAddPl = document.getElementById('btn-add-playlist');
    if (btnAddPl) {
        btnAddPl.onclick = async () => {
            const name = await uiPrompt('Имя нового плейлиста (латиница, цифры, _ -):', '', 'Новый плейлист');
            if (!name) return;
            const res = await apiRequest('/api/playlists', 'POST', { name });
            if (res.ok) selectPlaylist(name);
            else showToast(res.error || 'Ошибка создания плейлиста', 'err');
        };
    }

    if (btnDeletePl) {
        btnDeletePl.onclick = () => {
            if (currentPlaylist) deletePlaylist(currentPlaylist);
        };
    }

    async function deletePlaylist(name) {
        if (!(await uiConfirm(`Удалить плейлист ${name}.m3u?`))) return;
        const res = await apiRequest('/api/playlists/delete', 'POST', { name });
        if (res.ok) {
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
            showToast(`Плейлист ${name}.m3u удалён`, 'ok');
            loadPlaylists();
        } else {
            showToast(res.error || 'Ошибка удаления плейлиста', 'err');
        }
    }

    // ===== CHANNEL FORM =====
    if (btnAddCh) {
        btnAddCh.onclick = () => {
            if (channelForm) channelForm.reset();
            document.getElementById('channel-index').value = -1;
            document.getElementById('form-title').textContent = 'Добавить канал';
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
            const data = {
                name: document.getElementById('ch-name').value.trim(),
                group: document.getElementById('ch-group').value.trim(),
                logo: document.getElementById('ch-logo').value.trim(),
                url: document.getElementById('ch-url').value.trim()
            };
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

    async function loadApkReleases() {
        const statusBox = document.getElementById('apk-status-box');
        const listBox = document.getElementById('apk-releases-container');
        const latestBtn = document.getElementById('apk-latest-download');
        const snippetEl = document.getElementById('apk-ci-snippet');
        const verNameInput = document.getElementById('apk-ver-name');
        const verCodeInput = document.getElementById('apk-ver-code');

        const res = await apiRequest('/api/admin/apk/releases');
        if (!res || !res.ok) {
            if (statusBox) statusBox.textContent = 'Ошибка загрузки релизов APK';
            return;
        }

        if (verNameInput && !verNameInput.value) verNameInput.value = res.suggestedVersionName || '1.0.1';
        if (verCodeInput && !verCodeInput.value) verCodeInput.value = String(res.suggestedVersionCode || 1);

        const latest = res.latest;
        if (statusBox) {
            if (latest) {
                statusBox.innerHTML = `
                    <div>Активная версия: <b style="color:#fff;">v${escapeHtml(latest.versionName)}</b> (code <code>${latest.versionCode}</code>)</div>
                    <div>Размер: <b>${fmtBytes(latest.sizeBytes)}</b> · ${latest.mandatory ? '<span style="color:#fcd34d;">Обязательное обновление</span>' : 'Обычное обновление'}</div>
                    <div style="font-size:11.5px; color:var(--muted); word-break:break-all;">SHA-256: ${escapeHtml(latest.sha256 || '')}</div>
                    ${latest.changelog ? `<div style="margin-top:6px;">Изменения: ${escapeHtml(latest.changelog)}</div>` : ''}
                `;
            } else {
                statusBox.innerHTML = `
                    <div>На сервере ещё нет загруженного <code>.apk</code>.</div>
                    <div style="color:var(--muted); font-size:12px; margin-top:4px;">Скачайте готовый Android TV проект справа, соберите релиз через Android Studio или GitHub Actions и загрузите <code>.apk</code> сюда — телевизоры получат обновление автоматически.</div>
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
                    html += `<tr>
                        <td>
                            <b style="color:#fff;">v${escapeHtml(rel.versionName)}</b>
                            ${i === 0 ? '<span class="badge-status badge-online" style="margin-left:6px;">latest</span>' : ''}
                        </td>
                        <td><code>${rel.versionCode}</code></td>
                        <td>${fmtBytes(rel.sizeBytes)}</td>
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

    function stopPlayerStream() {
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

        overlay.classList.remove('hidden');
        text.textContent = 'Загрузка потока...';

        const proxied = '/api/stream/proxy?url=' + encodeURIComponent(url);
        const low = url.split('?')[0].toLowerCase();
        const isM3u8 = low.includes('.m3u8');
        const isTs = low.endsWith('.ts');

        const onReady = () => overlay.classList.add('hidden');
        const onErr = (msg) => {
            overlay.classList.remove('hidden');
            text.textContent = msg || 'Ошибка воспроизведения';
        };

        v.onloadeddata = onReady;
        v.oncanplay = onReady;
        v.onerror = () => onErr('Поток недоступен или формат не поддерживается');

        if (isM3u8 && window.Hls && window.Hls.isSupported()) {
            playerHls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                manifestLoadingTimeOut: 12000,
                manifestLoadingMaxRetry: 2,
                fragLoadingTimeOut: 25000
            });
            playerHls.loadSource(proxied);
            playerHls.attachMedia(v);
            playerHls.on(Hls.Events.MANIFEST_PARSED, () => v.play().catch(() => {}));
            let hlsErrorCount = 0;
            playerHls.on(Hls.Events.ERROR, (evt, data) => {
                if (!data) return;
                // Не критичные ошибки (битые сегменты, реклама) — просто пропускаем
                const ignorable = [
                    'bufferAppendError',
                    'bufferAppendingError',
                    'bufferStalledError',
                    'fragParsingError',
                    'fragLoadError',
                    'levelLoadError'
                ];
                if (ignorable.includes(data.details) && !data.fatal) {
                    hlsErrorCount++;
                    // Если больше 5 нефатальных ошибок подряд — тихо перезапускаем поток
                    if (hlsErrorCount === 6) {
                        try { playerHls.startLoad(); } catch(e) {}
                    }
                    return;
                }
                // Показываем только реально фатальные
                if (data.fatal) onErr('Ошибка HLS: ' + (data.details || 'unknown'));
            });
        } else if (isTs && window.mpegts && window.mpegts.isSupported()) {
            playerMpegts = mpegts.createPlayer({
                type: 'mpegts',
                url: proxied,
                isLive: true
            }, {
                enableWorker: true,
                liveBufferLatencyChasing: true
            });
            playerMpegts.attachMediaElement(v);
            playerMpegts.load();
            playerMpegts.play().catch(() => {});
            playerMpegts.on(mpegts.Events.ERROR, (t, d) => onErr('Ошибка TS: ' + d));
        } else {
            v.src = proxied;
            v.play().catch(() => {});
        }
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
