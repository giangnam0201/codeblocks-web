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
            img.style.cssText = 'width:12px;height:12px;margin-left:2px;';
            return img;
        };
        (f.bookmarks || new Set()).forEach(line =>
            f.cm.setGutterMarker(line - 1, 'cb-margin-marker',
                                 marker('assets/icons/bookmark_add.svg', 'Bookmark')));
        const set = Debugger.breakpoints.get(f.name);
        if (set) set.forEach(line =>
            f.cm.setGutterMarker(line - 1, 'cb-margin-marker',
                                 marker('assets/icons/breakpoint.svg', 'Breakpoint')));

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

Dialogs.about = function () {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="text-align:center">
        <img src="assets/splash_2503.png" style="max-width:100%">
      </div>
      <div style="padding:10px 4px;line-height:1.5">
        <b>Code::Blocks</b> 25.03 &mdash; web edition<br>
        The open source, cross platform, free C++ IDE.<br><br>
        This page reproduces the Code::Blocks user interface in the browser and
        compiles and runs C++ entirely client side.<br><br>
        &copy; 2004 - 2025, The Code::Blocks Team.
      </div>`;
    const w = UI.window({
        title: 'About Code::Blocks', icon: 'assets/codeblocks.png',
        width: 520, minimizable: false, body,
        buttons: [{ label: 'OK', onClick: () => w.remove() }],
    });
    w.style.height = 'auto';
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

Wizard.newProject = function () {
    const body = document.createElement('div');
    body.innerHTML = `
      <div style="display:flex;gap:10px;height:290px">
        <div style="width:140px;border:1px solid #7a7a7a;background:#fff;overflow:auto">
          <div class="tree-row selected" style="padding-left:6px">Projects</div>
          <div class="tree-row" style="padding-left:6px">Category</div>
          <div class="tree-row" style="padding-left:6px">Files</div>
        </div>
        <div style="flex:1;border:1px solid #7a7a7a;background:#fff;padding:10px;overflow:auto">
          <div id="wiz-templates" style="display:flex;flex-wrap:wrap;gap:14px">
            <div class="wiz-item" data-t="console" style="width:88px;text-align:center">
              <img src="assets/console_logo.png" style="width:32px;height:32px"><br>Console application
            </div>
            <div class="wiz-item" data-t="empty" style="width:88px;text-align:center">
              <img src="assets/icons/filenew.svg" style="width:32px;height:32px"><br>Empty project
            </div>
          </div>
        </div>
      </div>
      <div style="margin-top:10px">
        <table style="border-spacing:6px">
          <tr><td>Project title:</td><td><input class="cb" id="wiz-name" value="MyProject" style="width:220px"></td></tr>
          <tr><td>Folder to create project in:</td><td><input class="cb" id="wiz-dir" value="C:\\Users\\Dev\\Projects" style="width:220px"></td></tr>
        </table>
      </div>`;

    let kind = 'console';
    body.querySelectorAll('.wiz-item').forEach(item => {
        item.style.border = '1px solid transparent';
        item.style.padding = '4px';
        if (item.dataset.t === kind) { item.style.background = '#cce8ff'; item.style.borderColor = '#99d1ff'; }
        item.addEventListener('click', () => {
            kind = item.dataset.t;
            body.querySelectorAll('.wiz-item').forEach(o => {
                o.style.background = o === item ? '#cce8ff' : '';
                o.style.borderColor = o === item ? '#99d1ff' : 'transparent';
            });
        });
    });

    const w = UI.window({
        title: 'New from template', icon: 'assets/codeblocks.png', width: 620, height: 480, body,
        buttons: [
            {
                label: 'Go',
                onClick: () => {
                    const name = (document.getElementById('wiz-name').value || 'MyProject').trim();
                    const dir = document.getElementById('wiz-dir').value.trim() || 'C:\\Users\\Dev\\Projects';
                    w.remove();
                    App.projectPath = dir + '\\' + name;
                    App.newProject(name, kind === 'console');
                    App.updateStartPageRecents();
                    App.updateStatusBar();
                },
            },
            { label: 'Cancel', onClick: () => w.remove() },
        ],
    });
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

App.updateDebugUI = function () {
    const on = Debugger.active;
    UI.enableTool('idDebuggerMenuStop', on);
    UI.enableTool('idDebuggerMenuNext', on);
    UI.enableTool('idDebuggerMenuStep', on);
    UI.enableTool('idDebuggerMenuStepOut', on);
};

function init() {
    /* menu bar + accelerators */
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
    window.addEventListener('beforeunload', () => App.persist());
    setInterval(() => App.persist(), 20000);
}

document.addEventListener('DOMContentLoaded', init);
