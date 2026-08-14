/* ---------------------------------------------------------------------------
   ui.js - the wxWidgets-lookalike widget layer: menu bar, pop-up menus,
   wxAuiToolBar, wxAuiNotebook, wxTreeCtrl, wxAuiManager panes, dialogs and
   floating windows.
--------------------------------------------------------------------------- */
'use strict';

const UI = {};

// --- small helpers -----------------------------------------------------------

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }

/* Maps the XRC stock_id strings to the SVG files shipped with Code::Blocks.
   Mirrors the cbArtProvider mappings in src/src/main.cpp. */
const ART = {
    'core/file_open': 'fileopen', 'core/file_new': 'filenew',
    'core/history_clear': 'history_clear', 'core/file_save': 'filesave',
    'core/file_save_as': 'filesaveas', 'core/file_save_all': 'filesaveall',
    'core/file_close': 'fileclose', 'core/file_print': 'fileprint',
    'core/exit': 'exit', 'core/undo': 'undo', 'core/redo': 'redo',
    'core/edit_cut': 'editcut', 'core/edit_copy': 'editcopy',
    'core/edit_paste': 'editpaste', 'core/bookmark_add': 'bookmark_add',
    'core/find': 'filefind', 'core/find_in_files': 'findf',
    'core/find_next': 'filefindnext', 'core/find_prev': 'filefindprev',
    'core/search_replace': 'searchreplace',
    'core/search_replace_in_files': 'searchreplacef',
    'core/goto': 'goto', 'core/manage_plugins': 'plug',
    'core/help_info': 'info', 'core/help_idea': 'idea',
    'core/dbg/run': 'dbgrun', 'core/dbg/pause': 'dbgpause',
    'core/dbg/stop': 'dbgstop', 'core/dbg/run_to': 'dbgrunto',
    'core/dbg/next': 'dbgnext', 'core/dbg/step': 'dbgstep',
    'core/dbg/step_out': 'dbgstepout', 'core/dbg/next_inst': 'dbgnexti',
    'core/dbg/step_inst': 'dbgstepi', 'core/dbg/window': 'dbgwindow',
    'core/dbg/info': 'dbginfo',
    'core/folder_open': 'tree/folder_open', 'core/gear': 'infopane/misc',
    'compiler/compile': 'compile', 'compiler/run': 'run',
    'compiler/compile_run': 'compilerun', 'compiler/rebuild': 'rebuild',
    'compiler/stop': 'stop', 'sdk/select_target': 'select_target',
};
UI.art = function (stockId) {
    const f = ART[stockId];
    return f ? 'assets/icons/' + f + '.svg' : null;
};

// wx accelerator strings ("Ctrl-Shift-F9") -> readable + matchable form.
UI.accelText = a => a ? a.replace(/-/g, '+') : '';

function normKey(k) {
    k = String(k).toUpperCase();
    const map = {
        DEL: 'DELETE', INS: 'INSERT', PGUP: 'PAGEUP', PGDN: 'PAGEDOWN',
        ESC: 'ESCAPE', RETURN: 'ENTER', SPACE: ' ',
    };
    return map[k] || k;
}

function parseAccel(a) {
    if (!a) return null;
    /* the XRC strings are inconsistent: "Ctrl-Shift-F9", "Ctrl+Tab",
       "SHIFT-F11", "Shift+Return" - accept every spelling. */
    const parts = a.split(/[-+]/).filter(Boolean);
    const key = parts.pop();
    const has = n => parts.some(p => p.toLowerCase() === n);
    return { ctrl: has('ctrl'), shift: has('shift'), alt: has('alt'), key: normKey(key) };
}
UI.parseAccel = parseAccel;

/* canonical name of a chord, so the two spellings of the same shortcut
   ("Shift-Ctrl-C" and "Ctrl+Shift+C") compare equal */
UI.accelId = function (a) {
    const p = parseAccel(a);
    if (!p) return '';
    return (p.ctrl ? 'Ctrl-' : '') + (p.alt ? 'Alt-' : '') + (p.shift ? 'Shift-' : '') + p.key;
};

/* ------------------------------------------------- browser-stolen shortcuts

   Some chords never reach the page: the browser acts on them itself and
   preventDefault() has no effect.  Ctrl+Shift+N opens an InPrivate window in
   Edge and Chrome, Ctrl+W closes the tab, Ctrl+R reloads.  Firefox reserves a
   different set, which is why the same key can work in one browser and not the
   other.  Every command bound to a stolen chord gets a second, free chord so
   the command is still reachable; the menu shows whichever one works here. */
UI.browserReserves = (function () {
    const gecko = /\bGecko\/|\bFirefox\//.test(navigator.userAgent) &&
                  !/\bChrome\//.test(navigator.userAgent);
    const both = [
        'Ctrl-N', 'Ctrl-T', 'Ctrl-W', 'Ctrl-R', 'Ctrl-TAB', 'Ctrl-Shift-TAB',
        'Ctrl-Shift-T', 'Ctrl-Shift-W', 'Ctrl-Shift-R', 'Ctrl-Shift-I',
        'Ctrl-Shift-J', 'Ctrl-Shift-DELETE', 'F11', 'F12',
    ];
    const chromium = [
        'Ctrl-Shift-N', 'Ctrl-Shift-B', 'Ctrl-Shift-C', 'Ctrl-Shift-D',
        'Ctrl-Shift-M', 'Ctrl-Shift-O',
    ];
    const firefox = ['Ctrl-Shift-P', 'Ctrl-Shift-A', 'Ctrl-Shift-K', 'Ctrl-Shift-E'];
    return new Set(both.concat(gecko ? firefox : chromium));
})();

/* Ctrl+Alt+Tab belongs to Windows, so tab switching needs its own escape. */
const ACCEL_OVERRIDE = { 'Ctrl-TAB': 'Ctrl-Alt-PgDn', 'Ctrl-Shift-TAB': 'Ctrl-Alt-PgUp' };

/* Chords the command also answers to.  Ctrl+N is what people press for a new
   file even though the desktop IDE binds Ctrl+Shift+N, and both of them reach
   the page once the desktop key map is on. */
UI.EXTRA_ACCELS = { idFileNewEmpty: ['Ctrl-N'] };

/* Gives every reserved accelerator a working alternative.  Returns the list of
   what moved, for the Keyboard shortcuts page. */
UI.applyBrowserAccelerators = function (menus) {
    const used = new Set(), items = [];
    const walk = list => list.forEach(it => {
        if (it.type === 'menu') return walk(it.items);
        if (it.accel) { used.add(UI.accelId(it.accel)); items.push(it); }
    });
    menus.forEach(m => walk(m.items));

    const moved = [];
    items.forEach(it => {
        const id = UI.accelId(it.accel);
        if (!UI.browserReserves.has(id)) return;
        const p = parseAccel(it.accel);
        const candidates = [
            ACCEL_OVERRIDE[id],
            'Ctrl-Alt-' + p.key,                // the shortest chord that is free
            'Ctrl-Alt-Shift-' + p.key,
        ].filter(Boolean);
        const alt = candidates.find(c => !used.has(UI.accelId(c)));
        if (!alt) return;                       // rather no binding than a double one
        used.add(UI.accelId(alt));
        it.accelAlt = alt;
        moved.push({ id: it.id, label: it.label, from: it.accel, to: alt });
    });
    UI.remappedAccels = moved;
    return moved;
};
UI.remappedAccels = [];

/* ============================================================== pop-up menus */

let openPopups = [];
let menuBarOpen = null;

function closePopups(from) {
    while (openPopups.length > (from || 0)) openPopups.pop().remove();
}
UI.closeAllMenus = function () {
    closePopups(0);
    if (menuBarOpen) { menuBarOpen.classList.remove('open'); menuBarOpen = null; }
    document.body.classList.remove('show-mnemonics');
};

function labelHtml(item) {
    const l = item.label || '';
    if (item.mnemonic === undefined || item.mnemonic < 0)
        return document.createTextNode(l);
    const frag = document.createDocumentFragment();
    frag.appendChild(document.createTextNode(l.slice(0, item.mnemonic)));
    const m = el('span', 'mnem', l[item.mnemonic]);
    frag.appendChild(m);
    frag.appendChild(document.createTextNode(l.slice(item.mnemonic + 1)));
    return frag;
}

/* Builds a pop-up. `items` follows the shape produced by tools/gen-menus.js. */
UI.popup = function (items, x, y, depth, onCommand) {
    closePopups(depth || 0);
    const pop = el('div', 'cb-popup');
    const hasIcons = items.some(i => i.bitmap);
    items.forEach(item => {
        if (item.type === 'sep') { pop.appendChild(el('div', 'sep')); return; }
        const row = el('div', 'row');
        const state = UI.menuState ? UI.menuState(item) : {};
        const enabled = state.enabled !== undefined ? state.enabled
                      : (item.enabled !== false);
        const checked = state.checked !== undefined ? state.checked : item.checked;
        if (!enabled) row.classList.add('disabled');
        if (checked) row.classList.add('checked');

        const gutter = el('div', 'gutter');
        if (item.bitmap && UI.art(item.bitmap)) {
            const img = el('img');
            img.src = UI.art(item.bitmap);
            gutter.appendChild(img);
        } else if (item.checkable || item.radio) {
            const c = el('div', 'check', checked ? (item.radio ? '●' : '✓') : '');
            gutter.appendChild(c);
        }
        row.appendChild(gutter);

        const lab = el('div', 'label');
        lab.appendChild(labelHtml(item));
        row.appendChild(lab);

        if (item.type === 'menu') {
            row.appendChild(el('div', 'arrow', '▶'));
        } else if (item.accel) {
            const acc = el('div', 'accel', UI.accelText(item.accelAlt || item.accel));
            if (item.accelAlt)
                acc.title = UI.accelText(item.accel) + ' belongs to the browser here';
            row.appendChild(acc);
        }

        if (item.type === 'menu') {
            let subTimer = null;
            row.addEventListener('mouseenter', () => {
                closePopups((depth || 0) + 1);
                const r = row.getBoundingClientRect();
                clearTimeout(subTimer);
                subTimer = setTimeout(() => {
                    UI.popup(item.items, r.right - 3, r.top - 3, (depth || 0) + 1, onCommand);
                }, 120);
            });
            row.addEventListener('mouseleave', () => clearTimeout(subTimer));
            row.addEventListener('click', ev => {
                ev.stopPropagation();
                const r = row.getBoundingClientRect();
                UI.popup(item.items, r.right - 3, r.top - 3, (depth || 0) + 1, onCommand);
            });
        } else {
            row.addEventListener('mouseenter', () => closePopups((depth || 0) + 1));
            row.addEventListener('click', ev => {
                ev.stopPropagation();
                if (!enabled) return;
                UI.closeAllMenus();
                onCommand(item);
            });
            row.addEventListener('mouseover', () => {
                if (item.help) UI.setStatus(0, item.help);
            });
        }
        pop.appendChild(row);
    });

    document.body.appendChild(pop);
    // keep the popup inside the window, like wxMenu does
    const w = pop.offsetWidth, h = pop.offsetHeight;
    if (x + w > window.innerWidth) x = Math.max(0, window.innerWidth - w - 2);
    if (y + h > window.innerHeight) y = Math.max(0, window.innerHeight - h - 2);
    pop.style.left = Math.round(x) + 'px';
    pop.style.top = Math.round(y) + 'px';
    openPopups.push(pop);
    return pop;
};

document.addEventListener('mousedown', ev => {
    if (ev.target.closest('.cb-popup') || ev.target.closest('#menubar')) return;
    UI.closeAllMenus();
});

/* ================================================================= menu bar */

UI.buildMenuBar = function (menus, onCommand) {
    const bar = $('#menubar');
    bar.innerHTML = '';
    menus.forEach(menu => {
        const item = el('div', 'mb-item');
        item.appendChild(labelHtml(menu));
        item.addEventListener('mousedown', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            if (menuBarOpen === item) { UI.closeAllMenus(); return; }
            UI.closeAllMenus();
            menuBarOpen = item;
            item.classList.add('open');
            const r = item.getBoundingClientRect();
            UI.popup(menu.items, r.left, r.bottom, 0, onCommand);
        });
        item.addEventListener('mouseenter', () => {
            if (menuBarOpen && menuBarOpen !== item) {
                menuBarOpen.classList.remove('open');
                menuBarOpen = item;
                item.classList.add('open');
                const r = item.getBoundingClientRect();
                UI.popup(menu.items, r.left, r.bottom, 0, onCommand);
            }
        });
        bar.appendChild(item);
    });
};

/* Walks the menu tree looking for the command bound to a keyboard shortcut. */
UI.findAccel = function (menus, ev) {
    let hit = null;
    const key = normKey(ev.key);
    /* AltGr arrives as ctrl+alt on Windows; a chord that produced a printable
       character is the user typing, not a shortcut. */
    const matches = a => {
        if (!a) return false;
        if (a.key !== key) return false;
        return a.ctrl === ev.ctrlKey && a.shift === ev.shiftKey && a.alt === ev.altKey;
    };
    const walk = items => items.forEach(it => {
        if (hit) return;
        if (it.type === 'menu') return walk(it.items);
        if (!it.accel) return;
        if (matches(parseAccel(it.accel)) || matches(parseAccel(it.accelAlt))) { hit = it; return; }
        const extra = UI.EXTRA_ACCELS[it.id];
        if (extra && extra.some(a => matches(parseAccel(a)))) hit = it;
    });
    menus.forEach(m => walk(m.items));
    return hit;
};

/* ================================================================= toolbars */

/* spec: [{id, tooltip, bitmap} | {sep:true} | {choice:[...]}] */
UI.buildToolbar = function (container, spec, onCommand) {
    container.innerHTML = '';
    container.appendChild(el('div', 'tb-grip'));
    spec.forEach(t => {
        if (t.sep) { container.appendChild(el('div', 'tb-sep')); return; }
        if (t.choice) {
            const sel = el('select', 'tb-choice');
            sel.id = t.id;
            if (t.width) sel.style.width = t.width + 'px';
            t.choice.forEach(o => sel.appendChild(new Option(o, o)));
            sel.title = t.tooltip || '';
            sel.addEventListener('change', () => onCommand({ id: t.id, value: sel.value }));
            container.appendChild(sel);
            return;
        }
        if (t.text) {
            const inp = el('input', 'tb-text');
            inp.id = t.id;
            inp.type = 'text';
            inp.style.width = (t.width || 140) + 'px';
            inp.title = t.tooltip || '';
            inp.addEventListener('input', () => onCommand({ id: t.id, value: inp.value }));
            container.appendChild(inp);
            return;
        }
        const b = el('div', 'tb-btn');
        b.dataset.id = t.id;
        b.title = t.tooltip || '';
        if (t.disabled) b.classList.add('disabled');
        const img = el('img');
        img.src = t.png ? 'assets/icons/plugins/' + t.png + '.png'
                        : (UI.art(t.bitmap) || 'assets/icons/missing_icon.svg');
        img.draggable = false;
        b.appendChild(img);
        b.addEventListener('click', () => {
            if (b.classList.contains('disabled')) return;
            onCommand({ id: t.id });
        });
        b.addEventListener('mouseenter', () => UI.setStatus(0, t.longhelp || t.tooltip || ''));
        b.addEventListener('mouseleave', () => UI.restoreStatus());
        container.appendChild(b);
    });
};

UI.enableTool = function (id, on) {
    $$('.tb-btn').forEach(b => {
        if (b.dataset.id === id) b.classList.toggle('disabled', !on);
    });
};

/* =============================================================== notebooks */

/* A wxAuiNotebook: tabs on top, optional icon, optional close button. */
class Notebook {
    constructor(root, opts) {
        this.root = typeof root === 'string' ? $(root) : root;
        this.tabsEl = $('.nb-tabs', this.root);
        this.pagesEl = $('.nb-pages', this.root);
        this.pages = [];
        this.active = -1;
        this.opts = opts || {};
        this.onChange = null;
        this.onClose = null;
        this.onContext = null;
    }
    addPage(key, title, content, icon, closable) {
        const page = el('div', 'nb-page');
        if (content) page.appendChild(content);
        this.pagesEl.appendChild(page);
        const rec = { key, title, page, icon, closable: !!closable };
        this.pages.push(rec);
        this.renderTabs();
        if (this.active < 0) this.select(0);
        return rec;
    }
    indexOf(key) { return this.pages.findIndex(p => p.key === key); }
    setTitle(key, title) {
        const p = this.pages[this.indexOf(key)];
        if (p) { p.title = title; this.renderTabs(); }
    }
    select(i) {
        if (typeof i === 'string') i = this.indexOf(i);
        if (i < 0 || i >= this.pages.length) return;
        this.active = i;
        this.pages.forEach((p, n) => p.page.classList.toggle('active', n === i));
        this.renderTabs();
        if (this.onChange) this.onChange(this.pages[i], i);
    }
    activePage() { return this.pages[this.active]; }
    removePage(key) {
        const i = typeof key === 'string' ? this.indexOf(key) : key;
        if (i < 0) return;
        this.pages[i].page.remove();
        this.pages.splice(i, 1);
        if (this.active >= this.pages.length) this.active = this.pages.length - 1;
        this.renderTabs();
        if (this.active >= 0) this.select(this.active);
        else if (this.onChange) this.onChange(null, -1);
    }
    renderTabs() {
        this.tabsEl.innerHTML = '';
        if (this.opts.scrollButtons) {
            const left = el('div', 'nb-scroll', '◀');
            const right = el('div', 'nb-scroll', '▶');
            left.addEventListener('click', () => this.select(Math.max(0, this.active - 1)));
            right.addEventListener('click', () => this.select(Math.min(this.pages.length - 1, this.active + 1)));
            this.tabsEl.appendChild(left);
            this.scrollRight = right;
        }
        this.pages.forEach((p, i) => {
            const t = el('div', 'nb-tab' + (i === this.active ? ' active' : ''));
            if (p.icon) {
                const img = el('img', 'tab-icon');
                img.src = p.icon;
                img.draggable = false;
                t.appendChild(img);
            }
            t.appendChild(el('span', 'tab-text', p.title));
            if (p.closable) {
                const x = el('span', 'tab-close');
                x.innerHTML = '<svg width="9" height="9" viewBox="0 0 9 9">' +
                    '<path d="M1 1 L8 8 M8 1 L1 8" stroke="#4d4d4d" stroke-width="1.4"/></svg>';
                /* The close box must swallow mousedown: selecting a tab
                   re-renders the strip, which would destroy this node before
                   the click event ever completed. */
                x.addEventListener('mousedown', ev => {
                    ev.preventDefault();
                    ev.stopPropagation();
                    x.classList.add('pressed');
                });
                x.addEventListener('mouseleave', () => x.classList.remove('pressed'));
                x.addEventListener('mouseup', ev => {
                    ev.stopPropagation();
                    if (!x.classList.contains('pressed')) return;
                    x.classList.remove('pressed');
                    if (this.onClose) this.onClose(p);
                });
                t.appendChild(x);
            }
            t.addEventListener('mousedown', ev => {
                if (ev.button === 1) {          /* middle click closes, as on the desktop */
                    ev.preventDefault();
                    if (p.closable && this.onClose) this.onClose(p);
                    return;
                }
                if (ev.button === 0 || ev.button === 2) this.select(i);
            });
            t.addEventListener('contextmenu', ev => {
                ev.preventDefault();
                if (this.onContext) this.onContext(p, ev);
            });
            t.title = p.tooltip || p.title;
            this.tabsEl.appendChild(t);
        });
        if (this.scrollRight) this.tabsEl.appendChild(this.scrollRight);
    }
}
UI.Notebook = Notebook;

/* ================================================================== trees */

/* nodes: {label, icon, bold, children, expanded, data} */
class Tree {
    constructor(container) {
        this.el = typeof container === 'string' ? $(container) : container;
        this.el.classList.add('cb-tree');
        this.roots = [];
        this.selected = null;
        this.onSelect = null;
        this.onActivate = null;
        this.onContext = null;
    }
    setRoots(roots) { this.roots = roots; this.render(); }
    render() {
        this.el.innerHTML = '';
        const draw = (node, depth) => {
            const row = el('div', 'tree-row' + (node.bold ? ' bold' : '') +
                                (node === this.selected ? ' selected' : ''));
            row.style.paddingLeft = (depth * 16) + 'px';
            const tw = el('div', 'twisty');
            const kids = node.children && node.children.length;
            if (kids) {
                tw.innerHTML = node.expanded
                    ? '<svg width="9" height="9" viewBox="0 0 9 9"><path d="M1 3 L4.5 7 L8 3" fill="#595959"/></svg>'
                    : '<svg width="9" height="9" viewBox="0 0 9 9"><path d="M3 1 L7 4.5 L3 8" fill="none" stroke="#595959" stroke-width="1.2"/></svg>';
                tw.addEventListener('mousedown', ev => {
                    ev.stopPropagation();
                    node.expanded = !node.expanded;
                    this.render();
                });
            }
            row.appendChild(tw);
            if (node.icon) {
                const img = el('img');
                img.src = node.icon;
                img.draggable = false;
                row.appendChild(img);
            }
            row.appendChild(el('span', null, node.label));
            row.addEventListener('mousedown', () => {
                this.selected = node;
                this.render();
                if (this.onSelect) this.onSelect(node);
            });
            row.addEventListener('dblclick', () => {
                if (kids) { node.expanded = !node.expanded; this.render(); }
                if (this.onActivate) this.onActivate(node);
            });
            row.addEventListener('contextmenu', ev => {
                ev.preventDefault();
                this.selected = node;
                this.render();
                if (this.onContext) this.onContext(node, ev);
            });
            this.el.appendChild(row);
            if (kids && node.expanded) node.children.forEach(c => draw(c, depth + 1));
        };
        this.roots.forEach(r => draw(r, 0));
    }
}
UI.Tree = Tree;

/* ====================================================== floating windows */

let zTop = 950;

UI.window = function (opts) {
    const w = el('div', 'cb-window');
    w.id = opts.id || '';
    w.style.width = (opts.width || 400) + 'px';
    if (opts.height) w.style.height = opts.height + 'px';
    w.style.left = (opts.x !== undefined ? opts.x
        : Math.max(0, (window.innerWidth - (opts.width || 400)) / 2)) + 'px';
    w.style.top = (opts.y !== undefined ? opts.y
        : Math.max(0, (window.innerHeight - (opts.height || 300)) / 2)) + 'px';
    w.style.zIndex = ++zTop;

    const title = el('div', 'title');
    if (opts.icon) {
        const img = el('img', 't-icon');
        img.src = opts.icon;
        title.appendChild(img);
    }
    title.appendChild(el('span', 't-text', opts.title || ''));
    if (opts.minimizable !== false) {
        const mn = el('span', 't-btn');
        mn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><path d="M1 8 H9" stroke="#000"/></svg>';
        title.appendChild(mn);
    }
    const cl = el('span', 't-btn close');
    cl.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10">' +
        '<path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" stroke-width="1.2"/></svg>';
    cl.addEventListener('click', () => {
        if (opts.onClose) opts.onClose();
        else w.remove();
    });
    title.appendChild(cl);
    w.appendChild(title);

    const body = el('div', 'body');
    if (opts.body) body.appendChild(opts.body);
    w.appendChild(body);
    w.bodyEl = body;

    if (opts.buttons) {
        const bar = el('div', 'buttons');
        opts.buttons.forEach(b => {
            const btn = el('button', 'cb', b.label);
            btn.addEventListener('click', () => b.onClick(w));
            bar.appendChild(btn);
        });
        w.appendChild(bar);
    }

    // dragging by the caption, like a real top-level window
    let drag = null;
    title.addEventListener('mousedown', ev => {
        if (ev.target.closest('.t-btn')) return;
        drag = { x: ev.clientX - w.offsetLeft, y: ev.clientY - w.offsetTop };
        w.style.zIndex = ++zTop;
        ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
        if (!drag) return;
        w.style.left = Math.max(0, Math.min(window.innerWidth - 60, ev.clientX - drag.x)) + 'px';
        w.style.top = Math.max(0, Math.min(window.innerHeight - 30, ev.clientY - drag.y)) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });
    w.addEventListener('mousedown', () => { w.style.zIndex = ++zTop; });

    // bottom-right resize grip
    if (opts.resizable !== false) {
        const grip = el('div');
        grip.style.cssText = 'position:absolute;right:0;bottom:0;width:14px;height:14px;cursor:nwse-resize;';
        w.appendChild(grip);
        let rs = null;
        grip.addEventListener('mousedown', ev => {
            rs = { x: ev.clientX, y: ev.clientY, w: w.offsetWidth, h: w.offsetHeight };
            ev.preventDefault();
            ev.stopPropagation();
        });
        document.addEventListener('mousemove', ev => {
            if (!rs) return;
            w.style.width = Math.max(220, rs.w + ev.clientX - rs.x) + 'px';
            w.style.height = Math.max(120, rs.h + ev.clientY - rs.y) + 'px';
            if (opts.onResize) opts.onResize();
        });
        document.addEventListener('mouseup', () => { rs = null; });
    }

    document.body.appendChild(w);
    return w;
};

/* Modal message box, mirroring wxMessageBox / cbMessageBox. */
UI.messageBox = function (text, caption, buttons, icon) {
    return new Promise(resolve => {
        const veil = el('div', 'cb-dialog-veil');
        document.body.appendChild(veil);
        const body = el('div');
        body.style.cssText = 'display:flex;gap:12px;align-items:flex-start;padding:6px 4px;';
        if (icon !== false) {
            const ic = el('div');
            ic.style.cssText = 'font-size:30px;line-height:1;';
            ic.textContent = icon || 'ℹ️';
            body.appendChild(ic);
        }
        const t = el('div');
        t.style.cssText = 'white-space:pre-wrap;padding-top:4px;max-width:420px;';
        t.textContent = text;
        body.appendChild(t);

        const w = UI.window({
            title: caption || 'Code::Blocks',
            icon: 'assets/codeblocks.png',
            width: 400, minimizable: false, resizable: false,
            body,
            buttons: (buttons || ['OK']).map(b => ({
                label: b,
                onClick: () => { w.remove(); veil.remove(); resolve(b); },
            })),
            onClose: () => { w.remove(); veil.remove(); resolve(null); },
        });
        w.style.height = 'auto';
    });
};

/* Simple one-line input dialog (wxTextEntryDialog). */
UI.textEntry = function (message, caption, value) {
    return new Promise(resolve => {
        const veil = el('div', 'cb-dialog-veil');
        document.body.appendChild(veil);
        const body = el('div');
        body.appendChild(el('div', null, message));
        const inp = el('input', 'cb');
        inp.style.cssText = 'width:100%;margin-top:8px;';
        inp.value = value || '';
        body.appendChild(inp);
        const done = v => { w.remove(); veil.remove(); resolve(v); };
        const w = UI.window({
            title: caption || 'Code::Blocks', icon: 'assets/codeblocks.png',
            width: 380, minimizable: false, resizable: false, body,
            buttons: [
                { label: 'OK', onClick: () => done(inp.value) },
                { label: 'Cancel', onClick: () => done(null) },
            ],
            onClose: () => done(null),
        });
        w.style.height = 'auto';
        inp.focus();
        inp.select();
        inp.addEventListener('keydown', ev => {
            if (ev.key === 'Enter') done(inp.value);
            if (ev.key === 'Escape') done(null);
        });
    });
};

/* =================================================================== sashes */

UI.makeSashV = function (sashEl, target, min, max) {
    let d = null;
    sashEl.addEventListener('mousedown', ev => {
        d = { x: ev.clientX, w: target.offsetWidth };
        document.body.style.cursor = 'ew-resize';
        ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
        if (!d) return;
        target.style.width = Math.max(min, Math.min(max(), d.w + ev.clientX - d.x)) + 'px';
        if (UI.onLayout) UI.onLayout();
    });
    document.addEventListener('mouseup', () => {
        if (d) { d = null; document.body.style.cursor = ''; }
    });
};

UI.makeSashH = function (sashEl, target, min, max) {
    let d = null;
    sashEl.addEventListener('mousedown', ev => {
        d = { y: ev.clientY, h: target.offsetHeight };
        document.body.style.cursor = 'ns-resize';
        ev.preventDefault();
    });
    document.addEventListener('mousemove', ev => {
        if (!d) return;
        target.style.height = Math.max(min, Math.min(max(), d.h - (ev.clientY - d.y))) + 'px';
        if (UI.onLayout) UI.onLayout();
    });
    document.addEventListener('mouseup', () => {
        if (d) { d = null; document.body.style.cursor = ''; }
    });
};

/* Pane caption buttons drawn the way wxAuiDefaultDockArt draws them. */
UI.initPaneButtons = function () {
    $$('.pane-btn').forEach(b => {
        if (b.dataset.act === 'pin') {
            b.innerHTML = '<svg width="11" height="11" viewBox="0 0 11 11">' +
                '<path d="M2 2 h7 v2 h-3 v5 h-1 v-5 h-3 z" fill="#000"/></svg>';
        } else {
            b.innerHTML = '<svg width="11" height="11" viewBox="0 0 11 11">' +
                '<path d="M2 2 L9 9 M9 2 L2 9" stroke="#000" stroke-width="1.4"/></svg>';
        }
    });
};

/* ===================================================================== hints

   A non-modal panel in the corner, for things the user needs to know but must
   not be interrupted by - it never takes the keyboard away from the editor. */
UI.hint = function (opts) {
    const old = document.querySelector('.cb-hint');
    if (old) old.remove();
    const box = el('div', 'cb-hint');
    const title = el('div', 'cb-hint-title');
    title.appendChild(el('span', '', opts.title || 'Code::Blocks'));
    const close = el('span', 'cb-hint-x', '✕');
    close.addEventListener('click', () => box.remove());
    title.appendChild(close);
    box.appendChild(title);

    const body = el('div', 'cb-hint-body');
    body.innerHTML = opts.html || '';
    box.appendChild(body);

    if (opts.buttons && opts.buttons.length) {
        const row = el('div', 'cb-hint-buttons');
        opts.buttons.forEach(b => {
            const btn = el('button', 'cb', b.label);
            btn.addEventListener('click', () => { box.remove(); b.onClick(); });
            row.appendChild(btn);
        });
        box.appendChild(row);
    } else if (opts.seconds !== 0) {
        setTimeout(() => box.remove(), (opts.seconds || 8) * 1000);
    }
    document.body.appendChild(box);
    return box;
};

/* ================================================================ statusbar */

const statusFields = [];
UI.setStatus = function (i, text) {
    const f = document.getElementById('sb-' + i);
    if (f) f.textContent = text || '';
};
UI.rememberStatus = function () { statusFields[0] = $('#sb-0').textContent; };
UI.restoreStatus = function () { if (UI.updateStatusBar) UI.updateStatusBar(); };
