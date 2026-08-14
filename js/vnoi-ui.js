/* ---------------------------------------------------------------------------
   vnoi-ui.js - the VNOI pane, in the place the Management pane used to hold.

   Tabs: Problems, Contests, Ranking, Submissions and Projects.  Projects stays
   because the IDE still has to manage files; everything else is the judge.

   Nothing here talks to VNOI directly - vnoi.js does that through the relay.
--------------------------------------------------------------------------- */
'use strict';

const VnoiUI = {};

VnoiUI.state = { problems: [], contest: null, rankingKey: null };

/* --------------------------------------------------------------- helpers */

function vel(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function vbutton(label, onClick, title) {
    const b = vel('button', 'cb vnoi-btn', label);
    if (title) b.title = title;
    b.addEventListener('click', onClick);
    return b;
}

/* Every VNOI action funnels through here so one failure cannot take the IDE
   down with it, and the reason always reaches the user. */
VnoiUI.guard = async function (what, fn, listId) {
    try {
        VnoiUI.setBusy(what + '...');
        const r = await fn();
        VnoiUI.setBusy('');
        return r;
    } catch (e) {
        VnoiUI.setBusy('');
        App.logAppend('vnoi', `${what} failed: ${e.message}\n`);
        UI.setStatus(0, 'VNOI: ' + e.message);
        VnoiUI.note(e.message, true);
        if (listId) VnoiUI.showError(listId, e.message);
        return null;
    }
};

/* When the relay is not there yet, say what to do about it rather than
   leaving an empty list behind. */
VnoiUI.showError = function (listId, message) {
    const list = document.getElementById(listId);
    if (!list) return;
    const unreachable = /relay|Failed to fetch|refused|reach/i.test(message);
    list.innerHTML = '';
    const box = vel('div');
    box.style.cssText = 'padding:10px;line-height:1.5';
    box.innerHTML = '<b>VNOI is not reachable.</b><br>' + escapeHtml(message) +
        (unreachable
            ? '<br><br>oj.vnoi.info sends no CORS headers, so the IDE talks to it ' +
              'through the Cloudflare Worker in <b>worker/vnoi-proxy.js</b>. Deploy it ' +
              '(<b>npx wrangler deploy</b>), then set its URL with the gear button above.'
            : '');
    list.appendChild(box);
};

VnoiUI.setBusy = function (text) {
    const el = document.getElementById('vnoi-busy');
    if (el) el.textContent = text || '';
};

VnoiUI.note = function (text, bad) {
    const el = document.getElementById('vnoi-note');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = bad ? '#a00000' : '';
};

/* ============================================================ the account */

VnoiUI.header = function () {
    const bar = vel('div', 'vnoi-header');
    bar.id = 'vnoi-header';
    VnoiUI.drawHeader(bar);
    return bar;
};

VnoiUI.drawHeader = function (bar) {
    bar = bar || document.getElementById('vnoi-header');
    if (!bar) return;
    bar.innerHTML = '';
    const who = vel('div', 'vnoi-who');
    if (VNOI.loggedIn()) {
        who.innerHTML = '<b>' + VNOI.user.name + '</b>' +
            (VNOI.user.points ? ' <span class="vnoi-dim">' + VNOI.user.points + '</span>' : '');
        bar.appendChild(who);
        bar.appendChild(vbutton('Log out', () => VnoiUI.guard('Log out', async () => {
            await VNOI.logout();
            VnoiUI.drawHeader();
            App.logAppend('vnoi', 'Signed out of VNOI.\n');
        })));
    } else {
        who.innerHTML = '<span class="vnoi-dim">not signed in</span>';
        bar.appendChild(who);
        bar.appendChild(vbutton('Log in...', VnoiUI.loginDialog));
    }
    bar.appendChild(vbutton('⚙', VnoiUI.settingsDialog, 'Where the VNOI relay lives'));
    const busy = vel('span', 'vnoi-dim');
    busy.id = 'vnoi-busy';
    bar.appendChild(busy);
};

VnoiUI.loginDialog = function () {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="margin-bottom:8px">Sign in to <b>oj.vnoi.info</b>.</div>
      <table style="border-spacing:6px">
        <tr><td>Username:</td><td><input class="cb" id="vn-user" style="width:180px"></td></tr>
        <tr><td>Password:</td><td><input class="cb" id="vn-pass" type="password" style="width:180px"></td></tr>
      </table>
      <div style="margin-top:8px;color:#404040">
        The password is sent once to sign in and is never stored. The session
        cookie stays in this browser.
      </div>
      <div id="vn-login-err" style="color:#a00000;margin-top:6px"></div>`;

    const go = async () => {
        const u = body.querySelector('#vn-user').value.trim();
        const p = body.querySelector('#vn-pass').value;
        if (!u || !p) return;
        const err = body.querySelector('#vn-login-err');
        err.textContent = 'Signing in...';
        try {
            await VNOI.login(u, p);
            err.textContent = '';
            w.remove();
            VnoiUI.drawHeader();
            App.logAppend('vnoi', `Signed in to VNOI as ${VNOI.user.name}.\n`);
            UI.setStatus(0, 'VNOI: signed in as ' + VNOI.user.name);
            VnoiUI.refreshAll();
        } catch (e) {
            err.textContent = e.message;
        }
    };
    const w = UI.window({
        title: 'VNOI - sign in', icon: 'assets/codeblocks.png', width: 380, body,
        buttons: [
            { label: 'Sign in', onClick: go },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
    setTimeout(() => body.querySelector('#vn-user').focus(), 0);
    body.querySelectorAll('input').forEach(i =>
        i.addEventListener('keydown', ev => { if (ev.key === 'Enter') go(); }));
};

/* The relay's address.  It is a setting rather than a constant because the
   Worker can live on a custom domain or on the free workers.dev name, and
   both are one paste away from working. */
VnoiUI.settingsDialog = function () {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="margin-bottom:6px">VNOI relay URL:</div>
      <input class="cb" id="vn-proxy" style="width:100%" value="${VNOI.PROXY}">
      <div style="margin-top:8px;color:#404040">
        oj.vnoi.info sends no CORS headers, so the IDE reaches it through a
        small Cloudflare Worker (see <b>worker/vnoi-proxy.js</b>). Deploy it with
        <b>npx wrangler deploy</b> and paste either the custom domain
        (https://vnoi.codeblocks.bond/vnoi) or the workers.dev URL it prints,
        with <b>/vnoi</b> on the end.
      </div>
      <div id="vn-proxy-state" style="margin-top:6px"></div>`;

    const test = async () => {
        const state = body.querySelector('#vn-proxy-state');
        const url = body.querySelector('#vn-proxy').value.trim().replace(/\/+$/, '');
        state.textContent = 'Testing...';
        VNOI.PROXY = url;
        try {
            const r = await VNOI.req('/');
            state.textContent = r.status === 200
                ? 'The relay answers and the judge is reachable.'
                : 'The relay answered with status ' + r.status + '.';
            state.style.color = r.status === 200 ? '#1f8a3d' : '#a00000';
        } catch (e) {
            state.textContent = e.message;
            state.style.color = '#a00000';
        }
    };
    const w = UI.window({
        title: 'VNOI - connection', icon: 'assets/codeblocks.png', width: 460, body,
        buttons: [
            { label: 'Test', onClick: test },
            { label: 'OK', onClick: () => {
                VNOI.PROXY = body.querySelector('#vn-proxy').value.trim().replace(/\/+$/, '');
                localStorage.setItem('vnoi.proxy', VNOI.PROXY);
                w.remove();
                VnoiUI.refreshAll();
            } },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

/* =========================================================== problems tab */

VnoiUI.buildProblems = function (host) {
    host.innerHTML = '';
    const search = vel('div', 'vnoi-row');
    const box = vel('input', 'cb');
    box.placeholder = 'Search problems...';
    box.style.flex = '1';
    search.appendChild(box);
    search.appendChild(vbutton('Go', () => VnoiUI.loadProblems(box.value)));
    host.appendChild(search);

    const list = vel('div', 'vnoi-list');
    list.id = 'vnoi-problem-list';
    host.appendChild(list);

    box.addEventListener('keydown', ev => { if (ev.key === 'Enter') VnoiUI.loadProblems(box.value); });
    VnoiUI.loadProblems('');
};

VnoiUI.loadProblems = function (search) {
    return VnoiUI.guard('Loading problems', async () => {
        const r = await VNOI.problems({ search });
        VnoiUI.state.problems = r.list;
        const list = document.getElementById('vnoi-problem-list');
        if (!list) return;
        list.innerHTML = '';
        if (!r.list.length) { list.appendChild(vel('div', 'vnoi-dim', 'No problems found.')); return; }
        r.list.forEach(p => {
            const row = vel('div', 'vnoi-item');
            row.innerHTML =
                `<div class="vnoi-item-title">${p.solved ? '<span class="vnoi-ac">&#10003;</span> ' : ''}` +
                `${escapeHtml(p.name || p.code)}</div>` +
                `<div class="vnoi-dim">${escapeHtml(p.code)} &middot; ${escapeHtml(p.points)} pts` +
                `${p.acRate ? ' &middot; ' + escapeHtml(p.acRate) + ' AC' : ''}</div>`;
            row.addEventListener('click', () => VnoiUI.openProblem(p.code));
            list.appendChild(row);
        });
        App.logAppend('vnoi', `Loaded ${r.list.length} problems${search ? ' matching "' + search + '"' : ''}.\n`);
    });
};

const escapeHtml = s => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* Opens the statement as an editor tab, with the buttons that matter next to
   it: create a source file for it, and submit. */
VnoiUI.openProblem = function (code) {
    return VnoiUI.guard('Opening ' + code, async () => {
        const p = await VNOI.problem(code);
        VNOI.current = p;
        const key = 'vnoi:' + code;
        if (App.nbEditors.indexOf(key) >= 0) { App.nbEditors.select(key); return p; }

        const host = vel('div', 'vnoi-statement');
        const head = vel('div', 'vnoi-statement-head');
        head.innerHTML =
            `<h2>${escapeHtml(p.title)}</h2>` +
            `<div class="vnoi-dim">${escapeHtml(p.code)}` +
            (p.timeLimit ? ' &middot; time ' + escapeHtml(p.timeLimit) : '') +
            (p.memoryLimit ? ' &middot; memory ' + escapeHtml(p.memoryLimit) : '') +
            (p.points ? ' &middot; ' + escapeHtml(p.points) + ' points' : '') + '</div>';
        const bar = vel('div', 'vnoi-row');
        bar.appendChild(vbutton('Write a solution', () => VnoiUI.solutionFile(p)));
        bar.appendChild(vbutton('Submit current file', () => VnoiUI.submitCurrent(p.code)));
        bar.appendChild(vbutton('My submissions', () => VnoiUI.loadSubmissions({ problem: p.code })));
        head.appendChild(bar);
        host.appendChild(head);

        const body = vel('div', 'vnoi-statement-body');
        body.innerHTML = p.html;
        body.querySelectorAll('a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
        body.querySelectorAll('img').forEach(img => {
            const src = img.getAttribute('src') || '';
            if (src.startsWith('/')) img.src = VNOI.BASE + src;
        });
        host.appendChild(body);

        App.nbEditors.addPage(key, code, host, 'assets/icons/tree/file.svg', true);
        App.nbEditors.select(key);
        return p;
    });
};

/* A source file to write the answer in, named after the problem. */
VnoiUI.solutionFile = function (p) {
    const name = p.code + '.cpp';
    const existing = App.files.find(f => f.name === name);
    if (existing) { App.nbEditors.select(existing.key); return existing; }
    const f = App.openFile(name, VnoiUI.template(p));
    if (App.activeProject) { f.project = App.activeProject; App.activeProject.files.push(name); }
    App.refreshTrees();
    return f;
};

VnoiUI.template = function (p) {
    return `// ${p.title}\n// https://oj.vnoi.info/problem/${p.code}\n` +
           `// time ${p.timeLimit || '?'}, memory ${p.memoryLimit || '?'}\n\n` +
           `#include <bits/stdc++.h>\nusing namespace std;\n\n` +
           `int main()\n{\n    ios_base::sync_with_stdio(false);\n    cin.tie(nullptr);\n\n` +
           `    return 0;\n}\n`;
};

/* ============================================================== submitting */

/* Submits whatever source file is in front, to the problem given (or the one
   whose statement is open, or the one the file is named after). */
VnoiUI.submitCurrent = function (code) {
    return VnoiUI.guard('Submitting', async () => {
        if (!VNOI.loggedIn()) { VnoiUI.loginDialog(); return null; }
        const f = App.activeSourceFile();
        if (!f) { VnoiUI.note('Open the source file you want to submit first.', true); return null; }
        const problem = code || (VNOI.current && VNOI.current.code) || f.name.replace(/\.[^.]*$/, '');

        const form = await VNOI.submitForm(problem);
        const lang = VNOI.languageFor(f.name, form.langs);
        if (!lang) { VnoiUI.note('This problem accepts no language this file could use.', true); return null; }

        const ok = await UI.messageBox(
            `Submit ${f.name} to "${problem}" as ${lang.name}?`,
            'VNOI', ['Yes', 'No'], '❓');
        if (ok !== 'Yes') return null;

        App.selectLogTab('vnoi');
        App.logAppend('vnoi', `\nSubmitting ${f.name} to ${problem} as ${lang.name}...\n`);
        const id = await VNOI.submit(problem, f.text(), lang.id);
        App.logAppend('vnoi', `Submission #${id} accepted by the judge. Grading:\n`);
        UI.setStatus(0, `VNOI: submission #${id} queued`);

        await VNOI.watch(id, ev => {
            if (ev.type === 'cases') {
                ev.cases.forEach(c => App.logAppend('vnoi',
                    `  ${c.label}  ${c.status}   time ${c.time}  memory ${c.memory}  score ${c.score}\n`,
                    /AC/i.test(c.status) ? '' : 'err'));
            } else if (ev.type === 'compile') {
                App.logAppend('vnoi', 'Compilation error:\n' + ev.text + '\n', 'err');
                UI.setStatus(0, 'VNOI: compilation error');
            } else if (ev.type === 'done') {
                const good = /^(\d+(?:[.,]\d+)?)\s*\/\s*\1\b/.test(ev.score);
                App.logAppend('vnoi', `Final score: ${ev.score}\n`, good ? '' : 'err');
                UI.setStatus(0, 'VNOI: ' + (ev.score || 'graded'));
            } else if (ev.type === 'timeout') {
                App.logAppend('vnoi', 'Gave up waiting for the judge.\n', 'err');
            }
        });
        VnoiUI.loadSubmissions({ problem });
        return id;
    });
};

/* =========================================================== contests tab */

VnoiUI.buildContests = function (host) {
    host.innerHTML = '';
    const bar = vel('div', 'vnoi-row');
    bar.appendChild(vbutton('Refresh', () => VnoiUI.loadContests()));
    const note = vel('span', 'vnoi-dim');
    note.id = 'vnoi-note';
    bar.appendChild(note);
    host.appendChild(bar);
    const list = vel('div', 'vnoi-list');
    list.id = 'vnoi-contest-list';
    host.appendChild(list);
    VnoiUI.loadContests();
};

VnoiUI.loadContests = function () {
    return VnoiUI.guard('Loading contests', async () => {
        const groups = await VNOI.contests();
        const list = document.getElementById('vnoi-contest-list');
        if (!list) return;
        list.innerHTML = '';
        const section = (title, items) => {
            if (!items.length) return;
            list.appendChild(vel('div', 'vnoi-section', title));
            items.forEach(c => {
                const row = vel('div', 'vnoi-item');
                row.innerHTML =
                    `<div class="vnoi-item-title">${escapeHtml(c.title)}</div>` +
                    `<div class="vnoi-dim">${escapeHtml(c.time)}` +
                    (c.users ? ' &middot; ' + escapeHtml(c.users) + ' users' : '') + '</div>';
                const acts = vel('div', 'vnoi-row');
                acts.appendChild(vbutton('Problems', () => VnoiUI.openContest(c.key)));
                acts.appendChild(vbutton('Ranking', () => VnoiUI.showRanking(c.key)));
                if (c.joined) acts.appendChild(vbutton('Leave', () => VnoiUI.leave(c.key)));
                else if (c.canJoin) acts.appendChild(vbutton('Join', () => VnoiUI.join(c.key)));
                row.appendChild(acts);
                list.appendChild(row);
            });
        };
        section('Running / joined', groups.active);
        section('Upcoming', groups.upcoming);
        section('Past', groups.past);
        App.logAppend('vnoi',
            `Contests: ${groups.active.length} running, ${groups.upcoming.length} upcoming, ${groups.past.length} past.\n`);
    });
};

VnoiUI.join = function (key) {
    return VnoiUI.guard('Joining ' + key, async () => {
        await VNOI.join(key);
        App.logAppend('vnoi', `Joined contest ${key}.\n`);
        UI.setStatus(0, 'VNOI: joined ' + key);
        VnoiUI.loadContests();
        VnoiUI.openContest(key);
    });
};

VnoiUI.leave = function (key) {
    return VnoiUI.guard('Leaving ' + key, async () => {
        const ok = await UI.messageBox(`Leave the contest "${key}"?`, 'VNOI', ['Yes', 'No'], '❓');
        if (ok !== 'Yes') return;
        await VNOI.leave(key);
        App.logAppend('vnoi', `Left contest ${key}.\n`);
        VnoiUI.loadContests();
    });
};

VnoiUI.openContest = function (key) {
    return VnoiUI.guard('Opening contest ' + key, async () => {
        const c = await VNOI.contestProblems(key);
        VnoiUI.state.contest = key;
        const list = document.getElementById('vnoi-problem-list');
        App.nbManagement.select('vnoi-problems');
        if (!list) return;
        list.innerHTML = '';
        list.appendChild(vel('div', 'vnoi-section', c.title || key));
        if (!c.list.length) list.appendChild(vel('div', 'vnoi-dim', 'No problems listed - are you in this contest?'));
        c.list.forEach(p => {
            const row = vel('div', 'vnoi-item');
            row.innerHTML = `<div class="vnoi-item-title">${escapeHtml(p.name)}</div>` +
                            `<div class="vnoi-dim">${escapeHtml(p.code)}` +
                            (p.points ? ' &middot; ' + escapeHtml(p.points) + ' pts' : '') + '</div>';
            row.addEventListener('click', () => VnoiUI.openProblem(p.code));
            list.appendChild(row);
        });
    });
};

/* ============================================================ ranking tab */

VnoiUI.buildRanking = function (host) {
    host.innerHTML = '';
    const bar = vel('div', 'vnoi-row');
    const key = vel('input', 'cb');
    key.placeholder = 'contest key';
    key.id = 'vnoi-rank-key';
    key.style.flex = '1';
    bar.appendChild(key);
    bar.appendChild(vbutton('Show', () => VnoiUI.showRanking(key.value.trim())));
    host.appendChild(bar);
    const list = vel('div', 'vnoi-list');
    list.id = 'vnoi-ranking';
    host.appendChild(list);
};

VnoiUI.showRanking = function (key) {
    if (!key) return;
    App.nbManagement.select('vnoi-ranking');
    const box = document.getElementById('vnoi-rank-key');
    if (box) box.value = key;
    return VnoiUI.guard('Loading the ranking', async () => {
        const rows = await VNOI.ranking(key);
        const list = document.getElementById('vnoi-ranking');
        if (!list) return;
        list.innerHTML = '';
        list.appendChild(vel('div', 'vnoi-section', key));
        if (!rows.length) {
            list.appendChild(vel('div', 'vnoi-dim',
                'No standings rows found. VNOI renders this table only for signed-in users.'));
            return;
        }
        rows.forEach(r => {
            const row = vel('div', 'vnoi-item');
            row.innerHTML = `<div class="vnoi-item-title">${escapeHtml(r.rank)}. ${escapeHtml(r.user)}</div>` +
                            `<div class="vnoi-dim">${escapeHtml(r.score)}</div>`;
            list.appendChild(row);
        });
    });
};

/* ======================================================== submissions tab */

VnoiUI.buildSubmissions = function (host) {
    host.innerHTML = '';
    const bar = vel('div', 'vnoi-row');
    bar.appendChild(vbutton('Mine', () => VnoiUI.loadSubmissions({ user: VNOI.user && VNOI.user.name })));
    bar.appendChild(vbutton('All', () => VnoiUI.loadSubmissions({})));
    host.appendChild(bar);
    const list = vel('div', 'vnoi-list');
    list.id = 'vnoi-submissions';
    host.appendChild(list);
};

VnoiUI.loadSubmissions = function (opts) {
    App.nbManagement.select('vnoi-submissions');
    return VnoiUI.guard('Loading submissions', async () => {
        const rows = await VNOI.submissions(opts || {});
        const list = document.getElementById('vnoi-submissions');
        if (!list) return;
        list.innerHTML = '';
        if (!rows.length) { list.appendChild(vel('div', 'vnoi-dim', 'Nothing here yet.')); return; }
        rows.forEach(s => {
            const row = vel('div', 'vnoi-item');
            const good = /AC|Accepted/i.test(s.verdict);
            row.innerHTML =
                `<div class="vnoi-item-title">${escapeHtml(s.problem || s.code)}</div>` +
                `<div class="vnoi-dim"><span class="${good ? 'vnoi-ac' : 'vnoi-wa'}">` +
                `${escapeHtml(s.verdict || '?')}</span>` +
                (s.score ? ' &middot; ' + escapeHtml(s.score) : '') +
                (s.runtime ? ' &middot; ' + escapeHtml(s.runtime) : '') +
                (s.language ? ' &middot; ' + escapeHtml(s.language) : '') + '</div>';
            if (s.id) row.addEventListener('click', () => VnoiUI.showSubmission(s.id));
            list.appendChild(row);
        });
    });
};

VnoiUI.showSubmission = function (id) {
    return VnoiUI.guard('Reading submission #' + id, async () => {
        const s = await VNOI.submission(id);
        App.selectLogTab('vnoi');
        App.logAppend('vnoi', `\nSubmission #${id}:\n`);
        if (s.compileError) App.logAppend('vnoi', s.compileError + '\n', 'err');
        s.cases.forEach(c => App.logAppend('vnoi',
            `  ${c.label}  ${c.status}   time ${c.time}  memory ${c.memory}  score ${c.score}\n`,
            /AC/i.test(c.status) ? '' : 'err'));
        if (s.score) App.logAppend('vnoi', `Final score: ${s.score}\n`);
    });
};

/* ================================================================== setup */

VnoiUI.refreshAll = function () {
    VnoiUI.loadProblems('');
    VnoiUI.loadContests();
};

/* Called from app.js once the notebook exists. */
VnoiUI.install = function (nb) {
    const caption = document.querySelector('#pane-management .pane-caption .title');
    if (caption) caption.textContent = 'VNOI';

    const pane = document.querySelector('#pane-management .pane-body');
    if (pane && !document.getElementById('vnoi-header')) pane.insertBefore(VnoiUI.header(), pane.firstChild);

    const problems = vel('div', 'vnoi-tab');
    const contests = vel('div', 'vnoi-tab');
    const ranking = vel('div', 'vnoi-tab');
    const submissions = vel('div', 'vnoi-tab');

    nb.addPage('vnoi-problems', 'Problems', problems);
    nb.addPage('vnoi-contests', 'Contests', contests);
    nb.addPage('vnoi-ranking', 'Ranking', ranking);
    nb.addPage('vnoi-submissions', 'Submissions', submissions);

    VnoiUI.buildProblems(problems);
    VnoiUI.buildContests(contests);
    VnoiUI.buildRanking(ranking);
    VnoiUI.buildSubmissions(submissions);
    nb.select('vnoi-problems');

    if (VNOI.loggedIn()) {
        // confirm the stored session is still good
        VNOI.whoami().then(() => VnoiUI.drawHeader()).catch(() => {});
    }
};
