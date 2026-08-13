// Generates js/menudata.js from the original Code::Blocks XRC resources so that
// the web menu bar matches the desktop application item-for-item.
//
//   node tools/gen-menus.js
//
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'src');
const MAIN = path.join(ROOT, 'src', 'resources', 'main_menu.xrc');
const COMPILER = path.join(ROOT, 'plugins', 'compilergcc', 'resources', 'compiler_menu.xrc');
const DEBUGGER = path.join(ROOT, 'src', 'resources', 'debugger_menu.xrc');

function unescapeXml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
            .replace(/&amp;/g, '&');
}

// Minimal tag-stream parser: enough for the very regular XRC files we read.
function tokenize(xml) {
    xml = xml.replace(/<\?[\s\S]*?\?>/g, '').replace(/<!--[\s\S]*?-->/g, '');
    const tokens = [];
    const re = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|([^<]+)/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        if (m[5] !== undefined) {
            tokens.push({ type: 'text', value: m[5] });
            continue;
        }
        const attrs = {};
        const are = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
        let a;
        while ((a = are.exec(m[3] || '')) !== null) attrs[a[1]] = unescapeXml(a[2]);
        tokens.push({
            type: m[1] ? 'close' : (m[4] ? 'selfclose' : 'open'),
            name: m[2],
            attrs,
        });
    }
    return tokens;
}

function parse(xml) {
    const tokens = tokenize(xml);
    const root = { name: '#root', attrs: {}, children: [], text: '' };
    const stack = [root];
    for (const t of tokens) {
        const top = stack[stack.length - 1];
        if (t.type === 'text') { top.text += t.value; continue; }
        if (t.type === 'close') { stack.pop(); continue; }
        const node = { name: t.name, attrs: t.attrs, children: [], text: '' };
        top.children.push(node);
        if (t.type === 'open') stack.push(node);
    }
    return root;
}

const child = (n, name) => n.children.find(c => c.name === name);
const textOf = (n, name) => { const c = child(n, name); return c ? unescapeXml(c.text.trim()) : undefined; };

// wx uses '&' for mnemonics; keep the letter, remember its index.
function splitMnemonic(label) {
    if (label === undefined) return { label: '', mnemonic: -1 };
    let out = '', mn = -1;
    for (let i = 0; i < label.length; i++) {
        if (label[i] === '&' && label[i + 1] === '&') { out += '&'; i++; }
        else if (label[i] === '&') { mn = out.length; }
        else out += label[i];
    }
    return { label: out, mnemonic: mn };
}

function convertItems(menuNode) {
    const items = [];
    for (const c of menuNode.children) {
        if (c.name !== 'object') continue;
        const cls = c.attrs.class;
        if (cls === 'separator') { items.push({ type: 'sep' }); continue; }
        const { label, mnemonic } = splitMnemonic(textOf(c, 'label'));
        if (cls === 'wxMenu') {
            items.push({
                type: 'menu', id: c.attrs.name, label, mnemonic,
                items: convertItems(c),
            });
            continue;
        }
        if (cls !== 'wxMenuItem') continue;
        const item = { type: 'item', id: c.attrs.name, label, mnemonic };
        const accel = textOf(c, 'accel');
        if (accel) item.accel = accel;
        const help = textOf(c, 'help');
        if (help) item.help = help;
        const bmp = child(c, 'bitmap');
        if (bmp && bmp.attrs.stock_id) item.bitmap = bmp.attrs.stock_id;
        if (textOf(c, 'checkable') === '1') item.checkable = true;
        if (textOf(c, 'radio') === '1') item.radio = true;
        if (textOf(c, 'enabled') === '0') item.enabled = false;
        items.push(item);
    }
    return items;
}

function loadMenu(file, name) {
    const doc = parse(fs.readFileSync(file, 'utf8'));
    const res = child(doc, 'resource');
    const node = res.children.find(c => c.attrs.name === name);
    return convertItems(node);
}

// --- main menu bar -----------------------------------------------------------
const mainDoc = parse(fs.readFileSync(MAIN, 'utf8'));
const bar = child(mainDoc, 'resource').children.find(c => c.attrs.name === 'main_menu_bar');
const menus = bar.children.filter(c => c.attrs.class === 'wxMenu').map(m => {
    const { label, mnemonic } = splitMnemonic(textOf(m, 'label'));
    return { id: m.attrs.name, label, mnemonic, items: convertItems(m) };
});

// --- items the plugins add at runtime ---------------------------------------
// projectmanagerui.cpp: Search -> "Goto file..."
const search = menus.find(m => m.id === 'menu_search');
search.items.push({ type: 'item', id: 'idMenuGotoFile', label: 'Goto file...', mnemonic: -1, accel: 'Alt-G' });

// projectmanagerui.cpp: File -> "Properties..." before the last item (Quit)
const file = menus.find(m => m.id === 'file_menu');
file.items.splice(file.items.length - 1, 0,
    { type: 'item', id: 'idMenuFileProperties', label: 'Properties...', mnemonic: -1 },
    { type: 'sep' });

// projectmanagerui.cpp: the Project menu is filled in entirely from code
const project = menus.find(m => m.id === 'menu_project');
const treeProps = {
    type: 'menu', id: 'idMenuProjectTreeProps', label: 'Project tree', mnemonic: -1,
    items: [
        { type: 'item', id: 'idMenuProjectUp', label: 'Move project up', mnemonic: -1, accel: 'Ctrl-Shift-Up' },
        { type: 'item', id: 'idMenuProjectDown', label: 'Move project down', mnemonic: -1, accel: 'Ctrl-Shift-Down' },
        { type: 'sep' },
        { type: 'item', id: 'idMenuPriorProject', label: 'Activate prior project', mnemonic: -1, accel: 'Alt-F5' },
        { type: 'item', id: 'idMenuNextProject', label: 'Activate next project', mnemonic: -1, accel: 'Alt-F6' },
        { type: 'sep' },
        { type: 'item', id: 'idMenuViewCategorize', label: 'Categorize by file types', mnemonic: -1, checkable: true, checked: true },
        { type: 'item', id: 'idMenuViewUseFolders', label: 'Display folders as on disk', mnemonic: -1, checkable: true, checked: true },
        { type: 'item', id: 'idMenuViewHideFolderName', label: 'Hide folder name', mnemonic: -1, checkable: true },
        { type: 'item', id: 'idMenuViewSortAlphabetically', label: 'Sort projects alphabetically', mnemonic: -1, checkable: true },
    ],
};
project.items.push(
    { type: 'item', id: 'idMenuAddFile', label: 'Add files...', mnemonic: -1, help: 'Add files to the project' },
    { type: 'item', id: 'idMenuAddFilesRecursively', label: 'Add files recursively...', mnemonic: -1, help: 'Add files recursively to the project' },
    { type: 'item', id: 'idMenuManageGlobs', label: 'Automatic source paths...', mnemonic: -1, help: 'Manage automatic source paths' },
    { type: 'item', id: 'idMenuRemoveFile', label: 'Remove files...', mnemonic: -1, help: 'Remove files from the project' },
    { type: 'sep' },
    treeProps,
    { type: 'item', id: 'idMenuProjectBuildOptions', label: 'Build options...', mnemonic: -1, help: "Set the project's build options" },
    { type: 'item', id: 'idMenuExecParams', label: "Set programs' arguments...", mnemonic: 4, help: 'Set execution parameters for the targets of this project' },
    { type: 'item', id: 'idMenuProjectNotes', label: 'Notes...', mnemonic: -1 },
    { type: 'item', id: 'idMenuProjectProperties', label: 'Properties...', mnemonic: -1 });

// compilergcc.cpp inserts "&Build" just before "&Debug"; the debugger plugin
// supplies "&Debug" itself, right after Project.
const buildMenu = { id: 'compiler_menu', label: 'Build', mnemonic: 0, items: loadMenu(COMPILER, 'compiler_menu') };
const debugMenu = { id: 'debugger_menu', label: 'Debug', mnemonic: 0, items: loadMenu(DEBUGGER, 'debugger_menu') };

// The Debug menu's dynamic submenus, as filled by debuggermenu.cpp.
for (const it of debugMenu.items) {
    if (it.id === 'idDebuggerMenuActive')
        it.items = [{ type: 'item', id: 'idDebuggerActiveGDB', label: 'GDB/CDB debugger : Default', mnemonic: -1, radio: true, checked: true }];
    if (it.id === 'idDebuggingWindows')
        it.items = [
            { type: 'item', id: 'idDebuggerWinBreakpoints', label: 'Breakpoints', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinCPURegisters', label: 'CPU Registers', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinCallStack', label: 'Call stack', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinDisassembly', label: 'Disassembly', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinMemory', label: 'Memory dump', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinThreads', label: 'Running threads', mnemonic: -1, checkable: true },
            { type: 'item', id: 'idDebuggerWinWatches', label: 'Watches', mnemonic: -1, checkable: true },
        ];
    if (it.id === 'idDebuggerInfo')
        it.items = [
            { type: 'item', id: 'idDebuggerInfoFrame', label: 'Current stack frame', mnemonic: -1 },
            { type: 'item', id: 'idDebuggerInfoDLL', label: 'Loaded libraries', mnemonic: -1 },
            { type: 'item', id: 'idDebuggerInfoFiles', label: 'Targets and files', mnemonic: -1 },
            { type: 'item', id: 'idDebuggerInfoFPU', label: 'FPU status', mnemonic: -1 },
            { type: 'item', id: 'idDebuggerInfoSignals', label: 'Signal handling', mnemonic: -1 },
        ];
    if (it.id === 'idCompilerMenuSelectTarget')
        it.items = it.items.concat([{ type: 'item', id: 'idCompilerTarget0', label: 'Debug', mnemonic: -1, radio: true, checked: true },
                                    { type: 'item', id: 'idCompilerTarget1', label: 'Release', mnemonic: -1, radio: true }]);
}
for (const it of buildMenu.items) {
    if (it.id === 'idCompilerMenuSelectTarget')
        it.items = it.items.concat([{ type: 'item', id: 'idCompilerTarget0', label: 'Debug', mnemonic: -1, radio: true, checked: true },
                                    { type: 'item', id: 'idCompilerTarget1', label: 'Release', mnemonic: -1, radio: true }]);
}

const projectIdx = menus.findIndex(m => m.id === 'menu_project');
menus.splice(projectIdx + 1, 0, buildMenu, debugMenu);

// The Tools menu is populated by the ToolsPlugin at runtime.
const tools = menus.find(m => m.id === 'menu_tools');
tools.items.push(
    { type: 'item', id: 'idPluginsCodeStats', label: 'Code statistics', mnemonic: -1,
      help: 'Count code, comment and empty lines' },
    { type: 'item', id: 'idPluginsTodo', label: 'To-Do list', mnemonic: -1,
      help: 'List the TODO/FIXME/NOTE items in the open files' },
    { type: 'item', id: 'idPluginsThreadSearch', label: 'Thread search', mnemonic: -1 },
    { type: 'sep' },
    { type: 'item', id: 'idToolsConfigure', label: 'Configure tools...', mnemonic: -1 });

// Plugins menu: the entries the contrib plugins add to it.
const plugins = menus.find(m => m.id === 'menu_plugins');
plugins.items.unshift(
    { type: 'item', id: 'idPluginsAStyle', label: 'Source code formatter (AStyle)', mnemonic: -1,
      accel: 'Ctrl-Shift-U', help: 'Format the current source file' },
    { type: 'item', id: 'idPluginsAbbreviations', label: 'Expand abbreviation', mnemonic: -1,
      accel: 'Ctrl-J', help: 'Expand the keyword before the caret' },
    { type: 'item', id: 'idPluginsCodeComplete', label: 'Code completion', mnemonic: -1,
      accel: 'Ctrl-Space' },
    { type: 'item', id: 'idPluginsOccurrences', label: 'Occurrences highlighting', mnemonic: -1,
      checkable: true, checked: true },
    { type: 'item', id: 'idPluginsGames', label: 'C::B games', mnemonic: -1,
      help: 'Play cbTris or Snake' },
    { type: 'sep' });

// Edit -> Highlight mode gets the C/C++ lexer alongside Plain text.
const editMenu = menus.find(m => m.id === 'edit_menu');
const hl = editMenu.items.find(i => i.id === 'idEditHighlightMode');
if (hl) hl.items.push({ type: 'item', id: 'idEditHighlightModeCpp', label: 'C/C++', mnemonic: -1 });

// Edit -> Folding: the "all" entries the plugin adds.
const folding = editMenu.items.find(i => i.id === 'idEditFolding');
if (folding) folding.items.unshift(
    { type: 'item', id: 'idEditFoldAll', label: 'Fold all', mnemonic: -1 },
    { type: 'item', id: 'idEditUnfoldAll', label: 'Unfold all', mnemonic: -1 });

// View -> Toolbars: the compiler toolbar entry.
const viewMenu = menus.find(m => m.id === 'menu_view');
const toolbars = viewMenu.items.find(i => i.id === 'idViewToolbars');
if (toolbars) toolbars.items.push(
    { type: 'item', id: 'idViewToolCompiler', label: 'Compiler', mnemonic: -1, checkable: true, checked: true });

// --- contrib plugin menus, in the order the Windows installer produces ------
const item = (id, label, extra) => Object.assign({ type: 'item', id, label, mnemonic: -1 }, extra || {});

const fortranMenu = {
    id: 'menu_fortran', label: 'Fortran', mnemonic: -1, items: [
        item('idFortranGotoDeclaration', 'Jump to declaration', { accel: 'Ctrl-Shift-D' }),
        item('idFortranGotoSubmodule', 'Jump to submodule procedure'),
        item('idFortranJumpBack', 'Jump back', { accel: 'Ctrl-Alt-Left' }),
        item('idFortranJumpForward', 'Jump forward', { accel: 'Ctrl-Alt-Right' }),
        { type: 'sep' },
        item('idFortranGenerateMakefile', 'Generate Makefile'),
        item('idFortranChangeCase', 'Change case...'),
        item('idFortranTab2Space', 'Tab2Space'),
        { type: 'sep' },
        item('idFortranBindTo', 'Bind to...'),
        item('idFortranFormatIndent', 'Format indent'),
    ],
};

const wxSmithMenu = {
    id: 'menu_wxsmith', label: 'wxSmith', mnemonic: -1, items: [
        item('idWxsAddWxFrame', 'Add wxFrame'),
        item('idWxsAddWxDialog', 'Add wxDialog'),
        item('idWxsAddWxPanel', 'Add wxPanel'),
        { type: 'sep' },
        item('idWxsImportXrc', 'Import XRC file'),
        item('idWxsAddResource', 'Add resource...'),
        { type: 'sep' },
        item('idWxsConfigure', 'Configure...'),
    ],
};

const toolsPlusMenu = {
    id: 'menu_toolsplus', label: 'Tools+', mnemonic: -1, items: [
        item('idToolsPlusConfigure', 'Configure...'),
    ],
};

const doxyBlocksMenu = {
    id: 'menu_doxyblocks', label: 'DoxyBlocks', mnemonic: -1, items: [
        item('idDoxyBlockComment', 'Block comment', { accel: 'Ctrl-Alt-B' }),
        item('idDoxyLineComment', 'Line comment', { accel: 'Ctrl-Alt-L' }),
        { type: 'sep' },
        item('idDoxyExtract', 'Extract documentation', { accel: 'Ctrl-Alt-E' }),
        item('idDoxyRunHTML', 'Run HTML', { accel: 'Ctrl-Alt-H' }),
        item('idDoxyRunCHM', 'Run CHM'),
        { type: 'sep' },
        item('idDoxyWizard', 'Run doxywizard'),
        item('idDoxyConfig', 'Open preferences...'),
    ],
};

// Fortran and wxSmith sit between Debug and Tools; Tools+ after Tools;
// DoxyBlocks between Plugins and Settings.
const debugIdx = menus.findIndex(m => m.id === 'debugger_menu');
menus.splice(debugIdx + 1, 0, fortranMenu, wxSmithMenu);
const toolsIdx = menus.findIndex(m => m.id === 'menu_tools');
menus.splice(toolsIdx + 1, 0, toolsPlusMenu);
const pluginsIdx = menus.findIndex(m => m.id === 'menu_plugins');
menus.splice(pluginsIdx + 1, 0, doxyBlocksMenu);

const header = '// GENERATED by tools/gen-menus.js from the Code::Blocks XRC resources.\n' +
               '// Do not edit by hand; re-run the generator instead.\n';
const out = header + 'const CB_MENUS = ' + JSON.stringify(menus, null, 1) + ';\n';
fs.writeFileSync(path.resolve(__dirname, '..', 'js', 'menudata.js'), out);
console.log('wrote js/menudata.js:', menus.length, 'menus,',
            JSON.stringify(menus).length, 'bytes');
