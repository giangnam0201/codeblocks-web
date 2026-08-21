/* ---------------------------------------------------------------------------
   toolchain.js - main-thread proxy for the compiler.

   The real work (clang -cc1, wasm-ld, and running the produced program) lives
   in js/toolchain-worker.js.  A clang invocation is one multi-second
   synchronous WebAssembly call; keeping it off the main thread is what stops
   the IDE from locking up while it builds.

   vendor/wasm-clang holds clang, wasm-ld and a WASI sysroot with the full
   libc++ (from binji/wasm-clang, Apache-2.0).  Nothing is uploaded anywhere:
   <iostream>, <vector>, <algorithm>, templates - it is a real C++ compiler,
   running locally.

   Interactive stdin:
     The WASI read hook cannot block, so the program is stopped the moment it
     reads past the end of the input we have, the console asks the user for a
     line, and the program is re-run from the start with the longer input.  Its
     earlier output is reproduced byte for byte, so only the new tail is
     printed and the window behaves like an ordinary console.
--------------------------------------------------------------------------- */
'use strict';

const Toolchain = {
    worker: null,
    ready: null,
    warmed: null,
    warm: false,
    loaded: false,
    onStatus: null,
    maxRounds: 500,
    pending: new Map(),
    nextId: 1,
};

Toolchain.start = function () {
    if (Toolchain.worker) return Toolchain.worker;
    /* The worker script is cached far harder than the page: a plain reload can
       leave an old compiler running behind a new IDE.  The stamp changes with
       each deployment, so the two always match. */
    const w = new Worker('js/toolchain-worker.js?v=' + (window.CBWEB_BUILD || '1'));
    w.onmessage = ev => {
        const msg = ev.data;
        if (msg.type === 'progress') {
            if (Toolchain.onStatus) Toolchain.onStatus(msg);
            return;
        }
        if (msg.type === 'result') {
            const p = Toolchain.pending.get(msg.id);
            if (!p) return;
            Toolchain.pending.delete(msg.id);
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg.result);
        }
    };
    w.onerror = e => {
        for (const [, p] of Toolchain.pending) p.reject(new Error(e.message || 'compiler worker failed'));
        Toolchain.pending.clear();
    };
    Toolchain.worker = w;
    return w;
};

Toolchain.call = function (type, payload) {
    const w = Toolchain.start();
    const id = Toolchain.nextId++;
    return new Promise((resolve, reject) => {
        Toolchain.pending.set(id, { resolve, reject });
        w.postMessage({ id, type, payload });
    });
};

/* Downloads, compiles and warms the toolchain in the background so the first
   Build the user asks for is immediate. */
Toolchain.preload = function (onStatus) {
    if (Toolchain.warmed) return Toolchain.warmed;
    Toolchain.onStatus = onStatus || null;
    const t0 = performance.now();
    Toolchain.warmed = Toolchain.call('preload', {}).then(() => {
        Toolchain.warm = true;
        Toolchain.loaded = true;
        const seconds = (performance.now() - t0) / 1000;
        if (Toolchain.onStatus) Toolchain.onStatus({ done: true, pct: 100, seconds });
        return true;
    });
    return Toolchain.warmed;
};

/* Compiles and links one translation unit.
   Returns {ok, diagnostics, id, size}; `id` names the executable. */
Toolchain.build = function (fileName, source, options) {
    return Toolchain.call('build', { file: fileName, source, options: options || {} });
};

/* One execution with a fixed stdin.  `stopOnInput` makes the program stop as
   soon as it reads past the end of `stdin`. */
Toolchain.runOnce = function (id, exeName, stdin, stopOnInput) {
    return Toolchain.call('run', { id, exeName, stdin, stopOnInput });
};

Toolchain.release = function (id) {
    if (id) Toolchain.call('release', { id }).catch(() => {});
};

/* Real assembly for the Disassembly window. */
Toolchain.assemble = function (fileName, source, options) {
    return Toolchain.call('assemble', { file: fileName, source, options: options || {} });
};

/* What the build left in the compiler's file system. */
Toolchain.listFiles = function () { return Toolchain.call('listfs', {}); };
Toolchain.readFile = function (path) { return Toolchain.call('readfile', { path }); };

/* Turns clang diagnostics into records for the Build messages grid. */
Toolchain.parseDiagnostics = function (text, fileName) {
    const out = [];
    if (!text) return out;
    const re = /^([^\s:]+):(\d+):(\d+):\s+(error|warning|note|fatal error):\s+(.*)$/;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        const m = re.exec(line);
        if (m) {
            out.push({
                file: m[1],
                line: parseInt(m[2], 10),
                col: parseInt(m[3], 10),
                kind: m[4] === 'fatal error' ? 'error' : m[4],
                message: m[5],
            });
            continue;
        }
        if (/^wasm-ld:\s+error:|undefined symbol:/.test(line))
            out.push({ file: fileName, line: 0, col: 0, kind: 'error', message: line });
    }
    return out;
};

/* Runs a program against a console window, prompting for input as needed. */
Toolchain.runInteractive = async function (build, con, hooks) {
    let stdin = '';
    let shown = 0;
    let exit = 0;
    const exe = build.exeName || 'a.exe';

    for (let round = 0; round < Toolchain.maxRounds; round++) {
        if (con.closed || (hooks && hooks.isAborted && hooks.isAborted())) break;

        const r = await Toolchain.runOnce(build.id, exe, stdin, true);
        if (con.closed) break;
        exit = r.exit;

        if (r.output.length > shown) con.write(r.output.slice(shown));
        shown = r.output.length;

        if (!r.starved) return exit;

        const line = await con.readLine();
        if (line === null) {
            // end of input: let the program run to completion on EOF
            const fin = await Toolchain.runOnce(build.id, exe, stdin, false);
            if (fin.output.length > shown) con.write(fin.output.slice(shown));
            return fin.exit;
        }
        stdin += line;
    }
    return exit;
};
