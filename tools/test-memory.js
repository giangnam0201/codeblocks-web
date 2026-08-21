/* ---------------------------------------------------------------------------
   test-memory.js - the Memory helper in vendor/wasm-clang/shared.js, against
   both ways an engine can grow a WebAssembly memory.

   Chrome detaches the old ArrayBuffer when memory.grow() is called, so its
   byteLength becomes 0 and the original "did it detach?" test noticed.
   Firefox hands back a different ArrayBuffer and leaves the old one alive at
   its old length, so that test saw nothing, the cached views stayed small, and
   the next copy threw "invalid or out-of-range index" - which is what a build
   with a large object file did there.

       node tools/test-memory.js
--------------------------------------------------------------------------- */
'use strict';

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'vendor', 'wasm-clang', 'shared.js'), 'utf8');
const classSrc = src.match(/class Memory \{[\s\S]*?\n\}/)[0];   // up to its own closing brace
const Memory = eval('(' + classSrc + ')');

const PAGE = 65536;

/* Chrome: grow() detaches the old buffer. */
function chromeMemory(pages) {
    let buffer = new ArrayBuffer(pages * PAGE);
    return {
        get buffer() { return buffer; },
        grow(n) {
            const bigger = new ArrayBuffer(buffer.byteLength + n * PAGE);
            new Uint8Array(bigger).set(new Uint8Array(buffer));
            Object.defineProperty(buffer, 'byteLength', { value: 0 });  // detached
            buffer = bigger;
        },
    };
}

/* Firefox: grow() returns a different buffer, the old one stays usable. */
function firefoxMemory(pages) {
    let buffer = new ArrayBuffer(pages * PAGE);
    return {
        get buffer() { return buffer; },
        grow(n) {
            const bigger = new ArrayBuffer(buffer.byteLength + n * PAGE);
            new Uint8Array(bigger).set(new Uint8Array(buffer));
            buffer = bigger;                       // old buffer left alone
        },
    };
}

let failed = 0;
function check(name, got, want) {
    if (got === want) { console.log('  ok    ' + name); return; }
    failed++;
    console.log(`  FAIL  ${name}: got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);
}

for (const [engine, make] of [['chrome', chromeMemory], ['firefox', firefoxMemory]]) {
    console.log(engine + '-style memory growth');
    const raw = make(1);                       // 64 KB
    const mem = new Memory(raw);

    check('starts at one page', mem.memory.buffer.byteLength, PAGE);

    // the module grows its own memory, as memfs does when a file arrives
    raw.grow(4);
    mem.check();
    check('check() picks up the new size', mem.u8.length, 5 * PAGE);

    // a view over ground that only exists after the growth
    let ok = true;
    try { mem.view(4 * PAGE, 1000); } catch (e) { ok = false; }
    check('view() reaches the grown region', ok, true);

    // writing past the end grows to fit rather than throwing
    const v = mem.fitView(6 * PAGE, 1000);
    v[0] = 42;
    check('fitView() grew the memory', mem.memory.buffer.byteLength >= 6 * PAGE + 1000, true);
    check('fitView() wrote into it', new Uint8Array(mem.memory.buffer)[6 * PAGE], 42);

    // and a genuinely impossible request still reports itself clearly
    let message = '';
    const stuck = { buffer: new ArrayBuffer(PAGE), grow() { throw new RangeError('cannot grow'); } };
    try { new Memory(stuck).fitView(10 * PAGE, 16); } catch (e) { message = e.message; }
    check('a memory that cannot grow says so', /requested from a \d+ byte memory/.test(message), true);
}

console.log(failed ? `\n${failed} failed` : '\nall memory checks passed');
process.exit(failed ? 1 : 0);
