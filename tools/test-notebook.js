/* ---------------------------------------------------------------------------
   test-notebook.js - checks which page a notebook shows after a close.

   Closing a tab to the left of the active one used to leave `active` pointing
   one page too far right, so shutting a background tab silently switched the
   editor to a different file.

       node tools/test-notebook.js
--------------------------------------------------------------------------- */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

/* Just enough DOM for the notebook: elements that can hold children, be
   removed, and answer the two selectors the constructor uses. */
function makeNode(cls) {
    const node = {
        className: cls || '',
        children: [],
        parent: null,
        style: {},
        dataset: {},
        textContent: '',
        title: '',
        classList: {
            add(c) { node.className = (node.className + ' ' + c).trim(); },
            remove(c) {
                node.className = node.className.split(/\s+/).filter(x => x && x !== c).join(' ');
            },
            contains(c) { return node.className.split(/\s+/).includes(c); },
            toggle(c, on) { if (on) node.classList.add(c); else node.classList.remove(c); },
        },
        appendChild(child) { child.parent = node; node.children.push(child); return child; },
        remove() {
            if (!node.parent) return;
            node.parent.children = node.parent.children.filter(c => c !== node);
            node.parent = null;
        },
        addEventListener() {},
        querySelector(sel) {
            const want = sel.replace(/^\./, '');
            for (const c of node.children) {
                if (c.className.split(/\s+/).includes(want)) return c;
                const deep = c.querySelector(sel);
                if (deep) return deep;
            }
            return null;
        },
        querySelectorAll() { return []; },
        set innerHTML(v) { if (!v) node.children = []; },
        get innerHTML() { return ''; },
    };
    return node;
}

global.window = global;
global.document = {
    createElement: () => makeNode(''),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
};
Object.defineProperty(global, 'navigator',
                      { value: { userAgent: 'node' }, configurable: true });

const Notebook = eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + ';Notebook');

let failed = 0;
function check(name, got, want) {
    if (got === want) { console.log('  ok    ' + name); return; }
    failed++;
    console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

function notebook() {
    const host = makeNode('nb');
    host.appendChild(makeNode('nb-tabs'));
    host.appendChild(makeNode('nb-pages'));
    const nb = new Notebook(host, {});
    ['a', 'b', 'c', 'd'].forEach(k => nb.addPage(k, k, makeNode('body'), null, true));
    return nb;
}

console.log('Notebook.removePage keeps the page the user was on');
{
    const nb = notebook();
    nb.select('b');
    nb.removePage('a');
    check('closing a tab on the left keeps the active page', nb.activePage().key, 'b');

    const nb2 = notebook();
    nb2.select('b');
    nb2.removePage('c');
    check('closing a tab on the right keeps the active page', nb2.activePage().key, 'b');

    const nb3 = notebook();
    nb3.select('b');
    nb3.removePage('b');
    check('closing the active page falls to its neighbour', nb3.activePage().key, 'c');

    const nb4 = notebook();
    nb4.select('d');
    nb4.removePage('d');
    check('closing the last page falls back one', nb4.activePage().key, 'c');

    const nb5 = notebook();
    ['a', 'b', 'c', 'd'].forEach(k => nb5.removePage(k));
    check('an empty notebook has no active page', nb5.active, -1);
}

console.log(failed ? `\n${failed} notebook check(s) failed` : '\nall notebook checks passed');
process.exit(failed ? 1 : 0);
