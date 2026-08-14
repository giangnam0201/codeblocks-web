/* ---------------------------------------------------------------------------
   app.js - the Code::Blocks main frame: editors, management panel, logs,
   status bar, menu/toolbar commands and the project model.
--------------------------------------------------------------------------- */
'use strict';

const App = {
    highlightOccurrencesOn: true,
    zoomLevel: 0,
    files: [],                 // open editors
    projects: [],
    activeProject: null,
    activeTarget: 'Debug',
    projectPath: 'C:\\Users\\Dev\\Projects',
    nbEditors: null,
    nbLogs: null,
    nbManagement: null,
    startPageOpen: false,
};

const STORE_KEY = 'cbweb.workspace.v1';

const CONSOLE_TEMPLATE =
`#include <iostream>

using namespace std;

int main()
{
    cout << "Hello world!" << endl;
    return 0;
}
`;

/* The other files the wizard writes, matching the desktop templates. */
const C_CONSOLE_TEMPLATE =
`#include <stdio.h>
#include <stdlib.h>

int main()
{
    printf("Hello world!\\n");
    return 0;
}
`;

const LIB_TEMPLATE_CPP =
`#include "main.h"

void hello()
{
    std::cout << "Hello world!" << std::endl;
}
`;

const LIB_TEMPLATE_C =
`#include "main.h"

void hello()
{
    printf("Hello world!\\n");
}
`;

/* ============================================================ file model */

class SourceFile {
    constructor(name, text, project) {
        this.name = name;
        this.project = project || null;
        this.modified = false;
        this.readOnly = false;
        this.handle = null;          // FileSystemFileHandle once it lives on disk
        this.dirPath = null;         // display path, for the status bar
        this.doc = CodeMirror.Doc(text, 'text/x-c++src');
        this.cm = null;
        this.host = null;
    }
    text() { return this.doc.getValue(); }
    get key() { return 'file:' + this.name; }
}

/* ================================================================ editors */

App.editorFor = function (file) {
    if (file.cm) return file.cm;
    const host = document.createElement('div');
    host.className = 'cb-editor';
    file.host = host;
    return host;
};

App.openFile = function (name, text, project, activate) {
    let f = App.files.find(x => x.name === name);
    if (f) {
        App.nbEditors.select(f.key);
        return f;
    }
    f = new SourceFile(name, text !== undefined ? text : '', project);
    App.files.push(f);
    const host = App.editorFor(f);
    App.nbEditors.addPage(f.key, name, host, 'assets/icons/tree/file.svg', true);

    f.cm = CodeMirror(host, {
        value: '',
        mode: 'text/x-c++src',
        theme: 'cb',
        lineNumbers: true,
        indentUnit: 4,
        tabSize: 4,
        indentWithTabs: false,
        smartIndent: true,
        matchBrackets: true,
        autoCloseBrackets: true,
        styleActiveLine: false,
        foldGutter: true,
        gutters: ['CodeMirror-linenumbers', 'cb-margin-marker', 'cb-margin-change', 'CodeMirror-foldgutter'],
        extraKeys: {
            'Ctrl-Space': () => Features.codeComplete(),
            'Ctrl-J': () => Features.expandAbbreviation(),
            'Ctrl-Shift-Space': () => Features.showCallTip(),
            'Ctrl-B': () => Features.toggleBookmark(),
            'Alt-Up': () => Features.lineOps.up(f.cm),
            'Alt-Down': () => Features.lineOps.down(f.cm),
            'Ctrl-D': () => Features.lineOps.duplicate(f.cm),
            'Ctrl-E': () => Features.selectNextOccurrence(false),
            'F12': () => Features.foldBlock(),
            'Shift-F12': () => App.command('idEditToggleAllFolds'),
            'F5': () => App.command('idDebuggerMenuToggleBreakpoint'),
            'F11': () => App.command('idEditSwapHeaderSource'),
        },
    });
    f.cm.swapDoc(f.doc);
    f.cm.on('change', (cm, change) => {
        if (!f.modified) {
            f.modified = true;
            App.nbEditors.setTitle(f.key, '*' + f.name);
        }
        // the changebar margin tracks which lines were edited
        if (!f.changedLines) f.changedLines = new Set();
        for (let l = change.from.line; l <= change.to.line + (change.text.length - 1); l++)
            f.changedLines.add(l + 1);
        App.updateStatusBar();
    });
    f.cm.on('cursorActivity', () => {
        App.updateStatusBar();
        Features.highlightOccurrences(f.cm);
    });
    // the editor's right-click menu
    f.cm.getWrapperElement().addEventListener('contextmenu', ev => {
        ev.preventDefault();
        Features.editorContextMenu(f.cm, ev);
    });
    /* Ctrl+wheel (and a trackpad pinch) resizes the code the way Scintilla
       does.  Without this the browser scales the whole IDE instead, which is
       not what anyone means by zooming in an editor. */
    f.cm.getWrapperElement().addEventListener('wheel', ev => {
        if (!ev.ctrlKey) return;
        ev.preventDefault();
        Features.zoom(ev.deltaY < 0 ? 1 : -1);
        UI.setStatus(0, App.zoomLevel === 0 ? 'Zoom reset'
            : `Zoom ${App.zoomLevel > 0 ? 'in' : 'out'}: ${13 + App.zoomLevel}px ` +
              '(Ctrl+wheel, or Edit -> Special commands -> Zoom)');
    }, { passive: false });
    // BrowseTracker keeps the jump history
    f.cm.on('focus', () => {
        App.browseHistory = App.browseHistory || [];
        App.browseHistory.push({ key: f.key, line: f.cm.getCursor().line + 1 });
        if (App.browseHistory.length > 50) App.browseHistory.shift();
        App.browseIndex = App.browseHistory.length - 1;
    });
    // left margin: click sets a breakpoint, Ctrl-click sets a bookmark
    f.cm.on('gutterClick', (cm, line, gutter, ev) => {
        if (gutter !== 'cb-margin-marker') return;
        if (ev && (ev.ctrlKey || ev.shiftKey)) Features.toggleBookmark(line + 1);
        else App.toggleBreakpointAt(f, line + 1);
    });

    if (App.zoomLevel) f.cm.getWrapperElement().style.fontSize = (13 + App.zoomLevel) + 'px';

    if (activate !== false) App.nbEditors.select(f.key);
    setTimeout(() => f.cm.refresh(), 0);
    App.refreshTrees();
    return f;
};

App.activeFile = function () {
    const p = App.nbEditors && App.nbEditors.activePage();
    if (!p) return null;
    return App.files.find(f => f.key === p.key) || null;
};
App.activeSourceFile = function () {
    const f = App.activeFile();
    if (f) return f;
    // fall back to the first open source file (Start here may be active)
    return App.files[0] || null;
};

App.closeFile = async function (file) {
    if (file.modified) {
        const a = await UI.messageBox(
            `File ${file.name} is modified...\nDo you want to save the changes?`,
            'Save file', ['Yes', 'No', 'Cancel'], '❓');
        if (a === 'Cancel' || a === null) return false;
        if (a === 'Yes') App.saveFile(file);
    }
    App.nbEditors.removePage(file.key);
    App.files = App.files.filter(f => f !== file);
    App.refreshTrees();
    App.updateStatusBar();
    return true;
};

/* Ctrl-S: writes to the real file when we already have a handle for it, and
   only shows the Save dialog the first time - like the desktop IDE. */
App.saveFile = async function (file) {
    const ok = await Disk.save(file);
    if (!ok) return false;
    file.modified = false;
    App.nbEditors.setTitle(file.key, file.name);
    App.refreshTrees();
    App.persist();
    App.updateStatusBar();
    UI.setStatus(0, `Saved ${App.pathOf(file)}`);
    return true;
};

App.saveAll = async function (quiet) {
    for (const f of App.files) {
        if (!f.modified) continue;
        if (!f.handle && quiet) continue;      // don't pop dialogs during a build
        await App.saveFile(f);
    }
    App.files.forEach(f => {
        if (!f.handle) { f.modified = false; App.nbEditors.setTitle(f.key, f.name); }
    });
    App.persist();
    if (!quiet) UI.setStatus(0, 'Saved everything');
    App.updateStatusBar();
};

App.pathOf = function (file) {
    return file.dirPath ? file.dirPath + '\\' + file.name : App.projectPath + '\\' + file.name;
};

/* ------------------------------------------------------------ breakpoints */

App.toggleBreakpointAt = function (file, line) {
    const on = Debugger.toggleBreakpoint(file.name, line);
    App.refreshBreakpoints();
    App.logAppend('debugger', (on ? 'Added' : 'Removed') + ` breakpoint at ${file.name}:${line}\n`);
    return on;
};

/* Redraws the marker margin: breakpoints and bookmarks share it, exactly as
   they do in the desktop editor. */
App.refreshBreakpoints = function () {
    App.files.forEach(f => {
        if (!f.cm) return;
        f.cm.clearGutter('cb-margin-marker');
        f.cm.clearGutter('cb-margin-change');

        const marker = (src, title) => {
            const img = document.createElement('img');
            img.src = src;
            img.title = title;
            img.style.cssText = 'width:0.95em;height:0.95em;margin-left:0.15em;vertical-align:middle;';
            return img;
        };
        (f.bookmarks || new Set()).forEach(line =>
            f.cm.setGutterMarker(line - 1, 'cb-margin-marker',
                                 marker('assets/icons/bookmark_add.svg', 'Bookmark')));
        const set = Debugger.breakpoints.get(f.name);
        if (set) set.forEach(line =>
            f.cm.setGutterMarker(line - 1, 'cb-margin-marker',
                                 marker('assets/icons/breakpoint.svg', 'Breakpoint')));

        /* Lines the compiler complained about get the red box the desktop
           editor puts in the marker margin, and the line itself is tinted. */
        const bad = (App.buildErrorLines && App.buildErrorLines.get(f.name)) || null;
        (f.errorMarks || []).forEach(h => f.cm.removeLineClass(h, 'background', 'cb-line-error'));
        (f.warnMarks || []).forEach(h => f.cm.removeLineClass(h, 'background', 'cb-line-warning'));
        f.errorMarks = []; f.warnMarks = [];
        if (bad) bad.forEach((kind, line) => {
            if (line < 1 || line > f.cm.lineCount()) return;
            const box = document.createElement('div');
            box.className = kind === 'warning' ? 'cb-marker-warn' : 'cb-marker-err';
            box.title = kind === 'warning' ? 'Warning on this line' : 'Error on this line';
            f.cm.setGutterMarker(line - 1, 'cb-margin-marker', box);
            const cls = kind === 'warning' ? 'cb-line-warning' : 'cb-line-error';
            const h = f.cm.addLineClass(line - 1, 'background', cls);
            (kind === 'warning' ? f.warnMarks : f.errorMarks).push(h);
        });

        // changebar: yellow for unsaved edits, green once saved
        (f.changedLines || new Set()).forEach(line => {
            const bar = document.createElement('div');
            bar.style.cssText = 'width:4px;height:100%;background:' +
                                (f.modified ? '#ffe604' : '#04ff50') + ';';
            f.cm.setGutterMarker(line - 1, 'cb-margin-change', bar);
        });
    });
    App.refreshBreakpointList();
};

/* What the last build complained about: file name -> Map(line -> kind).  The
   markers survive until the next build, like the desktop editor. */
App.buildErrorLines = new Map();
App.setBuildErrors = function (list) {
    App.buildErrorLines = new Map();
    (list || []).forEach(d => {
        if (!d.line) return;
        const key = d.file;
        if (!App.buildErrorLines.has(key)) App.buildErrorLines.set(key, new Map());
        const m = App.buildErrorLines.get(key);
        // an error on a line beats a warning on the same line
        if (m.get(d.line) !== 'error') m.set(d.line, d.kind === 'warning' ? 'warning' : 'error');
    });
    App.refreshBreakpoints();
};

let debugLineHandle = null;
App.showDebugLine = function (line) {
    const f = Build.lastBuild && Build.lastBuild.file;
    if (!f || !f.cm) return;
    App.nbEditors.select(f.key);
    App.clearDebugLine();
    debugLineHandle = { cm: f.cm, line: line - 1 };
    f.cm.addLineClass(line - 1, 'background', 'cb-line-debug');
    f.cm.scrollIntoView({ line: line - 1, ch: 0 }, 80);
};
App.clearDebugLine = function () {
    if (debugLineHandle) {
        try { debugLineHandle.cm.removeLineClass(debugLineHandle.line, 'background', 'cb-line-debug'); }
        catch (e) { /* the document may already be gone */ }
        debugLineHandle = null;
    }
};

/* =================================================================== logs */

App.logs = {};

App.logAppend = function (which, text, cls) {
    const pane = App.logs[which];
    if (!pane) return;
    const span = document.createElement('span');
    if (cls) span.className = cls;
    span.textContent = text;
    pane.appendChild(span);
    pane.scrollTop = pane.scrollHeight;
};

App.selectLogTab = function (which) {
    if (App.nbLogs) App.nbLogs.select('log:' + which);
    const pane = document.getElementById('pane-logs');
    if (pane.classList.contains('collapsed')) App.togglePane('logs');
};

App.buildMessagesClear = function () {
    const tb = document.querySelector('#build-messages tbody');
    if (tb) tb.innerHTML = '';
};
App.buildMessagesAdd = function (file, line, message, type) {
    const tb = document.querySelector('#build-messages tbody');
    if (!tb) return;
    const tr = document.createElement('tr');
    tr.className = type === 'error' ? 'error' : type === 'warning' ? 'warning' : '';
    [file, line, message].forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
    });
    tr.addEventListener('click', () => {
        document.querySelectorAll('#build-messages tr.selected').forEach(r => r.classList.remove('selected'));
        tr.classList.add('selected');
        if (line) App.gotoLine(parseInt(line, 10));
    });
    tb.appendChild(tr);
};

App.gotoLine = function (line) {
    const f = App.activeSourceFile();
    if (!f || !f.cm) return;
    App.nbEditors.select(f.key);
    f.cm.setCursor({ line: line - 1, ch: 0 });
    f.cm.scrollIntoView({ line: line - 1, ch: 0 }, 100);
    f.cm.focus();
};

/* ============================================================== watches */

/* The Watches pane: the locals of the frame the debugger stopped in, then the
   globals - the same split the desktop debugger shows.  Structures, arrays and
   vectors expand. */
App.updateWatches = function (interp) {
    const box = document.getElementById('watch-body');
    if (!box) return;
    box.innerHTML = '';
    if (!interp) return;

    const describe = v => {
        if (!v) return '';
        switch (v.k) {
            case 'a': return `[${v.a.length} items]`;
            case 'v': return `vector<> [${v.a.length} items]`;
            case 'o': return v.cls === '#pair' ? 'pair' : `${v.cls}`;
            case 'm': return `map [${v.e.length} entries]`;
            case 'set': return `set [${v.e.length} entries]`;
            case 'p': return v.a ? '0x' + (0x60000000 + v.i * 4).toString(16) : '0x0 (null)';
            case 's': return '"' + v.v + '"';
            default: return CPP.valueToString(v);
        }
    };
    const children = v => {
        if (!v) return [];
        if (v.k === 'a' || v.k === 'v') return v.a.map((s, i) => ['[' + i + ']', s.v]);
        if (v.k === 'o') return Object.keys(v.f).map(k => [k, v.f[k].v]);
        if (v.k === 'm') return v.e.map((p, i) => ['[' + i + ']', p.slot.v]);
        if (v.k === 'set') return v.e.map((x, i) => ['[' + i + ']', x]);
        return [];
    };

    const draw = (name, value, depth, parent) => {
        const kids = depth < 3 ? children(value) : [];
        const row = document.createElement('div');
        row.className = 'tree-row';
        row.style.paddingLeft = (depth * 14 + 4) + 'px';
        const tw = document.createElement('span');
        tw.className = 'twisty';
        tw.textContent = kids.length ? (value.__open ? '▾' : '▸') : '';
        if (kids.length) {
            tw.style.cursor = 'pointer';
            tw.addEventListener('mousedown', ev => {
                ev.stopPropagation();
                value.__open = !value.__open;
                App.updateWatches(interp);
            });
        }
        row.appendChild(tw);
        row.appendChild(document.createTextNode(`${name} = ${describe(value)}`));
        parent.appendChild(row);
        if (kids.length && value.__open)
            kids.forEach(([k, v]) => draw(k, v, depth + 1, parent));
    };

    const section = title => {
        const h = document.createElement('div');
        h.className = 'tree-row bold';
        h.style.paddingLeft = '4px';
        h.textContent = title;
        box.appendChild(h);
        return h;
    };

    // locals: walk the live scope chain up to (but not including) the globals
    const locals = [];
    let s = interp.currentScope;
    const seen = new Set();
    while (s && s !== interp.globals) {
        for (const [name, slot] of s.vars) {
            if (seen.has(name) || name === 'this') continue;
            seen.add(name);
            locals.push([name, slot.v]);
        }
        s = s.parent;
    }
    section(`Local variables (${locals.length})`);
    if (!locals.length) {
        const none = document.createElement('div');
        none.className = 'tree-row';
        none.style.cssText = 'padding-left:18px;color:#666';
        none.textContent = 'no locals in this frame';
        box.appendChild(none);
    }
    locals.forEach(([n, v]) => draw(n, v, 1, box));

    const globals = Array.from(interp.globals.vars).filter(([n]) => !seen.has(n));
    section(`Global variables (${globals.length})`);
    globals.forEach(([n, sl]) => draw(n, sl.v, 1, box));
};

App.refreshBreakpointList = function () {
    const box = document.getElementById('breakpoint-body');
    if (!box) return;
    box.innerHTML = '';
    Debugger.breakpoints.forEach((set, file) => {
        set.forEach(line => {
            const row = document.createElement('div');
            row.className = 'tree-row';
            const img = document.createElement('img');
            img.src = 'assets/icons/breakpoint.svg';
            row.appendChild(img);
            row.appendChild(document.createTextNode(`${App.projectPath}\\${file}:${line}`));
            row.addEventListener('dblclick', () => App.gotoLine(line));
            box.appendChild(row);
        });
    });
};

/* ============================================================ status bar */

App.updateStatusBar = function () {
    const f = App.activeFile();
    const page = App.nbEditors && App.nbEditors.activePage();
    document.title = (f ? f.name : (page ? page.title : 'Start here')) + ' - Code::Blocks 25.03';
    if (!f) {
        UI.setStatus(0, page && page.key === '#start' ? 'Start here' : 'Welcome to Code::Blocks!');
        for (let i = 1; i <= 7; i++) UI.setStatus(i, '');
        UI.setStatus(8, 'default');
        return;
    }
    const cur = f.cm.getCursor();
    const pos = f.cm.indexFromPos(cur);
    UI.setStatus(0, App.pathOf(f));
    UI.setStatus(1, 'C/C++');
    UI.setStatus(2, 'Windows (CR+LF)');
    UI.setStatus(3, 'WINDOWS-1252');
    UI.setStatus(4, `Line ${cur.line + 1}, Col ${cur.ch + 1}, Pos ${pos}`);
    UI.setStatus(5, f.overwrite ? 'Overwrite' : 'Insert');
    UI.setStatus(6, f.modified ? 'Modified' : '');
    UI.setStatus(7, f.readOnly ? 'Read only' : 'Read/Write');
    UI.setStatus(8, 'default');
};
UI.updateStatusBar = App.updateStatusBar;

/* ============================================================== projects */

class Project {
    constructor(name) {
        this.name = name;
        this.targets = ['Debug', 'Release'];
        this.files = [];               // SourceFile names
        this.args = '';
    }
}

App.newProject = function (name, withMain) {
    const p = new Project(name);
    App.projects.push(p);
    App.activeProject = p;
    App.projectPath = `C:\\Users\\Dev\\Projects\\${name}`;
    if (withMain !== false) {
        const f = App.openFile('main.cpp', CONSOLE_TEMPLATE, p);
        p.files.push(f.name);
    }
    App.refreshTrees();
    App.logAppend('app', `Project '${name}' created.\n`);
    App.persist();
    return p;
};

/* --------------------------------------------------------- project trees */

App.refreshTrees = function () {
    if (!App.treeProjects) return;

    const fileNode = f => ({
        label: f.name,
        icon: 'assets/icons/tree/' + (f.modified ? 'file-modified.svg' : 'file.svg'),
        data: f,
        children: [],
    });

    if (!App.projects.length) {
        App.treeProjects.setRoots([{
            label: 'Workspace', icon: 'assets/icons/tree/workspace.svg', bold: true,
            expanded: true, children: App.files.map(fileNode),
        }]);
    } else {
        App.treeProjects.setRoots([{
            label: 'Workspace', icon: 'assets/icons/tree/workspace.svg', bold: true, expanded: true,
            children: App.projects.map(p => ({
                label: p.name,
                icon: 'assets/icons/tree/project.svg',
                bold: p === App.activeProject,
                expanded: true,
                data: p,
                children: [{
                    label: 'Sources',
                    icon: 'assets/icons/tree/vfolder_open.svg',
                    expanded: true,
                    children: App.files.filter(f => f.project === p || p.files.includes(f.name)).map(fileNode),
                }],
            })),
        }]);
    }

    // Symbols tab: functions and globals found by a light scan of the sources
    if (App.treeSymbols) {
        const global = { label: 'Global functions', icon: 'assets/icons/tree/vfolder_open.svg', expanded: true, children: [] };
        const vars = { label: 'Global variables', icon: 'assets/icons/tree/vfolder_open.svg', expanded: true, children: [] };
        const types = { label: 'Global typedefs', icon: 'assets/icons/tree/vfolder_open.svg', expanded: true, children: [] };
        App.files.forEach(f => {
            const src = f.text();
            const fnRe = /^[ \t]*(?:[A-Za-z_][\w:<>,\s*&]*?)\s+([A-Za-z_]\w*)\s*\(([^;{]*)\)\s*(?:const\s*)?\{/gm;
            let m;
            while ((m = fnRe.exec(src)) !== null) {
                if (['if', 'for', 'while', 'switch', 'catch', 'return'].includes(m[1])) continue;
                global.children.push({ label: `${m[1]}(${m[2].trim()})`, icon: 'assets/icons/tree/file.svg', children: [] });
            }
            const clsRe = /^\s*(?:struct|class)\s+([A-Za-z_]\w*)/gm;
            while ((m = clsRe.exec(src)) !== null)
                types.children.push({ label: m[1], icon: 'assets/icons/tree/vfolder_open.svg', children: [] });
        });
        App.treeSymbols.setRoots([{
            label: App.activeProject ? App.activeProject.name : 'Workspace',
            icon: 'assets/icons/tree/workspace.svg', bold: true, expanded: true,
            children: [global, vars, types],
        }]);
    }

    /* The Files tab shows the build directory as it really is: the sources,
       plus whatever the last build actually produced. */
    if (App.treeFiles) {
        const kb = n => n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B';
        const artifacts = (App.buildArtifacts || []).map(a => ({
            label: `${a.path}  (${kb(a.size)})`,
            icon: 'assets/icons/tree/' + (a.kind === 'source' ? 'file.svg' : 'file-readonly.svg'),
            children: [],
        }));
        App.treeFiles.setRoots([{
            label: App.projectPath, icon: 'assets/icons/tree/folder_open.svg', expanded: true,
            children: App.files.map(fileNode).concat(artifacts.length ? [{
                label: 'Build output', icon: 'assets/icons/tree/vfolder_open.svg',
                expanded: true, children: artifacts,
            }] : []),
        }]);
    }

    // Open files list: the editors currently open, in tab order
    if (App.treeOpenFiles) {
        App.treeOpenFiles.setRoots(App.files.map(f => ({
            label: (f.modified ? '*' : '') + f.name,
            icon: 'assets/icons/tree/' + (f.modified ? 'file-modified.svg' : 'file.svg'),
            data: f,
            children: [],
        })));
    }
};

/* ============================================================ persistence */

App.persist = function () {
    try {
        localStorage.setItem(STORE_KEY, JSON.stringify({
            projectPath: App.projectPath,
            target: App.activeTarget,
            projects: App.projects.map(p => ({ name: p.name, files: p.files, args: p.args })),
            files: App.files.map(f => ({ name: f.name, text: f.text(), project: f.project ? f.project.name : null })),
            active: App.nbEditors && App.nbEditors.activePage() ? App.nbEditors.activePage().key : null,
        }));
    } catch (e) { /* private mode, quota - not fatal */ }
};

App.restore = function () {
    let data = null;
    try { data = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch (e) { data = null; }
    if (!data || !data.files || !data.files.length) return false;
    App.projectPath = data.projectPath || App.projectPath;
    App.activeTarget = data.target || 'Debug';
    (data.projects || []).forEach(p => {
        const pr = new Project(p.name);
        pr.files = p.files || [];
        pr.args = p.args || '';
        App.projects.push(pr);
    });
    App.activeProject = App.projects[0] || null;
    data.files.forEach(f => {
        const pr = App.projects.find(p => p.name === f.project) || App.activeProject;
        App.openFile(f.name, f.text, pr, false);
    });
    if (data.active) App.nbEditors.select(data.active);
    return true;
};

/* ============================================================ start page */

function buildStartPage() {
    const div = document.createElement('div');
    div.className = 'start-here';
    div.innerHTML = `
      <div align="center">
        <a href="https://www.codeblocks.org/" target="_blank"><img alt="" src="assets/start_here/title_1712.png"></a>
        <br>
        <a href="#rev"><font color="#0000ff"><small>Release 25.03 rev 13644 (2025-03-29 05:36:19) clang 8.0.1 WebAssembly/unicode - 32 bit</small></font></a>
        <br><br>
        <table border="0" cellspacing="5"><tr>
          <td valign="middle" align="center"><a href="#new"><img style="width:47px;height:42px" alt="" src="assets/start_here/new.png"></a></td>
          <td valign="middle" align="center"><a href="#new"><font color="#0000ff">Create a new project</font></a></td>
          <td valign="middle" align="center"><a href="#open"><img style="width:47px;height:47px" alt="" src="assets/start_here/open.png"></a></td>
          <td valign="middle" align="center"><a href="#open"><font color="#0000ff">Open an existing project</font></a></td>
          <td valign="middle" align="center"><a href="#tip"><img style="width:33px;height:47px" alt="" src="assets/start_here/tip.png"></a></td>
          <td valign="middle" align="center"><a href="#tip"><font color="#0000ff">Tip of the Day</font></a></td>
        </tr></table>
        <table border="0" cellspacing="5"><tr>
          <td align="center"><img alt="" src="assets/start_here/www.png"></td>
          <td align="center"><a href="https://forums.codeblocks.org/" target="_blank"><font color="#0000ff">Visit the Code::Blocks forums</font></a></td>
          <td align="center"><a href="https://sourceforge.net/p/codeblocks/tickets/" target="_blank"><font color="#0000ff">Report a bug or request a new feature</font></a></td>
        </tr></table>
        <table border="0" cellspacing="5"><tr>
          <td valign="middle"><img alt="" src="assets/start_here/reopen.png"></td>
          <td align="left">
            <table><tr><td colspan="2"><b>Recent projects</b></td></tr>
              <tbody id="sp-recent-projects"><tr><td style="width:2em"></td><td>&nbsp;&nbsp;&nbsp;&nbsp;No recent projects</td></tr></tbody>
            </table>
            <table><tr><td colspan="2"><b>Recent files</b></td></tr>
              <tbody id="sp-recent-files"><tr><td style="width:2em"></td><td>&nbsp;&nbsp;&nbsp;&nbsp;No recent files</td></tr></tbody>
            </table>
          </td>
        </tr></table>
        <hr>
        <font color="#000000">&copy; 2004 - 2025, The
          <a href="https://www.codeblocks.org/" target="_blank"><font color="#0000ff">Code::Blocks</font></a> Team.
        </font>
      </div>`;
    div.addEventListener('click', ev => {
        const a = ev.target.closest('a');
        if (!a) return;
        const href = a.getAttribute('href') || '';
        if (href === '#new') { ev.preventDefault(); App.command('idFileNewProject'); }
        else if (href === '#open') { ev.preventDefault(); App.command('idFileOpen'); }
        else if (href === '#tip') { ev.preventDefault(); App.command('idHelpTips'); }
        else if (href.startsWith('#')) ev.preventDefault();
    });
    return div;
}

/* startherepage.cpp renders each entry as: blank spacer, trash icon, link. */
App.updateStartPageRecents = function () {
    const row = (href, text) =>
        `<tr><td width="50"><img alt="" width="20" src="assets/start_here/blank.png">` +
        `<a href="#del"><img alt="" src="assets/start_here/trash_16x16.png"></a>` +
        `<img alt="" width="10" src="assets/start_here/blank.png"></td>` +
        `<td width="10"><a href="${href}"><font color="#0000ff">${text}</font></a></td></tr>`;
    const empty = what =>
        `<tr><td style="width:2em"></td><td>&nbsp;&nbsp;&nbsp;&nbsp;No recent ${what}</td></tr>`;

    const p = document.getElementById('sp-recent-projects');
    const f = document.getElementById('sp-recent-files');
    if (p) {
        p.innerHTML = App.projects.length
            ? App.projects.map(x => row('#project', `${App.projectPath}\\${x.name}.cbp`)).join('')
            : empty('projects');
    }
    if (f) {
        f.innerHTML = App.files.length
            ? App.files.map(x => row('#file', App.pathOf(x))).join('')
            : empty('files');
    }
};

App.openStartPage = function () {
    if (App.nbEditors.indexOf('#start') >= 0) { App.nbEditors.select('#start'); return; }
    App.nbEditors.addPage('#start', 'Start here', buildStartPage(), 'assets/codeblocks.png', true);
    App.nbEditors.select('#start');
    App.updateStartPageRecents();
};

/* ========================================================== the menu bar */

App.menuState = function (item) {
    const f = App.activeFile();
    switch (item.id) {
        case 'idFileSave': case 'idFileSaveAs': case 'idFileClose':
        case 'idEditUndo': case 'idEditRedo': case 'idEditCut': case 'idEditCopy':
        case 'idEditPaste': case 'idEditSelectAll': case 'idSearchFind':
        case 'idSearchReplace': case 'idSearchGotoLine':
        case 'idEditCommentSelected': case 'idEditUncommentSelected':
        case 'idEditToggleCommentSelected':
            return { enabled: !!f };
        case 'idCompilerMenuKillProcess':
            return { enabled: !!Build.process || Build.running };
        case 'idCompilerMenuCompile': case 'idCompilerMenuRun':
        case 'idCompilerMenuCompileAndRun': case 'idCompilerMenuRebuild':
        case 'idCompilerMenuClean': case 'idCompilerMenuCompileFile':
            return { enabled: !Build.running && !Build.process };
        case 'idDebuggerMenuDebug':
            return { enabled: !Build.running };
        case 'idDebuggerMenuStop': case 'idDebuggerMenuBreak':
            return { enabled: Debugger.active };
        case 'idDebuggerMenuNext': case 'idDebuggerMenuStep':
        case 'idDebuggerMenuStepOut': case 'idDebuggerMenuRunToCursor':
            return { enabled: Debugger.active };
        case 'idViewManager':
            return { checked: !document.getElementById('pane-management').classList.contains('hidden') };
        case 'idViewLogManager':
            return { checked: !document.getElementById('pane-logs').classList.contains('hidden') };
        case 'idViewStatusbar':
            return { checked: !document.getElementById('statusbar').classList.contains('hidden') };
        case 'idViewStartPage':
            return { checked: App.nbEditors.indexOf('#start') >= 0 };
        case 'idFileCloseProject': case 'idFileSaveProject':
            return { enabled: !!App.activeProject };
        default:
            return {};
    }
};
UI.menuState = App.menuState;

/* ------------------------------------------------------------- commands */

App.command = async function (id, extra) {
    const f = App.activeFile();
    const cm = f && f.cm;

    if (typeof Features !== 'undefined' && Features.contextCommand(id, extra)) return;

    switch (id) {
        /* ---- File ---- */
        case 'idFileNewEmpty': {
            let n = 1;
            while (App.files.some(x => x.name === `Untitled${n}.cpp`)) n++;
            App.openFile(`Untitled${n}.cpp`, '');
            return;
        }
        case 'idFileNewProject': case 'idFileNewCustom': case 'idFileNewUser':
            return Wizard.newProject();
        case 'idFileNewFile':
            return App.command('idFileNewEmpty');
        case 'idFileOpen': return App.openFromDisk();
        case 'idFileSave': if (f) await App.saveFile(f); return;
        case 'idFileSaveAs': {
            if (!f) return;
            const handle = await Disk.saveAs(f.name, f.text());
            if (handle) {
                f.handle = handle;
                f.name = handle.name;
                f.modified = false;
                App.nbEditors.setTitle(f.key, f.name);
                App.refreshTrees();
                App.persist();
                App.updateStatusBar();
            }
            return;
        }
        case 'idFileSaveAll': case 'idFileSaveProject': case 'idFileSaveWorkspace':
            await App.saveAll();
            return;
        case 'idFileClose': if (f) await App.closeFile(f); return;
        case 'idFileCloseAll':
            for (const x of App.files.slice()) if (!await App.closeFile(x)) break;
            return;
        case 'idFileCloseProject':
            App.projects = [];
            App.activeProject = null;
            for (const x of App.files.slice()) await App.closeFile(x);
            App.refreshTrees();
            return;
        case 'idFilePrint': window.print(); return;
        case 'idFileExit':
            if (confirm('Quit Code::Blocks?')) window.close();
            return;

        /* ---- Edit ---- */
        case 'idEditUndo': if (cm) { cm.undo(); cm.focus(); } return;
        case 'idEditRedo': if (cm) { cm.redo(); cm.focus(); } return;
        case 'idEditCut': if (cm) { document.execCommand('cut'); cm.focus(); } return;
        case 'idEditCopy': if (cm) { document.execCommand('copy'); cm.focus(); } return;
        case 'idEditPaste':
            if (cm && navigator.clipboard) {
                try { cm.replaceSelection(await navigator.clipboard.readText()); } catch (e) { /* denied */ }
                cm.focus();
            }
            return;
        case 'idEditSelectAll': if (cm) { cm.execCommand('selectAll'); cm.focus(); } return;
        case 'idEditCommentSelected': if (cm) cm.execCommand('toggleComment'); return;
        case 'idEditUncommentSelected': if (cm) cm.execCommand('toggleComment'); return;
        case 'idEditToggleCommentSelected': if (cm) cm.execCommand('toggleComment'); return;
        case 'idEditGotoMatchingBrace': if (cm) cm.execCommand('goToBracket'); return;
        case 'idEditFoldAll': if (cm) cm.execCommand('foldAll'); return;
        case 'idEditUnfoldAll': if (cm) cm.execCommand('unfoldAll'); return;

        /* ---- Search ---- */
        case 'idSearchFind': return Features.findDialog(false);
        case 'idSearchReplace': return Features.findDialog(true);
        case 'idSearchFindNext':
            Features.findState.direction = 'down';
            return Features.doFind();
        case 'idSearchFindPrevious':
            Features.findState.direction = 'up';
            return Features.doFind();
        case 'idSearchGotoLine': {
            if (!cm) return;
            const n = await UI.textEntry('Line: (1 - ' + cm.lineCount() + ')', 'Goto line', '');
            if (n) App.gotoLine(parseInt(n, 10));
            return;
        }
        case 'idMenuGotoFile': return Features.gotoFileDialog();
        case 'idFileNewClass': return Features.classWizard();

        /* ---- View ---- */
        case 'idViewManager': App.togglePaneVisible('management'); return;
        case 'idViewLogManager': App.togglePaneVisible('logs'); return;
        case 'idViewStatusbar':
            document.getElementById('statusbar').classList.toggle('hidden');
            return;
        case 'idViewStartPage':
            if (App.nbEditors.indexOf('#start') >= 0) App.nbEditors.removePage('#start');
            else App.openStartPage();
            return;
        case 'idViewFullScreen':
            if (document.fullscreenElement) document.exitFullscreen();
            else document.documentElement.requestFullscreen();
            return;
        case 'idViewFocusEditor': if (cm) cm.focus(); return;
        case 'idViewFocusManagement': document.getElementById('pane-management').scrollIntoView(); return;
        case 'idViewFocusLogsAndOthers': App.selectLogTab('build'); return;
        case 'idViewToolbarsMain': document.getElementById('tb-main').classList.toggle('hidden'); return;
        case 'idViewToolbarsCompiler': document.getElementById('tb-compiler').classList.toggle('hidden'); return;
        case 'idViewToolbarsDebugger': document.getElementById('tb-debugger').classList.toggle('hidden'); return;

        /* ---- Project ---- */
        case 'idMenuAddFile': {
            const name = await UI.textEntry('File name to add:', 'Add files', 'utils.cpp');
            if (!name) return;
            const nf = App.openFile(name, '');
            if (App.activeProject) { nf.project = App.activeProject; App.activeProject.files.push(name); }
            App.refreshTrees();
            return;
        }
        case 'idMenuRemoveFile': {
            if (!f) return;
            App.closeFile(f);
            return;
        }
        case 'idMenuExecParams': {
            const args = await UI.textEntry('Program arguments:', "Select program's arguments",
                App.activeProject ? App.activeProject.args : '');
            if (args !== null && App.activeProject) App.activeProject.args = args;
            return;
        }
        case 'idMenuProjectProperties': case 'idMenuFileProperties':
            return Dialogs.projectProperties();

        /* ---- Build ---- */
        case 'idCompilerMenuCompile': case 'idCompilerMenuCompileFile':
            return Build.doBuild();
        case 'idCompilerMenuRun': return Build.doRun();
        case 'idCompilerMenuCompileAndRun': return Build.doBuildAndRun();
        case 'idCompilerMenuRebuild': return Build.doRebuild();
        case 'idCompilerMenuClean': case 'idCompilerMenuCleanWorkspace': return Build.doClean();
        case 'idCompilerMenuBuildWorkspace': return Build.doBuild();
        case 'idCompilerMenuRebuildWorkspace': return Build.doRebuild();
        case 'idCompilerMenuKillProcess': Build.abort(); return;
        case 'idCompilerMenuNextError': App.gotoError(1); return;
        case 'idCompilerMenuPreviousError': App.gotoError(-1); return;
        case 'idCompilerMenuClearErrors': Build.clearMessages(); return;
        case 'idCompilerTarget0': App.setTarget('Debug'); return;
        case 'idCompilerTarget1': App.setTarget('Release'); return;
        case 'idMenuSelectTargetDialog': return Dialogs.selectTarget();

        /* ---- Debug ---- */
        case 'idDebuggerMenuDebug': return Debugger.start();
        case 'idDebuggerMenuStop': Debugger.stop(); return;
        case 'idDebuggerMenuBreak': Debugger.mode = 'step'; return;
        case 'idDebuggerMenuNext': Debugger.next(); return;
        case 'idDebuggerMenuStep': Debugger.stepInto(); return;
        case 'idDebuggerMenuStepOut': Debugger.stepOut(); return;
        case 'idDebuggerMenuRunToCursor':
            if (cm && f) {
                Debugger.toggleBreakpoint(f.name, cm.getCursor().line + 1);
                App.refreshBreakpoints();
                if (Debugger.active) Debugger.cont(); else await Debugger.start();
            }
            return;
        case 'idDebuggerMenuToggleBreakpoint':
            if (cm && f) App.toggleBreakpointAt(f, cm.getCursor().line + 1);
            return;
        case 'idDebuggerMenuRemoveAllBreakpoints': Debugger.removeAll(); return;
        case 'idDebuggerWinBreakpoints': App.selectLogTab('breakpoints'); return;
        case 'idDebuggerWinWatches': App.selectLogTab('watches'); return;
        case 'idDebuggerWinCallStack': App.selectLogTab('callstack'); return;

        /* ---- Settings / Help ---- */
        case 'idSettingsCompiler': return Features.buildOptionsDialog();
        case 'idSettingsEditor': return Features.editorSettingsDialog();
        case 'idSettingsEnvironment':
        case 'idSettingsDebugger': case 'idSettingsScripting':
            return Dialogs.settingsStub(id);
        case 'idPluginsManagePlugins': return Dialogs.plugins();
        case 'wxID_ABOUT': return Dialogs.about();
        case 'idHelpTips': return Dialogs.tipOfTheDay();

        default:
            if (typeof Features !== 'undefined' && Features.command(id)) return;
            UI.setStatus(0, 'Command "' + id + '" is not available in the web edition');
            return;
    }
};

/* The IncrementalSearch toolbar: types straight into the active editor. */
App.incSearch = { text: '', pos: null, highlight: false, matchCase: false, regex: false };

App.incrementalSearch = function (c) {
    const f = App.activeFile();
    const cm = f && f.cm;
    const st = App.incSearch;

    switch (c.id) {
        case 'idIncSearchText': st.text = c.value; break;
        case 'idIncSearchClear': {
            st.text = '';
            const box = document.getElementById('idIncSearchText');
            if (box) box.value = '';
            App.clearIncHighlight();
            return;
        }
        case 'idIncSearchHighlight': st.highlight = !st.highlight; break;
        case 'idIncSearchCase': st.matchCase = !st.matchCase; break;
        case 'idIncSearchRegex': st.regex = !st.regex; break;
        case 'idIncSearchSelected': st.selectedOnly = !st.selectedOnly; break;
        default: break;
    }
    if (!cm || !st.text) { App.clearIncHighlight(); return; }

    const query = st.regex ? new RegExp(st.text, st.matchCase ? 'g' : 'gi') : st.text;
    const back = c.id === 'idIncSearchPrev';
    const from = back ? cm.getCursor('from') : cm.getCursor('to');
    let cursor = cm.getSearchCursor(query, from, !st.matchCase);
    const found = back ? cursor.findPrevious() : cursor.findNext();
    if (!found) {
        cursor = cm.getSearchCursor(query, back ? null : { line: 0, ch: 0 }, !st.matchCase);
        if (!(back ? cursor.findPrevious() : cursor.findNext())) return;
    }
    cm.setSelection(cursor.from(), cursor.to());
    cm.scrollIntoView({ from: cursor.from(), to: cursor.to() }, 60);

    App.clearIncHighlight();
    if (st.highlight) {
        const marks = [];
        const all = cm.getSearchCursor(query, { line: 0, ch: 0 }, !st.matchCase);
        while (all.findNext())
            marks.push(cm.markText(all.from(), all.to(), { className: 'cm-matchhighlight' }));
        App.incMarks = marks;
    }
};

App.clearIncHighlight = function () {
    (App.incMarks || []).forEach(m => m.clear());
    App.incMarks = [];
};

App.setTarget = function (t) {
    App.activeTarget = t;
    const sel = document.getElementById('idToolTarget');
    if (sel) sel.value = t;
    Build.lastBuild = null;
    App.persist();
};

/* The build-target dropdown follows the project's own targets, so a project
   the wizard made with only a Release configuration offers only that. */
App.setTargetList = function (p) {
    const sel = document.getElementById('idToolTarget');
    if (!sel) return;
    const targets = (p && p.targets && p.targets.length) ? p.targets : ['Debug', 'Release'];
    sel.innerHTML = '';
    targets.forEach(t => {
        const o = document.createElement('option');
        o.textContent = t;
        sel.appendChild(o);
    });
    App.setTarget(targets.includes(App.activeTarget) ? App.activeTarget : targets[0]);
};

App.gotoError = function (dir) {
    const rows = Array.from(document.querySelectorAll('#build-messages tbody tr'))
        .filter(r => r.classList.contains('error') || r.classList.contains('warning'));
    if (!rows.length) return;
    let i = rows.findIndex(r => r.classList.contains('selected'));
    i = (i < 0 ? (dir > 0 ? -1 : 0) : i) + dir;
    if (i < 0) i = rows.length - 1;
    if (i >= rows.length) i = 0;
    rows[i].click();
    rows[i].scrollIntoView({ block: 'nearest' });
};

App.openFromDisk = function () {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.c,.cpp,.cc,.cxx,.h,.hpp,.txt';
    input.multiple = true;
    input.addEventListener('change', () => {
        Array.from(input.files).forEach(file => {
            const r = new FileReader();
            r.onload = () => {
                App.openFile(file.name, String(r.result));
                App.persist();
            };
            r.readAsText(file);
        });
    });
    input.click();
};

/* ---------------------------------------------------------- pane toggles */

App.togglePaneVisible = function (which) {
    const pane = document.getElementById(which === 'logs' ? 'pane-logs' : 'pane-management');
    const sash = document.getElementById(which === 'logs' ? 'sash-bottom' : 'sash-left');
    pane.classList.toggle('hidden');
    sash.classList.toggle('hidden');
    App.refreshEditors();
};
App.togglePane = App.togglePaneVisible;

App.refreshEditors = function () {
    App.files.forEach(f => { if (f.cm) f.cm.refresh(); });
};
UI.onLayout = App.refreshEditors;

/* ============================================================== dialogs */

const Dialogs = {};

/* The desktop About box: the splash bitmap, the build stamp and a notebook
   with Description / Information / Plugins / Thanks to... / License.  Same
   pages, same texts (src/src/dlgabout.cpp), with the numbers this edition can
   actually measure. */
Dialogs.about = function () {
    const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');

    /* dlgabout.cpp lays the Information and Plugins pages out by padding the
       names to a common width - keep that. */
    const format = items => {
        const w = items.reduce((m, i) => Math.max(m, i[0].length), 0);
        return items.map(i => i[0] + ' '.repeat(w - i[0].length) + ' : ' + i[1]).join('\n');
    };

    const description =
        'Welcome to Code::Blocks 25.03!\n' +
        'Code::Blocks is a full-featured IDE (Integrated Development Environment) ' +
        'aiming to make the individual developer (and the development team) work in ' +
        'a nice programming environment offering everything he/they would ever need ' +
        'from a program of that kind.\n' +
        'Its pluggable architecture allows you, the developer, to add any kind of ' +
        'functionality to the core program, through the use of plugins...\n';

    const dpr = window.devicePixelRatio || 1;
    const info = [
        ['Name', 'Code::Blocks'],
        ['Version', '25.03-r13644'],
        ['SDK Version', '2.25.0'],
        ['Editor Version', 'CodeMirror ' + (window.CodeMirror ? CodeMirror.version : '5')],
        ['Compiler', 'clang 8.0.1 - WebAssembly, libc++ (runs in this page)'],
        ['Author', 'The Code::Blocks Team'],
        ['E-mail', 'info@codeblocks.org'],
        ['Website', 'https://www.codeblocks.org'],
        ['Web edition', 'https://github.com/giangnam0201/codeblocks-web'],
        ['Web edition by', 'https://github.com/giangnam0201'],
        ['Build', document.lastModified],
        ['Browser', navigator.userAgent],
        ['OS', (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform],
        ['Scaling factor', dpr.toFixed(6)],
        ['Display PPI', Math.round(96 * dpr) + 'x' + Math.round(96 * dpr)],
        ['Display count', '1'],
        ['Display 0', `XY=[${screen.availLeft || 0},${screen.availTop || 0}]; ` +
                      `Size=[${screen.width},${screen.height}]; Primary`],
        ['Storage', navigator.storage ? 'Cache API (the toolchain is kept offline)' : 'none'],
        ['Cores', navigator.hardwareConcurrency || 'unknown'],
    ];

    const thanks =
`Developers:
--------------
Yiannis Mandravellos: Developer - Project leader
Thomas Denk         : Developer
Lieven de Cock      : Developer
"tiwag"             : Developer
Martin Halle        : Developer
Biplab Modak        : Developer
Jens Lody           : Developer
Yuchen Deng         : Developer
Teodor Petrov       : Developer
Daniel Anselmi      : Developer
Yuanhui Zhang       : Developer
Damien Moore        : Developer
Micah Ng            : Developer
BlueHazzard         : Developer
Miguel Gimenez      : Developer
Ricardo Garcia      : All-hands person
Paul A. Jimenez     : Help and AStyle plugins
Thomas Lorblanches  : CodeStat and Profiler plugins
Bartlomiej Swiecki  : wxSmith RAD plugin
Jerome Antoine      : ThreadSearch plugin
Pecan Heber         : Keybinder, BrowseTracker, DragScroll
                      CodeSnippets, clangd-client plugins
Arto Jonsson        : CodeSnippets plugin (passed on to Pecan)
Darius Markauskas   : Fortran support
Mario Cupelli       : Compiler support for embedded systems
                      User's manual
Jonas Zinn          : Misc. wxSmith AddOns and plugins
Mirai Computing     : cbp2make tool
Anders F Bjoerklund : wxMac compatibility

Contributors (in no special order):
-----------------------------------
Daniel Orb          : RPM spec file and packages
byo,elvstone, me22  : Conversion to Unicode
pasgui              : Providing Ubuntu nightly packages
Hakki Dogusan       : DigitalMars compiler support
ybx                 : OpenWatcom compiler support
Tim Baker           : Patches for the direct-compile-mode
                      dependencies generation system
David Perfors       : Unicode tester and future documentation writer
Sylvain Prat        : Initial MSVC workspace and project importers
Chris Raschko       : Design of the 3D logo for Code::Blocks
J.A. Ortega         : 3D Icon based on the above
Alexandr Efremo     : Providing OpenSuSe packages
Huki                : Misc. Code-Completion improvements
stahta01            : Misc. patches for several enhancements
Gerard Durand       : Translation infrastructure, documentation writer

All contributors that provided patches.
The wxWidgets project (https://www.wxwidgets.org).
wxScintilla (https://sourceforge.net/projects/wxscintilla).
TinyXML parser (https://www.grinninglizard.com/tinyxml).
Squirrel scripting language (http://www.squirrel-lang.org).
The GNU Software Foundation (https://www.gnu.org).
Last, but not least, the open-source community.

Web edition:
--------------
giangnam0201        : the browser port - https://github.com/giangnam0201
clang / LLVM        : the C++ compiler, built to WebAssembly
binji/wasm-clang    : the WebAssembly toolchain this edition runs on
CodeMirror          : the editor component`;

    const license =
        'This program is licensed under the terms\n' +
        'of the GNU General Public License version 3\n\n' +
        'Available online under:\nhttp://www.gnu.org/licenses/gpl-3.0.html\n\n' +
        'The web edition keeps the same license, and its source is at\n' +
        'https://github.com/giangnam0201/codeblocks-web';

    const body = document.createElement('div');
    /* single quotes: this string is interpolated into a style="" attribute */
    const pageStyle = 'height:200px;overflow:auto;border:1px solid #8b8b8b;background:#fff;' +
                      "padding:6px;white-space:pre-wrap;font-family:Consolas,'Courier New',monospace;" +
                      'font-size:12px';
    body.innerHTML = `
      <div style="text-align:center">
        <img src="assets/splash_2503.png" style="max-width:100%;max-height:190px">
      </div>
      <div style="text-align:right;padding:2px 2px 6px">Build: ${esc(document.lastModified)}</div>
      <hr style="border:none;border-top:1px solid #d5d5d5;margin:0 0 6px">
      <div style="display:flex;gap:4px;margin-bottom:6px">
        <div class="cb-tab-btn" data-p="desc" style="font-weight:bold">Description</div>
        <div class="cb-tab-btn" data-p="info">Information</div>
        <div class="cb-tab-btn" data-p="plug">Plugins</div>
        <div class="cb-tab-btn" data-p="thx">Thanks to...</div>
        <div class="cb-tab-btn" data-p="lic">License</div>
      </div>
      <div data-b="desc" style="${pageStyle};white-space:normal;font-family:inherit;font-size:inherit">
        ${esc(description).replace(/\n/g, '<br>')}
        <div style="margin-top:10px">
          This edition runs the whole IDE in the browser: the editor, the project
          manager and a real clang 8.0.1 compiled to WebAssembly, so your code is
          compiled and run on your own machine with nothing sent to a server.
        </div>
        <div style="margin-top:10px">
          Web edition by
          <a href="https://github.com/giangnam0201" target="_blank" rel="noopener">github.com/giangnam0201</a>
          &mdash; source at
          <a href="https://github.com/giangnam0201/codeblocks-web" target="_blank" rel="noopener">giangnam0201/codeblocks-web</a>
        </div>
        <div style="margin-top:10px">&copy; 2004 - 2025, The Code::Blocks Team.</div>
      </div>
      <div data-b="info" style="${pageStyle};display:none">${esc(format(info))}</div>
      <div data-b="plug" style="${pageStyle};display:none">Loading...</div>
      <div data-b="thx"  style="${pageStyle};display:none">${esc(thanks)}</div>
      <div data-b="lic"  style="${pageStyle};display:none">${esc(license)}</div>`;

    body.querySelectorAll('.cb-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            body.querySelectorAll('.cb-tab-btn').forEach(b =>
                b.style.fontWeight = b === btn ? 'bold' : 'normal');
            body.querySelectorAll('[data-b]').forEach(p =>
                p.style.display = p.dataset.b === btn.dataset.p ? '' : 'none');
        });
    });

    /* Plugins page: the active plugins and their versions, like the real one. */
    (async () => {
        let list = [];
        try { list = await (await fetch('assets/plugins.json')).json(); } catch (e) { /* offline */ }
        const active = list
            .filter(p => App.pluginState[p.name] !== false)
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
            .map(p => [p.name, p.version]);
        const box = body.querySelector('[data-b="plug"]');
        box.textContent = active.length ? format(active) : 'There are no active plugins\n';
    })();

    const w = UI.window({
        title: 'About...', icon: 'assets/codeblocks.png',
        width: 560, minimizable: false, body,
        buttons: [{ label: 'OK', onClick: () => w.remove() }],
    });
    w.style.height = 'auto';
    w.style.maxHeight = '94vh';
    w.style.top = '3vh';
};

/* Tip of the Day, reading the tips Code::Blocks itself ships in src/tips.txt. */
App.tips = null;
Dialogs.tipOfTheDay = async function () {
    if (!App.tips) {
        try {
            const r = await fetch('assets/tips.txt');
            App.tips = (await r.text()).split('\n').map(s => s.trim()).filter(Boolean);
        } catch (e) {
            App.tips = ['You can build and run your program with a single keystroke: F9'];
        }
    }
    let i = Math.floor(Math.random() * App.tips.length);

    const body = document.createElement('div');
    body.style.cssText = 'display:flex;gap:12px;';
    const text = document.createElement('div');
    text.innerHTML = `<b>Did you know...</b><br><br><span id="tip-text">${App.tips[i]}</span>
        <label style="display:block;margin-top:14px">
          <input type="checkbox" id="tip-startup" checked> Show tips at startup</label>`;
    body.innerHTML = '<img src="assets/icons/idea.svg" style="width:48px;height:48px;flex:none">';
    body.appendChild(text);

    const w = UI.window({
        title: 'Tip of the Day', icon: 'assets/codeblocks.png', width: 470,
        minimizable: false, body,
        buttons: [
            {
                label: 'Next tip',
                onClick: () => {
                    i = (i + 1) % App.tips.length;
                    document.getElementById('tip-text').textContent = App.tips[i];
                },
            },
            {
                label: 'Close',
                onClick: () => {
                    const cb = document.getElementById('tip-startup');
                    localStorage.setItem('cbweb.tips', cb && cb.checked ? '1' : '0');
                    w.remove();
                },
            },
        ],
    });
    w.style.height = 'auto';
};

/* Manage plugins, listing the plugins this source tree actually ships (read
   from their manifest.xml files) and letting the ones we implement be turned
   on and off for real. */
App.pluginState = { Abbreviations: true, 'Occurrences highlighting': true,
                    Autosave: true, 'Code statistics': true, 'To-Do list': true,
                    'Source code formatter (AStyle)': true, 'BYO Games': true,
                    'Incremental search': true, BrowseTracker: true,
                    'Thread search': true, DoxyBlocks: true, 'Code completion': true };

Dialogs.plugins = async function () {
    let list = [];
    try {
        const r = await fetch('assets/plugins.json');
        list = await r.json();
    } catch (e) { /* fall back to what we implement */ }
    const implemented = Object.keys(App.pluginState);
    for (const name of implemented)
        if (!list.some(p => p.name === name)) list.push({ name, version: '1.0', description: '' });
    list.sort((a, b) => a.name.localeCompare(b.name));

    const body = document.createElement('div');
    body.innerHTML =
        '<div style="margin-bottom:6px">Plugins shipped with Code::Blocks 25.03. ' +
        'The ones in <b>bold</b> are implemented in the web edition and can be toggled.</div>' +
        '<table class="log-grid"><thead><tr><th style="width:30px"></th><th>Title</th>' +
        '<th style="width:60px">Version</th><th>Description</th></tr></thead><tbody>' +
        list.map((p, i) => {
            const on = App.pluginState[p.name];
            const live = on !== undefined;
            return `<tr><td><input type="checkbox" data-i="${i}" ${live ? (on ? 'checked' : '') : 'checked disabled'}></td>` +
                   `<td${live ? ' style="font-weight:bold"' : ''}>${p.name}</td>` +
                   `<td>${p.version}</td><td>${p.description || ''}</td></tr>`;
        }).join('') + '</tbody></table>';

    const w = UI.window({
        title: 'Manage plugins', icon: 'assets/icons/plug.svg', width: 640, height: 420, body,
        buttons: [
            {
                label: 'OK',
                onClick: () => {
                    body.querySelectorAll('input[data-i]:not([disabled])').forEach(cb => {
                        const p = list[+cb.dataset.i];
                        App.pluginState[p.name] = cb.checked;
                    });
                    App.highlightOccurrencesOn = !!App.pluginState['Occurrences highlighting'];
                    App.refreshTrees();
                    localStorage.setItem('cbweb.plugins', JSON.stringify(App.pluginState));
                    w.remove();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
};

/* Settings -> Environment: the options that genuinely apply here. */
App.environment = {
    showStartPage: true, tipsAtStartup: false, autosave: true, autosaveMins: 5,
    tabsBottom: false, logsTabsBottom: false, showToolbars: true,
    consoleFontSize: 14, terminalRows: 25,
};

Dialogs.environment = function () {
    const e = App.environment;
    const body = document.createElement('div');
    const check = (k, label) => `<label style="display:block;margin:3px 0">
        <input type="checkbox" data-k="${k}" ${e[k] ? 'checked' : ''}> ${label}</label>`;
    body.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">General</div>
      ${check('showStartPage', 'Show Start page at startup')}
      ${check('tipsAtStartup', 'Show tips at startup')}
      ${check('autosave', 'Autosave the workspace')}
      <table style="border-spacing:6px;margin-top:4px">
        <tr><td>Autosave every</td><td><input class="cb" type="number" min="1" max="60"
            data-k="autosaveMins" value="${e.autosaveMins}" style="width:60px"> minutes</td></tr>
        <tr><td>Console font size</td><td><input class="cb" type="number" min="8" max="28"
            data-k="consoleFontSize" value="${e.consoleFontSize}" style="width:60px"> px</td></tr>
      </table>
      <div style="font-weight:bold;margin:10px 0 6px">Notebook appearance</div>
      ${check('tabsBottom', 'Editor tabs at the bottom')}
      ${check('logsTabsBottom', 'Logs tabs at the bottom')}`;

    const w = UI.window({
        title: 'Environment settings', icon: 'assets/codeblocks.png', width: 440, body,
        buttons: [
            {
                label: 'OK',
                onClick: () => {
                    body.querySelectorAll('[data-k]').forEach(inp => {
                        e[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked
                                                                  : (parseInt(inp.value, 10) || 0);
                    });
                    App.applyEnvironment();
                    localStorage.setItem('cbweb.env', JSON.stringify(e));
                    w.remove();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

App.applyEnvironment = function () {
    const e = App.environment;
    document.documentElement.style.setProperty('--console-size', e.consoleFontSize + 'px');
    document.querySelectorAll('.console-screen').forEach(s => {
        s.style.fontSize = e.consoleFontSize + 'px';
    });
    document.getElementById('nb-editors').classList.toggle('tabs-bottom', e.tabsBottom);
    document.getElementById('nb-logs').classList.toggle('tabs-bottom', e.logsTabsBottom);
    if (App.autosaveTimer) clearInterval(App.autosaveTimer);
    if (e.autosave)
        App.autosaveTimer = setInterval(() => App.persist(), Math.max(1, e.autosaveMins) * 60000);
};

/* Settings -> Debugger: the options the stepping engine honours. */
App.debuggerSettings = { stopOnMain: false, evalTooltips: true, maxSteps: 5000000 };

Dialogs.debuggerSettings = function () {
    const d = App.debuggerSettings;
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="font-weight:bold;margin-bottom:6px">GDB/CDB debugger : Default</div>
      <label style="display:block;margin:3px 0"><input type="checkbox" data-k="stopOnMain"
        ${d.stopOnMain ? 'checked' : ''}> Run to main() when the debugger starts</label>
      <label style="display:block;margin:3px 0"><input type="checkbox" data-k="evalTooltips"
        ${d.evalTooltips ? 'checked' : ''}> Evaluate expression under cursor (tooltips)</label>
      <table style="border-spacing:6px;margin-top:6px">
        <tr><td>Step limit before aborting</td><td><input class="cb" type="number"
          data-k="maxSteps" value="${d.maxSteps}" style="width:110px"></td></tr>
      </table>`;
    const w = UI.window({
        title: 'Debugger settings', icon: 'assets/icons/dbgrun.svg', width: 440, body,
        buttons: [
            {
                label: 'OK',
                onClick: () => {
                    body.querySelectorAll('[data-k]').forEach(inp => {
                        d[inp.dataset.k] = inp.type === 'checkbox' ? inp.checked
                                                                   : (parseInt(inp.value, 10) || 0);
                    });
                    w.remove();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

Dialogs.settingsStub = function (id) {
    if (id === 'idSettingsEnvironment') return Dialogs.environment();
    if (id === 'idSettingsDebugger') return Dialogs.debuggerSettings();
    return Features.scriptConsole();
};

Dialogs.selectTarget = function () {
    const body = document.createElement('div');
    body.innerHTML = '<div>Select the target you want to build:</div>' +
        '<select class="cb" size="6" style="width:100%;margin-top:8px" id="tgt-list">' +
        ['Debug', 'Release'].map(t => `<option${t === App.activeTarget ? ' selected' : ''}>${t}</option>`).join('') +
        '</select>';
    const w = UI.window({
        title: 'Select target', icon: 'assets/icons/select_target.svg', width: 320, body,
        buttons: [
            { label: 'OK', onClick: () => { App.setTarget(document.getElementById('tgt-list').value); w.remove(); } },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

Dialogs.projectProperties = function () {
    const p = App.activeProject;
    const body = document.createElement('div');
    body.innerHTML = `
      <table style="border-spacing:6px">
        <tr><td>Project title:</td><td><input class="cb" id="pp-title" value="${p ? p.name : ''}" style="width:240px"></td></tr>
        <tr><td>Filename:</td><td>${App.projectPath}\\${p ? p.name : 'project'}.cbp</td></tr>
        <tr><td>Platforms:</td><td>All</td></tr>
        <tr><td>Makefile:</td><td>Makefile</td></tr>
      </table>`;
    const w = UI.window({
        title: 'Project/target options', icon: 'assets/icons/tree/project.svg', width: 520, body,
        buttons: [
            {
                label: 'OK',
                onClick: () => {
                    const t = document.getElementById('pp-title').value.trim();
                    if (p && t) { p.name = t; App.refreshTrees(); App.persist(); }
                    w.remove();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
};

/* ------------------------------------------------------- project wizard */

const Wizard = {};

/* The template gallery, then the scripted wizard itself.  Both follow the
   desktop: the gallery is "New from template" with its category list, and the
   console wizard walks the same four pages its wizard.script defines - intro,
   language, project path, compiler and configurations - with the strings from
   projectpathpanel.cpp and compilerpanel.cpp. */

Wizard.TEMPLATES = [
    {
        id: 'console', title: 'Console application', icon: 'assets/console_logo.png',
        info: 'Welcome to the new console application wizard!\n' +
              'This wizard will guide you to create a new console application.\n\n' +
              'When you\'re ready to proceed, please click "Next"...',
        languages: true,
    },
    {
        id: 'empty', title: 'Empty project', icon: 'assets/icons/filenew.svg',
        info: 'Welcome to the new empty project wizard!\n' +
              'This wizard will guide you to create a new empty project.\n\n' +
              'When you\'re ready to proceed, please click "Next"...',
        languages: false,
    },
    {
        id: 'staticlib', title: 'Static library', icon: 'assets/icons/tree/project.svg',
        info: 'Welcome to the new static library wizard!\n' +
              'This wizard will guide you to create a new static library.\n\n' +
              'When you\'re ready to proceed, please click "Next"...',
        languages: true,
    },
];

Wizard.newProject = function () {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="display:flex;gap:10px;height:300px">
        <div style="width:150px;border:1px solid #7a7a7a;background:#fff;overflow:auto" id="wiz-cats"></div>
        <div style="flex:1;display:flex;flex-direction:column">
          <div style="flex:1;border:1px solid #7a7a7a;background:#fff;padding:10px;overflow:auto">
            <div id="wiz-templates" style="display:flex;flex-wrap:wrap;gap:14px"></div>
          </div>
          <div style="margin-top:6px">
            View as: <label><input type="radio" name="wiz-view" checked> Large icons</label>
            <label style="margin-left:8px"><input type="radio" name="wiz-view"> List</label>
          </div>
        </div>
      </div>
      <div id="wiz-tip" style="margin-top:8px;min-height:32px">
        TIP: Select a wizard and press "Go" to start it.
      </div>`;

    const cats = ['Projects', 'Build targets', 'Files', 'Custom', 'User templates'];
    const catBox = body.querySelector('#wiz-cats');
    cats.forEach((c, i) => {
        const row = el('div', 'tree-row' + (i === 0 ? ' selected' : ''));
        row.style.paddingLeft = '6px';
        row.textContent = c;
        row.addEventListener('click', () => {
            catBox.querySelectorAll('.tree-row').forEach(r => r.classList.remove('selected'));
            row.classList.add('selected');
            body.querySelector('#wiz-tip').textContent = i === 0
                ? 'TIP: Select a wizard and press "Go" to start it.'
                : `TIP: The web edition creates projects and files; "${c}" is empty here.`;
            grid.style.display = i === 0 ? 'flex' : 'none';
        });
        catBox.appendChild(row);
    });

    let chosen = Wizard.TEMPLATES[0];
    const grid = body.querySelector('#wiz-templates');
    Wizard.TEMPLATES.forEach(t => {
        const item = el('div', 'wiz-item');
        item.style.cssText = 'width:92px;text-align:center;padding:4px;border:1px solid transparent';
        item.innerHTML = `<img src="${t.icon}" style="width:32px;height:32px"><br>${t.title}`;
        const select = () => {
            chosen = t;
            grid.querySelectorAll('.wiz-item').forEach(o => {
                o.style.background = o === item ? '#cce8ff' : '';
                o.style.borderColor = o === item ? '#99d1ff' : 'transparent';
            });
        };
        item.addEventListener('click', select);
        item.addEventListener('dblclick', () => { select(); go(); });
        grid.appendChild(item);
        if (t === chosen) select();
    });

    const go = () => { w.remove(); Wizard.run(chosen); };
    const w = UI.window({
        title: 'New from template', icon: 'assets/codeblocks.png', width: 620, height: 460, body,
        buttons: [
            { label: 'Go', onClick: go },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
};

/* The wizard pages.  Back/Next/Finish behave as they do on the desktop:
   Finish only lights up on the last page, and Next validates the page it is
   leaving. */
Wizard.run = function (tpl) {
    const state = {
        lang: 1,                                  // 0 = C, 1 = C++
        title: 'MyProject',
        dir: 'C:\\Users\\Dev\\Projects',
        compiler: 'GNU GCC Compiler',
        debug: true, debugName: 'Debug',
        debugOut: 'bin\\Debug\\', debugObj: 'obj\\Debug\\',
        release: true, releaseName: 'Release',
        releaseOut: 'bin\\Release\\', releaseObj: 'obj\\Release\\',
    };

    const pages = [];
    pages.push({                                   // Wizard.AddInfoPage
        name: 'intro',
        render: () => `
          <div style="display:flex;gap:12px">
            <img src="assets/console_logo.png" style="width:64px;height:64px;flex:none">
            <div style="white-space:pre-wrap">${tpl.info}</div>
          </div>
          <label style="display:block;margin-top:16px">
            <input type="checkbox" id="wz-skip"> Skip this page next time</label>`,
    });
    if (tpl.languages) pages.push({                // AddGenericSingleChoiceListPage
        name: 'language',
        render: () => `
          <div style="margin-bottom:6px">Please select the language you want to use.</div>
          <select class="cb" id="wz-lang" size="6" style="width:100%;height:120px">
            <option${state.lang === 0 ? ' selected' : ''}>C</option>
            <option${state.lang === 1 ? ' selected' : ''}>C++</option>
          </select>`,
        leave: box => { state.lang = box.querySelector('#wz-lang').selectedIndex; return true; },
    });
    pages.push({                                   // AddProjectPathPage
        name: 'path',
        render: () => `
          <div style="white-space:pre-wrap;margin-bottom:8px">Please select the folder where you want the new project
to be created as well as its title.</div>
          <table style="border-spacing:4px;width:100%">
            <tr><td style="width:150px">Project title:</td>
                <td><input class="cb" id="wz-title" value="${state.title}" style="width:100%"></td></tr>
            <tr><td>Folder to create project in:</td>
                <td><input class="cb" id="wz-dir" value="${state.dir.replace(/\\/g, '\\')}" style="width:100%"></td></tr>
            <tr><td>Project filename:</td>
                <td><input class="cb" id="wz-file" value="${state.title}.cbp" style="width:100%"></td></tr>
            <tr><td>Resulting filename:</td>
                <td><input class="cb" id="wz-full" readonly style="width:100%;background:var(--face)"></td></tr>
          </table>`,
        enter: box => {
            const t = box.querySelector('#wz-title'), d = box.querySelector('#wz-dir');
            const f = box.querySelector('#wz-file'), full = box.querySelector('#wz-full');
            const sync = () => {
                if (!f.dataset.touched) f.value = (t.value || 'MyProject') + '.cbp';
                full.value = d.value.replace(/\\+$/, '') + '\\' + (t.value || 'MyProject') + '\\' + f.value;
            };
            t.addEventListener('input', sync);
            d.addEventListener('input', sync);
            f.addEventListener('input', () => { f.dataset.touched = '1'; sync(); });
            sync();
        },
        leave: async box => {
            const title = box.querySelector('#wz-title').value.trim();
            if (!title) {
                await UI.messageBox('Please enter a project title.', 'Notice', ['OK'], '⚠️');
                return false;
            }
            if (App.projects.some(p => p.name === title)) {
                await UI.messageBox(`A project named "${title}" is already open.`, 'Notice', ['OK'], '⚠️');
                return false;
            }
            state.title = title;
            state.dir = box.querySelector('#wz-dir').value.trim() || state.dir;
            return true;
        },
    });
    pages.push({                                   // AddCompilerPage
        name: 'compiler',
        render: () => `
          <div style="white-space:pre-wrap;margin-bottom:8px">Please select the compiler to use and which configurations
you want enabled in your project.</div>
          <div style="margin-bottom:8px">Compiler:<br>
            <select class="cb" id="wz-compiler" style="width:100%">
              <option>GNU GCC Compiler</option>
            </select>
          </div>
          <fieldset style="border:1px solid #a0a0a0;margin-bottom:8px">
            <legend><label><input type="checkbox" id="wz-dbg" ${state.debug ? 'checked' : ''}>
              Create "Debug" configuration:</label>
              <input class="cb" id="wz-dbg-name" value="${state.debugName}" style="width:110px"></legend>
            <table style="border-spacing:4px">
              <tr><td>Output dir.:</td><td><input class="cb" id="wz-dbg-out" value="${state.debugOut}" style="width:180px"></td></tr>
              <tr><td>Objects output dir.:</td><td><input class="cb" id="wz-dbg-obj" value="${state.debugObj}" style="width:180px"></td></tr>
            </table>
          </fieldset>
          <fieldset style="border:1px solid #a0a0a0">
            <legend><label><input type="checkbox" id="wz-rel" ${state.release ? 'checked' : ''}>
              Create "Release" configuration:</label>
              <input class="cb" id="wz-rel-name" value="${state.releaseName}" style="width:110px"></legend>
            <table style="border-spacing:4px">
              <tr><td>Output dir.:</td><td><input class="cb" id="wz-rel-out" value="${state.releaseOut}" style="width:180px"></td></tr>
              <tr><td>Objects output dir.:</td><td><input class="cb" id="wz-rel-obj" value="${state.releaseObj}" style="width:180px"></td></tr>
            </table>
          </fieldset>`,
        leave: async box => {
            const dbg = box.querySelector('#wz-dbg').checked;
            const rel = box.querySelector('#wz-rel').checked;
            if (!dbg && !rel) {
                await UI.messageBox('At least one configuration must be set...', 'Notice', ['OK'], '⚠️');
                return false;
            }
            state.debug = dbg; state.release = rel;
            state.debugName = box.querySelector('#wz-dbg-name').value.trim() || 'Debug';
            state.releaseName = box.querySelector('#wz-rel-name').value.trim() || 'Release';
            state.debugOut = box.querySelector('#wz-dbg-out').value.trim();
            state.debugObj = box.querySelector('#wz-dbg-obj').value.trim();
            state.releaseOut = box.querySelector('#wz-rel-out').value.trim();
            state.releaseObj = box.querySelector('#wz-rel-obj').value.trim();
            return true;
        },
    });

    let at = 0;
    const body = document.createElement('div');
    const box = el('div');
    box.style.cssText = 'min-height:230px';
    body.appendChild(box);

    const draw = () => {
        box.innerHTML = pages[at].render();
        if (pages[at].enter) pages[at].enter(box);
        btnBack.disabled = at === 0;
        btnNext.disabled = at === pages.length - 1;
        btnFinish.disabled = at !== pages.length - 1;
    };
    const step = async dir => {
        if (dir > 0 && pages[at].leave && !(await pages[at].leave(box))) return;
        at += dir;
        draw();
    };

    const w = UI.window({
        title: 'Console application', icon: 'assets/codeblocks.png', width: 520, body,
        buttons: [
            { label: '< Back', onClick: () => step(-1) },
            { label: 'Next >', onClick: () => step(1) },
            { label: 'Finish', onClick: async () => {
                if (pages[at].leave && !(await pages[at].leave(box))) return;
                w.remove();
                Wizard.finish(tpl, state);
            } },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
    w.style.height = 'auto';
    const btns = w.querySelectorAll('.buttons button');
    const [btnBack, btnNext, btnFinish] = btns;
    draw();
};

/* Turns the wizard's answers into a real project. */
Wizard.finish = function (tpl, state) {
    const cpp = state.lang !== 0;
    App.projectPath = state.dir.replace(/\\+$/, '') + '\\' + state.title;
    const p = App.newProject(state.title, false);

    p.targets = [];
    if (state.debug) p.targets.push(state.debugName);
    if (state.release) p.targets.push(state.releaseName);
    if (!p.targets.length) p.targets = ['Debug'];
    p.outputDirs = {};
    if (state.debug) p.outputDirs[state.debugName] = { out: state.debugOut, obj: state.debugObj };
    if (state.release) p.outputDirs[state.releaseName] = { out: state.releaseOut, obj: state.releaseObj };
    p.compiler = state.compiler;

    if (tpl.id !== 'empty') {
        const name = cpp ? 'main.cpp' : 'main.c';
        const text = cpp ? CONSOLE_TEMPLATE : C_CONSOLE_TEMPLATE;
        const f = App.openFile(name, tpl.id === 'staticlib' ? (cpp ? LIB_TEMPLATE_CPP : LIB_TEMPLATE_C) : text, p);
        p.files.push(f.name);
    }
    App.setTargetList(p);
    App.refreshTrees();
    App.updateStartPageRecents();
    App.updateStatusBar();
    App.logAppend('app',
        `Project '${state.title}' created (${cpp ? 'C++' : 'C'}, ${p.targets.join(' and ')}).\n`);
    App.persist();
};

/* ================================================================= setup */

const MAIN_TOOLBAR = [
    { id: 'idToolNew', tooltip: 'New file', bitmap: 'core/file_new', longhelp: 'Create a new source file' },
    { id: 'idFileOpen', tooltip: 'Open', bitmap: 'core/file_open', longhelp: 'Open an existing file' },
    { id: 'idFileSave', tooltip: 'Save', bitmap: 'core/file_save', longhelp: 'Save current file' },
    { id: 'idFileSaveAll', tooltip: 'Save everything', bitmap: 'core/file_save_all', longhelp: 'Save all source files, projects and the workspace' },
    { sep: true },
    { id: 'idEditUndo', tooltip: 'Undo', bitmap: 'core/undo', longhelp: 'Undo the last editing action' },
    { id: 'idEditRedo', tooltip: 'Redo', bitmap: 'core/redo', longhelp: 'Redo the last editing action' },
    { sep: true },
    { id: 'idEditCut', tooltip: 'Cut', bitmap: 'core/edit_cut', longhelp: 'Cut selected text to clipboard' },
    { id: 'idEditCopy', tooltip: 'Copy', bitmap: 'core/edit_copy', longhelp: 'Copy selected text to clipboard' },
    { id: 'idEditPaste', tooltip: 'Paste', bitmap: 'core/edit_paste', longhelp: 'Paste text from clipboard' },
    { sep: true },
    { id: 'idSearchFind', tooltip: 'Find', bitmap: 'core/find', longhelp: 'Find text' },
    { id: 'idSearchReplace', tooltip: 'Replace', bitmap: 'core/search_replace', longhelp: 'Replace text' },
];

const COMPILER_TOOLBAR = [
    { id: 'idCompilerMenuCompile', tooltip: 'Build', bitmap: 'compiler/compile', longhelp: 'Build the active project' },
    { id: 'idCompilerMenuRun', tooltip: 'Run', bitmap: 'compiler/run', longhelp: 'Run the active project' },
    { id: 'idCompilerMenuCompileAndRun', tooltip: 'Build and run', bitmap: 'compiler/compile_run', longhelp: 'Build and run the active project' },
    { id: 'idCompilerMenuRebuild', tooltip: 'Rebuild', bitmap: 'compiler/rebuild', longhelp: 'Rebuild all modules in the active project' },
    { id: 'idCompilerMenuKillProcess', tooltip: 'Abort', bitmap: 'compiler/stop', longhelp: 'Abort the running build process', disabled: true },
    { id: 'idToolTarget', choice: ['Debug', 'Release'], tooltip: 'Build target' },
    { id: 'idMenuSelectTargetDialog', tooltip: 'Show the Select target dialog', bitmap: 'sdk/select_target' },
];

/* CodeCompletion's two combo boxes, at the right of the first row. */
const CODECOMPLETION_TOOLBAR = [
    { id: 'idCCScope', choice: ['<global>'], width: 240, tooltip: 'Scope' },
    { id: 'idCCFunction', choice: ['main() : int'], width: 330, tooltip: 'Function' },
];

/* Second row: BrowseTracker, DoxyBlocks, IncrementalSearch. */
const BROWSETRACKER_TOOLBAR = [
    { id: 'idBrowseTrackerBack', tooltip: 'Browse tracker: backward', png: 'prev' },
    { id: 'idBrowseTrackerForward', tooltip: 'Browse tracker: forward', png: 'next' },
    { sep: true },
    { id: 'idBookmarkToggle', tooltip: 'Toggle bookmark', png: 'mark' },
    { id: 'idBookmarkPrev', tooltip: 'Previous bookmark', png: 'mark_prev' },
    { id: 'idBookmarkNext', tooltip: 'Next bookmark', png: 'mark_next' },
    { id: 'idBookmarkClear', tooltip: 'Clear all bookmarks', png: 'mark_clear' },
    { id: 'idBrowseMarks', tooltip: 'Show browse tracker marks', png: 'signpost' },
];

const DOXYBLOCKS_TOOLBAR = [
    { id: 'idDoxyWizard', tooltip: 'Run doxywizard', png: 'doxywizard' },
    { id: 'idDoxyExtract', tooltip: 'Extract documentation for the current project', png: 'extract' },
    { sep: true },
    { id: 'idDoxyBlockComment', tooltip: 'Insert a comment block at the current line', png: 'comment_block' },
    { id: 'idDoxyLineComment', tooltip: 'Insert a line comment at the current cursor position', png: 'comment_line' },
    { sep: true },
    { id: 'idDoxyRunHTML', tooltip: 'Run HTML documentation', png: 'html' },
    { id: 'idDoxyRunCHM', tooltip: 'Run HTML Help documentation', png: 'chm' },
    { sep: true },
    { id: 'idDoxyConfig', tooltip: "Open DoxyBlocks' preferences", png: 'configure' },
];

const INCSEARCH_TOOLBAR = [
    { id: 'idIncSearchText', text: true, width: 170, tooltip: 'Text to search for' },
    { id: 'idIncSearchClear', tooltip: 'Clear search', png: 'incsearchclear' },
    { id: 'idIncSearchPrev', tooltip: 'Search previous occurrence', png: 'incsearchprev' },
    { id: 'idIncSearchNext', tooltip: 'Search next occurrence', png: 'incsearchnext' },
    { id: 'idIncSearchHighlight', tooltip: 'Highlight all occurrences', png: 'incsearchhighlight' },
    { id: 'idIncSearchCase', tooltip: 'Match case', png: 'incsearchcase' },
    { id: 'idIncSearchRegex', tooltip: 'Use regex', png: 'incsearchregex' },
    { id: 'idIncSearchSelected', tooltip: 'Search in selection only', png: 'incsearchselectedonly' },
];

const DEBUGGER_TOOLBAR = [
    { id: 'idDebuggerMenuDebug', tooltip: 'Debug / Continue', bitmap: 'core/dbg/run' },
    { id: 'idDebuggerMenuRunToCursor', tooltip: 'Run to cursor', bitmap: 'core/dbg/run_to' },
    { id: 'idDebuggerMenuNext', tooltip: 'Next line', bitmap: 'core/dbg/next' },
    { id: 'idDebuggerMenuStep', tooltip: 'Step into', bitmap: 'core/dbg/step' },
    { id: 'idDebuggerMenuStepOut', tooltip: 'Step out', bitmap: 'core/dbg/step_out' },
    { id: 'idDebuggerMenuNextInstr', tooltip: 'Next instruction', bitmap: 'core/dbg/next_inst' },
    { id: 'idDebuggerMenuStepIntoInstr', tooltip: 'Step into instruction', bitmap: 'core/dbg/step_inst' },
    { id: 'idDebuggerMenuBreak', tooltip: 'Break debugger', bitmap: 'core/dbg/pause' },
    { id: 'idDebuggerMenuStop', tooltip: 'Stop debugger', bitmap: 'core/dbg/stop' },
    { id: 'idDebuggingWindows', tooltip: 'Debugging windows', bitmap: 'core/dbg/window' },
    { id: 'idDebuggerInfo', tooltip: 'Various info', bitmap: 'core/dbg/info' },
];

/* The tab set a stock Windows install shows, in the same order. */
const LOG_TABS = [
    { key: 'app', title: 'Code::Blocks', icon: 'edit' },
    { key: 'search', title: 'Search results', icon: 'edit' },
    { key: 'build', title: 'Build log', icon: 'misc' },
    { key: 'messages', title: 'Build messages', icon: 'flag', grid: true },
    { key: 'debugger', title: 'Debugger', icon: 'misc' },
    { key: 'cccc', title: 'Cccc', icon: 'edit' },
    { key: 'cppcheck', title: 'CppCheck/Vera++', icon: 'edit' },
    { key: 'cppcheckmsg', title: 'CppCheck/Vera++ messages', icon: 'flag' },
    { key: 'cscope', title: 'Cscope', icon: 'edit' },
    { key: 'doxyblocks', title: 'DoxyBlocks', icon: 'edit' },
    { key: 'fortran', title: 'Fortran info', icon: 'edit' },
    { key: 'closedfiles', title: 'Closed files list', icon: 'edit' },
    { key: 'threadsearch', title: 'Thread search', icon: 'edit', special: 'threadsearch' },
    { key: 'todo', title: 'To-Do list', icon: 'flag', special: 'todo' },
    { key: 'breakpoints', title: 'Breakpoints', icon: 'flag', special: 'breakpoint' },
    { key: 'watches', title: 'Watches', icon: 'misc', special: 'watch' },
];

/* Pulls the compiler down and warms it while the user is still reading the
   Start page, so that pressing Build is immediate. */
App.startToolchain = function () {
    let lastPct = -1;
    let logged = false;
    const t0 = performance.now();

    Toolchain.preload(st => {
        if (st.done) {
            UI.setStatus(0, 'Compiler ready');
            App.logAppend('app', `Compiler "GNU GCC Compiler" found (clang ${'8.0.1'} / libc++, WebAssembly).\n`);
            App.logAppend('app', `Toolchain ready in ${st.seconds.toFixed(1)}s - builds are local and instant.\n`);
            setTimeout(() => App.updateStatusBar(), 2500);
            return;
        }
        if (!logged) { logged = true; App.logAppend('app', 'Loading the C++ toolchain (clang + libc++)...\n'); }
        if (st.pct !== lastPct) {
            lastPct = st.pct;
            UI.setStatus(0, `Loading compiler... ${st.pct}%`);
        }
    }).catch(e => {
        App.logAppend('app', 'Could not load the C++ toolchain: ' + e.message + '\n');
        UI.setStatus(0, 'Compiler unavailable');
    });
    void t0;
};

/* ============================================ shortcuts the browser takes

   Ctrl+N, Ctrl+Shift+N and Ctrl+W are handled inside the browser: the keydown
   is never dispatched to the page, so there is nothing to intercept and no way
   to answer the key directly.  What we can do is notice it happened - the
   modifier goes down here and then the window loses focus because a new
   browser window came up - and tell the user which key does work, with one
   click to switch the whole key map back to the desktop one. */
App.desktopKeymap = function (on) {
    if (on) {
        const root = document.documentElement;
        const p = root.requestFullscreen ? root.requestFullscreen() : Promise.reject();
        return p.then(() => {
            localStorage.setItem('cb.desktopKeymap', '1');
            return true;
        }).catch(() => {
            UI.messageBox(
                'This browser would not go full screen, so the browser keeps its own shortcuts.\n' +
                'Use the keys listed under Settings -> Editor -> Keyboard shortcuts instead.',
                'Desktop shortcuts', ['OK'], '⚠️');
            return false;
        });
    }
    localStorage.removeItem('cb.desktopKeymap');
    if (document.fullscreenElement) document.exitFullscreen();
    return Promise.resolve(false);
};

/* In full screen the keyboard is locked to the IDE, so F11 and Escape no
   longer leave it - there has to be a way out on screen. */
App.showFullScreenExit = function (on) {
    let box = document.getElementById('fs-exit');
    if (!on) { if (box) box.remove(); return; }
    if (box) return;
    box = document.createElement('div');
    box.id = 'fs-exit';
    box.innerHTML = '<span class="fs-exit-text">Full screen &mdash; desktop shortcuts active</span>' +
                    '<span class="fs-exit-x" title="Exit full screen">&#10005;</span>';
    box.querySelector('.fs-exit-x').addEventListener('click', () => {
        if (document.exitFullscreen) document.exitFullscreen();
    });
    document.body.appendChild(box);
};

App.watchStolenShortcuts = function () {
    if (!UI.remappedAccels.length) return;      // this browser takes nothing
    let ctrlAt = 0, sawChord = false, shown = false, timer = 0;

    const mayShow = () =>
        !shown && !document.fullscreenElement && !localStorage.getItem('cb.hideKeymapHint');
    const show = delay => {
        if (!mayShow()) return;
        shown = true;
        setTimeout(App.hintStolenShortcut, delay);
    };
    const cancel = () => { clearTimeout(timer); timer = 0; };

    /* Say it up front rather than waiting for someone to lose a keystroke to
       the browser: the panel comes up once, after the IDE has settled. */
    setTimeout(() => show(0), 2500);

    document.addEventListener('keydown', ev => {
        if (ev.key === 'Control' || ev.key === 'Shift' || ev.key === 'Alt') {
            if (ev.key === 'Control' || !ctrlAt) { if (ev.key === 'Control') ctrlAt = Date.now(); }
            /* Ctrl+Shift is the prefix of the shortcuts this browser takes -
               Ctrl+Shift+N above all.  If the rest of the chord never arrives,
               the browser swallowed it, and the user is left wondering why
               nothing happened.  Waiting a moment tells the two apart: a real
               Ctrl+Shift+S reaches us long before this fires. */
            if (ev.ctrlKey && ev.shiftKey && !timer && mayShow())
                timer = setTimeout(() => { timer = 0; show(0); }, 900);
            return;
        }
        sawChord = true;                        // the chord did reach us, all good
        cancel();
    }, true);

    document.addEventListener('keyup', ev => {
        if (ev.key === 'Control') { ctrlAt = 0; cancel(); }
        if (ev.key === 'Shift') cancel();
    }, true);

    window.addEventListener('blur', () => {
        /* Ctrl went down, no chord arrived, and now focus is gone: the browser
           opened a window of its own with the key the user meant for us. */
        cancel();
        if (!ctrlAt || sawChord) return;
        if (Date.now() - ctrlAt > 4000) return;
        show(400);                              // wait until we have focus back
    });
};

App.hintStolenShortcut = function () {
    const row = id => {
        const m = UI.remappedAccels.find(x => x.id === id);
        return m ? `<tr><td style="padding-right:10px">${m.label.replace(/&/g, '')}</td>
                        <td><kbd>${UI.accelText(m.to)}</kbd></td></tr>` : '';
    };
    UI.hint({
        title: 'The browser took that shortcut',
        html:
            '<div style="margin-bottom:6px">Your browser acts on <kbd>Ctrl+Shift+N</kbd>, ' +
            '<kbd>Ctrl+N</kbd>, <kbd>Ctrl+W</kbd> and <kbd>Ctrl+R</kbd> itself, so they never ' +
            'reach Code::Blocks. Here they are:</div>' +
            '<table>' + row('idFileNewEmpty') + row('idFileClose') + row('idSearchReplace') + '</table>' +
            '<div style="margin-top:6px">Or take the desktop keys back - the IDE goes full ' +
            'screen and every shortcut works as it does on the PC.</div>',
        seconds: 0,
        buttons: [
            { label: 'Use desktop shortcuts', onClick: () => App.desktopKeymap(true) },
            { label: "Don't show again", onClick: () => localStorage.setItem('cb.hideKeymapHint', '1') },
        ],
    });
};

/* ================================================================ theming

   A web-edition extra: the same IDE in a dark palette.  The switch is on the
   main toolbar, and it animates - the icon turns from sun to moon, a soft
   sweep runs out from the button, and every colour crosses over rather than
   snapping. */
App.THEME_KEY = 'cb.theme';

App.applyTheme = function (dark, animate, origin) {
    const body = document.body;
    if (animate) {
        body.classList.add('theme-anim');
        const sweep = document.createElement('div');
        sweep.id = 'theme-sweep';
        if (origin) {
            sweep.style.setProperty('--sweep-x', origin.x + 'px');
            sweep.style.setProperty('--sweep-y', origin.y + 'px');
        }
        document.body.appendChild(sweep);
        setTimeout(() => sweep.remove(), 600);
        setTimeout(() => body.classList.remove('theme-anim'), 420);
    }
    body.classList.toggle('cb-dark', !!dark);
    App.dark = !!dark;
    try { localStorage.setItem(App.THEME_KEY, dark ? 'dark' : 'light'); } catch (e) { /* private mode */ }
    // CodeMirror measures against the stylesheet, so it needs a nudge
    setTimeout(() => App.files.forEach(f => { if (f.cm) f.cm.refresh(); }), 350);
    if (animate) UI.setStatus(0, dark ? 'Dark theme' : 'Light theme');
    const btn = document.querySelector('.tb-theme');
    if (btn) btn.title = dark ? 'Switch to the light theme' : 'Switch to the dark theme';
};

App.toggleTheme = function (ev) {
    const btn = document.querySelector('.tb-theme');
    const r = btn ? btn.getBoundingClientRect() : null;
    const origin = ev && ev.clientX
        ? { x: ev.clientX, y: ev.clientY }
        : r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
    App.applyTheme(!App.dark, true, origin);
};

App.installThemeButton = function () {
    const bar = document.getElementById('tb-main');
    if (!bar || bar.querySelector('.tb-theme')) return;
    bar.appendChild(el('div', 'tb-sep'));
    const b = el('div', 'tb-btn tb-theme');
    b.title = 'Switch to the dark theme';
    b.innerHTML =
        '<svg class="sun" viewBox="0 0 16 16" width="16" height="16">' +
        '<circle cx="8" cy="8" r="3.2" fill="#f5a623"/>' +
        '<g stroke="#f5a623" stroke-width="1.4" stroke-linecap="round">' +
        '<path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6L13 13M13 3l-1.4 1.4M4.4 11.6L3 13"/>' +
        '</g></svg>' +
        '<svg class="moon" viewBox="0 0 16 16" width="16" height="16">' +
        '<path d="M12.5 10.4A5.4 5.4 0 0 1 5.6 3.5a5.5 5.5 0 1 0 6.9 6.9z" fill="#d7d7ff"/>' +
        '</svg>';
    b.addEventListener('click', ev => App.toggleTheme(ev));
    bar.appendChild(b);
};

App.updateDebugUI = function () {
    const on = Debugger.active;
    UI.enableTool('idDebuggerMenuStop', on);
    UI.enableTool('idDebuggerMenuNext', on);
    UI.enableTool('idDebuggerMenuStep', on);
    UI.enableTool('idDebuggerMenuStepOut', on);
};

function init() {
    /* menu bar + accelerators.  Shortcuts the browser keeps for itself get a
       second binding first, so the menus show the chord that really works. */
    const moved = UI.applyBrowserAccelerators(CB_MENUS);
    UI.buildMenuBar(CB_MENUS, item => App.command(item.id));
    UI.initPaneButtons();

    document.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') { UI.closeAllMenus(); return; }
        const hit = UI.findAccel(CB_MENUS, ev);
        if (hit) {
            const st = App.menuState(hit);
            if (st.enabled === false) return;
            ev.preventDefault();
            App.command(hit.id);
        }
    });

    /* Full screen is the one place a page may take the browser's own chords:
       the Keyboard Lock API hands Ctrl+W, Ctrl+Shift+N and friends to us, so
       full screen gives the exact desktop key map. */
    document.addEventListener('fullscreenchange', () => {
        const kb = navigator.keyboard;
        if (document.fullscreenElement) {
            App.showFullScreenExit(true);
            if (kb && kb.lock) kb.lock().then(() => {
                App.keysLocked = true;
                UI.setStatus(0, 'Desktop shortcuts active - Ctrl+Shift+N, Ctrl+W and Ctrl+R belong to the IDE again');
            }).catch(() => {});
        } else {
            App.showFullScreenExit(false);
            if (App.keysLocked && kb && kb.unlock) { App.keysLocked = false; kb.unlock(); }
        }
    });

    App.watchStolenShortcuts();


    /* toolbars */
    UI.buildToolbar(document.getElementById('tb-main'), MAIN_TOOLBAR, c => App.command(c.id));
    UI.buildToolbar(document.getElementById('tb-debugger'), DEBUGGER_TOOLBAR, c => App.command(c.id));
    UI.buildToolbar(document.getElementById('tb-compiler'), COMPILER_TOOLBAR, c => {
        if (c.id === 'idToolTarget') { App.setTarget(c.value); return; }
        App.command(c.id);
    });
    UI.buildToolbar(document.getElementById('tb-codecompletion'), CODECOMPLETION_TOOLBAR, () => {});
    UI.buildToolbar(document.getElementById('tb-browsetracker'), BROWSETRACKER_TOOLBAR, c => App.command(c.id));
    UI.buildToolbar(document.getElementById('tb-doxyblocks'), DOXYBLOCKS_TOOLBAR, c => App.command(c.id));
    UI.buildToolbar(document.getElementById('tb-incsearch'), INCSEARCH_TOOLBAR, c => App.incrementalSearch(c));
    document.querySelector('#tb-main .tb-btn[data-id="idToolNew"]')
        .addEventListener('click', () => App.command('idFileNewEmpty'));

    /* the theme switch lives at the end of the main toolbar */
    App.installThemeButton();
    let savedTheme = null;
    try { savedTheme = localStorage.getItem(App.THEME_KEY); } catch (e) { /* private mode */ }
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    App.applyTheme(savedTheme ? savedTheme === 'dark' : prefersDark, false);

    /* management panel */
    App.nbManagement = new UI.Notebook('#nb-management', { scrollButtons: true });
    const projHost = document.createElement('div');
    const symHost = document.createElement('div');
    const filesHost = document.createElement('div');
    const openHost = document.createElement('div');
    App.nbManagement.addPage('projects', 'Projects', projHost);
    App.nbManagement.addPage('symbols', 'Symbols', symHost);
    App.nbManagement.addPage('files', 'Files', filesHost);
    App.nbManagement.addPage('openfiles', 'Open files list', openHost);
    App.treeOpenFiles = new UI.Tree(openHost);
    App.treeOpenFiles.onSelect = node => {
        if (node.data instanceof SourceFile) App.nbEditors.select(node.data.key);
    };
    App.treeProjects = new UI.Tree(projHost);
    App.treeSymbols = new UI.Tree(symHost);
    App.treeFiles = new UI.Tree(filesHost);
    const openFromTree = node => { if (node.data instanceof SourceFile) App.nbEditors.select(node.data.key); };
    App.treeProjects.onActivate = openFromTree;
    App.treeFiles.onActivate = openFromTree;
    App.treeProjects.onContext = (node, ev) => {
        const items = [
            { type: 'item', id: 'idMenuAddFile', label: 'Add files...', mnemonic: -1 },
            { type: 'item', id: 'idMenuRemoveFile', label: 'Remove file from project', mnemonic: -1 },
            { type: 'sep' },
            { type: 'item', id: 'idCompilerMenuCompile', label: 'Build', mnemonic: -1 },
            { type: 'item', id: 'idCompilerMenuRebuild', label: 'Rebuild', mnemonic: -1 },
            { type: 'item', id: 'idCompilerMenuClean', label: 'Clean', mnemonic: -1 },
            { type: 'sep' },
            { type: 'item', id: 'idMenuProjectProperties', label: 'Properties...', mnemonic: -1 },
        ];
        if (node.data instanceof SourceFile) App.nbEditors.select(node.data.key);
        UI.popup(items, ev.clientX, ev.clientY, 0, it => App.command(it.id));
    };

    /* editors */
    App.nbEditors = new UI.Notebook('#nb-editors');
    App.nbEditors.onClose = async page => {
        if (page.key === '#start') { App.nbEditors.removePage('#start'); return; }
        const f = App.files.find(x => x.key === page.key);
        if (f) await App.closeFile(f);
    };
    App.nbEditors.onChange = () => {
        App.updateStatusBar();
        const f = App.activeFile();
        if (f && f.cm) setTimeout(() => f.cm.refresh(), 0);
    };
    App.nbEditors.onContext = (page, ev) => {
        UI.popup([
            { type: 'item', id: 'idFileSave', label: 'Save file', mnemonic: -1 },
            { type: 'item', id: 'idFileClose', label: 'Close file', mnemonic: -1 },
            { type: 'item', id: 'idFileCloseAll', label: 'Close all files', mnemonic: -1 },
            { type: 'sep' },
            { type: 'item', id: 'idEditSwapHeaderSource', label: 'Swap header/source', mnemonic: -1 },
            { type: 'item', id: 'idMenuFileProperties', label: 'Properties...', mnemonic: -1 },
        ], ev.clientX, ev.clientY, 0, it => App.command(it.id));
    };

    /* logs */
    App.nbLogs = new UI.Notebook('#nb-logs');
    LOG_TABS.forEach(t => {
        let content;
        if (t.grid) {
            content = document.createElement('div');
            content.id = 'build-messages';
            content.style.cssText = 'height:100%;overflow:auto;background:#fff';
            content.innerHTML = '<table class="log-grid"><thead><tr>' +
                '<th style="width:128px">File</th><th style="width:48px">Line</th>' +
                '<th>Message</th></tr></thead><tbody></tbody></table>';
        } else if (t.special) {
            content = document.createElement('div');
            content.id = t.special + '-body';
            content.className = 'cb-tree';
        } else {
            content = document.createElement('div');
            content.className = 'log-text';
            App.logs[t.key] = content;
        }
        App.nbLogs.addPage('log:' + t.key, t.title, content,
                           'assets/icons/infopane/' + t.icon + '.svg', true);
    });
    App.nbLogs.onClose = page => App.nbLogs.removePage(page.key);
    App.nbLogs.select('log:app');

    /* sashes */
    UI.makeSashV(document.getElementById('sash-left'),
                 document.getElementById('pane-management'), 120, () => window.innerWidth * 0.6);
    UI.makeSashH(document.getElementById('sash-bottom'),
                 document.getElementById('pane-logs'), 60, () => window.innerHeight * 0.75);

    /* pane caption buttons */
    document.querySelectorAll('#pane-management .pane-btn, #pane-logs .pane-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const which = btn.closest('#pane-logs') ? 'logs' : 'management';
            if (btn.dataset.act === 'close') App.togglePaneVisible(which);
            else {
                const pane = document.getElementById(which === 'logs' ? 'pane-logs' : 'pane-management');
                if (which === 'logs') {
                    pane.dataset.oldH = pane.dataset.oldH || pane.offsetHeight;
                    pane.style.height = pane.offsetHeight > 24 ? '20px' : pane.dataset.oldH + 'px';
                } else {
                    pane.dataset.oldW = pane.dataset.oldW || pane.offsetWidth;
                    pane.style.width = pane.offsetWidth > 40 ? '28px' : pane.dataset.oldW + 'px';
                }
                App.refreshEditors();
            }
        });
    });

    /* focus tracking for the active/inactive pane caption gradient */
    document.addEventListener('mousedown', ev => {
        const mgmt = document.getElementById('pane-management');
        const logs = document.getElementById('pane-logs');
        const inLogs = !!ev.target.closest('#pane-logs');
        const inMgmt = !!ev.target.closest('#pane-management');
        mgmt.classList.toggle('inactive', !inMgmt);
        logs.classList.toggle('inactive', !inLogs);
    });

    /* initial contents */
    App.openStartPage();
    if (!App.restore()) {
        App.newProject('HelloWorld');
    } else {
        App.refreshTrees();
    }
    App.nbEditors.select('#start');
    App.updateStartPageRecents();

    App.logAppend('app', 'Code::Blocks 25.03 (web edition)\n');
    App.logAppend('app', 'Loaded C/C++ lexer from the stock Code::Blocks configuration.\n');
    App.logAppend('app', 'Scanning for compilers...\n');
    if (UI.remappedAccels.length) {
        App.logAppend('app',
            `This browser keeps ${UI.remappedAccels.length} of the standard shortcuts for itself; ` +
            'those commands answer to a second key here:\n');
        UI.remappedAccels.forEach(m => App.logAppend('app',
            `    ${UI.accelText(m.to)}\t${m.label.replace(/&/g, '')}   (desktop: ${UI.accelText(m.from)})\n`));
        App.logAppend('app', '    Settings -> Editor -> Keyboard shortcuts lists them all; ' +
            'View -> Full screen gives the originals back.\n');
    }
    App.logAppend('debugger', 'Active debugger: GDB/CDB debugger : Default\n');
    App.startToolchain();

    // adopt the settings features.js defines, then layer the saved ones on top
    App.editorSettings = Features.editorSettings;
    App.buildOptions = Features.buildOptions;
    try {
        const es = JSON.parse(localStorage.getItem('cbweb.editor') || 'null');
        if (es) Object.assign(App.editorSettings, es);
        const bs = JSON.parse(localStorage.getItem('cbweb.build') || 'null');
        if (bs) Object.assign(App.buildOptions, bs);
    } catch (e) { /* defaults are fine */ }
    Features.applyEditorSettings();

    App.setTarget('Debug');
    App.updateStatusBar();
    App.updateDebugUI();
    UI.enableTool('idCompilerMenuKillProcess', false);

    window.addEventListener('resize', App.refreshEditors);
    /* Full screen needs a user gesture, so a remembered desktop key map is
       re-armed on the first click rather than at load. */
    if (localStorage.getItem('cb.desktopKeymap') && document.documentElement.requestFullscreen) {
        UI.setStatus(0, 'Click anywhere to restore the desktop shortcuts');
        const arm = () => {
            document.removeEventListener('mousedown', arm, true);
            App.desktopKeymap(true);
        };
        document.addEventListener('mousedown', arm, true);
    }

    /* Ctrl+W belongs to the browser and closes the tab, so unsaved work needs
       the one guard a page is allowed: the "Leave site?" prompt. */
    window.addEventListener('beforeunload', ev => {
        App.persist();
        if (!App.files.some(f => f.modified)) return;
        ev.preventDefault();
        ev.returnValue = '';
    });
    setInterval(() => App.persist(), 20000);
}

document.addEventListener('DOMContentLoaded', init);
