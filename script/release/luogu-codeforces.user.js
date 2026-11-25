// ==UserScript==
// @name         luogu RMJ CodeForces
// @namespace    luogu-codeforces-direct
// @version      1.1.7
// @updateURL    https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-codeforces.user.js
// @downloadURL  https://raw.githubusercontent.com/TH911/Luogu-RMJ-Submit-Script/main/script/release/luogu-codeforces.user.js
// @description  在洛谷编写代码，用自己的 Codeforces 账号提交并查看记录。
// @match        https://www.luogu.com.cn/*
// @match        https://www.luogu.com/*
// @match        https://codeforces.com/*
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

    const prefix = 'lg-cf-v1:';
    const lifetime = 2 * 60 * 60 * 1000;
    const verificationLimit = 2 * 60 * 1000;
    const cancelKey = id => prefix + id + ':cancel';
    const visible = el => el && el.getClientRects().length > 0;
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    const firstVisible = selector => [...document.querySelectorAll(selector)].find(visible);
    const familyPatterns = [
        ['cpp', /^(?:(?:(?:gnu|clang|ms)\s+)?[cg]\s*\+\+|gnu\+\+)/i], ['cs', /^(?:c#|csharp|mono c#|\.net (?:core )?c#)/i],
        ['c', /^(?:(?:gnu|clang)\s+)?c(?:\d|\b)/i], ['python', /^(?:python|pypy|cpython)/i],
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
            cpp: /(?:c|gnu|g)\+\+\s*(\d+)/i, c: /^(?:(?:gnu|clang)\s+)?c\s*(\d+)/i,
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
                const compiler = /clang/i.test(source) ? /clang/i : /gnu|gcc|g\+\+/i;
                if (compiler.test(label)) result += 8;
                if (/64[\s-]*bit/i.test(label)) result += 1;
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

    const pidFromPath = () => /^\/problem\/(CF\d+[A-Z][A-Z\d]*)\/?$/i.exec(location.pathname)?.[1];
    function originalTask(doc, pid, withProblem) {
        const raw = doc.querySelector('#lentille-context')?.textContent;
        const problem = raw && JSON.parse(raw)?.data?.problem;
        if (!problem || problem.pid.toLowerCase() !== pid.toLowerCase()) return;
        const description = problem.content?.description || '';
        const match = /^\s*\[problemUrl\]:\s*<?https:\/\/(?:www\.)?codeforces\.com\/(contest|gym|problemset\/problem)\/(\d+)\/(?:problem\/)?([a-z][a-z\d]*)\b/im.exec(description);
        if (!match && !withProblem) return;
        const target = match ? { kind: match[1] === 'gym' ? 'gym' : 'contest', contest: match[2], task: match[3].toUpperCase() }
            : taskFromPid(pid);
        if (withProblem) target.problem = { pid, name: problem.name, difficulty: problem.difficulty };
        return target;
    }
    function taskFromPid(pid) {
        const [, contest, task] = /^CF(\d+)([a-z][a-z\d]*)$/i.exec(pid);
        return { kind: Number(contest) >= 100000 ? 'gym' : 'contest', contest, task: task.toUpperCase() };
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
        return target || taskFromPid(pid);
    }

    function prune() {
        for (const key of GM_listValues().filter(k => k.startsWith(prefix))) {
            const data = GM_getValue(key);
            if (!data || Date.now() - data.created > lifetime) GM_deleteValue(key);
        }
    }
    const setJob = (id, data) => GM_setValue(prefix + id, data);
    const getJob = id => GM_getValue(prefix + id);
    const contestPath = job => '/' + job.kind + '/' + job.contest;
    const submitPath = job => contestPath(job) + '/submit';
    const problemPath = job => contestPath(job) + '/problem/' + job.task;
    const workerUrl = (job, id) => 'https://codeforces.com' + problemPath(job)
        + '?' + new URLSearchParams({ lg_cf_rmj: id });

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

    const unacceptedVerdicts = new Set([
        'WRONG_ANSWER', 'PRESENTATION_ERROR', 'RUNTIME_ERROR', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED',
        'OUTPUT_LIMIT_EXCEEDED', 'IDLENESS_LIMIT_EXCEEDED', 'SECURITY_VIOLATED', 'REJECTED', 'CHALLENGED', 'PARTIAL'
    ]);
    function remoteJudgeStatus(code) {
        if (code === 'OK') return 12;                // Accepted
        if (code === 'COMPILATION_ERROR') return 2; // Compile Error
        return unacceptedVerdicts.has(code) ? 14 : 11; // Unaccepted / Unknown Error
    }

    function awaitingVerdict(item) {
        return item.code === 'SUBMITTED' || item.code === 'TESTING' || (!item.code && !item.verdict);
    }

    function submissionTime(text) {
        // CF prints wall time and its UTC offset in separate DOM nodes.
        const match = /^(.*?)\s*(?:UTC|GMT)\s*([+\-−]?)(\d{1,2})(?::(\d{2}))?$/i.exec(text);
        if (!match) return Date.parse(text) / 1000;
        const utc = Date.parse(match[1].trim() + ' GMT') / 1000;
        const offset = (Number(match[3]) * 60 + Number(match[4] || 0)) * 60;
        return utc - (match[2] === '-' || match[2] === '−' ? -offset : offset);
    }

    function mergedRecords(original, records, user, pid, problem) {
        // CF submission IDs preserve submission order even when display times share a minute.
        const newestFirst = [...records].sort((a, b) => Number(b.id) - Number(a.id));
        const rows = newestFirst.map(item => {
            const timestamp = submissionTime(item.time);
            const memory = /^([\d.]+)\s*(KB|KiB|MB|MiB|B)?$/i.exec(item.memory);
            return {
                id: 'CF' + item.id, user, problem: problem || { pid, name: item.problem.replace(/^\S+\s*[-–]\s*/, '') },
                status: remoteJudgeStatus(item.code), submitTime: Number.isFinite(timestamp) ? timestamp : 0,
                time: parseFloat(item.runtime), memory: memory ? Number(memory[1]) *
                    (/^m/i.test(memory[2]) ? 1024 : /^b$/i.test(memory[2]) ? 1 / 1024 : 1) : undefined,
                // Reserve the native language icon and caption. Its text is filled with CF's compiler label.
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
            view.controls.remove();
            view = null;
        }
        function decorate(current) {
            for (const link of current.card.querySelectorAll('.row a.status')) {
                const id = link.hostname === 'codeforces.com' ? link.pathname.split('/').pop()
                    : /^\/record\/CF(\d+)$/.exec(link.pathname)?.[1];
                const item = current.items.get(id);
                if (!item) {
                    if (link.title.startsWith('Codeforces #')) link.removeAttribute('title');
                    continue;
                }
                if (link.hostname !== 'codeforces.com')
                    link.href = 'https://codeforces.com' + contestPath(current.target) + '/submission/' + id;
                const title = 'Codeforces #' + id + ' · ' + item.verdict;
                if (link.title !== title) link.title = title;
                const row = link.closest('.row');
                const line = row.querySelector('.detail > div:not(.metrics)');
                const language = line && [...line.childNodes].find(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
                if (language && language.textContent.trim() !== item.language) language.nodeValue = ' ' + item.language;
                const memory = row.querySelector('.metrics > span:only-child')?.lastChild;
                if (memory?.nodeType === Node.TEXT_NODE && /\/\s*$/.test(memory.nodeValue))
                    memory.nodeValue = memory.nodeValue.replace(/\s*\/\s*$/, '');
                // A missing timestamp is preferable to a fabricated Unix-epoch date.
                if (!Number.isFinite(submissionTime(item.time))) {
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
            if (!/^\/record\/list\/?$/.test(location.pathname) || !/^CF\d+[a-z][a-z\d]*$/i.test(pid || '')
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
            const controls = element('span', '', 'lgcf-record-controls lfe-caption');
            const status = element('span');
            status.setAttribute('role', 'status');
            const action = element('button', '取消', 'lgcf-action');
            action.type = 'button';
            controls.append(status, action);
            (main.querySelector('.result .count') || card).append(controls);
            const current = view = { pid, search: location.search, card, block, controls, original: block.props.records };
            async function read() {
                const controller = current.controller = new AbortController();
                const { signal } = controller;
                action.textContent = '取消';
                function notice(text, kind = 'loading') {
                    if (signal.aborted) return;
                    status.className = ['loading', 'verification'].includes(kind) ? 'lgcf-wait' : '';
                    status.textContent = text;
                }
                notice('正在读取 CF 记录…');
                try {
                    const target = await resolveTask(pid, true, signal);
                    if (signal.aborted) return;
                    const { records } = await launch(target, { operation: 'records' }, notice, signal);
                    if (signal.aborted || location.search !== current.search || !card.isConnected) return;
                    const problem = current.original.result.find(r => r.problem?.pid === pid)?.problem || target.problem;
                    current.target = target;
                    const judged = records.filter(item => !awaitingVerdict(item));
                    const pending = records.length - judged.length;
                    current.items = new Map(judged.map(item => [item.id, item]));
                    // Give the existing component a display copy. Its parent keeps the server response and paginator.
                    block.props.records = mergedRecords(current.original, judged, user, pid, problem);
                    current.merged = block.props.records;
                    const summary = [];
                    if (judged.length) summary.push('+ ' + judged.length + ' 条 CF 记录');
                    if (pending) summary.push(pending + ' 条 CF 记录待评测');
                    notice(summary.join(' · ') || '此题暂无 CF 记录', 'done');
                    schedule();
                } catch (error) { notice(error.message, 'error'); }
                finally {
                    if (current.controller === controller) {
                        current.controller = null;
                        action.textContent = '刷新 CF 记录';
                    }
                }
            }
            action.addEventListener('click', () => {
                if (current.controller) {
                    current.controller.abort();
                    status.className = '';
                    status.textContent = '已取消读取 CF 记录。';
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
            .swal2-popup.lgat-loading > .swal2-actions {
                display: contents !important;
            }
            .lgat-loading .swal2-loader {
                grid-column: 1 / -1;
                grid-row: 1;
                margin: 2.5em auto .6em;
            }
            .lgat-loading .swal2-cancel {
                grid-column: 1 / -1;
                grid-row: 4;
                justify-self: center;
                margin: 1.25em auto 0;
            }
            .lgcf-record-controls { display:inline-flex; align-items:center; gap:.5em; margin-inline-start:.75em }
            .lgcf-action { background:none; border:0; font:inherit; cursor:pointer; color:rgb(var(--lcolor--primary,52,152,219)) }
            .lgcf-action:disabled { opacity:.55; cursor:default }
            .lgcf-wait { display:flex; align-items:center; gap:.5em }
            .lgcf-wait::before { content:''; width:.85em; height:.85em; border:2px solid currentColor;
                border-right-color:transparent; border-radius:50%; color:rgb(var(--lcolor--primary,52,152,219));
                animation:lgcf-spin .9s linear infinite }
            @keyframes lgcf-spin { to { transform:rotate(1turn) } }
            @media (prefers-reduced-motion:reduce) { .lgcf-wait::before { animation:none } }
            .lgcf-submit-wait { display:inline-flex; margin:.5em; vertical-align:middle }
            .lgat-loading .swal2-loader {
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
        let lastNotice, submitControl, inlineNotice;
        function report(text, kind = 'loading', onCancel) {
            const sameCancelAction = lastNotice?.onCancel === onCancel;
            lastNotice = { text, kind, onCancel };
            inlineNotice?.remove();
            if (kind === 'verification') {
                if (dialogs.getPopup()) dialogs.close();
                inlineNotice = element('span', text, 'lgcf-wait lgcf-submit-wait');
                inlineNotice.setAttribute('role', 'status');
                if (onCancel) {
                    const cancel = element('button', '取消', 'lgcf-action');
                    cancel.type = 'button';
                    cancel.addEventListener('click', onCancel, { once: true });
                    inlineNotice.append(cancel);
                }
                if (submitControl?.isConnected) submitControl.after(inlineNotice);
                else (document.querySelector('main') || document.body).prepend(inlineNotice);
                return;
            }
            const title = {
                loading: '正在提交', login: '请登录 Codeforces',
                uncertain: '提交状态待确认', error: '提交失败', done: '提交成功'
            }[kind];
            const waiting = kind === 'loading';
            if (waiting && sameCancelAction && dialogs.getPopup()?.classList.contains('lgat-' + kind)) {
                dialogs.getHtmlContainer().textContent = text;
                return;
            }
            const options = {
                titleText: title, text,
                showCancelButton: !!onCancel, cancelButtonText: '取消',
                theme: document.documentElement.dataset.lcolorTheme === 'dark' ? 'dark' : 'light'
            };
            if (waiting) {
                Object.assign(options, {
                    customClass: { popup: 'lgat-' + kind }, showConfirmButton: false,
                    allowEscapeKey: false,
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
                if (result.dismiss === 'cancel' && lastNotice?.onCancel === onCancel) onCancel?.();
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
                if (/\.zip$/i.test(picked.file.name)) throw Error('Codeforces 需要源代码，请选择单个源文件。');
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
                    signal?.removeEventListener('abort', abort);
                    GM_deleteValue(prefix + id);
                    GM_deleteValue(cancelKey(id));
                    if (reading && tab && !tab.closed) {
                        try { tab.close(); } catch { /* The query tab may have already closed. */ }
                    }
                    if (error) reject(error);
                    else resolve(receipt);
                }
                function abort() {
                    if (reading) finish(new DOMException('已结束读取。', 'AbortError'));
                    else if (!tab) finish(null, null);
                    else stopWaiting('cancel');
                }
                function stopWaiting(reason) {
                    const current = getJob(id);
                    if (finished || stopping || !current || (reason === 'timeout' && current.notice !== 'verification')) return;
                    if (reading) { finish(Error('人机验证等待超时，请刷新重试。')); return; }
                    if (current.posted || current.phase === 'sent') {
                        if (reason === 'timeout') finish(null, { uncertain: '提交后的人机验证超时，请在 Codeforces 核对提交记录。' });
                        return;
                    }
                    if (!['ready', 'requesting'].includes(current.phase)) return;
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
                        if (!data) { finish(Error(reading ? '记录查询已过期，请刷新。' : '本次提交已过期，请在 Codeforces 核对提交记录。')); return; }
                        if (data.phase === 'uncertain') { finish(null, { uncertain: data.message }); return; }
                        if (data.phase === 'error') { finish(Error(data.message)); return; }
                        if (data.phase === 'done') {
                            finish(null, reading ? { records: data.records, handle: data.handle } : { message: data.message, worker: tab });
                        } else if (data.phase === 'requesting') {
                            notify(data.message, 'loading', false);
                            // Only the Luogu tab can authorize the POST, after retiring its cancel control.
                            if (getJob(id)?.phase === 'requesting') setJob(id, { ...data, phase: 'authorized' });
                        } else if (data.notice === 'verification') {
                            notify(data.message, 'verification', data.phase === 'ready' && !data.posted);
                            verificationTimer = setTimeout(() => stopWaiting('timeout'),
                                Math.max(0, data.verificationSince + verificationLimit - Date.now()));
                        } else if (data.message) {
                            notify(data.message, data.notice || 'loading', data.phase === 'ready' && !data.posted);
                        }
                    });
                    tab = GM_openInTab(workerUrl(job, id), { active: false, insert: true });
                    if (!tab) throw Error('无法打开 Codeforces 标签页。');
                    tab.onclose = () => {
                        const current = getJob(id);
                        if (reading) {
                            if (current?.phase === 'done') finish(null, { records: current.records, handle: current.handle });
                            else finish(Error(stopping === 'timeout' ? '人机验证等待超时，请刷新重试。' : 'Codeforces 查询标签页已关闭。'));
                            return;
                        }
                        if (stopping) {
                            if (stopping === 'timeout') {
                                finish(Error('人机验证等待超时，请重新提交。'));
                            } else finish(null, null);
                        } else if (current && !['done', 'error'].includes(current.phase)) {
                            finish(Error(current.phase === 'sent' ? '标签页已关闭，请在 Codeforces 核对提交记录。' : 'Codeforces 提交标签页已关闭。'));
                        }
                    };
                    hint = setTimeout(() => {
                        if (!getJob(id)?.message) notify('正在等待 Codeforces 响应…');
                    }, 7000);
                    expiry = setTimeout(() => finish(Error(reading ? '记录查询超时，请刷新重试。' : '本次提交等待已过期，请在 Codeforces 核对提交记录。')), reading ? 5 * 60 * 1000 : lifetime);
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
                notify('正在连接 Codeforces…');
                const target = await resolveTask(pid, false, controller.signal);
                if (controller.signal.aborted) return;
                if (pid !== pidFromPath()) throw Error('题目已切换，请在当前题目重新提交。');
                const receipt = await launch(target, draft, notify, controller.signal);
                if (!receipt) return;
                if (receipt.uncertain) { report(receipt.uncertain, 'uncertain'); return; }
                await report(receipt.message, 'done');
                try {
                    const tab = GM_openInTab('https://codeforces.com/problemset/status?my=on', { active: true, insert: true });
                    if (tab) receipt.worker?.close();
                } catch { /* The original worker tab already contains the submission record. */ }
            } catch (error) {
                if (!(controller.signal.aborted && error.name === 'AbortError')) report(error.message, 'error');
            }
            finally { inlineNotice?.remove(); submitting = false; }
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
            if (!submitting) { submitControl = control; void submit(pid); }
            else if (lastNotice && lastNotice.kind !== 'done' && !dialogs.isVisible())
                report(lastNotice.text, lastNotice.kind, lastNotice.onCancel);
        }, true);
        installRecordList(launch);
    }

    function workerId() {
        const url = new URL(location.href);
        let id = url.searchParams.get('lg_cf_rmj');
        if (!id && url.pathname === '/enter') {
            const next = new URL(url.searchParams.get('back') || '/', url.origin);
            if (next.origin === url.origin) id = next.searchParams.get('lg_cf_rmj');
        }
        const key = prefix + 'tab';
        if (id && /^[a-f\d-]{36}$/i.test(id) && getJob(id)) sessionStorage.setItem(key, id);
        return sessionStorage.getItem(key);
    }
    function challengePage() {
        return Boolean(document.querySelector('#challenge-running, #challenge-form, #challenge-stage, #cf-challenge-running'))
            || /just a moment|checking your browser|正在验证|しばらくお待ち/i.test(document.title);
    }
    function widgetPending(form) {
        const names = ['cf-turnstile-response', 'g-recaptcha-response', 'h-captcha-response'];
        for (const name of names) {
            const field = form.elements.namedItem(name);
            if (field) return !field.value?.trim() || field.matches?.(':disabled');
        }
        // Codeforces renders this placeholder before Turnstile adds its response field.
        return !!form.querySelector('.cf-challenge,.cf-turnstile,.g-recaptcha,.h-captcha,iframe[src*="challenges.cloudflare.com"]');
    }

    function readMySubmissions(id, job) {
        const base = contestPath(job);
        const first = base + '/my';
        const path = location.pathname.replace(/\/$/, '');
        if (path !== first && !path.startsWith(first + '/page/')) {
            if (path !== problemPath(job) && job.notice !== 'login')
                throw Error('无法打开此比赛的个人提交记录，请检查比赛权限。');
            location.replace(first);
            return;
        }
        const profile = document.querySelector('#header .lang-chooser a[href^="/profile/"], #header a[href^="/profile/"]');
        const handle = profile?.getAttribute('href').split('/')[2];
        const table = document.querySelector('#pageContent table.status-frame-datatable');
        if (!handle || !table) throw Error('无法识别 Codeforces 当前账号或提交记录表，请刷新重试。');
        if (job.handle && job.handle !== handle) throw Error('Codeforces 账号已切换，请刷新记录。');
        const records = new Map((job.records || []).map(item => [item.id, item]));
        for (const row of table.querySelectorAll('tr[data-submission-id]')) {
            const problem = [...row.querySelectorAll('a[href]')].find(a =>
                [problemPath(job), '/problemset/problem/' + job.contest + '/' + job.task].includes(a.pathname));
            if (!problem) continue;
            const cells = row.cells;
            const submission = row.getAttribute('data-submission-id');
            const verdict = row.querySelector('.submissionVerdictWrapper') || row.querySelector('.status-verdict-cell');
            if (!/^\d+$/.test(submission) || !verdict || cells.length < 8)
                throw Error('Codeforces 记录格式已变更，无法完整读取本题记录。');
            const code = verdict.getAttribute('submissionverdict')?.trim().toUpperCase();
            const text = cell => cell.textContent.trim().replace(/\s+/g, ' ');
            records.set(submission, { id: submission, code, author: text(cells[2]), time: text(cells[1]),
                problem: text(problem), language: text(cells[4]), verdict: text(verdict),
                runtime: text(cells[6]), memory: text(cells[7]) });
        }
        const page = path === first ? 1 : Number(path.slice((first + '/page/').length));
        if (!Number.isSafeInteger(page) || page < 1) throw Error('无法识别 Codeforces 记录页码。');
        const nextPath = first + '/page/' + (page + 1);
        const pages = [...document.querySelectorAll('#pageContent .pagination a[href]')];
        const next = pages.find(a => a.origin === location.origin && a.pathname === nextPath);
        if (!next && pages.some(a => a.pathname.startsWith(first + '/page/') && Number(a.pathname.split('/').pop()) > page))
            throw Error('无法读取下一页 Codeforces 记录，请刷新重试。');
        const data = { ...job, handle, records: [...records.values()], notice: 'loading', verificationSince: null };
        if (next) {
            setJob(id, { ...data, message: '正在读取第 ' + (page + 1) + ' 页提交记录…' });
            location.replace(next.href);
        } else {
            sessionStorage.removeItem(prefix + 'tab');
            setJob(id, { ...data, phase: 'done', message: '已读取提交记录。' });
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
            const phase = job.phase === 'authorized' && ['verification', 'login'].includes(notice) ? 'ready' : job.phase;
            setJob(id, { ...job, phase, message, notice, verificationSince: notice === 'verification' ? Date.now() : null });
        }
        function stop(message, phase = 'error') {
            sessionStorage.removeItem(prefix + 'tab');
            const current = getJob(id);
            if (!current || GM_getValue(cancelKey(id))) return;
            const end = { ...current, code: '', phase, message };
            setJob(id, end);
        }
        const base = contestPath(job);
        const reading = job.operation === 'records';
        const loginNotice = reading ? '请在后台 Codeforces 标签页登录，登录后会继续读取记录。'
            : '尚未登录 Codeforces，请切换到新标签页登录。登录后将继续提交。';
        const path = location.pathname;
        const recordsPath = path.replace(/\/$/, '');
        const isMySubmissions = recordsPath === base + '/my' || (recordsPath === '/problemset/status'
            && new URLSearchParams(location.search).get('my') === 'on');
        function verificationFailed(message) {
            if (job.phase === 'sent') stop(message + ' 提交请求已发出，请先查看 Codeforces 的「我的提交」。', 'uncertain');
            else stop(message + (reading ? ' 请刷新记录。' : ' 请重新提交。'));
        }
        let readySince = Date.now();
        try {
            while ((job = getJob(id)) && Date.now() - job.created < lifetime) {
                if (GM_getValue(cancelKey(id))) return;
                if (job.phase === 'requesting') {
                    if (Date.now() - job.requestedAt > 30000) { stop('未收到洛谷页面的发送确认，请重新提交。'); return; }
                    await delay(200);
                    continue;
                }
                const challenge = challengePage();
                const problemError = firstVisible('.submit-form .error, form.submitForm .error, .error.for__submittedProblemIndex, .error.for__programTypeId, .error.for__source, .alert-danger, .alert-error, .error.message');
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
                    if (isMySubmissions && !problemError
                        && document.querySelector('tr[data-submission-id], a.view-source, a[href^="' + base + '/submission/"]')) {
                        stop('Codeforces 已收到提交。', 'done');
                    } else {
                        const detail = problemError?.innerText.replace(/^\s*×\s*/, '').trim();
                        if (!detail || /^error[.。!！]?$/i.test(detail)) {
                            stop('Codeforces 未确认收到提交' + (detail ? '，页面仅返回「' + detail + '」' : '') +
                                '。请先查看「我的提交」中是否有本次记录。', 'uncertain');
                        } else stop(detail);
                    }
                    return;
                }
                if (path === '/enter' || document.querySelector('#enterForm input[type="password"]')) {
                    say(loginNotice, 'login');
                    return;
                }
                const signIn = document.querySelector('a[href="/enter"], a[href^="/enter?"]');
                if (signIn && !document.querySelector('a[href$="/logout"], a[href^="/logout?"]')) {
                    say(loginNotice, 'login');
                    location.replace('/enter?' + new URLSearchParams({ back: reading ? base + '/my' : submitPath(job) }));
                    return;
                }
                if (reading) { readMySubmissions(id, job); return; }
                if (path !== submitPath(job)) {
                    // Persist the job on the public problem page before a login redirect can drop its query.
                    if (path === problemPath(job) || job.notice === 'login') {
                        say('正在打开 Codeforces 提交表单…');
                        location.replace(submitPath(job) + '?' + new URLSearchParams({ submittedProblemIndex: job.task }));
                    } else stop('Codeforces 跳转到了其他页面，请检查比赛访问权限。');
                    return;
                }
                if (problemError) { stop(problemError.innerText.trim() || 'Codeforces 返回了错误。'); return; }

                const source = document.querySelector('form textarea[name="source"]');
                const form = source?.form;
                const task = form?.querySelector('select[name="submittedProblemIndex"], input[name="submittedProblemIndex"]');
                if (task instanceof HTMLSelectElement && task.value !== job.task) {
                    if (![...task.options].some(o => o.value === job.task)) {
                        stop('此比赛的提交表单中找不到题目 ' + job.task + '。'); return;
                    }
                    task.value = job.task;
                    task.dispatchEvent(new Event('change', { bubbles: true }));
                }
                if (task instanceof HTMLInputElement && task.type === 'text' && task.value !== job.task) {
                    task.value = job.task;
                    task.dispatchEvent(new Event('input', { bubbles: true }));
                }
                const language = form?.querySelector('select[name="programTypeId"]');
                const button = form?.querySelector('input[type="submit"], button[type="submit"], button:not([type])');
                if (form && task?.value === job.task && language && button) {
                    const option = chooseLanguage(job.language, language.options);
                    if (!option) { stop('这道题没有与「' + job.language + '」兼容的语言，请在洛谷更改语言后再提交。'); return; }
                    if (widgetPending(form)) {
                        say('等待人机验证…', 'verification');
                        readySince = Date.now();
                    } else if (!button.disabled) {
                        language.value = option.value;
                        language.dispatchEvent(new Event('change', { bubbles: true }));
                        const code = job.code.replace(/\r\n?/g, '\n');
                        source.value = code;
                        source.dispatchEvent(new Event('input', { bubbles: true }));
                        const data = new FormData(form);
                        // Codeforces has an input named "action", which can shadow form.action.
                        const action = button.getAttribute('formaction') ?? form.getAttribute('action');
                        const destination = new URL(action || location.href, document.baseURI);
                        const method = button.getAttribute('formmethod') ?? form.getAttribute('method');
                        if (method?.toLowerCase() !== 'post' || destination.origin !== location.origin
                            || destination.pathname !== submitPath(job)
                            || data.get(task.name) !== job.task || data.get(language.name) !== option.value
                            || data.get(source.name) !== code) {
                            throw Error('Codeforces 表单校验失败，请查看后台标签页。');
                        }
                        if (!form.reportValidity()) throw Error('Codeforces 表单还有必填项目，请查看后台标签页。');
                        // Commit before the native click. A reload or back navigation must never replay this POST.
                        const send = () => {
                            const latest = getJob(id);
                            if (!latest || GM_getValue(cancelKey(id))) return;
                            if (widgetPending(form)) return 'wait';
                            if (latest.phase === 'ready') {
                                setJob(id, { ...latest, phase: 'requesting', requestedAt: Date.now(),
                                    notice: 'loading', message: '正在发起提交…' });
                                return 'wait';
                            }
                            if (latest.phase !== 'authorized') return;
                            setJob(id, { ...latest, code: '', phase: 'sent', posted: true, notice: 'loading',
                                message: '正在等待 Codeforces 确认…' });
                            button.click();
                            setTimeout(() => {
                                if (getJob(id)?.phase === 'sent') {
                                    say('仍在等待 Codeforces 确认…');
                                }
                            }, 12000);
                        };
                        const state = navigator.locks ? await navigator.locks.request(prefix + id, send) : send();
                        if (state !== 'wait') return;
                    }
                }
                if (Date.now() - readySince > 20000) {
                    stop('未找到可用的 Codeforces 提交表单，请在后台标签页检查登录状态及比赛权限。'); return;
                }
                await delay(400);
            }
            if (job) stop('本次提交等待已过期，请回到洛谷重新提交。');
        } catch (error) { stop(error.message); }
    }

    prune();
    if (location.hostname === 'codeforces.com') {
        const id = workerId();
        if (id) void runWorker(id);
    } else installLuogu();
})();
