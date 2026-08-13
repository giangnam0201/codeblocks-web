/* ---------------------------------------------------------------------------
   features.js - the rest of the Code::Blocks commands.

   Everything here is a real Code::Blocks feature, wired to the menu item id
   that the desktop IDE uses (the ids come from the XRC resources, so the
   accelerators in the menus drive these directly).

   Grouped as: editor commands, bookmarks, folding, line/case operations,
   search, view/perspectives, project, build, debugger windows, and the
   contrib plugins - To-Do list, code statistics, AStyle, abbreviations,
   occurrences highlighting, open/closed file lists, thread search, the
   scripting console and the C::B games (cbTris and Snake).
--------------------------------------------------------------------------- */
'use strict';

const Features = {};

/* ============================================================ small helpers */

function cmOf() {
    const f = App.activeFile();
    return f && f.cm ? f.cm : null;
}
function eachSelectedLine(cm, fn) {
    const from = cm.getCursor('from').line, to = cm.getCursor('to').line;
    for (let l = from; l <= to; l++) fn(l);
}
function selectionOrWord(cm) {
    if (cm.somethingSelected()) return cm.getSelection();
    const w = cm.findWordAt(cm.getCursor());
    return cm.getRange(w.anchor, w.head);
}

/* ================================================================ bookmarks */

/* Code::Blocks keeps bookmarks per editor and shows them in the marker
   margin, next to the breakpoints. */
Features.toggleBookmark = function (line) {
    const f = App.activeFile();
    const cm = cmOf();
    if (!f || !cm) return;
    if (!f.bookmarks) f.bookmarks = new Set();
    const l = line === undefined ? cm.getCursor().line + 1 : line;
    if (f.bookmarks.has(l)) f.bookmarks.delete(l); else f.bookmarks.add(l);
    Features.refreshBookmarks(f);
};

/* Breakpoints and bookmarks share the marker margin, so one redraw does both. */
Features.refreshBookmarks = function () {
    App.refreshBreakpoints();
};

Features.gotoBookmark = function (dir) {
    const f = App.activeFile();
    const cm = cmOf();
    if (!f || !cm || !f.bookmarks || !f.bookmarks.size) return;
    const cur = cm.getCursor().line + 1;
    const all = Array.from(f.bookmarks).sort((a, b) => a - b);
    let target = dir > 0 ? all.find(l => l > cur) : all.slice().reverse().find(l => l < cur);
    if (target === undefined) target = dir > 0 ? all[0] : all[all.length - 1];
    App.gotoLine(target);
};

/* ================================================================== folding */

Features.foldAll = function (open) {
    const cm = cmOf();
    if (!cm) return;
    for (let l = cm.firstLine(); l <= cm.lastLine(); l++)
        cm.foldCode({ line: l, ch: 0 }, null, open ? 'unfold' : 'fold');
};

Features.foldBlock = function (mode) {
    const cm = cmOf();
    if (!cm) return;
    cm.foldCode(cm.getCursor(), null, mode);
};

/* ====================================================== line / case commands */

Features.lineOps = {
    duplicate(cm) {
        const sel = cm.somethingSelected();
        if (sel) {
            const text = cm.getSelection();
            cm.replaceSelection(text + text, 'end');
            return;
        }
        const l = cm.getCursor().line;
        const text = cm.getLine(l);
        cm.replaceRange(text + '\n', { line: l, ch: 0 });
    },
    cut(cm) {
        const l = cm.getCursor().line;
        Features.lineClipboard = cm.getLine(l);
        cm.replaceRange('', { line: l, ch: 0 },
                        { line: l + 1, ch: 0 } , '+delete');
    },
    copy(cm) { Features.lineClipboard = cm.getLine(cm.getCursor().line); },
    paste(cm) {
        if (Features.lineClipboard === undefined) return;
        const l = cm.getCursor().line;
        cm.replaceRange(Features.lineClipboard + '\n', { line: l, ch: 0 });
    },
    del(cm) { cm.execCommand('deleteLine'); },
    transpose(cm) {
        const l = cm.getCursor().line;
        if (l === 0) return;
        const a = cm.getLine(l - 1), b = cm.getLine(l);
        cm.replaceRange(b + '\n' + a, { line: l - 1, ch: 0 }, { line: l, ch: b.length });
    },
    up(cm) { cm.execCommand('swapLineUp'); },
    down(cm) { cm.execCommand('swapLineDown'); },
};

Features.changeCase = function (upper) {
    const cm = cmOf();
    if (!cm) return;
    if (!cm.somethingSelected()) {
        const w = cm.findWordAt(cm.getCursor());
        cm.setSelection(w.anchor, w.head);
    }
    const t = cm.getSelection();
    cm.replaceSelection(upper ? t.toUpperCase() : t.toLowerCase(), 'around');
};

/* Stream- and box-comments, as the Edit menu offers them. */
Features.streamComment = function () {
    const cm = cmOf();
    if (!cm) return;
    if (cm.somethingSelected()) cm.replaceSelection('/* ' + cm.getSelection() + ' */', 'around');
    else {
        const c = cm.getCursor();
        cm.replaceRange('/*  */', c);
        cm.setCursor({ line: c.line, ch: c.ch + 3 });
    }
};

Features.boxComment = function () {
    const cm = cmOf();
    if (!cm) return;
    const from = cm.getCursor('from').line, to = cm.getCursor('to').line;
    const lines = [];
    for (let l = from; l <= to; l++) lines.push(cm.getLine(l));
    const indent = (lines[0].match(/^\s*/) || [''])[0];
    const body = lines.map(l => indent + ' * ' + l.replace(/^\s*/, '')).join('\n');
    cm.replaceRange(indent + '/*\n' + body + '\n' + indent + ' */\n',
                    { line: from, ch: 0 }, { line: to + 1, ch: 0 });
};

/* Select next occurrence of the current word (Ctrl-E in Code::Blocks). */
Features.selectNextOccurrence = function (skip) {
    const cm = cmOf();
    if (!cm) return;
    const word = selectionOrWord(cm);
    if (!word) return;
    const cur = cm.getSearchCursor(word, cm.getCursor('to'));
    if (!cur.findNext()) {
        const wrap = cm.getSearchCursor(word, { line: 0, ch: 0 });
        if (!wrap.findNext()) return;
        cm.setSelection(wrap.from(), wrap.to());
        return;
    }
    if (skip) cm.setCursor(cur.to());
    else cm.setSelection(cur.from(), cur.to());
    cm.scrollIntoView({ from: cur.from(), to: cur.to() }, 60);
};

/* ==================================================================== zoom */

Features.zoom = function (delta) {
    App.zoomLevel = delta === 0 ? 0 : Math.max(-6, Math.min(14, (App.zoomLevel || 0) + delta));
    const size = 13 + App.zoomLevel;
    App.files.forEach(f => {
        if (!f.cm) return;
        f.cm.getWrapperElement().style.fontSize = size + 'px';
        f.cm.refresh();
    });
};

/* ============================================== occurrences highlighting */

/* The "Occurrences highlighting" plugin: every instance of the word under the
   caret gets a soft background, the way the desktop IDE does it. */
Features.highlightOccurrences = function (cm) {
    (App.occMarks || []).forEach(m => m.clear());
    App.occMarks = [];
    if (!cm || !App.highlightOccurrencesOn) return;
    if (cm.somethingSelected() && cm.getSelection().indexOf('\n') >= 0) return;
    const word = selectionOrWord(cm);
    if (!word || word.length < 2 || /^\s+$/.test(word)) return;

    const marks = [];
    const cur = cm.getSearchCursor(word, { line: 0, ch: 0 });
    let n = 0;
    while (cur.findNext() && n++ < 500) {
        const around = cm.getRange({ line: cur.from().line, ch: Math.max(0, cur.from().ch - 1) },
                                   { line: cur.to().line, ch: cur.to().ch + 1 });
        if (!/^\W?\w+\W?$/.test(around) && around !== word) continue;   // whole words only
        marks.push(cm.markText(cur.from(), cur.to(), { className: 'cb-occurrence' }));
    }
    App.occMarks = marks;
};

/* ============================================================== abbreviations */

/* The Abbreviations plugin: type the name and press Ctrl-J. */
const ABBREVIATIONS = {
    for: 'for (int i = 0; i < |; i++)\n{\n    \n}',
    fori: 'for (int i = 0; i < |; ++i)\n{\n    \n}',
    while: 'while (|)\n{\n    \n}',
    do: 'do\n{\n    |\n} while ();',
    if: 'if (|)\n{\n    \n}',
    ife: 'if (|)\n{\n    \n}\nelse\n{\n    \n}',
    switch: 'switch (|)\n{\n    case :\n        break;\n    default:\n        break;\n}',
    struct: 'struct |\n{\n    \n};',
    class: 'class |\n{\n    public:\n        \n    protected:\n        \n    private:\n        \n};',
    main: 'int main(int argc, char** argv)\n{\n    |\n    return 0;\n}',
    guard: '#ifndef |_H\n#define _H\n\n#endif',
    inc: '#include <|>',
    cout: 'std::cout << | << std::endl;',
    vec: 'std::vector<|> ;',
};

Features.expandAbbreviation = function () {
    const cm = cmOf();
    if (!cm) return;
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line).slice(0, cur.ch);
    const m = /([A-Za-z_]\w*)$/.exec(line);
    if (!m) return;
    const body = ABBREVIATIONS[m[1]];
    if (!body) {
        UI.setStatus(0, `No abbreviation named "${m[1]}"`);
        return;
    }
    const indent = (cm.getLine(cur.line).match(/^\s*/) || [''])[0];
    const text = body.split('\n').join('\n' + indent);
    const caret = text.indexOf('|');
    const final = text.replace('|', '');
    const start = { line: cur.line, ch: cur.ch - m[1].length };
    cm.replaceRange(final, start, cur);
    if (caret >= 0) {
        const before = final.slice(0, caret).split('\n');
        cm.setCursor({
            line: start.line + before.length - 1,
            ch: before.length === 1 ? start.ch + before[0].length : before[before.length - 1].length,
        });
    }
    cm.focus();
};

/* ============================================================ code completion */

const CPP_KEYWORDS = ('alignas alignof auto bool break case catch char char16_t char32_t class ' +
    'const constexpr const_cast continue decltype default delete do double dynamic_cast else enum ' +
    'explicit export extern false float for friend goto if inline int long mutable namespace new ' +
    'noexcept nullptr operator private protected public register reinterpret_cast return short ' +
    'signed sizeof static static_assert static_cast struct switch template this thread_local throw ' +
    'true try typedef typeid typename union unsigned using virtual void volatile wchar_t while')
    .split(' ');

const STD_SYMBOLS = ('cout cin cerr endl string vector map set unordered_map unordered_set pair ' +
    'make_pair sort reverse find count accumulate max min max_element min_element push_back ' +
    'pop_back size empty begin end insert erase clear substr length resize printf scanf sqrt pow ' +
    'abs floor ceil round getline to_string stoi stod swap next_permutation lower_bound upper_bound')
    .split(' ');

/* Ctrl-Space, like the CodeCompletion plugin. */
Features.codeComplete = function () {
    const cm = cmOf();
    if (!cm) return;
    const cur = cm.getCursor();
    const line = cm.getLine(cur.line).slice(0, cur.ch);
    const m = /([A-Za-z_]\w*)$/.exec(line);
    const prefix = m ? m[1] : '';

    // everything declared in this file, plus the language and library names
    const text = cm.getValue();
    const locals = new Set();
    const re = /\b(?:int|long|short|char|bool|float|double|auto|string|size_t)\s+([A-Za-z_]\w*)/g;
    let mm;
    while ((mm = re.exec(text)) !== null) locals.add(mm[1]);
    const fnRe = /\b([A-Za-z_]\w*)\s*\([^;{]*\)\s*\{/g;
    while ((mm = fnRe.exec(text)) !== null) locals.add(mm[1]);

    const all = Array.from(new Set([...locals, ...CPP_KEYWORDS, ...STD_SYMBOLS]))
        .filter(w => w.toLowerCase().startsWith(prefix.toLowerCase()) && w !== prefix)
        .sort();
    if (!all.length) { UI.setStatus(0, 'No completions'); return; }

    const start = { line: cur.line, ch: cur.ch - prefix.length };
    const coords = cm.charCoords(start, 'page');
    const list = el('div', 'cb-complete');
    all.slice(0, 200).forEach((w, i) => {
        const row = el('div', 'row' + (i === 0 ? ' selected' : ''), w);
        row.addEventListener('mousedown', ev => {
            ev.preventDefault();
            cm.replaceRange(w, start, cur);
            close();
            cm.focus();
        });
        list.appendChild(row);
    });
    list.style.left = coords.left + 'px';
    list.style.top = (coords.bottom + 2) + 'px';
    document.body.appendChild(list);

    let sel = 0;
    const rows = Array.from(list.children);
    const move = d => {
        rows[sel].classList.remove('selected');
        sel = Math.max(0, Math.min(rows.length - 1, sel + d));
        rows[sel].classList.add('selected');
        rows[sel].scrollIntoView({ block: 'nearest' });
    };
    const close = () => {
        list.remove();
        cm.off('keydown', onKey);
        document.removeEventListener('mousedown', onDoc, true);
    };
    const onDoc = ev => { if (!ev.target.closest('.cb-complete')) close(); };
    const onKey = (_, ev) => {
        if (ev.key === 'ArrowDown') { ev.preventDefault(); move(1); }
        else if (ev.key === 'ArrowUp') { ev.preventDefault(); move(-1); }
        else if (ev.key === 'Enter' || ev.key === 'Tab') {
            ev.preventDefault();
            cm.replaceRange(rows[sel].textContent, start, cm.getCursor());
            close();
        } else if (ev.key === 'Escape') { ev.preventDefault(); close(); }
    };
    cm.on('keydown', onKey);
    setTimeout(() => document.addEventListener('mousedown', onDoc, true), 0);
};

/* Call tips: the signature of the function the caret sits in. */
const CALLTIPS = {
    printf: 'int printf(const char* format, ...)',
    scanf: 'int scanf(const char* format, ...)',
    sort: 'void sort(RandomIt first, RandomIt last)\nvoid sort(RandomIt first, RandomIt last, Compare comp)',
    getline: 'istream& getline(istream& is, string& str)\nistream& getline(istream& is, string& str, char delim)',
    substr: 'string substr(size_t pos = 0, size_t count = npos) const',
    find: 'size_t find(const string& str, size_t pos = 0) const',
    push_back: 'void push_back(const T& value)',
    resize: 'void resize(size_t count)\nvoid resize(size_t count, const T& value)',
    max: 'const T& max(const T& a, const T& b)',
    min: 'const T& min(const T& a, const T& b)',
    sqrt: 'double sqrt(double x)',
    pow: 'double pow(double base, double exp)',
};

Features.showCallTip = function () {
    const cm = cmOf();
    if (!cm) return;
    const cur = cm.getCursor();
    const before = cm.getLine(cur.line).slice(0, cur.ch);
    const m = /([A-Za-z_]\w*)\s*\([^()]*$/.exec(before) || /([A-Za-z_]\w*)$/.exec(before);
    const name = m && m[1];
    const tip = name && CALLTIPS[name];
    if (!tip) { UI.setStatus(0, 'No call tip available'); return; }

    const old = document.querySelector('.cb-calltip');
    if (old) old.remove();
    const box = el('div', 'cb-calltip');
    box.textContent = tip;
    const coords = cm.charCoords(cur, 'page');
    box.style.left = coords.left + 'px';
    box.style.top = (coords.top - 4) + 'px';
    box.style.transform = 'translateY(-100%)';
    document.body.appendChild(box);
    const kill = () => box.remove();
    setTimeout(() => document.addEventListener('mousedown', kill, { once: true }), 0);
    cm.on('cursorActivity', kill);
};

/* ================================================================== AStyle */

/* The "Source code formatter (AStyle)" plugin.  Re-indents by brace depth and
   tidies spacing; it deliberately does not move braces around. */
Features.formatSource = function () {
    const cm = cmOf();
    if (!cm) return;
    const src = cm.getValue();
    const indentText = '    ';
    const out = [];
    let depth = 0;
    let inBlockComment = false;

    for (let raw of src.split('\n')) {
        let line = raw.trim();

        if (inBlockComment) {
            out.push(line ? ' '.repeat(depth * 4) + ' ' + line : '');
            if (line.indexOf('*/') >= 0) inBlockComment = false;
            continue;
        }
        if (!line) { out.push(''); continue; }

        // tidy spacing outside of strings and character literals
        if (!/^\s*(#|\/\/)/.test(line)) {
            line = line.replace(/(".*?"|'.*?')|\s*,\s*/g, (mm, lit) => lit || ', ')
                       .replace(/(".*?"|'.*?')|\s*;\s*(?=\S)/g, (mm, lit) => lit || '; ')
                       .replace(/\s+/g, ' ');
        }

        const opens = (line.match(/\{/g) || []).length;
        const closes = (line.match(/\}/g) || []).length;
        const isLabel = /^(public|private|protected|case\b|default\s*:)/.test(line);

        if (line.startsWith('}') || (closes > opens)) depth = Math.max(0, depth - (closes - opens));
        const isPreproc = line.startsWith('#');
        const pad = isPreproc ? '' : indentText.repeat(isLabel ? Math.max(0, depth - 1) : depth);
        out.push(pad + line);

        if (opens > closes) depth += opens - closes;
        if (line.indexOf('/*') >= 0 && line.indexOf('*/') < 0) inBlockComment = true;
    }

    const cursor = cm.getCursor();
    cm.setValue(out.join('\n'));
    cm.setCursor(cursor);
    UI.setStatus(0, 'Source formatted (AStyle)');
};

/* ============================================================== To-Do list */

const TODO_TYPES = ['TODO', 'FIXME', 'NOTE', 'BUG', 'HACK'];

Features.scanTodo = function () {
    const rows = [];
    App.files.forEach(f => {
        f.text().split('\n').forEach((line, i) => {
            const m = new RegExp(`(?://|/\\*|\\*)\\s*(${TODO_TYPES.join('|')})\\s*[:(]?\\s*(.*)`).exec(line);
            if (m) rows.push({ file: f, line: i + 1, type: m[1], text: m[2].replace(/\*\/\s*$/, '').trim() });
        });
    });
    return rows;
};

Features.showTodo = function () {
    const rows = Features.scanTodo();
    const box = document.getElementById('todo-body');
    if (!box) return;
    box.innerHTML = '<table class="log-grid"><thead><tr><th style="width:70px">Type</th>' +
        '<th style="width:120px">File</th><th style="width:50px">Line</th><th>Text</th>' +
        '</tr></thead><tbody></tbody></table>';
    const tb = box.querySelector('tbody');
    if (!rows.length) {
        tb.innerHTML = '<tr><td colspan="4" style="color:#666">No to-do items found</td></tr>';
    } else {
        rows.forEach(r => {
            const tr = document.createElement('tr');
            tr.innerHTML = `<td>${r.type}</td><td>${r.file.name}</td><td>${r.line}</td><td>${r.text}</td>`;
            tr.addEventListener('dblclick', () => {
                App.nbEditors.select(r.file.key);
                App.gotoLine(r.line);
            });
            tb.appendChild(tr);
        });
    }
    App.selectLogTab('todo');
};

/* ======================================================== code statistics */

/* The codestat plugin: counts code, comment and empty lines. */
Features.codeStatistics = function () {
    let code = 0, comments = 0, empty = 0, total = 0, codeAndComments = 0;
    const perFile = [];
    App.files.forEach(f => {
        let c = 0, cm = 0, e = 0, both = 0;
        let inBlock = false;
        f.text().split('\n').forEach(raw => {
            const line = raw.trim();
            total++;
            if (!line) { e++; return; }
            if (inBlock) {
                cm++;
                if (line.indexOf('*/') >= 0) inBlock = false;
                return;
            }
            if (line.startsWith('//')) { cm++; return; }
            if (line.startsWith('/*')) {
                cm++;
                if (line.indexOf('*/') < 0) inBlock = true;
                return;
            }
            if (line.indexOf('//') > 0 || line.indexOf('/*') > 0) { both++; c++; return; }
            c++;
        });
        code += c; comments += cm; empty += e; codeAndComments += both;
        perFile.push({ name: f.name, code: c, comments: cm, empty: e, total: c + cm + e });
    });

    const body = document.createElement('div');
    const pct = n => total ? ((n / total) * 100).toFixed(1) + '%' : '0%';
    body.innerHTML = `
      <table class="log-grid" style="margin-bottom:10px">
        <thead><tr><th>File</th><th>Code</th><th>Comments</th><th>Empty</th><th>Total</th></tr></thead>
        <tbody>${perFile.map(f =>
            `<tr><td>${f.name}</td><td>${f.code}</td><td>${f.comments}</td><td>${f.empty}</td><td>${f.total}</td></tr>`).join('')}
        </tbody>
      </table>
      <table style="border-spacing:6px">
        <tr><td>Files:</td><td><b>${App.files.length}</b></td></tr>
        <tr><td>Lines of code:</td><td><b>${code}</b> (${pct(code)})</td></tr>
        <tr><td>Comment lines:</td><td><b>${comments}</b> (${pct(comments)})</td></tr>
        <tr><td>Lines with both:</td><td><b>${codeAndComments}</b></td></tr>
        <tr><td>Empty lines:</td><td><b>${empty}</b> (${pct(empty)})</td></tr>
        <tr><td>Total lines:</td><td><b>${total}</b></td></tr>
      </table>`;
    const w = UI.window({
        title: 'Code statistics', icon: 'assets/codeblocks.png', width: 520, body,
        buttons: [{ label: 'OK', onClick: () => w.remove() }],
    });
    w.style.height = 'auto';
};

/* =========================================================== find in files */

Features.findInFiles = async function (replace) {
    const cm = cmOf();
    const preset = cm && cm.somethingSelected() ? cm.getSelection() : '';
    const term = await UI.textEntry(replace ? 'Text to search for:' : 'Text to search for:',
                                    replace ? 'Replace in files' : 'Find in files', preset);
    if (!term) return;
    let replacement = null;
    if (replace) {
        replacement = await UI.textEntry('Replace with:', 'Replace in files', '');
        if (replacement === null) return;
    }

    const pane = App.logs.search;
    pane.innerHTML = '';
    let hits = 0, changed = 0;
    App.files.forEach(f => {
        const lines = f.text().split('\n');
        lines.forEach((line, i) => {
            if (line.indexOf(term) < 0) return;
            hits++;
            const row = document.createElement('div');
            row.textContent = `${App.pathOf(f)}:${i + 1}: ${line.trim()}`;
            row.style.cursor = 'pointer';
            row.addEventListener('dblclick', () => {
                App.nbEditors.select(f.key);
                App.gotoLine(i + 1);
            });
            pane.appendChild(row);
        });
        if (replace && replacement !== null) {
            const before = f.text();
            const after = before.split(term).join(replacement);
            if (after !== before) {
                f.cm.setValue(after);
                changed++;
            }
        }
    });
    const head = document.createElement('div');
    head.textContent = replace
        ? `Replaced "${term}" with "${replacement}" in ${changed} file(s), ${hits} occurrence(s)\n`
        : `Search for "${term}": ${hits} match(es) in ${App.files.length} file(s)\n`;
    head.style.fontWeight = 'bold';
    pane.insertBefore(head, pane.firstChild);
    App.selectLogTab('search');
};

/* ============================================================ thread search */

Features.threadSearch = function () {
    const box = document.getElementById('threadsearch-body');
    if (!box) return;
    box.innerHTML = '';
    const bar = el('div');
    bar.style.cssText = 'display:flex;gap:4px;padding:3px;background:#f0f0f0;';
    const input = el('input', 'cb');
    input.style.flex = '1';
    input.placeholder = 'Text to search';
    const btn = el('button', 'cb', 'Search');
    bar.appendChild(input);
    bar.appendChild(btn);
    const results = el('div');
    results.style.cssText = 'font-family:var(--mono-font);font-size:12px;padding:2px 4px;';
    box.appendChild(bar);
    box.appendChild(results);

    const run = () => {
        const term = input.value;
        results.innerHTML = '';
        if (!term) return;
        let n = 0;
        App.files.forEach(f => {
            f.text().split('\n').forEach((line, i) => {
                if (line.indexOf(term) < 0) return;
                n++;
                const row = el('div', null, `${f.name}:${i + 1}: ${line.trim()}`);
                row.style.cursor = 'pointer';
                row.addEventListener('dblclick', () => {
                    App.nbEditors.select(f.key);
                    App.gotoLine(i + 1);
                });
                results.appendChild(row);
            });
        });
        results.insertBefore(el('div', null, `${n} match(es)`), results.firstChild);
    };
    btn.addEventListener('click', run);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') run(); });
    App.selectLogTab('threadsearch');
    setTimeout(() => input.focus(), 0);
};

/* ====================================================== perspectives (View) */

Features.saveLayout = async function () {
    const name = await UI.textEntry('Perspective name:', 'Save perspective', 'default');
    if (!name) return;
    const layouts = JSON.parse(localStorage.getItem('cbweb.layouts') || '{}');
    layouts[name] = {
        mgmtWidth: document.getElementById('pane-management').offsetWidth,
        logsHeight: document.getElementById('pane-logs').offsetHeight,
        mgmtHidden: document.getElementById('pane-management').classList.contains('hidden'),
        logsHidden: document.getElementById('pane-logs').classList.contains('hidden'),
    };
    localStorage.setItem('cbweb.layouts', JSON.stringify(layouts));
    UI.setStatus(0, `Perspective "${name}" saved`);
};

Features.deleteLayout = async function () {
    const layouts = JSON.parse(localStorage.getItem('cbweb.layouts') || '{}');
    const names = Object.keys(layouts);
    if (!names.length) { await UI.messageBox('No saved perspectives.', 'Code::Blocks', ['OK'], 'ℹ️'); return; }
    const name = await UI.textEntry('Perspective to delete (' + names.join(', ') + '):',
                                    'Delete perspective', names[0]);
    if (!name || !layouts[name]) return;
    delete layouts[name];
    localStorage.setItem('cbweb.layouts', JSON.stringify(layouts));
    UI.setStatus(0, `Perspective "${name}" deleted`);
};

/* ========================================================= script console */

/* The scripting console.  Code::Blocks scripts in Squirrel; here the console
   evaluates JavaScript against the same objects the IDE is built from. */
Features.scriptConsole = function () {
    if (document.getElementById('script-console')) return;
    const body = el('div');
    body.style.cssText = 'display:flex;flex-direction:column;height:100%;';
    const out = el('div');
    out.style.cssText = 'flex:1;overflow:auto;font-family:var(--mono-font);font-size:12px;' +
                        'background:#fff;border:1px solid #7a7a7a;padding:3px;white-space:pre-wrap;';
    out.textContent = 'Code::Blocks scripting console\nTry: App.files.length, App.activeTarget, Build.doBuild()\n\n';
    const row = el('div');
    row.style.cssText = 'display:flex;gap:4px;margin-top:6px;';
    const input = el('input', 'cb');
    input.style.flex = '1';
    const go = el('button', 'cb', 'Run');
    row.appendChild(input);
    row.appendChild(go);
    body.appendChild(out);
    body.appendChild(row);

    const run = () => {
        const src = input.value;
        if (!src) return;
        out.textContent += '> ' + src + '\n';
        try {
            const value = (0, eval)(src);
            out.textContent += (value === undefined ? 'undefined' :
                typeof value === 'object' ? JSON.stringify(value, null, 1) : String(value)) + '\n';
        } catch (e) {
            out.textContent += 'Error: ' + e.message + '\n';
        }
        out.scrollTop = out.scrollHeight;
        input.value = '';
    };
    go.addEventListener('click', run);
    input.addEventListener('keydown', ev => { if (ev.key === 'Enter') run(); });

    const w = UI.window({
        id: 'script-console', title: 'Scripting console', icon: 'assets/codeblocks.png',
        width: 520, height: 340, body,
    });
    setTimeout(() => input.focus(), 0);
};

/* ======================================================= debugger windows */

Features.debugWindow = function (which) {
    const titles = {
        registers: 'CPU Registers', disassembly: 'Disassembly', memory: 'Memory dump',
        threads: 'Running threads', callstack: 'Call stack',
    };
    const id = 'dbgwin-' + which;
    const existing = document.getElementById(id);
    if (existing) { existing.remove(); return; }

    const body = el('div');
    body.style.cssText = 'font-family:var(--mono-font);font-size:12px;';
    const interp = Debugger.interp;

    if (which === 'callstack') {
        const frames = interp && interp.callStack ? interp.callStack : [];
        body.innerHTML = '<table class="log-grid"><thead><tr><th>Nr</th><th>Function</th>' +
            '<th>File</th><th>Line</th></tr></thead><tbody>' +
            (frames.length
                ? frames.slice().reverse().map((f, i) =>
                    `<tr><td>#${i}</td><td>${f.name}()</td>` +
                    `<td>${Build.lastBuild ? Build.lastBuild.file.name : ''}</td><td>${f.line}</td></tr>`).join('')
                : '<tr><td colspan="4">The debugger is not running.</td></tr>') +
            '</tbody></table>';
    } else if (which === 'registers') {
        const regs = ['eax', 'ebx', 'ecx', 'edx', 'esi', 'edi', 'ebp', 'esp', 'eip'];
        body.innerHTML = '<table class="log-grid"><thead><tr><th>Register</th><th>Hex</th>' +
            '<th>Decimal</th></tr></thead><tbody>' +
            regs.map((r, i) => {
                const v = interp ? (interp.steps * (i + 7)) & 0xffff : 0;
                return `<tr><td>${r}</td><td>0x${v.toString(16).padStart(8, '0')}</td><td>${v}</td></tr>`;
            }).join('') + '</tbody></table>' +
            '<div style="padding:6px;color:#555">The web edition executes a statement tree, not ' +
            'machine code, so these are the interpreter\'s counters rather than real CPU registers.</div>';
    } else if (which === 'disassembly') {
        const line = Debugger.currentLine;
        const src = Build.lastBuild ? Build.lastBuild.file.text().split('\n') : [];
        body.innerHTML = '<div style="padding:4px">' +
            (src.length
                ? src.map((t, i) => `<div${i + 1 === line ? ' style="background:#a0a0ff"' : ''}>` +
                    `0x${(0x401000 + i * 16).toString(16)}&nbsp;&nbsp;${String(i + 1).padStart(4)}&nbsp;&nbsp;` +
                    `${t.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`).join('')
                : 'Nothing to disassemble.') + '</div>';
    } else if (which === 'memory') {
        let html = '';
        for (let r = 0; r < 16; r++) {
            const addr = 0x60000000 + r * 16;
            const bytes = [];
            for (let b = 0; b < 16; b++) bytes.push(((addr + b) * 7 & 0xff).toString(16).padStart(2, '0'));
            html += `0x${addr.toString(16)}: ${bytes.join(' ')}\n`;
        }
        body.innerHTML = `<pre style="margin:0">${html}</pre>`;
    } else if (which === 'threads') {
        body.innerHTML = '<table class="log-grid"><thead><tr><th>Active</th><th>Nr</th>' +
            '<th>Info</th></tr></thead><tbody><tr><td>*</td><td>1</td>' +
            `<td>main thread${Debugger.active ? ' (stopped at line ' + Debugger.currentLine + ')' : ''}</td>` +
            '</tr></tbody></table>';
    }

    const w = UI.window({
        id, title: titles[which] || which, icon: 'assets/icons/dbgwindow.svg',
        width: which === 'memory' || which === 'disassembly' ? 560 : 420,
        height: 320, body,
    });
    void w;
};

Features.debuggerInfo = function (kind) {
    const info = {
        frame: () => Debugger.active
            ? `Stack level 0, frame at 0x${(0x22fe30).toString(16)}:\n` +
              ` eip = 0x401000 in main (${Build.lastBuild ? Build.lastBuild.file.name : 'main.cpp'}:` +
              `${Debugger.currentLine}); saved eip = 0x4013c8\n Locals at 0x22fe30, Previous frame's sp is 0x22fe40`
            : 'No stack frame: the debugger is not running.',
        dll: () => 'Loaded modules:\n  ' + (Build.lastBuild ? Build.lastBuild.exe : 'none') +
                   '\n  libc++.a (static)\n  libc.a (static)',
        files: () => `Symbols from "${Build.lastBuild ? Build.lastBuild.exe : '(not built)'}".\n` +
                     `Local exec file:\n  ` +
                     (Build.lastBuild ? `\`${App.projectPath}\\${Build.lastBuild.exe}', file type wasm32-wasi.` : 'none'),
        fpu: () => 'No FPU on this target: WebAssembly uses IEEE-754 f32/f64 registers directly.',
        signals: () => 'Signal        Stop\tPrint\tPass to program\tDescription\n' +
                       'SIGINT        Yes\tYes\tNo\t\tInterrupt\n' +
                       'SIGSEGV       Yes\tYes\tYes\t\tSegmentation fault\n' +
                       'SIGABRT       Yes\tYes\tYes\t\tAborted',
    };
    const body = el('div');
    body.style.cssText = 'font-family:var(--mono-font);font-size:12px;white-space:pre-wrap;';
    body.textContent = (info[kind] || (() => ''))();
    const w = UI.window({
        title: 'Debugger info', icon: 'assets/icons/dbginfo.svg', width: 560, body,
        buttons: [{ label: 'Close', onClick: () => w.remove() }],
    });
    w.style.height = 'auto';
};

/* ============================================================ export Makefile */

Features.exportMakefile = function () {
    const file = App.activeSourceFile();
    if (!file) return;
    const name = file.name.replace(/\.[^.]*$/, '');
    const text =
`# Makefile exported by Code::Blocks (web edition)

CXX      = g++
CXXFLAGS = -Wall -std=c++17 ${App.activeTarget === 'Debug' ? '-g -O0' : '-O2'}
TARGET   = bin/${App.activeTarget}/${name}
OBJDIR   = obj/${App.activeTarget}
SOURCES  = ${App.files.map(f => f.name).join(' ')}
OBJECTS  = $(SOURCES:%.cpp=$(OBJDIR)/%.o)

all: $(TARGET)

$(TARGET): $(OBJECTS)
\t@mkdir -p $(dir $@)
\t$(CXX) -o $@ $(OBJECTS)

$(OBJDIR)/%.o: %.cpp
\t@mkdir -p $(OBJDIR)
\t$(CXX) $(CXXFLAGS) -c $< -o $@

clean:
\trm -rf $(OBJDIR) $(TARGET)

.PHONY: all clean
`;
    Disk.download('Makefile', text);
    Build.log('Exported Makefile\n');
    App.selectLogTab('build');
};

/* ================================================================== games */

/* The byogames plugin ships two games; this is the same idea, playable in a
   floating window.  Menu: Plugins -> C::B games. */
Features.showGames = function () {
    const body = el('div');
    body.innerHTML = '<div style="margin-bottom:8px">Select a game to play:</div>';
    const list = el('select', 'cb');
    list.size = 4;
    list.style.cssText = 'width:100%';
    ['cbTris', 'Snake'].forEach(g => list.appendChild(new Option(g, g)));
    list.selectedIndex = 0;
    body.appendChild(list);

    const w = UI.window({
        title: 'C::B games', icon: 'assets/codeblocks.png', width: 300, body,
        buttons: [
            { label: 'Play', onClick: () => { const g = list.value; w.remove(); Features.playGame(g); } },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

Features.playGame = function (name) {
    if (name === 'Snake') Features.playSnake();
    else Features.playTetris();
};

Features.playTetris = function () {
    const COLS = 10, ROWS = 20, CELL = 18;
    const canvas = document.createElement('canvas');
    canvas.width = COLS * CELL;
    canvas.height = ROWS * CELL;
    canvas.style.cssText = 'background:#000;display:block;margin:0 auto;';
    const wrap = el('div');
    const score = el('div');
    score.style.cssText = 'text-align:center;padding:4px;font-weight:bold;';
    score.textContent = 'Score: 0';
    wrap.appendChild(score);
    wrap.appendChild(canvas);
    const hint = el('div', null, 'Arrows move/rotate, Space drops, P pauses');
    hint.style.cssText = 'text-align:center;padding:4px;color:#555;';
    wrap.appendChild(hint);

    const ctx = canvas.getContext('2d');
    const SHAPES = [
        [[1, 1, 1, 1]],
        [[1, 1], [1, 1]],
        [[0, 1, 0], [1, 1, 1]],
        [[1, 0, 0], [1, 1, 1]],
        [[0, 0, 1], [1, 1, 1]],
        [[1, 1, 0], [0, 1, 1]],
        [[0, 1, 1], [1, 1, 0]],
    ];
    const COLOURS = ['#00f0f0', '#f0f000', '#a000f0', '#0000f0', '#f0a000', '#00f000', '#f00000'];
    const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
    let piece = null, px = 0, py = 0, colour = 0, points = 0, over = false, paused = false;

    const spawn = () => {
        const i = Math.floor(Math.random() * SHAPES.length);
        piece = SHAPES[i].map(r => r.slice());
        colour = i + 1;
        px = Math.floor((COLS - piece[0].length) / 2);
        py = 0;
        if (collides(px, py, piece)) over = true;
    };
    const collides = (x, y, p) => {
        for (let r = 0; r < p.length; r++)
            for (let c = 0; c < p[r].length; c++) {
                if (!p[r][c]) continue;
                const gx = x + c, gy = y + r;
                if (gx < 0 || gx >= COLS || gy >= ROWS) return true;
                if (gy >= 0 && grid[gy][gx]) return true;
            }
        return false;
    };
    const merge = () => {
        piece.forEach((row, r) => row.forEach((v, c) => {
            if (v && py + r >= 0) grid[py + r][px + c] = colour;
        }));
        let cleared = 0;
        for (let r = ROWS - 1; r >= 0; r--) {
            if (grid[r].every(v => v)) {
                grid.splice(r, 1);
                grid.unshift(new Array(COLS).fill(0));
                cleared++;
                r++;
            }
        }
        points += [0, 40, 100, 300, 1200][cleared] || 0;
        score.textContent = 'Score: ' + points;
        spawn();
    };
    const rotate = () => {
        const rotated = piece[0].map((_, c) => piece.map(r => r[c]).reverse());
        if (!collides(px, py, rotated)) piece = rotated;
    };
    const draw = () => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        const cell = (x, y, col) => {
            ctx.fillStyle = COLOURS[col - 1];
            ctx.fillRect(x * CELL + 1, y * CELL + 1, CELL - 2, CELL - 2);
        };
        grid.forEach((row, r) => row.forEach((v, c) => { if (v) cell(c, r, v); }));
        if (piece) piece.forEach((row, r) => row.forEach((v, c) => { if (v) cell(px + c, py + r, colour); }));
        if (over) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2);
        }
    };

    spawn();
    let acc = 0, last = performance.now(), raf = 0;
    const loop = now => {
        if (!document.body.contains(canvas)) return;
        const dt = now - last;
        last = now;
        if (!over && !paused) {
            acc += dt;
            if (acc > 450) {
                acc = 0;
                if (!collides(px, py + 1, piece)) py++;
                else merge();
            }
        }
        draw();
        raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const onKey = ev => {
        if (!document.body.contains(canvas)) { document.removeEventListener('keydown', onKey); return; }
        if (over) return;
        const k = ev.key;
        if (k === 'ArrowLeft' && !collides(px - 1, py, piece)) px--;
        else if (k === 'ArrowRight' && !collides(px + 1, py, piece)) px++;
        else if (k === 'ArrowDown' && !collides(px, py + 1, piece)) py++;
        else if (k === 'ArrowUp') rotate();
        else if (k === ' ') { while (!collides(px, py + 1, piece)) py++; merge(); }
        else if (k === 'p' || k === 'P') paused = !paused;
        else return;
        ev.preventDefault();
        draw();
    };
    document.addEventListener('keydown', onKey);

    const win = UI.window({
        title: 'cbTris', icon: 'assets/codeblocks.png',
        width: COLS * CELL + 22, height: ROWS * CELL + 122,
        body: wrap, resizable: false,
        onClose: () => {
            cancelAnimationFrame(raf);
            document.removeEventListener('keydown', onKey);
            win.remove();
        },
    });
    win.querySelector('.body').style.cssText = 'flex:1;overflow:hidden;padding:4px;';
};

Features.playSnake = function () {
    const SIZE = 20, CELL = 16;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE * CELL;
    canvas.style.cssText = 'background:#000;display:block;margin:0 auto;';
    const wrap = el('div');
    const score = el('div');
    score.style.cssText = 'text-align:center;padding:4px;font-weight:bold;';
    score.textContent = 'Score: 0';
    wrap.appendChild(score);
    wrap.appendChild(canvas);
    const hint = el('div', null, 'Arrow keys to steer');
    hint.style.cssText = 'text-align:center;padding:4px;color:#555;';
    wrap.appendChild(hint);

    const ctx = canvas.getContext('2d');
    let snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
    let dir = { x: 1, y: 0 }, next = dir;
    let food = { x: 15, y: 10 };
    let points = 0, over = false;

    const placeFood = () => {
        for (;;) {
            const f = { x: Math.floor(Math.random() * SIZE), y: Math.floor(Math.random() * SIZE) };
            if (!snake.some(s => s.x === f.x && s.y === f.y)) { food = f; return; }
        }
    };
    const step = () => {
        if (over) return;
        dir = next;
        const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
        if (head.x < 0 || head.y < 0 || head.x >= SIZE || head.y >= SIZE ||
            snake.some(s => s.x === head.x && s.y === head.y)) { over = true; return; }
        snake.unshift(head);
        if (head.x === food.x && head.y === food.y) {
            points += 10;
            score.textContent = 'Score: ' + points;
            placeFood();
        } else snake.pop();
    };
    const draw = () => {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#e00';
        ctx.fillRect(food.x * CELL + 2, food.y * CELL + 2, CELL - 4, CELL - 4);
        snake.forEach((s, i) => {
            ctx.fillStyle = i === 0 ? '#0f0' : '#0a0';
            ctx.fillRect(s.x * CELL + 1, s.y * CELL + 1, CELL - 2, CELL - 2);
        });
        if (over) {
            ctx.fillStyle = '#fff';
            ctx.font = 'bold 18px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText('GAME OVER', canvas.width / 2, canvas.height / 2);
        }
    };

    const timer = setInterval(() => {
        if (!document.body.contains(canvas)) { clearInterval(timer); return; }
        step();
        draw();
    }, 110);

    const onKey = ev => {
        if (!document.body.contains(canvas)) { document.removeEventListener('keydown', onKey); return; }
        const map = {
            ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 },
            ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 },
        };
        const d = map[ev.key];
        if (!d) return;
        ev.preventDefault();
        if (d.x === -dir.x && d.y === -dir.y) return;      // no instant reversal
        next = d;
    };
    document.addEventListener('keydown', onKey);

    const win = UI.window({
        title: 'Snake', icon: 'assets/codeblocks.png',
        width: SIZE * CELL + 22, height: SIZE * CELL + 122,
        body: wrap, resizable: false,
        onClose: () => {
            clearInterval(timer);
            document.removeEventListener('keydown', onKey);
            win.remove();
        },
    });
    win.querySelector('.body').style.cssText = 'flex:1;overflow:hidden;padding:4px;';
};

/* ========================================================= editor settings */

/* Settings -> Editor.  These options really drive the editor.
   They live on Features until App exists, then App.init adopts them. */
Features.editorSettings = {
    tabSize: 4, useTabs: false, lineNumbers: true, indentGuides: false,
    showWhitespace: false, wordWrap: false, highlightCaretLine: false,
    rightMargin: 0, autoIndent: true, autoCloseBrackets: true,
};

Features.applyEditorSettings = function () {
    const s = App.editorSettings;
    App.files.forEach(f => {
        if (!f.cm) return;
        f.cm.setOption('tabSize', s.tabSize);
        f.cm.setOption('indentUnit', s.tabSize);
        f.cm.setOption('indentWithTabs', s.useTabs);
        f.cm.setOption('lineNumbers', s.lineNumbers);
        f.cm.setOption('lineWrapping', s.wordWrap);
        f.cm.setOption('styleActiveLine', s.highlightCaretLine);
        f.cm.setOption('smartIndent', s.autoIndent);
        f.cm.setOption('autoCloseBrackets', s.autoCloseBrackets);
        f.cm.setOption('rulers', s.rightMargin
            ? [{ column: s.rightMargin, color: '#c0c0c0', lineStyle: 'solid' }] : []);
        f.cm.getWrapperElement().classList.toggle('cb-show-ws', s.showWhitespace);
        f.cm.getWrapperElement().classList.toggle('cb-indent-guides', s.indentGuides);
        f.cm.refresh();
    });
    localStorage.setItem('cbweb.editor', JSON.stringify(s));
};

Features.editorSettingsDialog = function () {
    const s = App.editorSettings;
    const body = el('div');
    const check = (key, label) =>
        `<label style="display:block;margin:3px 0">
           <input type="checkbox" data-k="${key}" ${s[key] ? 'checked' : ''}> ${label}</label>`;
    body.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">General settings</div>
      <table style="border-spacing:6px">
        <tr><td>TAB size:</td><td><input class="cb" type="number" min="1" max="16" data-k="tabSize"
              value="${s.tabSize}" style="width:60px"></td></tr>
        <tr><td>Right margin at column:</td><td><input class="cb" type="number" min="0" max="200"
              data-k="rightMargin" value="${s.rightMargin}" style="width:60px"> (0 = off)</td></tr>
      </table>
      <div style="margin-top:8px">
        ${check('useTabs', 'Use TAB character')}
        ${check('lineNumbers', 'Show line numbers')}
        ${check('indentGuides', 'Show indentation guides')}
        ${check('showWhitespace', 'Show whitespace')}
        ${check('wordWrap', 'Word wrap')}
        ${check('highlightCaretLine', 'Highlight line under caret')}
        ${check('autoIndent', 'Auto-indent')}
        ${check('autoCloseBrackets', 'Auto-complete brackets')}
      </div>`;

    const apply = () => {
        body.querySelectorAll('[data-k]').forEach(inp => {
            const k = inp.dataset.k;
            s[k] = inp.type === 'checkbox' ? inp.checked : parseInt(inp.value, 10) || 0;
        });
        Features.applyEditorSettings();
    };
    const w = UI.window({
        title: 'Configure editor', icon: 'assets/codeblocks.png', width: 420, body,
        buttons: [
            { label: 'OK', onClick: () => { apply(); w.remove(); } },
            { label: 'Apply', onClick: apply },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

/* ========================================================== build options */

/* Project -> Build options.  The values here go straight into the real clang
   command line, so changing the standard or the optimisation level changes
   what is compiled. */
Features.buildOptions = {
    std: 'c++17',
    optDebug: '-O0',
    optRelease: '-O2',
    defines: '',
    wall: true,
    wextra: false,
    pedantic: false,
};

Features.buildOptionsDialog = function () {
    const b = App.buildOptions;
    const body = el('div');
    const opt = (v, cur) => `<option${v === cur ? ' selected' : ''}>${v}</option>`;
    body.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">Compiler settings for "${App.activeProject ? App.activeProject.name : 'project'}"</div>
      <table style="border-spacing:6px">
        <tr><td>Selected compiler:</td><td><select class="cb" style="width:220px"><option>GNU GCC Compiler</option></select></td></tr>
        <tr><td>C++ standard:</td><td><select class="cb" data-k="std" style="width:120px">
          ${['c++98', 'c++11', 'c++14', 'c++17'].map(v => opt(v, b.std)).join('')}</select></td></tr>
        <tr><td>Optimisation (Debug):</td><td><select class="cb" data-k="optDebug" style="width:120px">
          ${['-O0', '-O1', '-O2', '-O3', '-Os'].map(v => opt(v, b.optDebug)).join('')}</select></td></tr>
        <tr><td>Optimisation (Release):</td><td><select class="cb" data-k="optRelease" style="width:120px">
          ${['-O0', '-O1', '-O2', '-O3', '-Os'].map(v => opt(v, b.optRelease)).join('')}</select></td></tr>
        <tr><td>#defines:</td><td><input class="cb" data-k="defines" value="${b.defines}"
              placeholder="NDEBUG DEBUG=1" style="width:220px"></td></tr>
      </table>
      <div style="margin-top:8px">
        <label style="display:block"><input type="checkbox" data-k="wall" ${b.wall ? 'checked' : ''}> Enable all common warnings (-Wall)</label>
        <label style="display:block"><input type="checkbox" data-k="wextra" ${b.wextra ? 'checked' : ''}> Enable extra warnings (-Wextra)</label>
        <label style="display:block"><input type="checkbox" data-k="pedantic" ${b.pedantic ? 'checked' : ''}> Strict ISO C++ (-pedantic)</label>
      </div>
      <div style="margin-top:10px;color:#555">These go into the actual clang command line.</div>`;

    const w = UI.window({
        title: 'Project build options', icon: 'assets/icons/compile.svg', width: 470, body,
        buttons: [
            {
                label: 'OK',
                onClick: () => {
                    body.querySelectorAll('[data-k]').forEach(inp => {
                        b[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked : inp.value;
                    });
                    Build.lastBuild = null;              // options changed: rebuild
                    localStorage.setItem('cbweb.build', JSON.stringify(b));
                    UI.setStatus(0, 'Build options updated');
                    w.remove();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

/* ======================================================== context menus */

/* The editor's right-click menu.  The first two entries are context
   sensitive, exactly as in the desktop IDE: they name the #include under the
   caret and the text that would be searched for. */
Features.editorContextMenu = function (cm, ev) {
    const pos = cm.coordsChar({ left: ev.clientX, top: ev.clientY });
    if (!cm.somethingSelected()) cm.setCursor(pos);

    const lineText = cm.getLine(pos.line) || '';
    const incMatch = /^\s*#\s*include\s*[<"]([^>"]+)[>"]/.exec(lineText);
    const selected = cm.somethingSelected()
        ? cm.getSelection().split('\n')[0]
        : (incMatch ? lineText.trim() : (() => {
            const w = cm.findWordAt(pos);
            return cm.getRange(w.anchor, w.head);
        })());

    const ellipsis = s => (s.length > 42 ? s.slice(0, 40) + '...' : s);
    const item = (id, label, extra) =>
        Object.assign({ type: 'item', id, label, mnemonic: -1 }, extra || {});
    const sub = (id, label, items) => ({ type: 'menu', id, label, mnemonic: -1, items });

    const debugging = Debugger.active;
    const hasSel = cm.somethingSelected();

    const items = [
        item('idCtxOpenInclude', `Open #include file: '${incMatch ? incMatch[1] : ''}'`,
             { enabled: !!incMatch }),
        item('idCtxFindOccurrences', `Find occurrences of: '${ellipsis(selected || '')}'`,
             { enabled: !!selected }),
        { type: 'sep' },
        item('idDebuggerMenuRunToCursor', 'Run to cursor', { enabled: debugging }),
        item('idDebuggerMenuToggleBreakpoint', 'Toggle breakpoint'),
        { type: 'sep' },
        item('idEditCut', 'Cut', { enabled: hasSel }),
        item('idEditCopy', 'Copy', { enabled: hasSel }),
        item('idEditPaste', 'Paste'),
        sub('idCtxEdit', 'Edit', [
            item('idEditUndo', 'Undo'),
            item('idEditRedo', 'Redo'),
            { type: 'sep' },
            item('idEditSelectAll', 'Select all'),
            item('idEditSelectNext', 'Select next occurrence'),
            { type: 'sep' },
            item('idEditToggleCommentSelected', 'Toggle comment'),
            item('idEditStreamCommentSelected', 'Stream comment'),
            item('idEditBoxCommentSelected', 'Box comment'),
            { type: 'sep' },
            item('idEditUpperCase', 'Uppercase'),
            item('idEditLowerCase', 'Lowercase'),
            { type: 'sep' },
            item('idEditLineDuplicate', 'Duplicate line'),
            item('idEditLineDelete', 'Delete line'),
            item('idEditLineUp', 'Move line up'),
            item('idEditLineDown', 'Move line down'),
        ]),
        { type: 'sep' },
        sub('idCtxRefactor', 'Insert/Refactor', [
            item('idCtxRefactorRename', 'Rename symbol...'),
            item('idCtxRefactorExtract', 'Extract selection into a function...'),
            { type: 'sep' },
            item('idCtxInsertGuard', 'Insert include guard'),
            item('idCtxInsertHeader', 'Insert file header comment'),
            item('idDoxyBlockComment', 'Insert documentation block'),
            { type: 'sep' },
            item('idPluginsAbbreviations', 'Expand abbreviation', { accel: 'Ctrl-J' }),
        ]),
        sub('idCtxBookmarks', 'Bookmarks', [
            item('idEditBookmarksToggle', 'Toggle bookmark', { accel: 'Ctrl-B' }),
            item('idEditBookmarksPrevious', 'Previous bookmark'),
            item('idEditBookmarksNext', 'Next bookmark'),
            item('idEditBookmarksClearAll', 'Clear all bookmarks'),
        ]),
        { type: 'sep' },
        item('idCtxAddTodo', 'Add Todo item...'),
        sub('idCtxAligner', 'Aligner', [
            item('idCtxAlignEquals', 'Align on ='),
            item('idCtxAlignComma', 'Align on ,'),
            item('idCtxAlignColon', 'Align on :'),
            item('idCtxAlignComment', 'Align on //'),
        ]),
        sub('idCtxDoxyBlocks', 'DoxyBlocks', [
            item('idDoxyBlockComment', 'Block comment', { accel: 'Ctrl-Alt-B' }),
            item('idDoxyLineComment', 'Line comment', { accel: 'Ctrl-Alt-L' }),
            { type: 'sep' },
            item('idDoxyExtract', 'Extract documentation'),
            item('idDoxyConfig', 'Open preferences...'),
        ]),
        item('idPluginsAStyle', 'Format use AStyle'),
        { type: 'sep' },
        sub('idCtxBrowseTracker', 'Browse Tracker', [
            item('idBrowseTrackerBack', 'Backward'),
            item('idBrowseTrackerForward', 'Forward'),
            { type: 'sep' },
            item('idBrowseTrackerClear', 'Clear all marks'),
        ]),
        sub('idCtxLocateIn', 'Locate in', [
            item('idCtxLocateProjectTree', 'Project tree'),
            item('idCtxLocateSymbols', 'Symbols browser'),
            item('idCtxLocateOpenFiles', 'Open files list'),
        ]),
        sub('idCtxNassi', 'Nassi Shneiderman', [
            item('idCtxNassiAdd', 'Add diagram for this function'),
        ]),
        item('idCtxSearchWeb', 'Search at BlackDuck...'),
    ];

    UI.popup(items, ev.clientX, ev.clientY, 0, it => App.command(it.id, { cm, pos, selected, incMatch }));
};

/* ------------------------------------------------- context menu commands */

Features.contextCommand = function (id, ctx) {
    const cm = cmOf();
    const f = App.activeFile();
    ctx = ctx || {};

    switch (id) {
        case 'idCtxOpenInclude': {
            const name = ctx.incMatch && ctx.incMatch[1];
            if (!name) return true;
            const base = name.split('/').pop();
            const open = App.files.find(x => x.name === base);
            if (open) { App.nbEditors.select(open.key); return true; }
            UI.messageBox(`The file "${name}" is a library header from the compiler's\n` +
                          `sysroot, not a file in this project.`, 'Open include file', ['OK'], 'ℹ️');
            return true;
        }
        case 'idCtxFindOccurrences': {
            if (!ctx.selected) return true;
            const pane = App.logs.search;
            pane.innerHTML = '';
            let n = 0;
            App.files.forEach(file => {
                file.text().split('\n').forEach((line, i) => {
                    if (line.indexOf(ctx.selected) < 0) return;
                    n++;
                    const row = el('div', null, `${file.name}:${i + 1}: ${line.trim()}`);
                    row.style.cursor = 'pointer';
                    row.addEventListener('dblclick', () => {
                        App.nbEditors.select(file.key);
                        App.gotoLine(i + 1);
                    });
                    pane.appendChild(row);
                });
            });
            const head = el('div', null, `Occurrences of "${ctx.selected}": ${n}`);
            head.style.fontWeight = 'bold';
            pane.insertBefore(head, pane.firstChild);
            App.selectLogTab('search');
            return true;
        }
        case 'idCtxAddTodo': {
            if (!cm) return true;
            UI.textEntry('To-Do text:', 'Add To-Do item', '').then(text => {
                if (!text) return;
                const line = cm.getCursor().line;
                const indent = (cm.getLine(line).match(/^\s*/) || [''])[0];
                cm.replaceRange(`${indent}// TODO (cbweb): ${text}\n`, { line, ch: 0 });
                Features.showTodo();
            });
            return true;
        }
        case 'idCtxRefactorRename': {
            if (!cm) return true;
            const word = selectionOrWord(cm);
            if (!word) return true;
            UI.textEntry(`Rename "${word}" to:`, 'Rename symbol', word).then(name => {
                if (!name || name === word) return;
                let n = 0;
                const re = new RegExp('\\b' + word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b', 'g');
                App.files.forEach(file => {
                    const before = file.text();
                    const after = before.replace(re, () => { n++; return name; });
                    if (after !== before) file.cm.setValue(after);
                });
                UI.setStatus(0, `Renamed ${n} occurrence(s) of "${word}" to "${name}"`);
            });
            return true;
        }
        case 'idCtxRefactorExtract': {
            if (!cm || !cm.somethingSelected()) {
                UI.setStatus(0, 'Select the statements to extract first');
                return true;
            }
            UI.textEntry('Name for the new function:', 'Extract function', 'extracted').then(name => {
                if (!name) return;
                const body = cm.getSelection().split('\n').map(l => '    ' + l.trim()).join('\n');
                cm.replaceSelection(`${name}();`);
                const at = { line: 0, ch: 0 };
                const text = cm.getValue();
                const mainAt = text.indexOf('int main');
                const line = mainAt >= 0 ? cm.posFromIndex(mainAt).line : 0;
                cm.replaceRange(`void ${name}()\n{\n${body}\n}\n\n`, { line, ch: 0 });
                void at;
            });
            return true;
        }
        case 'idCtxInsertGuard': {
            if (!cm || !f) return true;
            const guard = f.name.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_INCLUDED';
            cm.replaceRange(`#ifndef ${guard}\n#define ${guard}\n\n`, { line: 0, ch: 0 });
            cm.replaceRange(`\n#endif // ${guard}\n`, { line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length });
            return true;
        }
        case 'idCtxInsertHeader': {
            if (!cm || !f) return true;
            const today = new Date().toISOString().slice(0, 10);
            cm.replaceRange(
                `/***************************************************************\n` +
                ` * Name:      ${f.name}\n * Purpose:   \n * Author:    \n` +
                ` * Created:   ${today}\n * Copyright: \n * License:   \n` +
                ` **************************************************************/\n\n`,
                { line: 0, ch: 0 });
            return true;
        }
        case 'idCtxAlignEquals': case 'idCtxAlignComma':
        case 'idCtxAlignColon': case 'idCtxAlignComment': {
            if (!cm) return true;
            const token = { idCtxAlignEquals: '=', idCtxAlignComma: ',',
                            idCtxAlignColon: ':', idCtxAlignComment: '//' }[id];
            const from = cm.getCursor('from').line, to = cm.getCursor('to').line;
            if (from === to) { UI.setStatus(0, 'Select the lines to align'); return true; }
            const lines = [];
            let col = 0;
            for (let l = from; l <= to; l++) {
                const text = cm.getLine(l);
                const at = text.indexOf(token);
                lines.push({ text, at });
                if (at > col) col = at;
            }
            const out = lines.map(({ text, at }) => {
                if (at < 0) return text;
                return text.slice(0, at).padEnd(col) + text.slice(at);
            });
            cm.replaceRange(out.join('\n'), { line: from, ch: 0 },
                            { line: to, ch: cm.getLine(to).length });
            return true;
        }
        case 'idCtxLocateProjectTree': App.nbManagement.select('projects'); return true;
        case 'idCtxLocateSymbols': App.nbManagement.select('symbols'); return true;
        case 'idCtxLocateOpenFiles': App.nbManagement.select('openfiles'); return true;
        case 'idCtxNassiAdd':
            UI.messageBox('Nassi-Shneiderman diagrams need the contrib plugin,\n' +
                          'which is not part of the web edition.', 'Nassi Shneiderman', ['OK'], 'ℹ️');
            return true;
        case 'idCtxSearchWeb': {
            const term = cm ? selectionOrWord(cm) : '';
            if (term) window.open('https://duckduckgo.com/?q=' + encodeURIComponent('C++ ' + term), '_blank');
            return true;
        }
        case 'idBrowseTrackerBack': case 'idBrowseTrackerForward': {
            const hist = App.browseHistory || [];
            if (!hist.length) return true;
            App.browseIndex = Math.max(0, Math.min(hist.length - 1,
                (App.browseIndex === undefined ? hist.length - 1 : App.browseIndex) +
                (id === 'idBrowseTrackerForward' ? 1 : -1)));
            const h = hist[App.browseIndex];
            if (h) { App.nbEditors.select(h.key); App.gotoLine(h.line); }
            return true;
        }
        case 'idBrowseTrackerClear': App.browseHistory = []; return true;
        case 'idBookmarkToggle': Features.toggleBookmark(); return true;
        case 'idBookmarkNext': Features.gotoBookmark(1); return true;
        case 'idBookmarkPrev': Features.gotoBookmark(-1); return true;
        case 'idBookmarkClear':
            if (f) { f.bookmarks = new Set(); Features.refreshBookmarks(); }
            return true;
        case 'idBrowseMarks': App.nbManagement.select('openfiles'); return true;
        case 'idDoxyExtract': case 'idDoxyRunHTML': case 'idDoxyRunCHM':
        case 'idDoxyWizard': case 'idDoxyConfig':
            UI.messageBox('DoxyBlocks needs a local doxygen installation.\n' +
                          'The comment insertion commands work without it.',
                          'DoxyBlocks', ['OK'], 'ℹ️');
            return true;
        default:
            return false;
    }
};

/* ==================================================== the command dispatcher */

/* Returns true when the id was handled here. */
Features.command = function (id, ctx) {
    const cm = cmOf();
    const f = App.activeFile();
    const L = Features.lineOps;

    if (Features.contextCommand(id, ctx)) return true;

    switch (id) {
        /* ---- Edit: bookmarks ---- */
        case 'idEditBookmarksToggle': Features.toggleBookmark(); return true;
        case 'idEditBookmarksNext': Features.gotoBookmark(1); return true;
        case 'idEditBookmarksPrevious': Features.gotoBookmark(-1); return true;
        case 'idEditBookmarksClearAll':
            if (f) { f.bookmarks = new Set(); Features.refreshBookmarks(f); }
            return true;

        /* ---- Edit: folding ---- */
        case 'idEditToggleAllFolds': {
            App.allFolded = !App.allFolded;
            Features.foldAll(!App.allFolded);
            return true;
        }
        case 'idEditFoldAll': Features.foldAll(false); return true;
        case 'idEditUnfoldAll': Features.foldAll(true); return true;
        case 'idEditFoldBlock': Features.foldBlock('fold'); return true;
        case 'idEditUnfoldBlock': Features.foldBlock('unfold'); return true;
        case 'idEditToggleFoldBlock': Features.foldBlock(); return true;

        /* ---- Edit: end-of-line ---- */
        case 'idEditEOLCRLF': case 'idEditEOLCR': case 'idEditEOLLF': {
            if (!f) return true;
            f.eol = id === 'idEditEOLCRLF' ? 'Windows (CR+LF)'
                  : id === 'idEditEOLCR' ? 'Mac (CR)' : 'Unix (LF)';
            App.updateStatusBar();
            UI.setStatus(0, 'End-of-line mode: ' + f.eol);
            return true;
        }

        /* ---- Edit: encoding ---- */
        case 'idEditEncodingDefault': case 'idEditEncodingAscii': case 'idEditEncodingUtf8':
        case 'idEditEncodingUtf7': case 'idEditEncodingUnicode': case 'idEditEncodingUtf16':
        case 'idEditEncodingUtf32': case 'idEditEncodingUnicode16BE':
        case 'idEditEncodingUnicode16LE': case 'idEditEncodingUnicode32BE':
        case 'idEditEncodingUnicode32LE': {
            if (!f) return true;
            const names = {
                idEditEncodingDefault: 'WINDOWS-1252', idEditEncodingAscii: 'ISO-8859-1',
                idEditEncodingUtf8: 'UTF-8', idEditEncodingUtf7: 'UTF-7',
                idEditEncodingUnicode: 'UTF-16', idEditEncodingUtf16: 'UTF-16',
                idEditEncodingUtf32: 'UTF-32', idEditEncodingUnicode16BE: 'UTF-16BE',
                idEditEncodingUnicode16LE: 'UTF-16LE', idEditEncodingUnicode32BE: 'UTF-32BE',
                idEditEncodingUnicode32LE: 'UTF-32LE',
            };
            f.encoding = names[id];
            App.updateStatusBar();
            return true;
        }
        case 'idEditEncodingUseBom':
            if (f) { f.bom = !f.bom; UI.setStatus(0, 'Byte-order-mark: ' + (f.bom ? 'on' : 'off')); }
            return true;

        /* ---- Edit: highlight mode ---- */
        case 'idEditHighlightModeText':
            if (cm) { cm.setOption('mode', 'text/plain'); f.language = 'Plain text'; App.updateStatusBar(); }
            return true;
        case 'idEditHighlightModeCpp':
            if (cm) { cm.setOption('mode', 'text/x-c++src'); f.language = 'C/C++'; App.updateStatusBar(); }
            return true;

        /* ---- Edit: movement ---- */
        case 'idEditParaUp': if (cm) cm.execCommand('goParagraphUp'); return true;
        case 'idEditParaDown': if (cm) cm.execCommand('goParagraphDown'); return true;
        case 'idEditParaUpExtend': case 'idEditParaDownExtend': {
            if (!cm) return true;
            const dir = id === 'idEditParaUpExtend' ? -1 : 1;
            const c = cm.getCursor();
            let l = c.line;
            while (l > 0 && l < cm.lineCount() - 1 && cm.getLine(l + dir).trim() !== '') l += dir;
            cm.setSelection(cm.getCursor('anchor'), { line: l, ch: 0 });
            return true;
        }
        case 'idEditWordPartLeft': if (cm) cm.execCommand('goWordLeft'); return true;
        case 'idEditWordPartRight': if (cm) cm.execCommand('goWordRight'); return true;
        case 'idEditWordPartLeftExtend':
            if (cm) cm.setSelection(cm.getCursor('anchor'),
                (cm.execCommand('goWordLeft'), cm.getCursor()));
            return true;
        case 'idEditWordPartRightExtend':
            if (cm) cm.setSelection(cm.getCursor('anchor'),
                (cm.execCommand('goWordRight'), cm.getCursor()));
            return true;

        /* ---- Edit: zoom ---- */
        case 'idEditZoomIn': Features.zoom(1); return true;
        case 'idEditZoomOut': Features.zoom(-1); return true;
        case 'idEditZoomReset': Features.zoom(0); return true;

        /* ---- Edit: line commands ---- */
        case 'idEditLineDuplicate': if (cm) L.duplicate(cm); return true;
        case 'idEditLineCut': if (cm) L.cut(cm); return true;
        case 'idEditLineCopy': if (cm) L.copy(cm); return true;
        case 'idEditLinePaste': if (cm) L.paste(cm); return true;
        case 'idEditLineDelete': if (cm) L.del(cm); return true;
        case 'idEditLineTranspose': if (cm) L.transpose(cm); return true;
        case 'idEditLineUp': if (cm) L.up(cm); return true;
        case 'idEditLineDown': if (cm) L.down(cm); return true;

        /* ---- Edit: case ---- */
        case 'idEditUpperCase': Features.changeCase(true); return true;
        case 'idEditLowerCase': Features.changeCase(false); return true;

        /* ---- Edit: other ---- */
        case 'idEditInsertNewLine': if (cm) cm.execCommand('newlineAndIndent'); return true;
        case 'idEditGotoLineEnd': if (cm) cm.execCommand('goLineEnd'); return true;
        case 'idEditInsertNewLineBelow':
            if (cm) {
                const l = cm.getCursor().line;
                cm.replaceRange('\n', { line: l, ch: cm.getLine(l).length });
                cm.setCursor({ line: l + 1, ch: 0 });
            }
            return true;
        case 'idEditInsertNewLineAbove':
            if (cm) {
                const l = cm.getCursor().line;
                cm.replaceRange('\n', { line: l, ch: 0 });
                cm.setCursor({ line: l, ch: 0 });
            }
            return true;
        case 'idEditSelectNext': Features.selectNextOccurrence(false); return true;
        case 'idEditSelectNextSkip': Features.selectNextOccurrence(true); return true;
        case 'idEditStreamCommentSelected': Features.streamComment(); return true;
        case 'idEditBoxCommentSelected': Features.boxComment(); return true;
        case 'idEditShowCallTip': Features.showCallTip(); return true;
        case 'idEditClearHistory':
            if (cm) { cm.clearHistory(); UI.setStatus(0, 'Changes history cleared'); }
            return true;
        case 'idEditSwapHeaderSource': {
            if (!f) return true;
            const base = f.name.replace(/\.[^.]*$/, '');
            const isHeader = /\.(h|hpp|hh|hxx)$/i.test(f.name);
            const wanted = isHeader ? ['.cpp', '.cc', '.cxx', '.c'] : ['.h', '.hpp', '.hh', '.hxx'];
            const other = App.files.find(x => wanted.some(e => x.name === base + e));
            if (other) App.nbEditors.select(other.key);
            else UI.setStatus(0, `No matching ${isHeader ? 'source' : 'header'} file for ${f.name}`);
            return true;
        }

        /* ---- Search ---- */
        case 'idSearchFindInFiles': Features.findInFiles(false); return true;
        case 'idSearchReplaceInFiles': Features.findInFiles(true); return true;
        case 'idSearchFindSelectedNext': Features.selectNextOccurrence(false); return true;
        case 'idSearchFindSelectedPrevious':
            if (cm) {
                const word = selectionOrWord(cm);
                const cur = cm.getSearchCursor(word, cm.getCursor('from'));
                if (cur.findPrevious()) cm.setSelection(cur.from(), cur.to());
            }
            return true;
        case 'idSearchGotoNextChanged': case 'idSearchGotoPreviousChanged': {
            if (!cm || !f) return true;
            const dir = id === 'idSearchGotoNextChanged' ? 1 : -1;
            const changed = f.changedLines ? Array.from(f.changedLines).sort((a, b) => a - b) : [];
            if (!changed.length) { UI.setStatus(0, 'No changed lines'); return true; }
            const cur = cm.getCursor().line + 1;
            let t = dir > 0 ? changed.find(l => l > cur) : changed.slice().reverse().find(l => l < cur);
            if (t === undefined) t = dir > 0 ? changed[0] : changed[changed.length - 1];
            App.gotoLine(t);
            return true;
        }

        /* ---- View ---- */
        case 'idViewLayoutSave': Features.saveLayout(); return true;
        case 'idViewLayoutDelete': Features.deleteLayout(); return true;
        case 'idViewToolMain': document.getElementById('tb-main').classList.toggle('hidden'); return true;
        case 'idViewToolDebugger': document.getElementById('tb-debugger').classList.toggle('hidden'); return true;
        case 'idViewToolCompiler': document.getElementById('tb-compiler').classList.toggle('hidden'); return true;
        case 'idViewToolFit': case 'idViewToolOptimize':
            document.querySelectorAll('#toolbar-dock .cb-toolbar').forEach(t => t.classList.remove('hidden'));
            UI.setStatus(0, 'Toolbars fitted');
            return true;
        case 'idViewHideEditorTabs': {
            const tabs = document.querySelector('#nb-editors .nb-tabs');
            tabs.classList.toggle('hidden');
            App.refreshEditors();
            return true;
        }
        case 'idViewSwitchTabs': {
            const n = App.nbEditors.pages.length;
            if (n > 1) App.nbEditors.select((App.nbEditors.active + 1) % n);
            return true;
        }
        case 'idViewScriptConsole': Features.scriptConsole(); return true;

        /* ---- Project ---- */
        case 'idMenuAddFilesRecursively': App.command('idMenuAddFile'); return true;
        case 'idMenuProjectNotes': {
            const p = App.activeProject;
            const body = el('div');
            const ta = el('textarea', 'cb');
            ta.style.cssText = 'width:100%;height:180px';
            ta.value = (p && p.notes) || '';
            body.appendChild(ta);
            const w = UI.window({
                title: 'Notes', icon: 'assets/codeblocks.png', width: 460, body,
                buttons: [
                    { label: 'OK', onClick: () => { if (p) p.notes = ta.value; App.persist(); w.remove(); } },
                    { label: 'Cancel', onClick: () => w.remove() },
                ],
            });
            w.style.height = 'auto';
            return true;
        }
        case 'idMenuProjectBuildOptions': Features.buildOptionsDialog(); return true;
        case 'idMenuViewCategorize': case 'idMenuViewUseFolders':
        case 'idMenuViewHideFolderName': case 'idMenuViewSortAlphabetically': {
            App.treeOptions = App.treeOptions || {};
            const key = id.replace('idMenuView', '');
            App.treeOptions[key] = !App.treeOptions[key];
            App.refreshTrees();
            return true;
        }
        case 'idMenuNextProject': case 'idMenuPriorProject': {
            if (App.projects.length < 2) return true;
            const i = App.projects.indexOf(App.activeProject);
            const d = id === 'idMenuNextProject' ? 1 : -1;
            App.activeProject = App.projects[(i + d + App.projects.length) % App.projects.length];
            App.refreshTrees();
            return true;
        }
        case 'idFileOpenRecentProjectClearHistory': case 'idFileOpenRecentFileClearHistory':
            App.updateStartPageRecents();
            UI.setStatus(0, 'History cleared');
            return true;
        case 'idFileCloseWorkspace': App.command('idFileCloseProject'); return true;
        case 'idFileOpenDefWorkspace': App.openStartPage(); return true;

        /* ---- Build ---- */
        case 'idCompilerMenuExportMakefile': Features.exportMakefile(); return true;

        /* ---- Debug ---- */
        case 'idDebuggerWinCallStack': Features.debugWindow('callstack'); return true;
        case 'idDebuggerWinCPURegisters': Features.debugWindow('registers'); return true;
        case 'idDebuggerWinDisassembly': Features.debugWindow('disassembly'); return true;
        case 'idDebuggerWinMemory': Features.debugWindow('memory'); return true;
        case 'idDebuggerWinThreads': Features.debugWindow('threads'); return true;
        case 'idDebuggerInfoFrame': Features.debuggerInfo('frame'); return true;
        case 'idDebuggerInfoDLL': Features.debuggerInfo('dll'); return true;
        case 'idDebuggerInfoFiles': Features.debuggerInfo('files'); return true;
        case 'idDebuggerInfoFPU': Features.debuggerInfo('fpu'); return true;
        case 'idDebuggerInfoSignals': Features.debuggerInfo('signals'); return true;
        case 'idDebuggerMenuNextInstr': Debugger.next(); return true;
        case 'idDebuggerMenuStepIntoInstr': Debugger.stepInto(); return true;
        case 'idDebuggerMenuSendCommand': {
            UI.textEntry('Enter command for the debugger:', 'Debugger command', '').then(c => {
                if (!c) return;
                App.logAppend('debugger', '> ' + c + '\n');
                App.logAppend('debugger', 'The built-in debugger does not take gdb commands.\n');
                App.selectLogTab('debugger');
            });
            return true;
        }

        /* ---- plugins ---- */
        case 'idPluginsGames': Features.showGames(); return true;
        case 'idPluginsTodo': Features.showTodo(); return true;
        case 'idPluginsCodeStats': Features.codeStatistics(); return true;
        case 'idPluginsAStyle': Features.formatSource(); return true;
        case 'idPluginsAbbreviations': Features.expandAbbreviation(); return true;
        case 'idPluginsCodeComplete': Features.codeComplete(); return true;
        case 'idPluginsThreadSearch': Features.threadSearch(); return true;
        case 'idPluginsOccurrences':
            App.highlightOccurrencesOn = !App.highlightOccurrencesOn;
            Features.highlightOccurrences(cm);
            UI.setStatus(0, 'Occurrences highlighting ' + (App.highlightOccurrencesOn ? 'on' : 'off'));
            return true;

        /* ---- DoxyBlocks ---- */
        case 'idDoxyBlockComment': case 'idDoxyLineComment': {
            if (!cm) return true;
            const c = cm.getCursor();
            const indent = (cm.getLine(c.line).match(/^\s*/) || [''])[0];
            if (id === 'idDoxyLineComment') {
                cm.replaceRange(' /*!<  */', { line: c.line, ch: cm.getLine(c.line).length });
            } else {
                cm.replaceRange(`${indent}/** \\brief \n${indent} *\n${indent} * \\param\n` +
                                `${indent} * \\return\n${indent} *\n${indent} */\n`,
                                { line: c.line, ch: 0 });
            }
            return true;
        }

        default:
            return false;
    }
};
