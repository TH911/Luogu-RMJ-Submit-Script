// ==UserScript==
// @name         luogu RMJ AtCoder
// @namespace    luogu-atcoder-direct
// @version      1.4.0
// @updateURL    https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-atcoder.user.js
// @downloadURL  https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-atcoder.user.js
// @description  用自己的 AtCoder 账号提交代码，并在洛谷评测记录页查看本题提交。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @match        https://atcoder.jp/*
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

    const prefix = 'lg-at-v1:';
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
        if (group === 'cpp' && wanted === 2014 && /(?:gcc|g\+\+)\s*9\b/i.test(source)) {
            const ioi = candidates.find(o => /ioi[ -]*style/i.test(o.text)
                && /gnu\+\+\s*20/i.test(o.text) && /(?:gcc|g\+\+)\s*14\b/i.test(o.text));
            if (ioi) return ioi;
        }
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

    const pidFromPath = () => /^\/problem\/(AT(?:_[\w-]+|\d+))\/?$/i.exec(location.pathname)?.[1];
    function originalTask(doc, pid, withProblem) {
        const raw = doc.querySelector('#lentille-context')?.textContent;
        const problem = raw && JSON.parse(raw)?.data?.problem;
        if (!problem || problem.pid.toLowerCase() !== pid.toLowerCase()) return;
        const description = problem.content?.description || '';
        const url = /^\s*\[problemUrl\]:\s*<?(https:\/\/atcoder\.jp\/contests\/[\w-]+\/tasks\/[\w-]+)\b/im.exec(description)?.[1];
        if (url) {
            const [, , contest, , task] = new URL(url).pathname.split('/');
            return withProblem ? { contest, task, problem: { pid, name: problem.name, difficulty: problem.difficulty } } : { contest, task };
        }
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
        // Historical slugs use underscores in task IDs and hyphens in contest IDs.
        const task = pid.replace(/^AT_/i, '');
        const split = task.lastIndexOf('_');
        if (split < 1) throw Error('无法从洛谷题面识别 AtCoder 原题链接。');
        return { contest: task.slice(0, split).replaceAll('_', '-'), task };
    }

    function prune() {
        for (const key of GM_listValues().filter(k => k.startsWith(prefix))) {
            const data = GM_getValue(key);
            if (!data || Date.now() - data.created > lifetime) GM_deleteValue(key);
        }
    }
    const setJob = (id, data) => GM_setValue(prefix + id, data);
    const getJob = id => GM_getValue(prefix + id);
    const submitPath = job => '/contests/' + job.contest + '/submit';
    const workerUrl = (job, id) => 'https://atcoder.jp' + submitPath(job)
        + '?' + new URLSearchParams({ taskScreenName: job.task, lg_rmj: id });

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
        CE: 2, IE: 11, WJ: 0, WR: 0, Waiting: 0, Judging: 1,
        'Waiting for Judging': 0, 'Waiting for Re-judging': 0
    };

    function mergedRecords(original, records, user, pid, problem) {
        const rows = records.map(item => {
            const timestamp = Date.parse(item.time) / 1000;
            const memory = /^([\d.]+)\s*(KB|KiB|MB|MiB|B)?$/i.exec(item.memory);
            return {
                id: 'AT' + item.id, user, problem: problem || { pid, name: item.problem },
                status: nativeStatus[item.code] ?? 11, submitTime: Number.isFinite(timestamp) ? timestamp : 0,
                time: parseFloat(item.runtime), memory: memory ? Number(memory[1]) *
                    (/^m/i.test(memory[2]) ? 1024 : /^b$/i.test(memory[2]) ? 1 / 1024 : 1) : undefined,
                // Reserve the native language icon and caption. Its text is filled with AtCoder's compiler label.
                language: 0
            };
        });
        rows.sort((a, b) => b.submitTime - a.submitTime || Number(b.id.slice(2)) - Number(a.id.slice(2)));
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
                const id = link.hostname === 'atcoder.jp' ? link.pathname.split('/').pop()
                    : /^\/record\/AT(\d+)$/.exec(link.pathname)?.[1];
                const item = current.items.get(id);
                if (!item) continue;
                if (link.hostname !== 'atcoder.jp')
                    link.href = 'https://atcoder.jp/contests/' + current.target.contest + '/submissions/' + id;
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
            if (!/^\/record\/list\/?$/.test(location.pathname) || !/^AT(?:_[\w-]+|\d+)$/i.test(pid || '')
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
            const controls = element('span', '', 'lgat-record-controls lfe-caption');
            const status = element('span');
            status.setAttribute('role', 'status');
            const action = element('button', '取消', 'lgat-action');
            action.type = 'button';
            controls.append(status, action);
            (main.querySelector('.result .count') || card).append(controls);
            // Let the browser follow external detail links instead of Luogu's router.
            const follow = event => {
                const link = event.target.closest?.('a.status');
                if (link?.origin === 'https://atcoder.jp') event.stopPropagation();
            };
            card.addEventListener('click', follow, true);
            const current = view = { pid, search: location.search, card, follow, block, controls, original: block.props.records };
            async function read() {
                const controller = current.controller = new AbortController();
                const { signal } = controller;
                action.textContent = '取消';
                function notice(text, kind = 'loading') {
                    if (signal.aborted) return;
                    status.className = ['loading', 'verification'].includes(kind) ? 'lgat-wait' : '';
                    status.textContent = text;
                }
                notice('正在读取 AtCoder 记录…');
                try {
                    const target = await resolveTask(pid, true, signal);
                    if (signal.aborted) return;
                    const { records } = await launch(target, { operation: 'records' }, notice, signal);
                    if (signal.aborted || location.search !== current.search || !card.isConnected) return;
                    const problem = current.original.result.find(r => r.problem?.pid === pid)?.problem || target.problem;
                    current.target = target;
                    current.items = new Map(records.map(item => [item.id, item]));
                    // Give the existing component a display copy. Its parent keeps the server response and paginator.
                    block.props.records = mergedRecords(current.original, records, user, pid, problem);
                    current.merged = block.props.records;
                    notice(records.length ? '+ ' + records.length + ' 条 AtCoder 记录' : '此题暂无 AtCoder 记录', 'done');
                    schedule();
                } catch (error) { notice(error.message, 'error'); }
                finally {
                    if (current.controller === controller) {
                        current.controller = null;
                        action.textContent = '刷新 AtCoder 记录';
                    }
                }
            }
            action.addEventListener('click', () => {
                if (current.controller) {
                    current.controller.abort();
                    status.className = '';
                    status.textContent = '已取消读取 AtCoder 记录。';
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

    function recordsUrl(job, id, page = 1) {
        return 'https://atcoder.jp/contests/' + job.contest + '/submissions/me?' + new URLSearchParams({
            'f.Task': job.task, lang: 'en', page: String(page), lg_rmj: id
        });
    }

    function installLuogu() {
        // SweetAlert2 uses Luogu's existing stylesheet, font and theme variables.
        const style = document.createElement('style');
        style.textContent = `
            .swal2-popup.lgat-loading > .swal2-actions {
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            .lgat-record-controls { display:inline-flex; align-items:center; gap:.5em; margin-inline-start:.75em }
            .lgat-action { background:none; border:0; font:inherit; cursor:pointer; color:rgb(var(--lcolor--primary,52,152,219)) }
            .lgat-action:disabled { opacity:.55; cursor:default }
            .lgat-wait { display:flex; align-items:center; gap:.5em }
            .lgat-wait::before { content:''; width:.85em; height:.85em; border:2px solid currentColor;
                border-right-color:transparent; border-radius:50%; color:rgb(var(--lcolor--primary,52,152,219));
                animation:lgat-spin .9s linear infinite }
            @keyframes lgat-spin { to { transform:rotate(1turn) } }
            @media (prefers-reduced-motion:reduce) { .lgat-wait::before { animation:none } }
            .lgat-verification > .swal2-actions { display: contents !important; }
            .lgat-verification .swal2-loader {
                grid-column: 1 / -1;
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            .lgat-verification .swal2-cancel {
                grid-column: 1 / -1;
                grid-row: 4;
                justify-self: center;
                margin: 1.25em auto 0;
            }
            .lgat-loading .swal2-loader, .lgat-verification .swal2-loader {
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
            const sameCancelAction = lastNotice?.onCancel === onCancel;
            lastNotice = { text, kind, onCancel };
            const title = {
                loading: '正在提交', verification: '正在提交', login: '请登录 AtCoder',
                uncertain: '提交状态待确认', error: '提交失败', done: '提交成功'
            }[kind];
            const waiting = kind === 'loading' || kind === 'verification';
            if (waiting && sameCancelAction && dialogs.getPopup()?.classList.contains('lgat-' + kind)) {
                dialogs.getHtmlContainer().textContent = text;
                return;
            }
            const options = {
                titleText: title, text, showCancelButton: !!onCancel, cancelButtonText: '取消',
                theme: document.documentElement.dataset.lcolorTheme === 'dark' ? 'dark' : 'light'
            };
            if (waiting) {
                Object.assign(options, {
                    customClass: { popup: 'lgat-' + kind }, showConfirmButton: false,
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
                if (/\.zip$/i.test(picked.file.name)) throw Error('AtCoder 需要源代码，请选择单个源文件。');
                return { language, code: await picked.file.text() };
            }
            return { code, language };
        }

        function launch(target, draft, notify = report, signal) {
            const reading = draft.operation === 'records';
            const id = crypto.randomUUID();
            const job = { ...target, ...draft, created: Date.now(), phase: 'ready' };
            return new Promise((resolve, reject) => {
                let tab, listener, hint, expiry, verificationTimer, stopping;
                let finished = false;
                function finish(error, receipt) {
                    if (finished) return;
                    finished = true;
                    clearTimeout(hint);
                    clearTimeout(expiry);
                    clearTimeout(verificationTimer);
                    if (listener !== undefined) GM_removeValueChangeListener(listener);
                    if (tab) tab.onclose = null;
                    GM_deleteValue(prefix + id);
                    GM_deleteValue(cancelKey(id));
                    signal?.removeEventListener('abort', abort);
                    if (reading && tab && !tab.closed) tab.close();
                    if (error) reject(error);
                    else resolve(receipt);
                }
                function abort() {
                    if (reading || !tab) finish(new DOMException('已取消。', 'AbortError'));
                    else if (getJob(id)?.phase === 'ready') stopWaiting('cancel');
                }
                function stopWaiting(reason) {
                    if (finished || stopping || (reason === 'timeout' && getJob(id)?.notice !== 'verification')) return;
                    if (reading) { finish(Error('人机验证等待超时，请刷新记录。')); return; }
                    stopping = reason;
                    // A separate key survives a simultaneous status update from the worker.
                    GM_setValue(cancelKey(id), { created: Date.now() });
                    tab.close();
                }
                try {
                    if (signal?.aborted) { abort(); return; }
                    signal?.addEventListener('abort', abort, { once: true });
                    setJob(id, job);
                    listener = GM_addValueChangeListener(prefix + id, (_, old, data) => {
                        if (finished || stopping) return;
                        clearTimeout(verificationTimer);
                        if (!data) { finish(Error('本次提交已过期，请在 AtCoder 核对提交记录。')); return; }
                        if (data.phase === 'uncertain') { finish(null, { uncertain: data.message }); return; }
                        if (data.phase === 'error') { finish(Error(data.message)); return; }
                        if (data.phase === 'done') {
                            finish(null, reading ? { records: data.records } : { url: data.result, message: data.message, worker: tab });
                        } else if (data.notice === 'verification') {
                            notify(data.message, 'verification', data.phase === 'ready');
                            verificationTimer = setTimeout(() => stopWaiting('timeout'),
                                Math.max(0, data.verificationSince + verificationLimit - Date.now()));
                        } else if (data.message) {
                            notify(data.message, data.notice || 'loading', data.phase === 'ready');
                        }
                    });
                    tab = GM_openInTab(reading ? recordsUrl(job, id) : workerUrl(job, id), { active: false, insert: true });
                    if (!tab) throw Error('无法打开 AtCoder 标签页。');
                    tab.onclose = () => {
                        const current = getJob(id);
                        if (stopping) {
                            if (current?.phase === 'sent' || current?.posted) {
                                finish(null, { uncertain: '已停止等待。提交请求已发出，请先查看 AtCoder 的「我的提交」。' });
                            } else if (stopping === 'timeout') {
                                finish(Error('人机验证等待超时，请重新提交。'));
                            } else finish(null, null);
                        } else if (current && !['done', 'error'].includes(current.phase)) {
                            finish(Error(current.phase === 'sent' ? '标签页已关闭，请在 AtCoder 核对提交记录。' : 'AtCoder 提交标签页已关闭。'));
                        }
                    };
                    hint = setTimeout(() => {
                        if (!getJob(id)?.message) notify('正在等待 AtCoder 响应…');
                    }, 7000);
                    expiry = setTimeout(() => finish(Error(reading ? '查询超时，请刷新记录。' : '本次提交等待已过期，请在 AtCoder 核对提交记录。')), reading ? 5 * 60 * 1000 : lifetime);
                } catch (error) { finish(error); }
            });
        }

        async function submit(pid) {
            submitting = true;
            const controller = new AbortController();
            const cancel = () => controller.abort();
            const notify = (text, kind, cancellable = true) => report(text, kind, cancellable ? cancel : undefined);
            try {
                const draft = await readEditor();
                if (!draft.code?.trim()) throw Error('请在洛谷编辑器中输入源代码，或重新选择源文件。');
                if (!draft.language || /自动|选择|auto|select|choose/i.test(draft.language))
                    throw Error('请在洛谷的语言列表中选择源代码使用的语言。');
                notify('正在连接 AtCoder…');
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
            } catch (error) { if (error.name !== 'AbortError') report(error.message, 'error'); }
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
        let id = url.searchParams.get('lg_rmj');
        if (!id && url.pathname === '/login') {
            const next = new URL(url.searchParams.get('continue') || '/', url.origin);
            if (next.origin === url.origin) id = next.searchParams.get('lg_rmj');
        }
        const key = prefix + 'tab';
        if (id && /^[a-f\d-]{36}$/i.test(id) && getJob(id)) sessionStorage.setItem(key, id);
        return sessionStorage.getItem(key);
    }
    function challengePage() {
        return Boolean(document.querySelector(
            '#challenge-running, #challenge-form, #challenge-stage, #cf-challenge-running, ' +
            'script[src*="/cdn-cgi/challenge-platform/"][src*="/orchestrate/"]'
        ));
    }
    function widgetPending(form) {
        const names = ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response'];
        for (const name of names) {
            const field = form.elements.namedItem(name);
            if (field) return !field.value?.trim() || field.matches?.(':disabled');
        }
        // AtCoder renders this placeholder before Turnstile adds its response field.
        return !!form.querySelector('.cf-challenge,.cf-turnstile,.g-recaptcha,.h-captcha,iframe[src*="challenges.cloudflare.com"]');
    }

    function readMySubmissions(id, job) {
        const base = '/contests/' + job.contest;
        const path = base + '/submissions/me';
        if (location.pathname !== path) throw Error('AtCoder 未打开个人提交记录，请检查比赛访问权限。');
        const handle = unsafeWindow.userScreenName || document.querySelector('#navbar-collapse a[href^="/users/"]')?.pathname.split('/')[2];
        if (!handle || (job.handle && job.handle !== handle)) throw Error('无法确认当前 AtCoder 账号，请重新查询。');
        const main = document.querySelector('#main-container');
        const column = (headers, pattern) => headers.findIndex(text => pattern.test(text));
        const languageHeader = /^(?:Language|言語|语言)$/i;
        const table = [...(main?.querySelectorAll('table') || [])].find(t =>
            [...t.querySelectorAll('thead th')].some(th => languageHeader.test(th.textContent.trim())));
        const records = new Map((job.records || []).map(item => [item.id, item]));
        if (!table && !/no submissions?|no results|提出がありません|暂无提交|没有提交/i.test(main?.innerText || ''))
            throw Error('未识别到 AtCoder 提交记录列表，请刷新重试。');
        if (table) {
            const headers = [...table.querySelectorAll('thead th')].map(th => th.textContent.trim());
            const language = column(headers, languageHeader), result = column(headers, /^(?:Result|Status|結果|结果|状态)$/i);
            const runtime = column(headers, /^(?:Exec(?:ution)? Time|実行時間|执行时间|运行时间)$/i);
            const memory = column(headers, /^(?:Memory|メモリ|内存)(?:使用量)?$/i);
            if (language < 0 || result < 0) throw Error('AtCoder 记录表列已变更，请检查查询页面。');
            for (const row of table.querySelectorAll('tbody tr')) {
                const task = row.querySelector('a[href*="/tasks/"]');
                if (task?.pathname !== base + '/tasks/' + job.task) continue;
                const author = row.querySelector('a[href^="/users/"]');
                if (author && author.pathname !== '/users/' + handle) continue;
                const detail = [...row.querySelectorAll('a[href]')].find(a =>
                    a.pathname.startsWith(base + '/submissions/') && /\/\d+$/.test(a.pathname));
                const sid = detail?.pathname.split('/').pop() || row.getAttribute('data-id');
                const cell = index => row.cells[index]?.textContent.trim() || '';
                const label = row.cells[result]?.querySelector('.label');
                const verdict = cell(result) || label?.getAttribute('data-original-title') || label?.title;
                if (!/^\d+$/.test(sid || '') || !verdict) throw Error('AtCoder 返回了无法识别的提交记录。');
                const time = row.querySelector('time');
                records.set(sid, { id: sid, code: /\d+\s*\/\s*\d+/.test(verdict) ? 'Judging' : verdict,
                    problem: task.textContent.trim(), language: cell(language),
                    time: time?.getAttribute('datetime') || time?.textContent.trim() || cell(0),
                    runtime: cell(runtime), memory: cell(memory) });
            }
        }
        const page = Number(new URLSearchParams(location.search).get('page') || 1);
        const more = [...main.querySelectorAll('.pagination a[href]')].some(a =>
            a.pathname === path && Number(new URL(a.href).searchParams.get('page')) > page);
        if (!getJob(id) || GM_getValue(cancelKey(id))) return;
        const data = { ...job, records: [...records.values()], handle, notice: 'loading', verificationSince: null };
        if (more) {
            setJob(id, { ...data, message: '正在读取第 ' + (page + 1) + ' 页 AtCoder 记录…' });
            location.replace(recordsUrl(job, id, page + 1));
        } else {
            sessionStorage.removeItem(prefix + 'tab');
            setJob(id, { ...data, phase: 'done' });
        }
    }

    async function runWorker(id) {
        let job = getJob(id);
        if (!job || Date.now() - job.created > lifetime || ['done', 'error', 'uncertain'].includes(job.phase)) {
            sessionStorage.removeItem(prefix + 'tab');
            return;
        }
        function say(message, notice = 'loading') {
            job = getJob(id);
            if (!job || GM_getValue(cancelKey(id)) || (job.message === message && job.notice === notice)) return;
            setJob(id, { ...job, message, notice, verificationSince: notice === 'verification' ? Date.now() : null });
        }
        function stop(message, phase = 'error') {
            sessionStorage.removeItem(prefix + 'tab');
            const current = getJob(id);
            if (!current || GM_getValue(cancelKey(id))) return;
            const end = { ...current, code: '', phase, message };
            if (phase === 'done') end.result = location.origin + location.pathname;
            setJob(id, end);
        }
        const base = '/contests/' + job.contest;
        const path = location.pathname;
        function verificationFailed(message) {
            if (job.phase === 'sent') stop(message + ' 提交请求已发出，请先查看 AtCoder 的「我的提交」。', 'uncertain');
            else stop(message + (job.operation === 'records' ? ' 请刷新记录。' : ' 请重新提交。'));
        }
        let readySince = Date.now();
        try {
            while ((job = getJob(id)) && Date.now() - job.created < lifetime) {
                if (GM_getValue(cancelKey(id))) return;
                const challenge = challengePage();
                const problemError = firstVisible('#main-container .alert-danger, .alert-danger, .alert-error');
                const challengeError = firstVisible('#challenge-error-text, #cf-error-details h1');
                if (challengeError?.innerText.trim() || (problemError && (challenge || job.notice === 'verification'))) {
                    verificationFailed('验证页面返回错误：' + (challengeError?.innerText.trim() || problemError.innerText.trim()));
                    return;
                }
                if (job.notice === 'verification' && Date.now() - job.verificationSince >= verificationLimit) {
                    verificationFailed('人机验证等待超时。');
                    return;
                }
                if (challenge) {
                    say('等待人机验证…', 'verification');
                    readySince = Date.now();
                    await delay(900);
                    continue;
                }
                if (job.phase === 'sent') {
                    const suffix = path.slice(base.length);
                    if (path.startsWith(base + '/') && /^\/submissions\/(me|\d+)\/?$/.test(suffix)
                        && !problemError && document.querySelector('#main-container table, #submission-code, .alert-success')) {
                        stop('AtCoder 已收到提交。', 'done');
                    } else {
                        const detail = problemError?.innerText.replace(/^\s*×\s*/, '').trim();
                        if (!detail || /^error[.。!！]?$/i.test(detail)) {
                            stop('AtCoder 未确认收到提交' + (detail ? '，页面仅返回「' + detail + '」' : '') +
                                '。请先查看「我的提交」中是否有本次记录。', 'uncertain');
                        } else stop(detail);
                    }
                    return;
                }
                if (path === '/login' || document.querySelector('form input[type="password"]')) {
                    say(job.operation === 'records' ? '请在后台 AtCoder 标签页登录，登录后继续查询。' : '尚未登录 AtCoder，请切换到新标签页登录。登录后将继续提交。', 'login');
                    return;
                }
                // A login started from the worker may land on the home page.
                if (path === '/') { location.replace(job.operation === 'records' ? recordsUrl(job, id) : workerUrl(job, id)); return; }
                if (job.operation === 'records') {
                    if (problemError) throw Error(problemError.innerText.trim());
                    readMySubmissions(id, job);
                    return;
                }
                if (path !== submitPath(job)) { stop('AtCoder 跳转到了其他页面，请检查比赛访问权限。'); return; }
                if (problemError) { stop(problemError.innerText.trim() || 'AtCoder 返回了错误。'); return; }

                const form = document.querySelector('form.form-code-submit, form[action$="/submit"]');
                const task = form?.querySelector('[name="data.TaskScreenName"], #select-task');
                const source = form?.querySelector('textarea[name="sourceCode"], textarea[name="data.SourceCode"], #plain-textarea');
                if (task instanceof HTMLSelectElement && task.value !== job.task) {
                    if (![...task.options].some(o => o.value === job.task)) {
                        stop('此比赛的提交表单中找不到题目 ' + job.task + '。'); return;
                    }
                    task.value = job.task;
                    task.dispatchEvent(new Event('change', { bubbles: true }));
                }
                const language = form?.querySelector('#select-lang select.current[name], select[name="data.LanguageId"]');
                const button = form?.querySelector('#submit, button[type="submit"], input[type="submit"], button:not([type])');
                if (form && task?.value === job.task && source && language && button) {
                    const option = chooseLanguage(job.language, language.options);
                    if (!option) { stop('这道题没有与「' + job.language + '」兼容的语言，请在洛谷更改语言后再提交。'); return; }
                    const editorEl = form.querySelector('#editor');
                    const editor = editorEl && unsafeWindow.document.getElementById('editor')?.env?.editor;
                    if (!editorEl || editor || form.querySelector('.btn-toggle-editor.active')) {
                        if (widgetPending(form)) {
                            say('等待人机验证…', 'verification');
                            readySince = Date.now();
                        } else if (!button.disabled) {
                            language.value = option.value;
                            language.dispatchEvent(new Event('change', { bubbles: true }));
                            const code = job.code.replace(/\r\n?/g, '\n');
                            editor?.setValue(code, -1);
                            source.value = code;
                            source.dispatchEvent(new Event('input', { bubbles: true }));
                            const data = new FormData(form);
                            if (form.method.toLowerCase() !== 'post' || new URL(form.action).origin !== location.origin
                                || new URL(form.action).pathname !== submitPath(job)
                                || data.get(task.name) !== job.task || data.get(language.name) !== option.value
                                || data.get(source.name) !== code || (editor && editor.getValue() !== code)) {
                                throw Error('AtCoder 表单校验失败，请查看后台标签页。');
                            }
                            if (!form.reportValidity()) throw Error('AtCoder 表单还有必填项目，请查看后台标签页。');
                            // Commit before the native click. A reload or back navigation must never replay this POST.
                            const send = () => {
                                const latest = getJob(id);
                                if (latest?.phase !== 'ready' || GM_getValue(cancelKey(id))) return;
                                if (widgetPending(form)) return 'wait';
                                setJob(id, { ...latest, code: '', phase: 'sent', posted: true, notice: 'loading',
                                    message: '正在等待 AtCoder 确认…' });
                                button.click();
                                setTimeout(() => {
                                    if (getJob(id)?.phase === 'sent') {
                                        say('仍在等待 AtCoder 确认…');
                                    }
                                }, 12000);
                            };
                            const state = navigator.locks ? await navigator.locks.request(prefix + id, send) : send();
                            if (state !== 'wait') return;
                        }
                    }
                }
                if (Date.now() - readySince > 20000) {
                    stop('未找到可用的 AtCoder 提交表单，请在后台标签页检查登录状态及比赛权限。'); return;
                }
                await delay(400);
            }
            if (job) stop('本次提交等待已过期，请回到洛谷重新提交。');
        } catch (error) { stop(error.message); }
    }

    prune();
    if (location.hostname === 'atcoder.jp') {
        const id = workerId();
        if (id) void runWorker(id);
    } else installLuogu();
})();
