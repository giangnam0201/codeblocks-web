/* ---------------------------------------------------------------------------
   toolchain-worker.js - runs clang, wasm-ld and the user's program.

   All of this happens off the main thread: a clang invocation is one long
   synchronous WebAssembly call, so running it in the page would freeze the
   IDE for seconds and look like a hang.  Here it costs the UI nothing - the
   menus, editor and toolbars stay live while a build is in progress.
--------------------------------------------------------------------------- */
'use strict';

importScripts('../vendor/wasm-clang/shared.js');

const BASE = '../vendor/wasm-clang/';
const CACHE = 'cbweb-toolchain-v1';

/* Uncompressed sizes, for the loading percentage. */
const ASSETS = { memfs: 345442, 'sysroot.tar': 9297920, lld: 19490094, clang: 31214472 };
const TOTAL = Object.values(ASSETS).reduce((a, b) => a + b, 0);

const CC1_BASE = [
    '-disable-free',
    '-isysroot', '/',
    '-internal-isystem', '/include/c++/v1',
    '-internal-isystem', '/include',
    '-internal-isystem', '/lib/clang/8.0.1/include',
    '-ferror-limit', '19',
    '-fmessage-length', '0',
];

const STDCXX_HEADERS = [
    'cstdio', 'cstdlib', 'cstring', 'cctype', 'cmath', 'ctime', 'cassert', 'cerrno',
    'climits', 'cfloat', 'cstdint', 'cstddef', 'cstdarg', 'cwchar', 'cwctype',
    'clocale', 'cinttypes',
    'algorithm', 'array', 'bitset', 'complex', 'deque', 'exception', 'forward_list',
    'fstream', 'functional', 'initializer_list', 'iomanip', 'ios', 'iosfwd',
    'iostream', 'istream', 'iterator', 'limits', 'list', 'locale', 'map', 'memory',
    'new', 'numeric', 'ostream', 'queue', 'random', 'ratio', 'set', 'sstream',
    'stack', 'stdexcept', 'streambuf', 'string', 'string_view', 'system_error',
    'tuple', 'type_traits', 'typeindex', 'typeinfo', 'unordered_map',
    'unordered_set', 'utility', 'valarray', 'vector',
];
const STDCXX_HEADER_TEXT =
    '// <bits/stdc++.h> for libc++, provided by Code::Blocks web edition.\n' +
    '#ifndef CBWEB_BITS_STDCXX_H\n#define CBWEB_BITS_STDCXX_H\n' +
    STDCXX_HEADERS.map(h => `#include <${h}>`).join('\n') + '\n#endif\n';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = s => s.replace(ANSI_RE, '');

class StdinStarved extends Error {
    constructor() { super('stdin starved'); this.cbwebQuiet = true; }
}

let api = null;
let sink = () => {};
let doneBytes = 0;
const modules = new Map();          // build id -> linked WebAssembly.Module
let nextModuleId = 1;

function post(msg) { self.postMessage(msg); }

async function fetchAsset(name) {
    const url = BASE + name;
    let response = null;
    if (self.caches) {
        try {
            const cache = await caches.open(CACHE);
            const hit = await cache.match(url);
            if (hit) {
                doneBytes += ASSETS[name] || 0;
                post({ type: 'progress', pct: Math.min(99, Math.round(doneBytes / TOTAL * 100)), name, cached: true });
                return hit.arrayBuffer();
            }
            response = await fetch(url);
            if (!response.ok) throw new Error(`cannot read ${name} (HTTP ${response.status})`);
            await cache.put(url, response.clone());
        } catch (e) {
            if (!response) response = await fetch(url);
        }
    } else {
        response = await fetch(url);
    }
    if (!response.ok) throw new Error(`cannot read ${name} (HTTP ${response.status})`);

    const total = parseInt(response.headers.get('content-length'), 10) || ASSETS[name] || 0;
    if (!response.body || !response.body.getReader) {
        doneBytes += ASSETS[name] || 0;
        return response.arrayBuffer();
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        post({
            type: 'progress', name,
            pct: Math.min(99, Math.round((doneBytes + received) / TOTAL * 100)),
            received, total,
        });
    }
    doneBytes += ASSETS[name] || 0;
    const buf = new Uint8Array(received);
    let at = 0;
    for (const c of chunks) { buf.set(c, at); at += c.length; }
    return buf.buffer;
}

let readyPromise = null;
function init() {
    if (readyPromise) return readyPromise;
    readyPromise = (async () => {
        api = new API({
            hostWrite: s => sink(s),
            readBuffer: fetchAsset,
            compileStreaming: async name => WebAssembly.compile(await fetchAsset(name)),
            clang: 'clang', lld: 'lld', sysroot: 'sysroot.tar', memfs: 'memfs',
        });
        const prev = sink;
        sink = () => {};
        await api.ready;
        api.memfs.addFile('include/bits/stdc++.h', STDCXX_HEADER_TEXT);
        sink = prev;
        return api;
    })();
    return readyPromise;
}

async function capture(fn) {
    let text = '';
    const prev = sink;
    sink = s => { text += s; };
    try {
        await fn();
        return { text, exit: 0 };
    } catch (e) {
        return { text, exit: (e && typeof e.code === 'number') ? e.code : 1, error: e };
    } finally {
        sink = prev;
    }
}

/* Drops the harness's "> clang -cc1 ..." command echo. */
function cleanDiagnostics(text) {
    return stripAnsi(text)
        .split('\n')
        .filter(l => !/^>\s/.test(l))
        .join('\n')
        .replace(/^\s*\n/, '')
        .replace(/\n{3,}/g, '\n\n');
}

async function build(fileName, source, options) {
    await init();
    const obj = fileName.replace(/\.[^.]*$/, '') + '.o';
    const out = fileName.replace(/\.[^.]*$/, '') + '.wasm';
    api.memfs.addFile(fileName, source);

    const clang = await api.getModule('clang');
    const args = CC1_BASE.concat([
        '-emit-obj',
        '-std=' + (options.std || 'c++17'),
        options.opt || '-O0',
        '-Wall',
        '-o', obj, '-x', 'c++', fileName,
    ]);
    const c = await capture(() => api.run(clang, 'clang', '-cc1', ...args));
    if (c.exit !== 0) return { ok: false, diagnostics: cleanDiagnostics(c.text) };

    const libdir = 'lib/wasm32-wasi';
    const rtdir = 'lib/clang/8.0.1/lib/wasi';
    const lld = await api.getModule('lld');
    // --gc-sections drops everything the program does not reach.  Without it
    // (and with --export-dynamic, which pins every symbol) a hello world links
    // the whole of libc++ and comes out tens of megabytes large.
    const l = await capture(() => api.run(
        lld, 'wasm-ld', '--no-threads', '--gc-sections',
        '-z', 'stack-size=1048576',
        `-L${libdir}`, `-L${rtdir}`,
        `${libdir}/crt1.o`, obj,
        '-lc', '-lc++', '-lc++abi', '-lcanvas', '-lclang_rt.builtins-wasm32',
        '-o', out));
    const diagnostics = [cleanDiagnostics(c.text), cleanDiagnostics(l.text)]
        .filter(t => t.trim()).join('\n');
    if (l.exit !== 0) return { ok: false, diagnostics };

    const buffer = api.memfs.getFileContents(out);
    const module = await WebAssembly.compile(buffer);
    const id = nextModuleId++;
    modules.set(id, module);
    return { ok: true, diagnostics, id, size: buffer.length };
}

async function run(id, exeName, stdin, stopOnInput) {
    await init();
    const module = modules.get(id);
    if (!module) throw new Error('no such executable');

    api.memfs.setStdinStr(stdin || '');
    let out = '';
    const prev = sink;
    sink = s => { out += s; };

    let starved = false;
    api.memfs.onStdinStarved = stopOnInput
        ? () => { starved = true; throw new StdinStarved(); }
        : null;

    let exit = 0;
    try {
        await api.run(module, exeName || 'a.exe');
    } catch (e) {
        if (e instanceof StdinStarved) starved = true;
        else if (e && typeof e.code === 'number') exit = e.code;
        else { exit = 1; out += `\n${e && e.message ? e.message : e}\n`; }
    } finally {
        api.memfs.onStdinStarved = null;
        sink = prev;
    }

    // The harness echoes the command line before the run and adds a newline
    // after it; neither belongs in the program's console output.
    const output = stripAnsi(out).replace(/^>[^\n]*\n/, '').replace(/\n$/, '');
    return { output, exit, starved };
}

async function warmup() {
    await init();
    await api.getModule('clang');
    await api.getModule('lld');
    const prev = sink;
    sink = () => {};
    try {
        const r = await build('__warmup.cpp', '#include <iostream>\nint main(){return 0;}\n',
                              { opt: '-O0', std: 'c++17' });
        if (r.ok) {
            await run(r.id, 'a.exe', '', false);
            modules.delete(r.id);
        }
    } catch (e) {
        /* never let a warm-up failure break the IDE */
    } finally {
        sink = prev;
    }
}

self.onmessage = async ev => {
    const { id, type, payload } = ev.data;
    try {
        let result;
        switch (type) {
            case 'preload':
                await warmup();
                result = { ok: true };
                break;
            case 'build':
                result = await build(payload.file, payload.source, payload.options || {});
                break;
            case 'run':
                result = await run(payload.id, payload.exeName, payload.stdin, payload.stopOnInput);
                break;
            case 'release':
                modules.delete(payload.id);
                result = { ok: true };
                break;
            default:
                throw new Error('unknown request: ' + type);
        }
        post({ type: 'result', id, result });
    } catch (e) {
        post({ type: 'result', id, error: e && e.message ? e.message : String(e) });
    }
};
