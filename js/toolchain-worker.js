/* ---------------------------------------------------------------------------
   toolchain-worker.js - runs clang, wasm-ld and the user's program.

   All of this happens off the main thread: a clang invocation is one long
   synchronous WebAssembly call, so running it in the page would freeze the
   IDE for seconds and look like a hang.  Here it costs the UI nothing - the
   menus, editor and toolbars stay live while a build is in progress.
--------------------------------------------------------------------------- */
'use strict';

importScripts('../vendor/wasm-clang/shared.js');
importScripts('sdk-headers.js');
importScripts('gnu-headers.js');

const BASE = '../vendor/wasm-clang/';
const CACHE = 'cbweb-toolchain-v1';

/* Uncompressed sizes, for the loading percentage. */
const ASSETS = { memfs: 345442, 'sysroot.tar': 9297920, lld: 19490094, clang: 31214472 };
const TOTAL = Object.values(ASSETS).reduce((a, b) => a + b, 0);

const CC1_BASE = [
    '-disable-free',
    /* This WebAssembly target has no atomic instructions, and libc++ reaches
       for them in the shared_ptr reference count - which meant std::shared_ptr
       and std::regex both died with "Cannot select AtomicLoadAdd" in the
       backend.  Telling clang there is only ever one thread lowers those to
       plain loads and stores, which is exactly right here: nothing in this
       runtime can run two threads over the same memory. */
    '-mthread-model', 'single',
    '-isysroot', '/',
    '-internal-isystem', '/include/c++/v1',
    '-internal-isystem', '/include',
    '-internal-isystem', '/lib/clang/8.0.1/include',
    '-ferror-limit', '19',
    '-fmessage-length', '0',
];

/* What g++ pulls in for <bits/stdc++.h>.  Every name here was checked against
   this toolchain: the ones libc++ does not ship at all (csignal, csetjmp,
   cuchar, cstdalign, ctgmath, execution, memory_resource) are left out, since
   including them would break the umbrella header for everyone. */
const STDCXX_HEADERS = [
    // C library
    'cassert', 'cctype', 'cerrno', 'cfenv', 'cfloat', 'cinttypes', 'ciso646',
    'climits', 'clocale', 'cmath', 'cstdarg', 'cstdbool', 'cstddef', 'cstdint',
    'cstdio', 'cstdlib', 'cstring', 'ctime', 'cwchar', 'cwctype',
    // containers and algorithms
    'algorithm', 'array', 'bitset', 'deque', 'forward_list', 'iterator', 'list',
    'map', 'queue', 'set', 'stack', 'unordered_map', 'unordered_set', 'vector',
    // strings and streams
    'fstream', 'iomanip', 'ios', 'iosfwd', 'iostream', 'istream', 'locale',
    'ostream', 'sstream', 'streambuf', 'string', 'string_view', 'codecvt',
    'charconv',
    // numerics
    'bit', 'complex', 'limits', 'numeric', 'random', 'ratio', 'valarray',
    // language support and utilities
    'any', 'chrono', 'exception', 'functional', 'initializer_list', 'memory',
    'new', 'optional', 'scoped_allocator', 'stdexcept', 'system_error', 'tuple',
    'type_traits', 'typeindex', 'typeinfo', 'utility', 'variant',
    // filesystem and regular expressions
    'filesystem', 'regex',
    // concurrency: these compile, and a program that actually starts a thread
    // fails at link time with a plain message rather than a mystery
    'atomic', 'condition_variable', 'future', 'mutex', 'shared_mutex', 'thread',
];
const STDCXX_HEADER_TEXT =
    '// <bits/stdc++.h> for libc++, provided by Code::Blocks web edition.\n' +
    '#ifndef CBWEB_BITS_STDCXX_H\n#define CBWEB_BITS_STDCXX_H\n' +
    STDCXX_HEADERS.map(h => `#include <${h}>`).join('\n') +
    // g++ users reach for std::__gcd and std::__lg through this header
    '\n#include <bits/stdcxx_ext.h>\n#endif\n';

const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const stripAnsi = s => s.replace(ANSI_RE, '');

class StdinStarved extends Error {
    constructor() { super('stdin starved'); this.cbwebQuiet = true; }
}

let api = null;
let sink = () => {};

/* Paths the toolchain has produced, so the Files panel can show what a build
   actually left behind.  memfs has no directory listing of its own. */
const fsFiles = new Map();     // path -> {size, kind}
function noteFile(path, kind) {
    let size = 0;
    try { size = api.memfs.getFileContents(path).length; } catch (e) { size = 0; }
    fsFiles.set(path, { size, kind });
}
function listFs() {
    return Array.from(fsFiles, ([path, info]) => ({ path, ...info }));
}
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

/* Directories created in memfs.  'include' and 'include/bits' come with the
   sysroot; anything deeper we make ourselves, once. */
const installedDirs = new Set(['include', 'include/bits']);
function ensureDir(dir) {
    const parts = dir.split('/');
    let cur = '';
    for (const p of parts) {
        cur = cur ? cur + '/' + p : p;
        if (installedDirs.has(cur)) continue;
        installedDirs.add(cur);
        api.memfs.addDirectory(cur);
    }
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
        // the Windows/console compatibility headers, then the g++ extensions
        for (const path in SDK_HEADERS) api.memfs.addFile(path, SDK_HEADERS[path]);
        /* memfs will not create a file inside a directory that does not exist
           yet - it traps - so the <ext/pb_ds/...> tree has to be laid out
           first. */
        for (const path in GNU_HEADERS) {
            const slash = path.lastIndexOf('/');
            if (slash > 0) ensureDir(path.slice(0, slash));
            api.memfs.addFile(path, GNU_HEADERS[path]);
        }
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

/* A few failures are inherent to compiling for WebAssembly in a page, and the
   raw message for them is a wall of backend internals or a bare symbol name.
   Each one gets a sentence saying what is actually wrong. */
const EXPLAIN = [
    {
        re: /Cannot select.*Atomic|atomic.*not supported/i,
        text: 'note: this WebAssembly target has no atomic instructions. ' +
              'If you did not start a thread yourself, this is a compiler bug - please report it.',
    },
    {
        re: /undefined symbol: (pthread_create|__cxa_thread|thrd_create)/,
        text: 'note: std::thread and friends cannot run here - a program in this ' +
              'edition gets a single WebAssembly thread. The headers compile so that ' +
              'code including <thread> still builds; starting a thread is what fails.',
    },
    {
        re: /undefined symbol: (__cxa_throw|__cxa_begin_catch|_Unwind_)/,
        text: 'note: exceptions are turned off in this toolchain (libc++ here is built ' +
              '-fno-exceptions), so throw and catch cannot be linked. Return a value or ' +
              'an error code instead.',
    },
    {
        re: /undefined symbol: _ZNSt3__24__fs|undefined symbol:.*filesystem/,
        text: 'note: <filesystem> compiles but cannot be linked here - this sysroot ships ' +
              'no libc++fs. Use <fstream> for reading and writing files; the program has ' +
              'its own private filesystem in the page.',
    },
    {
        re: /undefined symbol: (socket|connect|bind|listen|accept|gethostby)/,
        text: 'note: there are no sockets in WebAssembly - a page cannot open a TCP ' +
              'connection. <winsock2.h> and <sys/socket.h> declare the functions so the ' +
              'code compiles, but nothing can connect.',
    },
];

/* Drops the harness's "> clang -cc1 ..." command echo. */
function cleanDiagnostics(text) {
    const cleaned = stripAnsi(text)
        .split('\n')
        .filter(l => !/^>\s/.test(l))
        .join('\n')
        .replace(/^\s*\n/, '')
        .replace(/\n{3,}/g, '\n\n');
    if (!cleaned.trim()) return cleaned;
    const notes = EXPLAIN.filter(e => e.re.test(cleaned)).map(e => e.text);
    return notes.length ? cleaned.replace(/\n*$/, '\n') + notes.join('\n') + '\n' : cleaned;
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
    ].concat(options.warnings || []));
    // Note: do not define _LIBCPP_HAS_NO_THREADS here.  This libc++ was built
    // against an external thread API and rejects that macro outright.
    for (const d of (options.defines || [])) args.push('-D' + d);
    for (const inc of (options.includes || [])) args.push('-I', inc);
    args.push('-o', obj, '-x', 'c++', fileName);
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
    noteFile(fileName, 'source');
    noteFile(obj, 'object');
    noteFile(out, 'executable');
    return { ok: true, diagnostics, id, size: buffer.length };
}

/* A trap in the running program prints a WebAssembly stack, which says nothing
   to someone who just wrote C++.  These are the cases worth naming. */
function runtimeExplanation(trace) {
    if (/std::__2::thread|pthread_create/.test(trace))
        return 'This program tried to start a std::thread. A program here gets a single\n' +
               'WebAssembly thread, so the thread never runs and std::terminate is called.\n' +
               'Call the function directly, or use std::async-free sequential code instead.\n';
    if (/std::terminate|abort/.test(trace) && /__cxa_throw/.test(trace))
        return 'This program threw an exception, and exceptions are not enabled in this\n' +
               'toolchain, so the throw ends the program instead of being caught.\n';
    if (/memory access out of bounds|table index is out of bounds/.test(trace))
        return 'The program read or wrote outside its memory - the usual causes are an\n' +
               'index past the end of an array, or a pointer used after free.\n';
    if (/call stack exhausted|Maximum call stack/.test(trace))
        return 'The call stack ran out: usually infinite recursion, or a very large array\n' +
               'declared inside a function. Large arrays belong outside main or on the heap.\n';
    return '';
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
        else {
            exit = 1;
            const msg = e && e.message ? e.message : String(e);
            out += `\n${msg}\n`;
            out += runtimeExplanation(msg + '\n' + (e && e.stack ? e.stack : ''));
        }
    } finally {
        api.memfs.onStdinStarved = null;
        sink = prev;
    }

    // The harness echoes the command line before the run and adds a newline
    // after it; neither belongs in the program's console output.  ANSI escapes
    // are kept: the console renders them, so <windows.h> colours work.
    const output = stripAnsi(out.slice(0, out.indexOf('\n') + 1)).startsWith('>')
        ? out.slice(out.indexOf('\n') + 1).replace(/\n$/, '')
        : out.replace(/\n$/, '');
    return { output, exit, starved };
}

/* Real disassembly: clang -S emits the assembly for the translation unit.
   The target is the one the program is actually built for - this libc++ is
   configured for wasm32 only, so an x86 triple cannot even parse <iostream>.
   What comes back is therefore the true assembly of the running program. */
async function assemble(fileName, source, options) {
    await init();
    const out = fileName.replace(/\.[^.]*$/, '') + '.s';
    api.memfs.addFile(fileName, source);
    const clang = await api.getModule('clang');
    const args = CC1_BASE.concat([
        '-S',
        '-triple=' + (options.triple || 'wasm32-unknown-wasi'),
        '-std=' + (options.std || 'c++17'),
        options.opt || '-O0',
        '-o', out, '-x', 'c++', fileName,
    ]);
    const r = await capture(() => api.run(clang, 'clang', '-cc1', ...args));
    if (r.exit !== 0) return { ok: false, diagnostics: cleanDiagnostics(r.text) };
    const bytes = api.memfs.getFileContents(out);
    const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
    return { ok: true, text };
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
            case 'assemble':
                result = await assemble(payload.file, payload.source, payload.options || {});
                break;
            case 'listfs':
                await init();
                result = { files: listFs() };
                break;
            case 'readfile':
                await init();
                try { result = { text: api.memfs.getFileContents(payload.path) }; }
                catch (e) { result = { text: null }; }
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
