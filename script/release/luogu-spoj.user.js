// ==UserScript==
// @name         luogu RMJ SPOJ
// @namespace    luogu-spoj-direct
// @version      1.0.4
// @updateURL    https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-spoj.user.js
// @downloadURL  https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-spoj.user.js
// @description  用自己的 SPOJ 账号提交代码，并在洛谷评测记录页查看本题提交。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @match        https://www.spoj.com/*
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

    const prefix = 'lg-sp-v1:';
    const lifetime = 2 * 60 * 60 * 1000;
    const verificationLimit = 2 * 60 * 1000;
    const cancelKey = id => prefix + id + ':cancel';
    const visible = el => el && el.getClientRects().length > 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const firstVisible = selector => [...document.querySelectorAll(selector)].find(visible);
    const familyPatterns = [
        ['cpp', /^(?:c\s*\+\+|g\+\+|gnu\+\+)/i], ['cs', /^(?:c#|csharp)/i],
        ['c', /^c(?:\d|\b)/i], ['python', /^(?:python|pypy|cpython)/i],
        ['js', /^(?:javascript|node\.?js)/i], ['java', /^java(?:\d|\b)/i],
        ['basic', /^(?:visual basic|vb\.net)/i], ['fs', /^f#/i],
        ['shell', /^(?:shell|bash)\b/i], ['kotlin', /^kotlin/i],
        ['pascal', /^(?:pascal|free pascal)/i]
    ];
    const norm = s => s.toLowerCase().replace(/\s+/g, '');
    function family(label) {
        const text = label.trim();
        return familyPatterns.find(([, pattern]) => pattern.test(text))?.[0]
            || text.match(/^[\p{L}]+/u)?.[0].toLowerCase();
    }

    function languageVersion(label, group) {
        const patterns = {
            cpp: /(?:c|gnu)\+\+\s*(\d+)/i, c: /^c\s*(\d+)/i,
            java: /java\s*(\d+)/i, python: /(?:python|pypy)\s*(\d+)/i
        };
        const digits = patterns[group]?.exec(label)?.[1];
        if (!digits) return null;
        const version = Number(digits);
        return ['cpp', 'c'].includes(group) ? (version >= 90 ? 1900 : 2000) + version : version;
    }

    function chooseLanguage(source, options) {
        const usable = [...options].filter(o => o.value && !o.disabled);
        const exact = usable.find(o => norm(o.text) === norm(source));
        if (exact) return exact;
        const group = family(source);
        const wanted = languageVersion(source, group);
        const candidates = usable.filter(o => group && family(o.text) === group);
        function score(label) {
            const version = languageVersion(label, group);
            let result = 0;
            if (wanted !== null && version !== null) {
                result += 60 - Math.abs(version - wanted) - (version < wanted ? 18 : 0);
            }
            if (group === 'python') {
                // Python 2 and 3 have incompatible syntax. PyPy and CPython share the language.
                if (wanted && version && wanted !== version) return -Infinity;
                if (/pypy/i.test(source) === /pypy/i.test(label)) result += 25;
                if (/cython|codon/i.test(label)) result -= 15;
            }
            if (['c', 'cpp'].includes(group)) {
                const compiler = /clang/i.test(source) ? /clang/i : /gcc|g\+\+/i;
                if (compiler.test(label)) result += 8;
                if (/ioi/i.test(label)) result -= 2;
            }
            if (group === 'js' && /node/i.test(label)) result += 10;
            if (group === 'kotlin' && /native/i.test(source) === /native/i.test(label)) result += 10;
            if (group === 'go' && /gccgo/i.test(label)) result -= 5;
            if (group === 'cs' && /native aot/i.test(label)) result -= 3;
            return result;
        }
        let best, bestScore = -Infinity;
        for (const option of candidates) {
            const rank = score(option.text);
            if (rank > bestScore) { best = option; bestScore = rank; }
        }
        return best;
    }

    const pidFromPath = () => /^\/problem\/(SP\d+)\/?$/i.exec(location.pathname)?.[1];
    function originalTask(doc, pid, withProblem) {
        const raw = doc.querySelector('#lentille-context')?.textContent;
        const problem = raw && JSON.parse(raw)?.data?.problem;
        if (!problem || problem.pid.toLowerCase() !== pid.toLowerCase()) return;
        const task = /^([A-Z0-9_]+)\s*[-–—]\s*/.exec(problem.name)?.[1];
        if (task) return withProblem ? { task, problem: { pid, name: problem.name, difficulty: problem.difficulty } } : { task };
    }
    async function resolveTask(pid, withProblem = false, signal) {
        let target = originalTask(document, pid, withProblem);
        if (!target) {
            const response = await fetch('/problem/' + encodeURIComponent(pid), { signal });
            if (response.ok) {
                const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
                target = originalTask(doc, pid, withProblem);
            }
        }
        if (target) return target;
        throw Error('无法从洛谷题目名称识别 SPOJ 题号。');
    }
    function prune() {
        for (const key of GM_listValues().filter(k => k.startsWith(prefix))) {
            const data = GM_getValue(key);
            if (!data || Date.now() - data.created > lifetime) GM_deleteValue(key);
        }
    }
    const setJob = (id, data) => GM_setValue(prefix + id, data);
    const getJob = id => GM_getValue(prefix + id);
    const problemPath = job => '/problems/' + job.task + '/';
    const submitPath = job => '/submit/' + job.task + '/';
    const statusPath = job => '/status/' + job.task + ',' + job.handle + '/';
    // SPOJ rewrites query parameters as path segments. A fragment stays in the browser.
    const workerUrl = (job, id) => 'https://www.spoj.com' + problemPath(job) + '#lg_spoj=' + encodeURIComponent(id);

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

    // Luogu RMJ groups failed test cases under Unaccepted.
    const nativeStatus = {
        AC: 12, WA: 14, RE: 14, TLE: 14, MLE: 14, OLE: 14, QLE: 14,
        CE: 2, IE: 11, WJ: 0, WR: 0, Judging: 1
    };

    function mergedRecords(original, records, user, pid, problem) {
        // SPOJ assigns increasing submission IDs, including when two submissions share a timestamp.
        const newestFirst = [...records].sort((a, b) => Number(b.id) - Number(a.id));
        const rows = newestFirst.map(item => {
            const timestamp = Date.parse(item.time) / 1000;
            const memory = /^([\d.]+)\s*(KB|KiB|MB|MiB|B)?$/i.exec(item.memory);
            return {
                id: 'SP' + item.id, user, problem: problem || { pid, name: item.problem },
                status: nativeStatus[item.code] ?? 11, submitTime: Number.isFinite(timestamp) ? timestamp : 0,
                time: parseFloat(item.runtime), memory: memory ? Number(memory[1]) *
                    (/^m/i.test(memory[2]) ? 1024 : /^b$/i.test(memory[2]) ? 1 / 1024 : 1) : undefined,
                // Reserve the native language icon and caption. Its text is filled with SPOJ's compiler label.
                language: 0
            };
        });
        return { ...original, result: [...rows, ...original.result] };
    }

    function installRecordList(launch) {
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
                const id = link.hostname === 'www.spoj.com' ? link.pathname.split('/').filter(Boolean).pop()
                    : /^\/record\/SP(\d+)$/.exec(link.pathname)?.[1];
                const item = current.items.get(id);
                if (!item) continue;
                if (link.hostname !== 'www.spoj.com')
                    link.href = 'https://www.spoj.com' + (item.detailPath || '/files/src/' + id + '/');
                const row = link.closest('.row');
                const line = row.querySelector('.detail > div:not(.metrics)');
                const language = line && [...line.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
                if (language && language.textContent.trim() !== item.language) language.nodeValue = ' ' + item.language;
                const memory = row.querySelector('.metrics > span:only-child')?.lastChild;
                if (memory?.nodeType === Node.TEXT_NODE && /\/\s*$/.test(memory.nodeValue))
                    memory.nodeValue = memory.nodeValue.replace(/\s*\/\s*$/, '');
                // A missing timestamp is preferable to a fabricated Unix-epoch date.
                if (!Number.isFinite(Date.parse(item.time) / 1000)) {
                    const time = row.querySelector('.user-info .lfe-caption');
                    if (time && time.textContent !== item.time) time.textContent = item.time;
                }
            }
        }
        function sync() {
            scheduled = false;
            if (suspended || document.readyState === 'loading') return;
            const query = new URLSearchParams(location.search);
            const pid = query.get('pid');
            if (!/^\/record\/list\/?$/.test(location.pathname) || !/^SP\d+$/i.test(pid || '')
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
            const controls = element('span', '', 'lgsp-record-controls lfe-caption');
            const status = element('span');
            status.setAttribute('role', 'status');
            const action = element('button', '取消', 'lgsp-action');
            action.type = 'button';
            controls.append(status, action);
            (main.querySelector('.result .count') || card).append(controls);
            // Let the browser follow external detail links instead of Luogu's router.
            const follow = event => {
                const link = event.target.closest?.('a.status');
                if (link?.origin === 'https://www.spoj.com') event.stopPropagation();
            };
            card.addEventListener('click', follow, true);
            const current = view = { pid, search: location.search, card, follow, block, controls, original: block.props.records };
            async function read() {
                const controller = current.controller = new AbortController();
                const { signal } = controller;
                action.textContent = '取消';
                function notice(text, kind = 'loading') {
                    if (signal.aborted) return;
                    status.className = ['loading', 'verification'].includes(kind) ? 'lgsp-wait' : '';
                    status.textContent = text;
                }
                notice('正在读取 SPOJ 记录…');
                try {
                    const target = await resolveTask(pid, true, signal);
                    if (signal.aborted) return;
                    const { records } = await launch(target, { operation: 'records' }, notice, signal);
                    if (signal.aborted || location.search !== current.search || !card.isConnected) return;
                    const problem = current.original.result.find(r => r.problem?.pid === pid)?.problem || target.problem;

                    current.items = new Map(records.map(item => [item.id, item]));
                    // Give the existing component a display copy. Its parent keeps the server response and paginator.
                    block.props.records = mergedRecords(current.original, records, user, pid, problem);
                    current.merged = block.props.records;
                    notice(records.length ? '+ ' + records.length + ' 条 SPOJ 记录' : '此题暂无 SPOJ 记录', 'done');
                    schedule();
                } catch (error) { notice(error.message, 'error'); }
                finally {
                    if (current.controller === controller) {
                        current.controller = null;
                        action.textContent = '刷新 SPOJ 记录';
                    }
                }
            }
            action.addEventListener('click', () => {
                if (current.controller) {
                    current.controller.abort();
                    status.className = '';
                    status.textContent = '已取消读取 SPOJ 记录。';
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
            .lgsp-record-controls { display:inline-flex; align-items:center; gap:.5em; margin-inline-start:.75em }
            .lgsp-action { background:none; border:0; font:inherit; cursor:pointer; color:rgb(var(--lcolor--primary,52,152,219)) }
            .lgsp-action:disabled { opacity:.55; cursor:default }
            .lgsp-wait { display:flex; align-items:center; gap:.5em }
            .lgsp-wait::before { content:''; width:.85em; height:.85em; border:2px solid currentColor;
                border-right-color:transparent; border-radius:50%; color:rgb(var(--lcolor--primary,52,152,219));
                animation:lgsp-spin .9s linear infinite }
            @keyframes lgsp-spin { to { transform:rotate(1turn) } }
            @media (prefers-reduced-motion:reduce) { .lgsp-wait::before { animation:none } }
            :is(.lgsp-loading,.lgsp-verification) > .swal2-actions { display: contents !important; }
            :is(.lgsp-loading,.lgsp-verification) .swal2-loader {
                grid-column: 1 / -1;
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            :is(.lgsp-loading,.lgsp-verification) .swal2-cancel {
                grid-column: 1 / -1;
                grid-row: 4;
                justify-self: center;
                margin: 1.25em auto 0;
            }
            .lgsp-loading .swal2-loader, .lgsp-verification .swal2-loader {
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
                loading: '正在提交', verification: '正在提交', login: '请登录 SPOJ',
                uncertain: '提交状态待确认', error: '提交失败', done: '提交成功'
            }[kind];
            const waiting = kind === 'loading' || kind === 'verification';
            if (waiting && dialogs.getPopup()?.classList.contains('lgsp-' + kind)) {
                dialogs.getHtmlContainer().textContent = text;
                return;
            }
            const options = {
                titleText: title, text, showCancelButton: !!onCancel, cancelButtonText: '取消',
                theme: document.documentElement.dataset.lcolorTheme === 'dark' ? 'dark' : 'light'
            };
            if (waiting) {
                Object.assign(options, {
                    customClass: { popup: 'lgsp-' + kind }, showConfirmButton: false,
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
                if (/\.zip$/i.test(picked.file.name)) throw Error('SPOJ 需要源代码，请选择单个源文件。');
                return { language, code: await picked.file.text() };
            }
            return { code, language };
        }

        function launch(target, draft, notify = report, signal) {
            const reading = draft.operation === 'records';
            const id = crypto.randomUUID();
            const job = { ...target, ...draft, created: Date.now(), phase: 'ready' };
            return new Promise((resolve, reject) => {
                let tab, listener, hint, startup, expiry, verificationTimer, stopping;
                let finished = false;
                function finish(error, receipt) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(hint);
                    clearTimeout(startup);
                    clearTimeout(expiry);
                    clearTimeout(verificationTimer);
                    if (listener !== undefined) GM_removeValueChangeListener(listener);
                    if (tab) tab.onclose = null;
                    GM_deleteValue(prefix + id);
                    // A closing worker may still deliver a queued write. prune() expires its cancellation marker.
                    if (!stopping) GM_deleteValue(cancelKey(id));
                    signal?.removeEventListener('abort', abort);
                    if (reading && tab && !tab.closed) tab.close();
                    if (error) reject(error);
                    else resolve(receipt);
                }
                function abort() {
                    if (reading) finish(new DOMException('已取消查询。', 'AbortError'));
                    else if (!tab) finish(null, null);
                    else stopWaiting('cancel');
                }
                function stopWaiting(reason) {
                    if (finished || stopping) return;
                    if (reading) { finish(Error('人机验证等待超时，请刷新记录。')); return; }
                    stopping = reason;
                    // A separate key survives a simultaneous status update from the worker.
                    GM_setValue(cancelKey(id), { created: Date.now() });
                    try { tab.close(); } finally { stopped(); }
                }
                function stopped() {
                    const current = getJob(id);
                    if (current?.posted || current?.phase === 'sent')
                        finish(null, { uncertain: '已停止等待。提交请求已发出，请先查看 SPOJ 的「我的提交」。' });
                    else if (stopping === 'timeout') finish(Error('人机验证等待超时，请重新提交。'));
                    else if (stopping === 'startup') finish(Error('SPOJ 后台页面未响应。请检查网站连接和 Tampermonkey 在 SPOJ 上的运行权限。'));
                    else finish(null, null);
                }
                try {
                    if (signal?.aborted) { abort(); return; }
                    signal?.addEventListener('abort', abort, { once: true });
                    setJob(id, job);
                    listener = GM_addValueChangeListener(prefix + id, (_, old, data) => {
                        if (finished || stopping) return;
                        if (data?.started) clearTimeout(startup);
                        clearTimeout(verificationTimer);
                        if (!data) { finish(Error('本次提交已过期，请在 SPOJ 核对提交记录。')); return; }
                        if (data.phase === 'uncertain') { finish(null, { uncertain: data.message }); return; }
                        if (data.phase === 'error') { finish(Error(data.message)); return; }
                        if (data.phase === 'done') {
                            finish(null, reading ? { records: data.records } : { url: data.result, message: data.message, worker: tab });
                        } else if (data.notice === 'verification') {
                            notify(data.message, 'verification', () => stopWaiting('cancel'));
                            verificationTimer = setTimeout(() => stopWaiting('timeout'),
                                Math.max(0, data.verificationSince + verificationLimit - Date.now()));
                        } else if (data.message) {
                            notify(data.message, data.notice || 'loading');
                        }
                    });
                    tab = GM_openInTab(workerUrl(job, id), { active: false, insert: true });
                    if (!tab) throw Error('无法打开 SPOJ 标签页。');
                    tab.onclose = () => {
                        const current = getJob(id);
                        if (stopping) stopped();
                        else if (current && !['done', 'error'].includes(current.phase)) {
                            finish(Error(current.phase === 'sent' ? '标签页已关闭，请在 SPOJ 核对提交记录。' : 'SPOJ 提交标签页已关闭。'));
                        }
                    };
                    hint = setTimeout(() => {
                        if (!getJob(id)?.message) notify('正在等待 SPOJ 响应…');
                    }, 7000);
                    startup = setTimeout(() => {
                        if (getJob(id)?.started) return;
                        if (reading) finish(Error('SPOJ 后台页面未响应，请检查网站连接和脚本运行权限。'));
                        else stopWaiting('startup');
                    }, 45000);
                    expiry = setTimeout(() => finish(Error(reading ? '查询超时，请刷新记录。' : '本次提交等待已过期，请在 SPOJ 核对提交记录。')), reading ? 5 * 60 * 1000 : lifetime);
                } catch (error) { finish(error); }
            });
        }

        async function submit(pid) {
            submitting = true;
            const controller = new AbortController();
            const cancel = () => controller.abort();
            const notify = (message, kind) => report(message, kind, cancel);
            try {
                const draft = await readEditor();
                if (!draft.code?.trim()) throw Error('请在洛谷编辑器中输入源代码，或重新选择源文件。');
                if (!draft.language || /自动|选择|auto|select|choose/i.test(draft.language))
                    throw Error('请在洛谷的语言列表中选择源代码使用的语言。');
                notify('正在连接 SPOJ…');
                const target = await resolveTask(pid, false, controller.signal);
                if (controller.signal.aborted) return;
                if (pid !== pidFromPath()) throw Error('题目已切换，请在当前题目重新提交。');
                const receipt = await launch(target, draft, notify, controller.signal);
                if (!receipt) return;
                if (receipt.uncertain) { report(receipt.uncertain, 'uncertain'); return; }
                await report(receipt.message, 'done');
                try {
                    const tab = GM_openInTab(receipt.url, { active: true, insert: true });
                    if (tab) receipt.worker?.close();
                } catch { /* The original worker tab already contains the submission record. */ }
            } catch (error) { if (!controller.signal.aborted) report(error.message, 'error'); }
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
        installRecordList(launch);
    }

    function workerId() {
        const url = new URL(location.href);
        let id = new URLSearchParams(url.hash.slice(1)).get('lg_spoj') || url.searchParams.get('lg_spoj')
            || /\/lg_spoj=([a-f\d-]{36})\/?$/i.exec(url.pathname)?.[1];
        if (!id && url.pathname === '/login') {
            const next = new URL(url.searchParams.get('continue') || '/', url.origin);
            if (next.origin === url.origin) id = next.searchParams.get('lg_spoj');
        }
        const key = prefix + 'tab';
        if (id && /^[a-f\d-]{36}$/i.test(id) && getJob(id)) sessionStorage.setItem(key, id);
        return sessionStorage.getItem(key);
    }
    function challengePage() {
        return Boolean(document.querySelector('#challenge-running, #challenge-form, #challenge-stage, #cf-challenge-running, script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/"]'))
            || /^(?:请稍候|請稍候|请稍等|請稍等|just a moment|checking your browser|正在验证|正在驗證|しばらくお待ち)/i.test(document.title.trim());
    }
    function widgetPending(form) {
        const names = ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response'];
        for (const name of names) {
            const field = form.elements.namedItem(name);
            if (field) return !field.value?.trim() || field.matches?.(':disabled');
        }
        // The widget can exist before its response field is mounted.
        return !!form.querySelector('.cf-challenge,.cf-turnstile,.g-recaptcha,.h-captcha,iframe[src*="challenges.cloudflare.com"]');
    }

    function account(task) {
        const personal = [...document.querySelectorAll('a[href*="/status/"]')].find(a =>
            a.origin === location.origin && a.pathname.startsWith('/status/' + task + ',')
            && !a.closest('.comments, #comments, #problem-body') && /my submissions|my status/i.test(a.textContent + ' ' + a.title));
        const name = personal?.pathname.split(',')[1]?.split('/')[0];
        if (name && /^\w+$/.test(name)) return name;
        const profile = document.querySelector('nav a[href^="/users/"], .navbar a[href^="/users/"], #menu a[href^="/users/"], #menu a[href^="/status/"][title*="submission" i]');
        return /^\/(?:users|status)\/(\w+)\/?$/.exec(profile?.pathname)?.[1];
    }

    function verdictCode(cell) {
        const text = [cell.textContent, cell.title, cell.querySelector('[title]')?.title].join(' ');
        if (/compil(?:ation|e) error|\bCE\b/i.test(text)) return 'CE';
        if (/wrong answer|runtime error|time limit|memory limit|output limit|presentation error|signal|\b(?:WA|RE|TLE|MLE|OLE)\b/i.test(text)) return 'WA';
        if (/\baccepted\b|\bAC\b/i.test(text) || cell.getAttribute('status') === '15') return 'AC';
        if (/waiting|queued|pending/i.test(text)) return 'WJ';
        if (/running|judging|compiling/i.test(text)) return 'Judging';
        return 'IE';
    }

    function statusPage(job) {
        const base = statusPath(job);
        if (location.pathname !== base && !location.pathname.startsWith(base + 'start='))
            throw Error('SPOJ 未打开当前账号在本题的提交列表。');
        const table = [...document.querySelectorAll('table')].find(t =>
            [...t.rows].some(r => [...r.cells].some(c => /^result$/i.test(c.textContent.trim()))));
        if (!table) {
            if (/no (?:submissions|solutions|results)(?: found)?/i.test(document.body.innerText)) return { rows: [] };
            throw Error('无法识别 SPOJ 提交记录表。');
        }
        const headers = [...table.rows].find(r => [...r.cells].some(c => /^result$/i.test(c.textContent.trim())));
        if (!headers) throw Error('无法识别 SPOJ 记录表头。');
        const columns = [...headers.cells].map(c => c.textContent.trim().toLowerCase());
        const cell = (row, pattern) => row.cells[columns.findIndex(c => pattern.test(c))];
        const rows = [];
        for (const row of table.rows) {
            const links = [...row.querySelectorAll('a[href]')];
            // SPOJ's submission ID opens a modal. Its source address lives in data-url.
            const sourceLink = row.querySelector('a.sourcelink[data-url]');
            const modalPath = sourceLink?.getAttribute('data-url');
            const detail = links.find(a => a.origin === location.origin && /^\/files\/src\/\d+\/?$/.test(a.pathname));
            const sid = detail?.pathname.match(/\d+/)?.[0] || cell(row, /^(?:id|#)$/)?.textContent.trim() || row.id.replace(/^status_?/, '');
            if (!/^\d+$/.test(sid)) {
                if (row.querySelector('.statusres')) throw Error('无法识别 SPOJ 提交编号。');
                continue;
            }
            if (links.some(a => a.pathname.startsWith('/problems/') && a.pathname !== problemPath(job))) continue;
            if (links.some(a => a.pathname.startsWith('/users/') && a.pathname !== '/users/' + job.handle + '/')) continue;
            const result = row.querySelector('.statusres') || cell(row, /^result$/);
            if (!result) throw Error('无法读取 SPOJ 评测结果。');
            const date = cell(row, /^date$/);
            const runtime = parseFloat(cell(row, /^time$/)?.textContent);
            const detailPath = modalPath?.replace(/\/$/, '') === '/files/src/' + sid ? modalPath : detail?.pathname;
            rows.push({ id: sid, detailPath, code: verdictCode(result), problem: job.task,
                time: date?.querySelector('time')?.dateTime || date?.textContent.trim() || '',
                language: cell(row, /^(?:lang(?:uage)?|lng)$/)?.textContent.trim() || '',
                runtime: Number.isFinite(runtime) ? String(runtime * 1000) : '',
                memory: cell(row, /^mem(?:ory)?$/)?.textContent.trim().replace(/(\d)\s*([kmg])$/i, '$1 $2B') || '' });
        }
        const offset = url => Number(/(?:[?&/])start=(\d+)/.exec(url.href)?.[1] || 0);
        const next = [...document.links].filter(a => a.origin === location.origin &&
            (a.pathname === base || a.pathname.startsWith(base + 'start=')) && offset(a) > offset(location))
            .sort((a, b) => offset(a) - offset(b))[0];
        return { rows, next: next?.href };
    }

    function fillForm(form, job) {
        const source = form.elements.namedItem('file');
        const language = form.elements.namedItem('lang');
        const task = form.elements.namedItem('problemcode');
        const button = form.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
        const url = new URL(form.action);
        if (task?.value !== job.task || !(source instanceof HTMLTextAreaElement) || !language?.options ||
            !button || form.method !== 'post' || url.origin !== location.origin || !/^\/submit\/complete\/?$/.test(url.pathname))
            throw Error('SPOJ 提交表单与当前题目不匹配。');
        const option = chooseLanguage(job.language, language.options);
        if (!option) throw Error('SPOJ 没有兼容的编程语言，请在洛谷更改语言。');
        language.value = option.value;
        language.dispatchEvent(new Event('change', { bubbles: true }));
        const code = job.code.replace(/\r\n?/g, '\n');
        const cm = form.querySelector('.CodeMirror')?.CodeMirror;
        cm?.setValue(code);
        cm?.save();
        const ace = form.querySelector('.ace_editor');
        if (ace) {
            if (!ace.env?.editor) throw Error('SPOJ 代码编辑器尚未就绪。');
            ace.env.editor.setValue(code, -1);
        }
        source.value = code;
        source.dispatchEvent(new Event('input', { bubbles: true }));
        const data = new FormData(form);
        if (data.get('file') !== code || data.get('lang') !== option.value || data.get('problemcode') !== job.task ||
            button.disabled || !form.reportValidity()) throw Error('SPOJ 表单校验失败。');
        return button;
    }

    async function runWorker(id) {
        const key = prefix + 'tab';
        function finish(job, phase, message, extra = {}) {
            sessionStorage.removeItem(key);
            if (getJob(id) && !GM_getValue(cancelKey(id)))
                setJob(id, { ...job, code: '', phase, message, ...extra });
        }
        function notice(job, message, kind) {
            if (job.message !== message || job.notice !== kind)
                setJob(id, { ...job, message, notice: kind, verificationSince: kind === 'verification' ? Date.now() : null });
        }
        let job, unknownSince;
        try {
            while ((job = getJob(id)) && !GM_getValue(cancelKey(id))) {
                if (Date.now() - job.created > lifetime || ['error','uncertain','done'].includes(job.phase)) return;
                if (!job.started) {
                    job = { ...job, started: true, message: '正在检查 SPOJ 登录状态…', notice: 'loading' };
                    setJob(id, job);
                }
                const form = document.querySelector('form[action*="/submit/complete"]');
                const password = firstVisible('input[type="password"]');
                if (challengePage() || (form && widgetPending(form)) || (password?.form && widgetPending(password.form))) {
                    unknownSince = undefined;
                    notice(job, '等待人机验证…', 'verification');
                    await delay(800);
                    continue;
                }
                const path = location.pathname;
                const reading = job.operation === 'records';
                const receipt = document.querySelector('#newSubmissionId, [name="newSubmissionId"]')?.value;
                if (job.phase === 'sent' && /^\d+$/.test(receipt || '')) {
                    finish(job, 'done', 'SPOJ 已收到提交。', { result: location.origin + statusPath(job) });
                    return;
                }
                const error = firstVisible('.alert-danger, .error-message');
                if (error?.textContent.trim()) throw Error(error.textContent.trim());
                const handle = account(job.task);
                if (job.handle && handle && job.handle !== handle) throw Error('SPOJ 登录账号已切换，请重新操作。');
                if (!handle && (password || /^\/login\/?$/.test(path) ||
                    document.querySelector('nav a[href^="/login"], .navbar a[href^="/login"], #menu a[href^="/login"]'))) {
                    notice(job, '请在后台 SPOJ 标签页登录，登录后继续。', 'login');
                    await delay(800);
                    continue;
                }
                if (!handle && !job.handle) {
                    if (document.querySelector('a[href*="/logout"]')) {
                        if (path !== problemPath(job)) { location.replace(problemPath(job)); return; }
                        throw Error('无法识别当前 SPOJ 用户名。');
                    }
                    unknownSince ??= Date.now();
                    if (Date.now() - unknownSince > 20000)
                        throw Error('无法识别 SPOJ 页面，请在后台标签页检查页面是否已加载。');
                    notice(job, '正在等待 SPOJ 页面加载…', 'loading');
                    await delay(400);
                    continue;
                }
                if (job.notice === 'verification' || job.notice === 'login') {
                    notice(job, '正在连接 SPOJ…', 'loading');
                    job = getJob(id);
                    if (!job || GM_getValue(cancelKey(id))) return;
                }
                if (!job.handle) {
                    job = { ...job, handle };
                    setJob(id, job);
                }
                if (job.phase === 'sent' && path !== statusPath(job)) {
                    if (!/^\/(?:submit|status)\//.test(path)) throw Error('SPOJ 未确认收到提交。');
                    location.replace(statusPath(job));
                    return;
                }
                if (path.startsWith(statusPath(job))) {
                    const { rows, next } = statusPage(job);
                    if (job.phase === 'sent') {
                        const fresh = rows.filter(r => Number(r.id) > job.baseline);
                        if (fresh.length !== 1) throw Error('无法确认本次提交，请查看 SPOJ 提交记录。');
                        finish(job, 'done', 'SPOJ 已收到提交。', { result: location.origin + statusPath(job) });
                    } else if (reading) {
                        const records = [...new Map([...(job.records || []), ...rows].map(r => [r.id, r])).values()];
                        if (next) {
                            setJob(id, { ...job, records, message: '正在读取更多 SPOJ 记录…', notice: 'loading' });
                            location.replace(next);
                        } else finish(job, 'done', '', { records });
                    } else {
                        setJob(id, { ...job, baseline: Math.max(0, ...rows.map(r => Number(r.id))) });
                        location.replace(submitPath(job));
                    }
                    return;
                }
                if (reading || job.baseline === undefined) { location.replace(statusPath(job)); return; }
                if (path !== submitPath(job)) { location.replace(submitPath(job)); return; }
                if (!form) throw Error('未找到 SPOJ 提交表单。');
                const send = () => {
                    const latest = getJob(id);
                    if (latest?.phase !== 'ready' || GM_getValue(cancelKey(id))) return;
                    const button = fillForm(unsafeWindow.document.querySelector('form[action*="/submit/complete"]'), latest);
                    if (getJob(id)?.phase !== 'ready' || GM_getValue(cancelKey(id))) return;
                    setJob(id, { ...latest, code: '', phase: 'sent', posted: true, message: '正在等待 SPOJ 确认…', notice: 'loading' });
                    if (GM_getValue(cancelKey(id))) return;
                    button.click();
                    setTimeout(() => {
                        const pending = getJob(id);
                        if (pending?.phase === 'sent') finish(pending, 'uncertain', 'SPOJ 尚未确认，请查看个人提交记录。');
                    }, 30000);
                };
                if (navigator.locks) await navigator.locks.request(prefix + id, send);
                else send();
                return;
            }
        } catch (error) {
            if (job) finish(job, getJob(id)?.posted ? 'uncertain' : 'error', error.message);
        }
    }

    prune();
    if (location.hostname === 'www.spoj.com') {
        const id = workerId();
        if (id) void runWorker(id);
    } else installLuogu();
})();
