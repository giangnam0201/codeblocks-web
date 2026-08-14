/* ---------------------------------------------------------------------------
   vnoi.js - VNOI Online Judge inside the IDE.

   oj.vnoi.info is a Django/DMOJ site: it serves HTML, has no JSON API
   (/api/v2/* is 404) and sends no CORS headers, so the page cannot call it
   directly.  Every request here goes through the Worker in ../worker, which
   adds the CORS headers and relays to the judge without storing anything; the
   parsing happens here, in the browser, against the same markup the CLI in
   D:\vnoi scrapes with BeautifulSoup.

   The session lives in this browser.  The judge's cookies cannot be held by
   the browser itself (they are SameSite=Lax and belong to another origin), so
   the jar is kept in localStorage and passed to the proxy in X-VNOI-Cookie.
   That means the password is typed once, sent once, and never stored.
--------------------------------------------------------------------------- */
'use strict';

const VNOI = {
    /* Where the relay lives.  It answers on its workers.dev address: a CORS
       preflight to a hostname on the codeblocks.bond zone is dropped at
       Cloudflare's edge before it ever reaches the Worker, and every POST here
       is preflighted because of the X-VNOI-Cookie header. */
    PROXY: localStorage.getItem('vnoi.proxy') ||
           'https://vnoi-proxy.namdev-account.workers.dev/vnoi',
    FALLBACK: '',
    BASE: 'https://oj.vnoi.info',
    jar: {},
    user: null,            // {name, points, rating} once logged in
    contest: null,         // the contest currently joined, if any
    current: null,         // the problem last opened (not 'problem': that is the method)
    langs: [],             // languages of the last submit form
};

/* File extension -> the language name VNOI shows in the submit form.  Same
   table the CLI uses; the real ids come from the form itself. */
VNOI.EXT_LANG = {
    cpp: 'C++20', cc: 'C++20', cxx: 'C++20', 'c++': 'C++20',
    c: 'C', py: 'Python 3', pas: 'Pascal', go: 'Go', rs: 'Rust',
    java: 'Java 8', kt: 'Kotlin',
};

/* ============================================================== transport */

VNOI.loadJar = function () {
    try { VNOI.jar = JSON.parse(localStorage.getItem('vnoi.jar') || '{}'); }
    catch (e) { VNOI.jar = {}; }
    try { VNOI.user = JSON.parse(localStorage.getItem('vnoi.user') || 'null'); }
    catch (e) { VNOI.user = null; }
};
VNOI.saveJar = function () {
    localStorage.setItem('vnoi.jar', JSON.stringify(VNOI.jar));
    localStorage.setItem('vnoi.user', JSON.stringify(VNOI.user));
};
VNOI.cookieHeader = function () {
    return Object.keys(VNOI.jar).map(k => k + '=' + VNOI.jar[k]).join('; ');
};
/* The relay hands back what the judge set as one "name=value; name=value"
   string - a header cannot carry the newlines a list of full Set-Cookie lines
   would need. */
VNOI.takeCookies = function (res) {
    const raw = res.headers.get('X-VNOI-Set-Cookie');
    if (!raw) return;
    raw.split(';').forEach(part => {
        const i = part.indexOf('=');
        if (i > 0) VNOI.jar[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    });
    VNOI.saveJar();
};

/* One request to the judge, through the relay.  Returns the parsed document
   plus the URL the judge finally landed on - a successful submit is a
   redirect, and that is how the submission id arrives. */
VNOI.req = async function (path, opts) {
    opts = opts || {};
    const url = VNOI.PROXY + path;
    const headers = {};
    const jar = VNOI.cookieHeader();
    if (jar) headers['X-VNOI-Cookie'] = jar;
    if (opts.referer) headers['X-VNOI-Referer'] = VNOI.BASE + opts.referer;

    let body;
    if (opts.form) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = new URLSearchParams(opts.form).toString();
    }

    let res;
    try {
        res = await fetch(url, { method: opts.form ? 'POST' : 'GET', headers, body });
    } catch (e) {
        /* The name may simply not have propagated to this resolver yet; the
           workers.dev address is the same Worker and always resolves. */
        if (VNOI.FALLBACK && VNOI.PROXY !== VNOI.FALLBACK) {
            try {
                res = await fetch(VNOI.FALLBACK + path,
                                  { method: opts.form ? 'POST' : 'GET', headers, body });
                VNOI.PROXY = VNOI.FALLBACK;
            } catch (e2) {
                throw new Error('Cannot reach the VNOI relay (' + VNOI.PROXY + '): ' + e.message);
            }
        } else {
            throw new Error('Cannot reach the VNOI relay (' + VNOI.PROXY + '): ' + e.message);
        }
    }
    if (res.status === 403) throw new Error('The relay refused this origin. Check ALLOWED_ORIGINS in the Worker.');
    VNOI.takeCookies(res);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');
    return { status: Number(res.headers.get('X-VNOI-Status') || res.status),
             url: res.headers.get('X-VNOI-Url') || url, html, doc };
};

/* The CSRF token Django wants back with every POST. */
VNOI.csrf = function (doc, formSel) {
    const form = formSel ? doc.querySelector(formSel) : doc;
    const input = (form || doc).querySelector('input[name="csrfmiddlewaretoken"]');
    return input ? input.value : (VNOI.jar.csrftoken || '');
};

const txt = el => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

/* The header's contest link carries the countdown inside it, so the clock has
   to come out before the name is readable. */
function contestTitle(link) {
    if (!link) return '';
    const copy = link.cloneNode(true);
    copy.querySelectorAll('#contest-time-remaining, .time-remaining').forEach(n => n.remove());
    return txt(copy).replace(/\s*[-–]\s*$/, '');
}

/* ================================================================ account */

VNOI.loggedIn = () => !!(VNOI.user && VNOI.user.name);

VNOI.login = async function (username, password) {
    const page = await VNOI.req('/accounts/login/');
    const token = VNOI.csrf(page.doc);
    if (!token) throw new Error('The login page did not carry a CSRF token.');
    const res = await VNOI.req('/accounts/login/', {
        referer: '/accounts/login/',
        form: { csrfmiddlewaretoken: token, username, password, next: '/' },
    });
    // the login form comes back with an error list when it fails
    const err = res.doc.querySelector('.errorlist, .alert-danger, .error');
    const stillForm = res.doc.querySelector('input[name="password"]');
    if (stillForm) throw new Error(txt(err) || 'Login failed: wrong username or password.');
    await VNOI.whoami();
    if (!VNOI.loggedIn()) throw new Error('Login did not take effect.');
    return VNOI.user;
};

VNOI.logout = async function () {
    try { await VNOI.req('/accounts/logout/'); } catch (e) { /* the jar goes anyway */ }
    VNOI.jar = {}; VNOI.user = null; VNOI.contest = null;
    VNOI.saveJar();
};

/* Who the judge thinks we are: the user block in the page header. */
VNOI.whoami = async function () {
    const res = await VNOI.req('/');
    const link = res.doc.querySelector('#user-links .user-name, .user-name, #user-links b');
    const name = txt(link);
    if (!name || res.doc.querySelector('a[href*="/accounts/login/"]') && !name) {
        VNOI.user = null;
    } else {
        VNOI.user = { name, points: txt(res.doc.querySelector('#user-links .rating')) || '' };
    }
    /* A contest in progress is announced in the header of every page, with
       its link and the clock. */
    const info = res.doc.querySelector('#contest-info');
    const contestLink = info && info.querySelector('a[href*="/contest/"]');
    if (contestLink) {
        const parts = (contestLink.getAttribute('href') || '').split('/').filter(Boolean);
        VNOI.contest = {
            key: parts[parts.indexOf('contest') + 1] || parts[parts.length - 1],
            title: contestTitle(contestLink),
            timeLeft: txt(res.doc.querySelector('#contest-time-remaining')),
        };
    } else {
        VNOI.contest = null;
    }
    VNOI.saveJar();
    return VNOI.user;
};

/* =============================================================== problems */

VNOI.problems = async function (opts) {
    opts = opts || {};
    const q = new URLSearchParams();
    if (opts.search) q.set('search', opts.search);
    if (opts.page) q.set('page', opts.page);
    if (opts.contest) {
        // inside a contest the problem list lives on the contest page
        return VNOI.contestProblems(opts.contest);
    }
    const res = await VNOI.req('/problems/' + (q.toString() ? '?' + q : ''));
    // the list is <table id="problem-table" class="table striped">, and the
    // header row carries the same classes on <th>, so match the cells
    const rows = res.doc.querySelectorAll('#problem-table tr, table.problem-table tr');
    const out = [];
    rows.forEach(tr => {
        const code = tr.querySelector('td.problem-code a');
        if (!code) return;
        out.push({
            code: txt(code),
            name: txt(tr.querySelector('td.problem-name a')),
            category: txt(tr.querySelector('td.category')),
            points: txt(tr.querySelector('td.p, td.points')),
            acRate: txt(tr.querySelector('.ac-rate')),
            users: txt(tr.querySelector('.users a')),
            solved: !!tr.querySelector('.solved-problem-color, .fa-check-circle'),
            editorial: !!tr.querySelector('.has-editorial-color'),
        });
    });
    // "Trang 1/128" style pager
    const pages = res.doc.querySelectorAll('.page-link, .pagination a');
    return { list: out, hasMore: pages.length > 0 };
};

VNOI.problem = async function (code) {
    const res = await VNOI.req('/problem/' + code);
    if (res.status === 404) throw new Error('No problem called "' + code + '".');
    const info = {};
    res.doc.querySelectorAll('.problem-info-entry').forEach(e => {
        const k = txt(e.querySelector('.pi-name')).replace(/:$/, '');
        const v = txt(e.querySelector('.pi-value'));
        if (k) info[k] = v;
    });
    const body = res.doc.querySelector('.content-description');
    if (body) body.querySelectorAll('iframe, script').forEach(n => n.remove());
    return {
        code,
        title: txt(res.doc.querySelector('.problem-title h2')) || code,
        html: body ? body.innerHTML : '<p>(no statement)</p>',
        points: info['Điểm'] || info['Points'] || '',
        timeLimit: info['Giới hạn thời gian'] || info['Time limit'] || '',
        memoryLimit: info['Giới hạn bộ nhớ'] || info['Memory limit'] || '',
        info,
    };
};

/* ================================================================= submit */

/* Reads the submit form: the CSRF token and the languages this problem
   actually accepts, which is the authoritative list. */
VNOI.submitForm = async function (code) {
    const res = await VNOI.req('/problem/' + code + '/submit');
    if (res.doc.querySelector('input[name="password"]'))
        throw new Error('Not logged in to VNOI.');
    const form = res.doc.querySelector('form#problem_submit') || res.doc.querySelector('form');
    if (!form) throw new Error('No submit form for "' + code + '" - is the problem open for submissions?');
    const langs = [];
    form.querySelectorAll('select[name="language"] option').forEach(o => {
        if (o.value) langs.push({ id: o.value, name: txt(o) });
    });
    VNOI.langs = langs;
    return { csrf: VNOI.csrf(form), langs };
};

const normLang = s => String(s).toLowerCase().replace(/c\+\+/g, 'cpp').replace(/[^a-z0-9]/g, '');

/* Picks the language id for a file, the way the CLI does: exact name first,
   then the extension's default, then anything that contains it. */
VNOI.pickLanguage = function (langs, wanted) {
    if (!langs.length) return null;
    if (wanted) {
        const w = normLang(wanted);
        const exact = langs.find(l => l.id === wanted || normLang(l.name) === w);
        if (exact) return exact;
        const part = langs.find(l => normLang(l.name).includes(w) || w.includes(normLang(l.name)));
        if (part) return part;
    }
    return langs.find(l => normLang(l.name) === 'cpp20')
        || langs.find(l => normLang(l.name).startsWith('cpp'))
        || langs[0];
};

VNOI.languageFor = function (fileName, langs) {
    const ext = (fileName.split('.').pop() || '').toLowerCase();
    return VNOI.pickLanguage(langs, VNOI.EXT_LANG[ext] || 'C++20');
};

VNOI.submit = async function (code, source, languageId) {
    const form = await VNOI.submitForm(code);
    const res = await VNOI.req('/problem/' + code + '/submit', {
        referer: '/problem/' + code + '/submit',
        form: { csrfmiddlewaretoken: form.csrf, source, language: languageId },
    });
    const m = /\/submission\/(\d+)/.exec(res.url);
    if (!m) {
        const err = res.doc.querySelector('.errorlist, .alert-danger, .error');
        throw new Error(txt(err) || 'The judge did not accept the submission.');
    }
    return m[1];
};

/* ============================================================ submissions */

/* One poll of a submission page: the per-test rows, the compile error and the
   final score, parsed from the same markup the CLI reads. */
VNOI.submission = async function (id) {
    const res = await VNOI.req('/submission/' + id);
    const doc = res.doc;

    let compileError = null;
    const ce = doc.querySelector('pre.compile-error, .compile-error-text');
    if (ce) compileError = ce.textContent.trim();
    if (!compileError) {
        const head = Array.from(doc.querySelectorAll('h1,h2,h3,h4,h5,h6'))
            .find(h => /biên dịch gặp lỗi|lỗi dịch|compil/i.test(h.textContent));
        if (head) {
            const pre = (doc.querySelector('#test-cases') || doc).querySelector('pre');
            compileError = pre ? pre.textContent.trim() : 'Compilation error';
        }
    }

    const cases = [];
    doc.querySelectorAll('table.submissions-status-table tr').forEach(tr => {
        if (!/case-row/.test(tr.className)) return;
        const cells = tr.querySelectorAll('td');
        if (cells.length < 5) return;
        const span = cells[1].querySelector('span');
        cases.push({
            label: txt(cells[0]),
            status: txt(span) || txt(cells[1]),
            cls: span ? span.className : '',
            time: txt(cells[2]).replace(/[[\]]/g, '').replace(',', '.'),
            memory: txt(cells[3]).replace(/[[\]]/g, ''),
            score: txt(cells[4]),
        });
    });

    let score = '', done = false;
    const all = doc.body ? doc.body.textContent : '';
    const fm = /(?:Điểm cuối cùng|Final score)\s*:?\s*([^\n]{0,60})/.exec(all);
    if (fm) { score = fm[1].replace(/\s+/g, ' ').trim(); done = true; }

    const verdictEl = doc.querySelector('.submission-result, .status, #status');
    return {
        id, cases, score, done: done || !!compileError,
        compileError,
        verdict: compileError ? 'CE' : txt(verdictEl),
        raw: res.status,
    };
};

/* Polls until the judge is finished, reporting each new test as it lands. */
VNOI.watch = async function (id, onUpdate) {
    let seen = 0;
    for (let i = 0; i < 600; i++) {
        let s;
        try { s = await VNOI.submission(id); }
        catch (e) { await sleep(1000); continue; }
        if (s.cases.length > seen) {
            onUpdate({ type: 'cases', cases: s.cases.slice(seen) });
            seen = s.cases.length;
        }
        if (s.compileError) { onUpdate({ type: 'compile', text: s.compileError }); return s; }
        if (s.done) { onUpdate({ type: 'done', score: s.score, cases: s.cases }); return s; }
        await sleep(i < 10 ? 700 : 1500);
    }
    onUpdate({ type: 'timeout' });
    return null;
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The user's own submissions, newest first. */
VNOI.submissions = async function (opts) {
    opts = opts || {};
    let path = '/submissions/';
    if (opts.problem && opts.user) path = `/problem/${opts.problem}/submissions/${opts.user}/`;
    else if (opts.problem) path = `/problem/${opts.problem}/submissions/`;
    else if (opts.user) path = `/user/${opts.user}/submissions/`;
    if (opts.page) path += '?page=' + opts.page;
    const res = await VNOI.req(path);
    const out = [];
    res.doc.querySelectorAll('.submission-row').forEach(row => {
        const link = row.querySelector('.sub-result, a[href*="/submission/"]');
        const href = link ? link.getAttribute('href') || '' : '';
        out.push({
            id: (row.id || '').replace(/\D/g, '') || (href.match(/(\d+)/) || [])[1] || '',
            verdict: txt(row.querySelector('.sub-result .state, .sub-result')),
            problem: txt(row.querySelector('.name a, .sub-info a')),
            code: (row.querySelector('.name a, .sub-info a') || {}).getAttribute
                ? (row.querySelector('.name a, .sub-info a').getAttribute('href') || '').split('/').filter(Boolean).pop() : '',
            time: txt(row.querySelector('.time-with-rel, .time')),
            runtime: txt(row.querySelector('.time.sub-prop, .sub-prop .time')),
            memory: txt(row.querySelector('.memory')),
            language: txt(row.querySelector('.language')),
            score: txt(row.querySelector('.score')),
        });
    });
    return out;
};

/* =============================================================== contests */

VNOI.contests = async function (search) {
    const res = await VNOI.req('/contests/');
    const groups = { active: [], upcoming: [], past: [] };
    const needle = (search || '').trim().toLowerCase();
    // the page lists them in sections; the join form tells us what we can do
    res.doc.querySelectorAll('.contest-block').forEach(block => {
        const a = block.querySelector('.contest-list-title');
        if (!a) return;
        const key = (a.getAttribute('href') || '').split('/').filter(Boolean).pop();
        const row = block.closest('tr');
        const joinForm = row ? row.querySelector('form[action*="/join"]') : null;
        const leaveForm = row ? row.querySelector('form[action*="/leave"]') : null;
        const item = {
            key,
            title: txt(a),
            tags: Array.from(block.querySelectorAll('.contest-tag')).map(txt),
            time: txt(block.querySelector('.time')),
            users: txt(row ? row.querySelector('a[href*="/ranking/"]') : null),
            canJoin: !!joinForm,
            joined: !!leaveForm,
        };
        // the search runs here: the judge's contest page has no search box
        if (needle && !(item.title.toLowerCase().includes(needle) ||
                        item.key.toLowerCase().includes(needle) ||
                        item.tags.join(' ').toLowerCase().includes(needle))) return;

        const section = block.closest('div[class*="contest-list"], section, .content-description');
        const heading = section ? txt(section.querySelector('h3, h4')) : '';
        if (/đang diễn ra|active|ongoing/i.test(heading) || item.joined) groups.active.push(item);
        else if (/sắp|upcoming|future/i.test(heading)) groups.upcoming.push(item);
        else groups.past.push(item);
    });
    return groups;
};

VNOI.contestAction = async function (key, action) {
    // the join/leave buttons are POST forms guarded by CSRF
    const page = await VNOI.req('/contest/' + key);
    const token = VNOI.csrf(page.doc);
    const res = await VNOI.req('/contest/' + key + '/' + action, {
        referer: '/contest/' + key,
        form: { csrfmiddlewaretoken: token },
    });
    if (res.status >= 400) throw new Error('The judge refused to ' + action + ' this contest.');
    await VNOI.whoami();
    return true;
};

/* Which contest this account is inside right now.

   Not the contests list: that page only ever offers "join" buttons, whether
   or not you are in one.  Every page carries #contest-info in the header while
   a participation is open, with the contest's own link and the clock. */
VNOI.currentContest = async function () {
    const res = await VNOI.req('/');
    const info = res.doc.querySelector('#contest-info');
    const link = info && info.querySelector('a[href*="/contest/"]');
    if (!link) { VNOI.contest = null; return null; }
    const parts = (link.getAttribute('href') || '').split('/').filter(Boolean);
    VNOI.contest = {
        key: parts[parts.indexOf('contest') + 1] || parts[parts.length - 1],
        title: contestTitle(link),
        timeLeft: txt(res.doc.querySelector('#contest-time-remaining')),
    };
    return VNOI.contest;
};

/* Joining a contest leaves the one already in progress: VNOI allows only one
   at a time, and a stale one silently swallows every submission. */
VNOI.join = async function (key) {
    const now = await VNOI.currentContest();
    if (now && now.key && now.key !== key) await VNOI.contestAction(now.key, 'leave');
    await VNOI.contestAction(key, 'join');
    await VNOI.currentContest();
    return VNOI.contest;
};
VNOI.leave = async function (key) {
    await VNOI.contestAction(key, 'leave');
    await VNOI.currentContest();
    return true;
};

VNOI.contestProblems = async function (key) {
    const res = await VNOI.req('/contest/' + key);
    const out = [];
    res.doc.querySelectorAll('table.contest-problems tr, .contest-problems tr').forEach(tr => {
        const a = tr.querySelector('a[href*="/problem/"]');
        if (!a) return;
        const cells = tr.querySelectorAll('td');
        out.push({
            code: (a.getAttribute('href') || '').split('/').filter(Boolean).pop(),
            name: txt(a),
            points: cells.length > 1 ? txt(cells[1]) : '',
            ac: cells.length > 2 ? txt(cells[2]) : '',
        });
    });
    return {
        list: out,
        title: txt(res.doc.querySelector('.contest-title, h2')),
        timeLeft: txt(res.doc.querySelector('.contest-time-left, #time-left')),
    };
};

/* The standings.  VNOJ renders this table from the page it only serves to
   signed-in users, so this parses defensively and says so when the shape is
   not what it expects. */
VNOI.ranking = async function (key) {
    const res = await VNOI.req('/contest/' + key + '/ranking/');
    if (/\/accounts\/login/.test(res.url)) throw new Error('VNOI only shows the ranking to signed-in users.');
    const rows = [];
    res.doc.querySelectorAll('tr').forEach(tr => {
        const user = tr.querySelector('.user-name, .rating, a[href*="/user/"]');
        if (!user) return;
        const cells = Array.from(tr.querySelectorAll('td')).map(txt);
        if (cells.length < 2) return;
        rows.push({
            rank: txt(tr.querySelector('.rank')) || cells[0],
            user: txt(user),
            score: txt(tr.querySelector('.user-points, .points')) || cells[cells.length - 1],
            cells,
        });
    });
    return rows;
};

VNOI.loadJar();
