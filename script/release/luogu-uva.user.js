// ==UserScript==
// @name         luogu RMJ UVa
// @namespace    luogu-uva-direct
// @version      1.1.0
// @updateURL    https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-uva.user.js
// @downloadURL  https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-uva.user.js
// @description  用自己的 UVa 账号提交代码，并在洛谷评测记录页查看本题提交。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @match        https://onlinejudge.org/*
// @match        https://uva.onlinejudge.org/*
// @run-at       document-idle
// @require      https://cdn.jsdelivr.net/npm/sweetalert2@11.22.4/dist/sweetalert2.min.js#sha256=b2c309afeba037d2cbd9a1c79778d518b662a1ffc1d9ba51dd009373d2fd1bf6
// @noframes
// @grant        unsafeWindow
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_addValueChangeListener
// @grant        GM_removeValueChangeListener
// ==/UserScript==

(() => {
    'use strict';

    const prefix = 'lg-uva-v1:';
    const lifetime = 10 * 60 * 1000;
    const verificationLimit = 2 * 60 * 1000;
    const visible = el => el && el.getClientRects().length > 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const firstVisible = selector => [...document.querySelectorAll(selector)].find(visible);
    const judge = 'https://onlinejudge.org';
    const judgeOrigin = origin => origin === judge || origin === 'https://uva.onlinejudge.org';
    const pidFromPath = () => /^\/problem\/UVA([1-9]\d*)\/?$/i.exec(location.pathname)?.[1];
    const judgeUrl = (item, params = {}) => judge + '/index.php?' +
        new URLSearchParams({ option: 'com_onlinejudge', Itemid: item, ...params });
    const quickSubmitUrl = judgeUrl('25', { page: 'submit_problem' });
    const mySubmissionsUrl = judgeUrl('9');
    const judgeTabKey = prefix + 'tab';
    const jobParam = 'lg_uva';
    const getJob = id => GM_getValue(prefix + id);
    const setJob = (id, value) => GM_setValue(prefix + id, value);

    function mergedRecords(original, records, user, pid, problem) {
        const newestFirst = [...records].sort((a, b) => b.timestamp - a.timestamp || Number(b.id) - Number(a.id));
        const rows = newestFirst.map(item => ({
            id: 'UVA' + item.id, user, problem: problem || { pid, name: item.problem },
            status: item.status, submitTime: item.timestamp, time: item.runtime, memory: item.memory, language: 0
        }));
        return { ...original, result: [...rows, ...original.result] };
    }

    function launch(draft, notify, signal) {
        const id = crypto.randomUUID();
        const isQuery = draft.operation === 'records';
        const url = new URL(isQuery ? mySubmissionsUrl : quickSubmitUrl);
        url.searchParams.set(jobParam, id);
        return new Promise((resolve, reject) => {
            let tab, listener, expiry, verificationTimer;
            let finished = false;

            function finish(error, receipt) {
                if (finished) return;
                finished = true;
                clearTimeout(expiry);
                clearTimeout(verificationTimer);
                signal?.removeEventListener('abort', cancel);
                if (listener !== undefined) GM_removeValueChangeListener(listener);
                GM_deleteValue(prefix + id);
                if (tab) {
                    tab.onclose = null;
                    if (!tab.closed && !receipt?.worker) tab.close();
                }
                if (error) reject(error);
                else resolve(receipt);
            }

            function cancel() {
                if (getJob(id)?.phase === 'sent') return;
                finish(new DOMException('操作已取消。', 'AbortError'));
            }

            function interrupted(message) {
                if (getJob(id)?.phase === 'sent')
                    finish(null, { uncertain: '提交请求已发出，请在 UVa「My Submissions」核对结果。', worker: tab });
                else finish(Error(message));
            }

            try {
                if (signal?.aborted) { cancel(); return; }
                signal?.addEventListener('abort', cancel, { once: true });
                setJob(id, { ...draft, created: Date.now(), phase: 'ready' });
                listener = GM_addValueChangeListener(prefix + id, (_, old, job) => {
                    if (!job || finished) return;
                    clearTimeout(verificationTimer);
                    if (job.phase === 'error') { finish(Error(job.message)); return; }
                    if (job.phase === 'uncertain') { finish(null, { uncertain: job.message, worker: tab }); return; }
                    if (job.phase === 'done') {
                        finish(null, isQuery ? { records: job.records } : { url: job.url, message: job.message, worker: tab });
                        return;
                    }
                    if (job.message) notify(job.message, job.notice, job.phase === 'ready' ? cancel : undefined);
                    if (job.notice === 'verification') verificationTimer = setTimeout(
                        () => interrupted('人机验证等待超时，请重试。'),
                        Math.max(0, job.verificationSince + verificationLimit - Date.now())
                    );
                });
                tab = GM_openInTab(url.href, { active: false, insert: true });
                if (!tab) throw Error('无法打开 UVa 标签页。');
                tab.onclose = () => interrupted('UVa 标签页已关闭。');
                expiry = setTimeout(() => interrupted(isQuery ? '查询 UVa 记录超时。' : '等待 UVa 确认超时。'),
                    isQuery ? 5 * 60 * 1000 : lifetime);
            } catch (error) { finish(error); }
        });
    }
    function element(tag, text, className) {
        const node = document.createElement(tag);
        if (text) node.textContent = text;
        if (className) node.className = className;
        return node;
    }

    // Locate the mounted list, including its empty-result branch. Luogu mounts it after the search form.
    function recordBlock(root) {
        function find(vnode) {
            if (!vnode) return;
            const component = vnode.component;
            if (component?.type.__name === 'RecordListBlock') return component;
            if (component) return find(component.subTree);
            if (vnode.suspense) return find(vnode.suspense.activeBranch);
            if (Array.isArray(vnode.children)) {
                for (const child of vnode.children) {
                    const found = find(child);
                    if (found) return found;
                }
            }
        }
        return find(root?._vnode);
    }

    function installRecordList() {
        const pageDocument = unsafeWindow.document;
        let view, scheduled = false, suspended = false;
        function clear() {
            if (!view) return;
            view.controller?.abort();
            if (!view.block.isUnmounted && view.block.props.records === view.merged)
                view.block.props.records = view.original;
            view.card.removeEventListener('click', view.follow, true);
            view.controls.remove();
            view = null;
        }
        function decorate(current) {
            for (const link of current.card.querySelectorAll('.row a.status')) {
                const id = judgeOrigin(link.origin) ? current.linkIds.get(link)
                    : /^\/record\/UVA(\d+)$/.exec(link.pathname)?.[1];
                const item = current.items.get(id);
                if (!item) continue;
                current.linkIds.set(link, id);
                if (link.href !== item.url) link.href = item.url;
                const row = link.closest('.row');
                const line = row.querySelector('.detail > div:not(.metrics)');
                const language = line && [...line.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
                if (language && language.textContent.trim() !== item.language) language.nodeValue = ' ' + item.language;
                const memory = row.querySelector('.metrics > span:only-child')?.lastChild;
                if (memory?.nodeType === Node.TEXT_NODE && /\/\s*$/.test(memory.nodeValue))
                    memory.nodeValue = memory.nodeValue.replace(/\s*\/\s*$/, '');
                if (!item.timestamp) {
                    const time = row.querySelector('.user-info .lfe-caption');
                    if (time && time.textContent !== item.date) time.textContent = item.date;
                }
            }
        }
        function sync() {
            scheduled = false;
            if (suspended || document.readyState === 'loading') return;
            const query = new URLSearchParams(location.search);
            const pid = query.get('pid');
            if (!/^\/record\/list\/?$/.test(location.pathname) || !/^UVA[1-9]\d*$/i.test(pid || '')
                || [...query.keys()].some(key => !['pid', 'user', 'page'].includes(key))
                || (query.has('page') && query.get('page') !== '1')) { clear(); return; }
            const main = pageDocument.querySelector('main .main-content');
            const card = main?.querySelectorAll(':scope > .l-card')[1];
            if (!card?.firstElementChild) { clear(); return; }
            const block = view?.card === card && !view.block.isUnmounted && card.contains(view.block.subTree.el)
                ? view.block : recordBlock(pageDocument.querySelector('#app'));
            if (!block?.isMounted || !card.contains(block.subTree.el) || !Array.isArray(block.props.records?.result)) {
                clear(); return;
            }
            if (view?.pid === pid && view.card === card && view.block === block
                && view.search === location.search && [view.original, view.merged].includes(block.props.records)) {
                if (view.merged) {
                    if (block.props.records === view.original) block.props.records = view.merged;
                    decorate(view);
                }
                return;
            }
            clear();
            const user = JSON.parse(pageDocument.querySelector('#lentille-context')?.textContent || '{}').user;
            if (!user?.uid || (query.get('user') && query.get('user') !== String(user.uid))) return;
            const controls = element('span', '', 'lguva-record-controls lfe-caption');
            const status = element('span');
            status.setAttribute('role', 'status');
            const action = element('button', '取消', 'lguva-action');
            action.type = 'button';
            controls.append(status, action);
            (main.querySelector('.result .count') || card).append(controls);
            // Let the browser follow external detail links instead of Luogu's router.
            const follow = event => {
                const link = event.target.closest?.('a.status');
                if (link && judgeOrigin(link.origin)) event.stopPropagation();
            };
            card.addEventListener('click', follow, true);
            const current = view = {
                pid, search: location.search, card, follow, block, controls, original: block.props.records, linkIds: new WeakMap()
            };
            async function read() {
                const controller = current.controller = new AbortController();
                const { signal } = controller;
                action.textContent = '取消';
                function notice(text, kind = 'loading') {
                    if (signal.aborted) return;
                    status.className = ['loading', 'verification'].includes(kind) ? 'lguva-wait' : '';
                    status.textContent = text;
                }
                notice('正在读取 UVa 记录…');
                try {
                    const number = pid.slice(3);
                    const { records } = await launch({ operation: 'records', number }, notice, signal);
                    if (signal.aborted || location.search !== current.search || !card.isConnected) return;
                    const problem = current.original.result.find(r => r.problem?.pid === pid)?.problem;
                    current.items = new Map(records.map(item => [String(item.id), item]));
                    // Give the existing component a display copy. Its parent keeps the server response and paginator.
                    block.props.records = mergedRecords(current.original, records, user, pid, problem);
                    current.merged = block.props.records;
                    notice(records.length ? '+ ' + records.length + ' 条 UVa 记录' : '此题暂无 UVa 记录', 'done');
                    schedule();
                } catch (error) { notice(error.message, 'error'); }
                finally {
                    if (current.controller === controller) {
                        current.controller = null;
                        action.textContent = '刷新 UVa 记录';
                    }
                }
            }
            action.addEventListener('click', () => {
                if (current.controller) {
                    current.controller.abort();
                    status.className = '';
                    status.textContent = '已取消读取 UVa 记录。';
                } else void read();
            });
            void read();
        }
        function schedule() {
            if (scheduled || suspended || (!view && !/^\/record\/list\/?$/.test(location.pathname))) return;
            scheduled = true;
            requestAnimationFrame(() => setTimeout(sync, 0));
        }
        new MutationObserver(() => {
            if (view?.merged && view.card.isConnected) decorate(view);
            schedule();
        }).observe(document.body, { childList: true, subtree: true });
        window.addEventListener('popstate', schedule);
        window.addEventListener('pagehide', () => { suspended = true; clear(); });
        window.addEventListener('pageshow', () => { suspended = false; schedule(); });
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule, { once: true });
        else schedule();
    }

    function installLuogu() {
        // SweetAlert2 uses Luogu's existing stylesheet, font and theme variables.
        const style = document.createElement('style');
        style.textContent = `
            .swal2-popup.lguva-loading > .swal2-actions {
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            .lguva-record-controls { display:inline-flex; align-items:center; gap:.5em; margin-inline-start:.75em }
            .lguva-action { background:none; border:0; font:inherit; cursor:pointer; color:rgb(var(--lcolor--primary,52,152,219)) }
            .lguva-action:disabled { opacity:.55; cursor:default }
            .lguva-wait { display:flex; align-items:center; gap:.5em }
            .lguva-wait::before { content:''; width:.85em; height:.85em; border:2px solid currentColor;
                border-right-color:transparent; border-radius:50%; color:rgb(var(--lcolor--primary,52,152,219));
                animation:lguva-spin .9s linear infinite }
            @keyframes lguva-spin { to { transform:rotate(1turn) } }
            @media (prefers-reduced-motion:reduce) { .lguva-wait::before { animation:none } }
            .lguva-verification > .swal2-actions { display: contents !important; }
            .lguva-verification .swal2-loader {
                grid-column: 1 / -1;
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            .lguva-verification .swal2-cancel {
                grid-column: 1 / -1;
                grid-row: 4;
                justify-self: center;
                margin: 1.25em auto 0;
            }
            .lguva-loading .swal2-loader, .lguva-verification .swal2-loader {
                width: 4em;
                height: 4em;
                border-width: .25em;
                border-color: rgb(var(--lcolor--primary, 52, 152, 219)) transparent;
            }`;
        document.head.append(style);
        const dialogs = globalThis.Sweetalert2.mixin({
            confirmButtonText: '确定',
            confirmButtonColor: 'rgb(var(--lcolor--primary, 52, 152, 219))',
            allowOutsideClick: false
        });
        let submitting = false;
        let lastNotice;
        function report(text, kind = 'loading', onCancel) {
            lastNotice = { text, kind, onCancel };
            const title = {
                loading: '正在提交', verification: '正在提交', login: '请登录 UVa',
                uncertain: '提交状态待确认', error: '提交失败', done: '提交成功'
            }[kind];
            const waiting = kind === 'loading' || kind === 'verification';
            const popupClass = 'lguva-' + (onCancel ? 'verification' : 'loading');
            if (waiting && dialogs.getPopup()?.classList.contains(popupClass)) {
                dialogs.getHtmlContainer().textContent = text;
                return;
            }
            const options = {
                titleText: title, text, showCancelButton: !!onCancel, cancelButtonText: '取消',
                theme: document.documentElement.dataset.lcolorTheme === 'dark' ? 'dark' : 'light'
            };
            if (waiting) {
                Object.assign(options, {
                    customClass: { popup: popupClass }, showConfirmButton: false,
                    allowEscapeKey: !onCancel,
                    didOpen: popup => { if (dialogs.getPopup() === popup) dialogs.showLoading(); }
                });
            } else if (kind === 'done') {
                // fire() resolves when dismissal begins. didClose runs after the closing animation.
                return new Promise(resolve => {
                    void dialogs.fire({ ...options, icon: 'success', timer: 1000, showConfirmButton: false,
                        allowEscapeKey: false, allowEnterKey: false, didClose: resolve });
                });
            } else {
                options.icon = kind === 'error' ? 'error' : 'info';
            }
            void dialogs.fire(options).then(result => {
                if (result.dismiss === 'cancel') onCancel?.();
            });
        }

        // Luogu clears the native file input after handling change. Remember the file for this drop area.
        const files = new WeakMap();
        function rememberFile(event) {
            const area = event.target.closest?.('.drop');
            const file = event.dataTransfer?.files[0] || event.target.files?.[0];
            if (area && file) files.set(area, { file, pid: pidFromPath() });
        }
        document.addEventListener('change', rememberFile, true);
        document.addEventListener('drop', rememberFile, true);
        async function readEditor() {
            const doc = unsafeWindow.document;
            // The IDE also has input/output editors. The language picker belongs to the source pane.
            const picker = [...doc.querySelectorAll('.lang-select')].find(visible);
            let section = picker;
            while (section && !section.querySelector('.cm-content, .CodeMirror, .monaco-editor'))
                section = section.parentElement;
            const content = section?.querySelector('.cm-content');
            const view = content?.cmTile?.root?.view || content?.cmView?.view;
            const code = view?.state.doc.toString()
                ?? section?.querySelector('.CodeMirror')?.CodeMirror?.getValue();
            const select = picker?.matches('select') ? picker : picker?.querySelector('select');
            const language = select?.selectedOptions[0]?.text?.trim()
                || picker?.querySelector(':scope > .text')?.innerText.trim()
                || picker?.querySelector('input')?.value?.trim() || picker?.innerText.trim().split('\n')[0];
            const area = firstVisible('.drop');
            const picked = files.get(area);
            if (area?.querySelector('input[type=file]')) {
                if (picked?.pid !== pidFromPath() || !area.innerText.includes(picked.file.name))
                    return { language, code: '' };
                if (/\.zip$/i.test(picked.file.name)) throw Error('UVa 需要源代码，请选择单个源文件。');
                return { language, code: await picked.file.text() };
            }
            return { code, language };
        }

        async function submit(number) {
            submitting = true;
            const controller = new AbortController();
            try {
                const draft = await readEditor();
                if (!draft.code?.trim()) throw Error('请在洛谷编辑器中输入源代码，或重新选择源文件。');
                if (!draft.language || /自动|选择|auto|select|choose/i.test(draft.language))
                    throw Error('请在洛谷的语言列表中选择源代码使用的语言。');
                report('正在连接 UVa…', 'loading', () => controller.abort());
                if (number !== pidFromPath()) throw Error('题目已切换，请在当前题目重新提交。');
                const receipt = await launch({ ...draft, number, operation: 'submit' }, report, controller.signal);
                if (!receipt) return;
                if (receipt.uncertain) { report(receipt.uncertain, 'uncertain'); return; }
                await report(receipt.message, 'done');
                try {
                    const tab = GM_openInTab(receipt.url, { active: true, insert: true });
                    if (tab) receipt.worker?.close();
                } catch { /* The original worker tab already contains the submission record. */ }
            } catch (error) {
                if (error.name !== 'AbortError') report(error.message, 'error');
            }
            finally { submitting = false; }
        }

        // Capture only the final action. Vue still owns the tab switch, file picker, and IDE run button.
        document.addEventListener('click', event => {
            const pid = pidFromPath();
            if (!pid) return;
            const control = event.target.closest?.('button, a, [role="button"]');
            if (!control || control.matches(':disabled, [aria-disabled="true"]')) return;
            const label = control.textContent.trim();
            const isJudgeButton = location.hash === '#submit' && control.matches('.l-card button')
                && /^(提交评测|Submit to Judge)$/i.test(label);
            const isIdeSubmit = location.hash === '#ide' && control.matches('.ide-toolbar .actions .title')
                && /^(提交|Submit)$/i.test(label);
            if (!isJudgeButton && !isIdeSubmit) return;
            event.preventDefault();
            event.stopImmediatePropagation();
            if (!submitting) void submit(pid);
            else if (lastNotice && lastNotice.kind !== 'done' && !dialogs.isVisible())
                report(lastNotice.text, lastNotice.kind, lastNotice.onCancel);
        }, true);
        installRecordList();
    }

    function workerId(page) {
        const marker = page.searchParams.get(jobParam);
        if (marker && /^[a-f\d-]{36}$/i.test(marker) && getJob(marker))
            sessionStorage.setItem(judgeTabKey, marker);
        return sessionStorage.getItem(judgeTabKey);
    }

    function isJudgePage(url, item) {
        return judgeOrigin(url.origin) && url.pathname === '/index.php'
            && url.searchParams.get('option') === 'com_onlinejudge'
            && (url.searchParams.get('Itemid') === item || (item === '9'
                && /^(?:show_)?my_submissions$/.test(url.searchParams.get('page') || '')));
    }

    function challengePage() {
        return Boolean(document.querySelector(
            '#challenge-running, #challenge-form, #challenge-stage, #cf-challenge-running, ' +
            'script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/"]'
        ));
    }

    function statusCode(verdict) {
        const label = verdict.replace(/[.…]+\s*$/, '').trim().replace(/\s+/g, ' ').toLowerCase();
        if (/^(?:ac|accepted)$/.test(label)) return 12;
        if (/^(?:ce|compil(?:e|ation) error)$/.test(label)) return 2;
        if (/^(?:in (?:judge )?queue|queued|waiting(?: for judg(?:e|ing))?|submitted|pending)$/.test(label)) return 0;
        if (/^(?:judging|running|compiling)(?: on test(?: case)? \d+)?$/.test(label)) return 1;
        if (/^(?:wa|re|tle|mle|ole|pe|rf|unaccepted|(?:time|memory|output) limit(?: exceeded)?|wrong answer|run[\s-]*time error|presentation error|restricted function)$/.test(label)) return 14;
        return 11;
    }

    function personalRecords(page, job) {
        const columnPatterns = {
            id: /^(?:#|id|submission|run(?: id)?|sub(?:mission)?[ ._-]*(?:#|id|no\.?|number))$/i,
            problem: /^(?:problem(?: (?:id|no\.?|number|title))?|title)$/i,
            status: /^(?:verdict|result|status)$/i,
            language: /^(?:language|lang\.?)$/i,
            date: /^(?:date(?:\s*\/\s*time)?|(?:submission|submit(?:ted)?) (?:date|time)|submitted|timestamp)$/i,
            runtime: /^(?:time|run[\s-]*time|exec(?:ution)?(?: time)?|cpu(?: time)?)(?:\s*\(.+\))?$/i,
            memory: /^memory(?:\s*\(.+\))?$/i
        };
        const records = new Map((job.records || []).map(item => [item.id, item]));
        const candidates = document.querySelectorAll('table');
        let found = false;
        for (const table of candidates) {
            const header = table.tHead?.rows[0] || table.rows[0];
            if (!header || [...header.cells].some(cell => cell.querySelector('table'))) continue;
            const columns = Object.fromEntries(Object.entries(columnPatterns).map(([field, pattern]) =>
                [field, [...header.cells].findIndex(cell => pattern.test(cell.textContent.trim()))]));
            if (['id', 'problem', 'status', 'language'].some(field => columns[field] < 0)) continue;
            found = true;
            for (const row of table.rows) {
                const cell = field => row.cells[columns[field]];
                const value = field => cell(field)?.textContent.trim() || '';
                const id = value('id').replace(/^#\s*/, '');
                if (!/^[1-9]\d*$/.test(id)) continue;
                const problemLabel = value('problem');
                // UVa can put the problem number in an unlabelled column before its title.
                const preceding = row.cells[columns.problem - 1];
                const numberedLink = preceding?.querySelector('a[href]');
                const titleLink = cell('problem')?.querySelector('a[href]');
                const separateNumber = numberedLink && numberedLink.href === titleLink?.href
                    ? numberedLink.textContent.trim() : '';
                const combinedNumber = /^(?:UVa\s*)?(\d+)\b/i.exec(problemLabel)?.[1];
                const problemNumber = /^\d+$/.test(separateNumber) ? separateNumber : combinedNumber;
                if (!problemNumber) throw Error('无法识别 UVa 记录中的题号。');
                if (problemNumber !== job.number) continue;
                const time = row.querySelector('time')?.getAttribute('datetime') || value('date');
                // The legacy submission table prints UTC without an offset.
                const normalizedTime = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)
                    ? time.replace(' ', 'T') + 'Z' : time;
                const timestamp = Date.parse(normalizedTime) / 1000;
                const detail = [...row.querySelectorAll('a[href]')].map(a => new URL(a.href))
                    .find(url => judgeOrigin(url.origin) && url.searchParams.get('option') === 'com_onlinejudge'
                        && String(url.searchParams.get('submission') || url.searchParams.get('sid')) === id);
                const runtime = value('runtime');
                const memory = /^([\d.]+)\s*(B|KB|KiB|MB|MiB)?$/i.exec(value('memory'));
                records.set(id, {
                    id, problem: (problemNumber === separateNumber ? problemLabel
                        : problemLabel.replace(/^(?:UVa\s*)?\d+\s*(?:[-–:]\s*)?/i, '')) || 'UVa ' + job.number,
                    status: statusCode(value('status')), language: value('language'),
                    timestamp: Number.isFinite(timestamp) ? timestamp : 0, date: time,
                    runtime: runtime ? parseFloat(runtime) * (/\bms\b/i.test(runtime) || /ms/i.test(header.cells[columns.runtime]?.textContent) ? 1 : 1000) : undefined,
                    memory: memory ? Number(memory[1]) * (/^m/i.test(memory[2]) ? 1024 : /^b$/i.test(memory[2]) ? 1 / 1024 : 1) : undefined,
                    url: detail?.href || mySubmissionsUrl
                });
            }
            break;
        }
        if (!found && !/(?:no|don't have any|have not made any) (?:submissions?|records?)/i.test(document.body.innerText))
            throw Error('未识别到 UVa 的「My Submissions」列表。');
        const offset = url => Number(url.searchParams.get('limitstart') || url.searchParams.get('start') || 0);
        const current = offset(page);
        const next = [...document.querySelectorAll('a[href]')].map(a => new URL(a.href))
            .filter(url => isJudgePage(url, '9') && offset(url) > current)
            .sort((a, b) => offset(a) - offset(b))[0];
        return { records: [...records.values()], next };
    }

    const languageNames = { 1: 'ANSI C', 2: 'Java', 3: 'C++', 4: 'Pascal', 5: 'C++11', 6: 'Python 3' };

    function languageType(label) {
        if (/^(?:c\s*\+\+|g\+\+|gnu\+\+)/i.test(label)) return 'cpp';
        if (/^(?:ansi\s+c|gnu\s+c|c)(?:$|\d|\s|\()/i.test(label)) return 'c';
        if (/^java(?:$|\d|\s|\()/i.test(label)) return 'java';
        if (/^(?:free\s+)?pascal\b/i.test(label)) return 'pascal';
        if (/^(?:pyth(?:on)?|pypy|cpython)/i.test(label)) {
            const major = /^(?:pyth(?:on)?|pypy|cpython)\s*([23])/i.exec(label)?.[1];
            return major === '2' ? 'python2' : 'python3';
        }
    }

    function chooseCompiler(form, language) {
        const choices = [...form.querySelectorAll('select[name="language"] option, input[name="language"][type="radio"]')]
            .filter(node => /^[1-9]\d*$/.test(node.value) && !node.matches(':disabled'))
            .map(node => ({ node, label: node.textContent.trim() || node.labels?.[0]?.textContent.trim()
                || languageNames[node.value] || '' }));
        const type = languageType(language);
        const compatible = choices.filter(choice => type && languageType(choice.label) === type);
        const exact = compatible.find(choice => choice.label.toLowerCase() === language.toLowerCase());
        if (exact) return exact.node;
        if (type === 'cpp') {
            const standard = label => {
                const n = Number(/(?:c|gnu)\+\+\s*(\d{2})\b/i.exec(label)?.[1] || 98);
                return n >= 90 ? 1900 + n : 2000 + n;
            };
            const requested = standard(language);
            compatible.sort((a, b) => Math.abs(standard(a.label) - requested) - Math.abs(standard(b.label) - requested));
        }
        return compatible[0]?.node;
    }

    async function runWorker(id, page) {
        let job = getJob(id);
        if (!job || Date.now() - job.created > lifetime || ['done', 'error', 'uncertain'].includes(job.phase)) {
            sessionStorage.removeItem(judgeTabKey);
            return;
        }
        function update(values) {
            const latest = getJob(id);
            if (latest) setJob(id, { ...latest, ...values });
        }
        function finish(phase, message, values) {
            sessionStorage.removeItem(judgeTabKey);
            update({ ...values, code: '', phase, message });
        }
        function notice(message, kind) {
            if (job.notice !== kind || job.message !== message)
                update({ notice: kind, message, verificationSince: kind === 'verification' ? Date.now() : null });
        }
        const reading = job.operation === 'records';
        const startUrl = reading ? mySubmissionsUrl : quickSubmitUrl;
        try {
            while ((job = getJob(id))) {
                if (challengePage()) {
                    notice('等待人机验证…', 'verification');
                    await delay(600);
                    continue;
                }
                const receipt = (page.searchParams.get('mosmsg') || '') + '\n' + document.body.innerText;
                if (job.phase === 'sent') {
                    const accepted = /submission\s+received\s+with\s+id\s*[:#]?\s*(\d+)/i.exec(receipt);
                    if (accepted) finish('done', 'UVa 已收到提交。', { url: mySubmissionsUrl });
                    else finish('uncertain', 'UVa 未确认收到提交，请先到「My Submissions」核对记录。');
                    return;
                }
                if (document.querySelector('#mod_loginform input[type="password"], #mod_login_password')
                    || /you need to log[ -]?in|not authori[sz]ed to view this resource/i.test(receipt)) {
                    notice('请在后台 UVa 标签页登录，登录后将自动继续。', 'login');
                    return;
                }
                if (!isJudgePage(page, reading ? '9' : '25')) {
                    if (job.notice === 'login') { location.replace(startUrl); return; }
                    throw Error('UVa 跳转到了其他页面，请检查登录状态。');
                }
                if (reading) {
                    const { records, next } = personalRecords(page, job);
                    if (!next) finish('done', '', { records });
                    else if (getJob(id)) {
                        update({ records, notice: 'loading', message: '正在读取更多 UVa 记录…', verificationSince: null });
                        location.replace(next.href);
                    }
                    return;
                }

                const source = firstVisible('form textarea[name="code"], form textarea[name="sourceCode"]');
                const form = source?.form;
                const number = form?.querySelector('input[name="localid"], input[name="problemnumber"]');
                if (!form || !number || number.type === 'hidden' || number.readOnly || number.disabled)
                    throw Error('未找到可用的 UVa Quick Submit 表单。');
                const destination = new URL(form.action);
                const existing = new FormData(form);
                const field = name => destination.searchParams.get(name) || existing.get(name);
                if (destination.origin !== location.origin || destination.pathname !== '/index.php'
                    || form.method.toLowerCase() !== 'post' || field('option') !== 'com_onlinejudge'
                    || field('page') !== 'save_submission')
                    throw Error('UVa 提交表单的地址已变更。');
                const compiler = chooseCompiler(form, job.language);
                if (!compiler) throw Error('UVa 没有兼容「' + job.language + '」的语言，请在洛谷更改语言后重试。');
                const send = () => {
                    const current = getJob(id);
                    if (current?.phase !== 'ready') return;
                    number.value = current.number;
                    source.value = current.code.replace(/\r\n?/g, '\n');
                    if (compiler instanceof HTMLOptionElement) compiler.selected = true;
                    else compiler.checked = true;
                    const payload = new FormData(form);
                    if (payload.get(number.name) !== current.number || payload.get('language') !== compiler.value
                        || payload.get(source.name) !== source.value || !form.reportValidity())
                        throw Error('UVa 表单校验失败。');
                    // Record the attempt first so reloads and login redirects cannot send it twice.
                    update({ code: '', phase: 'sent', notice: 'loading', message: '正在等待 UVa 确认…' });
                    const button = [...form.querySelectorAll('input[type="submit"], button[type="submit"], button:not([type])')]
                        .find(control => visible(control) && !control.disabled);
                    form.requestSubmit(button);
                };
                if (navigator.locks) await navigator.locks.request(prefix + id, send);
                else send();
                return;
            }
        } catch (error) {
            if (getJob(id)?.phase === 'sent') finish('uncertain', '提交状态待确认，请在 UVa 核对提交记录。');
            else finish('error', error.message);
        }
    }

    for (const key of GM_listValues().filter(key => key.startsWith(prefix))) {
        const job = GM_getValue(key);
        if (!job || Date.now() - job.created > lifetime) GM_deleteValue(key);
    }
    if (judgeOrigin(location.origin)) {
        const page = new URL(location.href);
        const id = workerId(page);
        if (id) void runWorker(id, page);
    } else if (location.hostname === 'www.luogu.com.cn' || location.hostname === 'www.luogu.com') {
        installLuogu();
    }
})();
