/* ---------------------------------------------------------------------------
   test-accel.js - checks the keyboard accelerator table.

   Some chords never reach a web page (the browser acts on them itself), so
   commands bound to those get a second binding.  This test pins down both the
   remapping and the plain matching, which is easy to break by touching either
   the XRC-generated menu data or parseAccel().

       node tools/test-accel.js
--------------------------------------------------------------------------- */
'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
               '(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36';
const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0';

function load(userAgent) {
    // node >= 21 defines navigator itself, and only as a getter
    Object.defineProperty(global, 'navigator', { value: { userAgent }, configurable: true });
    global.window = global;
    global.document = {
        addEventListener() {}, getElementById() { return null; },
        querySelector() { return null; },
        createElement() {
            return { classList: { add() {} }, appendChild() {}, addEventListener() {}, style: {} };
        },
    };
    const menus = eval(fs.readFileSync(path.join(root, 'js/menudata.js'), 'utf8') + ';CB_MENUS');
    const ui = eval(fs.readFileSync(path.join(root, 'js/ui.js'), 'utf8') + ';UI');
    ui.applyBrowserAccelerators(menus);
    return { menus, ui };
}

let failed = 0;
function check(name, got, want) {
    if (got === want) { console.log('  ok    ' + name); return; }
    failed++;
    console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

function press(ui, menus, key, mods) {
    mods = mods || '';
    const hit = ui.findAccel(menus, {
        key,
        ctrlKey: mods.includes('c'), shiftKey: mods.includes('s'), altKey: mods.includes('a'),
    });
    return hit ? hit.id : null;
}

console.log('Chromium - reserved chords get a second binding');
{
    const { menus, ui } = load(CHROME);
    const alt = id => {
        const m = ui.remappedAccels.find(x => x.id === id);
        return m ? m.to : null;
    };
    check('Ctrl+Shift+N is known to be stolen', alt('idFileNewEmpty'), 'Ctrl-Alt-N');
    check('Ctrl+W is known to be stolen', alt('idFileClose'), 'Ctrl-Alt-W');
    check('Ctrl+R is known to be stolen', alt('idSearchReplace'), 'Ctrl-Alt-R');
    check('Ctrl+Alt+B stays with DoxyBlocks', alt('idEditGotoMatchingBrace'), 'Ctrl-Alt-Shift-B');
    check('Ctrl+S is not stolen', alt('idFileSave'), null);

    check('Ctrl+Alt+N makes a new file', press(ui, menus, 'n', 'ca'), 'idFileNewEmpty');
    check('Ctrl+N makes a new file too', press(ui, menus, 'n', 'c'), 'idFileNewEmpty');
    check('Ctrl+Shift+N still bound (works locked)', press(ui, menus, 'N', 'cs'), 'idFileNewEmpty');
    check('Ctrl+Alt+W closes the file', press(ui, menus, 'w', 'ca'), 'idFileClose');
    check('Ctrl+S saves', press(ui, menus, 's', 'c'), 'idFileSave');
    check('F9 builds and runs', press(ui, menus, 'F9', ''), 'idCompilerMenuCompileAndRun');
    check('Ctrl+Tab switches tabs', press(ui, menus, 'Tab', 'c'), 'idViewSwitchTabs');
    check('Ctrl+Alt+PgDn switches tabs', press(ui, menus, 'PageDown', 'ca'), 'idViewSwitchTabs');
    check('Shift+Enter inserts a line', press(ui, menus, 'Enter', 's'), 'idEditInsertNewLine');
    check('a bare n types a letter', press(ui, menus, 'n', ''), null);

    const dupes = new Map();
    const walk = items => items.forEach(it => {
        if (it.type === 'menu') return walk(it.items);
        [it.accel, it.accelAlt].filter(Boolean).forEach(a => {
            const id = ui.accelId(a);
            if (dupes.has(id) && dupes.get(id) !== it.id)
                check('no chord bound twice: ' + id, it.id, dupes.get(id));
            dupes.set(id, it.id);
        });
    });
    menus.forEach(m => walk(m.items));
    check('every chord is unique', true, true);
}

console.log('Firefox - keeps Ctrl+Shift+N, so nothing moves there');
{
    const { menus, ui } = load(FIREFOX);
    const moved = ui.remappedAccels.map(m => m.id);
    check('Ctrl+Shift+N untouched', moved.includes('idFileNewEmpty'), false);
    check('Ctrl+W still stolen', moved.includes('idFileClose'), true);
    check('Ctrl+Shift+N makes a new file', press(ui, menus, 'N', 'cs'), 'idFileNewEmpty');
}

console.log(`\n${failed ? failed + ' failed' : 'all accelerator checks passed'}`);
process.exit(failed ? 1 : 0);
