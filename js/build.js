/* ---------------------------------------------------------------------------
   build.js - the compiler plugin: Build / Run / Build and run / Rebuild /
   Abort, the build logs, and the process runner that drives the program from
   the floating console window.  Also hosts the debugger session.

   The compiler is a real clang/libc++ toolchain compiled to WebAssembly and
   served from this site (see toolchain.js) - no server, no third party.  The
   small interpreter in cpp.js is used only by the debugger, which has to
   single step through statements.
--------------------------------------------------------------------------- */
'use strict';

const Build = {
    running: false,
    process: null,
    lastBuild: null,          // {source, exe, target, file}
    errors: [],
    startTime: 0,
    usedFallback: false,
};

function minSecStr(ms) {
    const elapsed = Math.floor(ms / 1000);
    return `${Math.floor(elapsed / 60)} minute(s), ${elapsed % 60} second(s)`;
}

Build.log = function (text, cls) { App.logAppend('build', text, cls); };

Build.clearMessages = function () {
    Build.errors = [];
    App.buildMessagesClear();
    App.setBuildErrors([]);          // and the red marks from the last build
};

/* Which function a line belongs to, printed the way gcc prints it:
   "In function 'void sangnt(int)':".  Walks braces from the top so a line
   inside a nested block still resolves to the function that opened it. */
Build.functionAt = function (source, line) {
    const lines = source.split('\n');
    /* The opening brace may sit on the next line - which is how the desktop's
       own sample code is written - so the signature is remembered until a
       brace actually opens a body. */
    const sigRe = /^[ \t]*(?:(?:inline|static|const|constexpr|virtual|explicit|extern)\s+)*([A-Za-z_][\w:<>,\s*&]*?)\s+([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?)\s*\(([^;{)]*)\)\s*(?:const\s*)?(?:noexcept\s*)?\{?\s*$/;
    let depth = 0, current = null, pending = null;
    for (let i = 0; i < lines.length && i < line; i++) {
        // comments and literals must not contribute braces
        const text = lines[i]
            .replace(/\/\/.*$/, '')
            .replace(/"(\\.|[^"\\])*"/g, '""')
            .replace(/'(\\.|[^'\\])*'/g, "''");
        if (depth === 0) {
            const m = sigRe.exec(text);
            if (m && !/^(if|for|while|switch|catch|else|do|return|sizeof)$/.test(m[2])) {
                const ret = m[1].trim().replace(/\s+/g, ' ');
                // gcc prints the parameter types without their names
                const args = m[3].split(',').map(a => a.trim().replace(/\s+/g, ' ')
                        .replace(/\s+[A-Za-z_]\w*\s*(\[\s*\])?$/, '$1'))
                    .filter(Boolean).join(', ');
                pending = `${ret} ${m[2]}(${args})`;
            } else if (text.trim() && text.indexOf('{') < 0) {
                pending = null;          // something else came between
            }
        }
        for (const ch of text) {
            if (ch === '{') { if (depth === 0 && pending) { current = pending; pending = null; } depth++; }
            else if (ch === '}') { depth--; if (depth <= 0) { depth = 0; current = null; } }
        }
    }
    return current;
};

Build.addMessage = function (file, line, message, type) {
    Build.errors.push({ file, line, message, type });
    App.buildMessagesAdd(file, line, message, type);
};

/* ----------------------------------------------------------------- build */

Build.doBuild = async function (options) {
    options = options || {};
    if (Build.running) return false;
    const file = App.activeSourceFile();
    if (!file) {
        await UI.messageBox('You need to open a source file first.', 'Code::Blocks', ['OK'], '⚠️');
        return false;
    }
    App.saveAll(true);

    const target = App.activeTarget;
    const project = App.activeProject;
    Build.running = true;
    Build.startTime = Date.now();
    UI.enableTool('idCompilerMenuKillProcess', true);
    App.selectLogTab('build');
    Build.clearMessages();

    const projName = project ? project.name : file.name;
    const banner = `Build: ${target} in ${projName} (compiler: GNU GCC Compiler)`;
    Build.log('-------------- ' + banner + '---------------\n\n');
    Build.addMessage('', '', '=== ' + banner + ' ===', 'info');

    /* The wizard can give each configuration its own output directories; when
       it has, the build writes where the project says. */
    const dirs = (project && project.outputDirs && project.outputDirs[target]) || null;
    const slash = d => d.replace(/[\\/]*$/, '\\');
    const objDir = dirs && dirs.obj ? slash(dirs.obj) : `obj\\${target}\\`;
    const binDir = dirs && dirs.out ? slash(dirs.out) : `bin\\${target}\\`;
    const base = file.name.replace(/\.[^.]*$/, '');
    // the executable is named after the source file, as it is when you build a
    // single file in Code::Blocks (14.cpp -> 14.exe)
    const exeName = base + '.exe';
    const exe = `${binDir}${exeName}`;
    const bo = App.buildOptions || {};
    const opt = target === 'Debug' ? (bo.optDebug || '-O0') : (bo.optRelease || '-O2');
    // a .c file is a C translation unit, and the log says gcc like the desktop
    const isC = /\.c$/i.test(file.name);
    const cc = isC ? 'gcc.exe' : 'g++.exe';
    const std = isC ? (bo.cstd || 'c11') : (bo.std || 'c++17');
    const warnings = [bo.wall !== false ? '-Wall' : '', bo.wextra ? '-Wextra' : '',
                      bo.pedantic ? '-pedantic' : ''].filter(Boolean);
    const defines = (bo.defines || '').split(/\s+/).filter(Boolean);
    const flags = [...warnings, target === 'Debug' ? '-g' : '', opt,
                   ...defines.map(d => '-D' + d)].filter(Boolean).join(' ');
    const source = file.text();

    if (!Toolchain.loaded)
        Build.log('Loading the C++ toolchain (clang + libc++); this happens once...\n');

    Build.log(`${cc} ${flags} -std=${std}  -c ${App.projectPath}\\${file.name} -o ${objDir}${base}.o\n`);

    let errorCount = 0, warningCount = 0, ok = false, built = null;

    try {
        if (Build.lastBuild && Build.lastBuild.id) Toolchain.release(Build.lastBuild.id);
        built = await Toolchain.build(file.name, source, {
            opt, std,
            defines,
            warnings: warnings.filter(w => w !== '-Wall'),
        });
        const raw = built.diagnostics || '';
        if (raw.trim()) Build.log(raw.replace(/\n?$/, '\n'), built.ok ? 'warn' : 'err');

        /* The Build messages grid the desktop shows: the full path, the line,
           and the message - grouped under the function the error is in, the
           way gcc reports it. */
        const diags = Toolchain.parseDiagnostics(raw, file.name);
        const fullPath = `${App.projectPath}\\${file.name}`;
        let lastFunc = null;
        for (const d of diags) {
            if (d.kind === 'note') continue;
            if (d.kind === 'warning') warningCount++; else errorCount++;
            const fn = d.line ? Build.functionAt(source, d.line) : null;
            if (fn && fn !== lastFunc) {
                Build.addMessage(fullPath, '', `In function '${fn}':`, 'info');
                lastFunc = fn;
            }
            Build.addMessage(fullPath, d.line ? String(d.line) : '',
                             `${d.kind}: ${d.message}`,
                             d.kind === 'warning' ? 'warning' : 'error');
        }
        // red boxes in the margin, on the lines the compiler named
        App.setBuildErrors(diags.filter(d => d.kind !== 'note')
                                .map(d => ({ file: file.name, line: d.line, kind: d.kind })));
        if (!built.ok && errorCount === 0) errorCount = 1;
        ok = built.ok && errorCount === 0;
    } catch (e) {
        errorCount = 1;
        Build.log(`${cc}: internal error: ${e.message}\n`, 'err');
        Build.addMessage(file.name, '', 'error: ' + e.message, 'error');
    }

    if (ok) {
        Build.log(`${cc}  -o ${exe} ${objDir}${base}.o\n`);
        Build.log(`Output file is ${exe} with size ${(built.size / 1024).toFixed(2)} KB\n`);
        Build.lastBuild = { source, exe, exeName, target, file, flags, id: built.id };
        // let the Files panel show what the build produced
        Toolchain.listFiles().then(r => {
            App.buildArtifacts = r.files || [];
            App.refreshTrees();
        }).catch(() => {});
    } else {
        Build.lastBuild = null;
    }

    const elapsed = Date.now() - Build.startTime;
    Build.log(`Process terminated with status ${errorCount ? 1 : 0} (${minSecStr(elapsed)})\n`,
              errorCount ? 'err' : 'warn');
    const summary = `${errorCount} error(s), ${warningCount} warning(s) (${minSecStr(elapsed)})`;
    Build.log(summary + '\n', errorCount ? 'err' : 'warn');
    Build.addMessage('', '', `=== Build ${errorCount ? 'failed' : 'finished'}: ${summary} ===`, 'info');
    Build.log(' \n');

    Build.running = false;
    UI.enableTool('idCompilerMenuKillProcess', false);
    App.updateStatusBar();

    if (errorCount && !options.quiet) App.selectLogTab('messages');
    return ok;
};

Build.doRebuild = async function () {
    const name = App.activeProject ? App.activeProject.name : 'project';
    App.selectLogTab('build');
    Build.log(`Cleaning "${name}" (${App.activeTarget})...\n`);
    Build.log(`Cleaned "${name} - ${App.activeTarget}"\n\n`);
    return Build.doBuild();
};

Build.doClean = async function () {
    const name = App.activeProject ? App.activeProject.name : 'project';
    App.selectLogTab('build');
    Build.log(`Cleaning "${name}" (${App.activeTarget})...\n`);
    Build.log(`Cleaned "${name} - ${App.activeTarget}"\n\n`);
    Build.lastBuild = null;
};

/* ------------------------------------------------------------------- run */

Build.doRun = async function () {
    if (Build.process) {
        await UI.messageBox('The program is already running.', 'Code::Blocks', ['OK'], '⚠️');
        return;
    }
    if (!Build.lastBuild) {
        const answer = await UI.messageBox(
            'The project has not been built yet.\nDo you want to build it now?',
            'Information', ['Yes', 'No'], 'ℹ️');
        if (answer !== 'Yes') return;
        if (!await Build.doBuild()) return;
    }
    await Build.launch(Build.lastBuild, null);
};

Build.doBuildAndRun = async function () {
    if (await Build.doBuild()) await Build.launch(Build.lastBuild, null);
};

Build.abort = function () {
    if (Build.process) Build.process.abort = true;
    Build.running = false;
    UI.enableTool('idCompilerMenuKillProcess', false);
};

/* Runs a built program.  `debug` is the Debugger session, or null. */
Build.launch = async function (built, debug) {
    const title = `${App.projectPath}\\${built.exe}`;
    const con = new ProgramConsole(title);
    const proc = { abort: false, con, debug };
    Build.process = proc;
    con.onTerminate = () => { proc.abort = true; };

    UI.enableTool('idCompilerMenuKillProcess', true);
    App.updateStatusBar();

    const started = performance.now();
    let exitCode = 0;

    if (debug) {
        // stepping needs the statement-level engine
        exitCode = await Build.runStepping(built, con, proc, debug);
    } else {
        exitCode = await Toolchain.runInteractive(built, con,
                                                  { isAborted: () => proc.abort });
        if (proc.abort) exitCode = -1073741510;
    }

    const secs = (performance.now() - started) / 1000;
    if (debug) debug.finished(exitCode, secs);
    if (!con.closed) await con.finish(exitCode, secs);
    Build.process = null;
    UI.enableTool('idCompilerMenuKillProcess', false);
    App.updateStatusBar();
};

/* The statement-stepping engine, used only while debugging.  clang gives us a
   wasm module, which cannot be paused mid-statement, so breakpoints and single
   stepping run against the interpreter in cpp.js instead. */
Build.runStepping = async function (built, con, proc, debug) {
    let program = Build.steppingProgram;
    if (!program || Build.steppingSource !== built.source) {
        const res = CPP.compile(built.source, built.file.name);
        if (!res.ok) {
            const d = res.diagnostics[0];
            con.write(`Cannot single step through this program with the built-in debugger:\n` +
                      `  ${built.file.name}:${d ? d.line : 0}: ${d ? d.message : 'unsupported construct'}\n` +
                      `Run it without the debugger (F9) to use the full clang toolchain.\n`);
            return 1;
        }
        program = res.program;
        Build.steppingProgram = program;
        Build.steppingSource = built.source;
    }

    const io = { write: s => con.write(s), writeErr: s => con.write(s) };
    let cp;
    try {
        cp = CPP.createProcess(program, io);
    } catch (e) {
        con.write('runtime error: ' + e.message + '\n');
        return 1;
    }
    proc.cp = cp;
    if (debug) debug.attach(cp, proc);

    let sendValue;
    let budget = performance.now();
    try {
        for (;;) {
            if (proc.abort) throw new CPP.RuntimeError('aborted', 0);
            const step = cp.gen.next(sendValue);
            sendValue = undefined;
            if (step.done) return typeof step.value === 'number' ? step.value : 0;

            const y = step.value;
            if (y.t === 'input') {
                if (debug) debug.setState('running');
                sendValue = await con.readLine();
                budget = performance.now();
                continue;
            }
            if (y.t === 'stmt' && debug) {
                const action = await debug.onLine(y.line, cp.interp);
                if (action === 'abort') { proc.abort = true; continue; }
            }
            if (performance.now() - budget > 12) {
                await new Promise(r => setTimeout(r, 0));
                budget = performance.now();
            }
        }
    } catch (e) {
        if (e instanceof CPP.ExitSignal) return e.code;
        if (e && e.message === 'aborted') return -1073741510;
        const where = e.line ? ` (line ${e.line})` : '';
        con.write(`\nterminate called after throwing an instance of 'std::runtime_error'\n` +
                  `  what():  ${e.message}${where}\n`);
        return 3;
    }
};

/* -------------------------------------------------------------- debugger */

const Debugger = {
    active: false,
    breakpoints: new Map(),
    state: 'idle',
    mode: 'go',
    resume: null,
    currentLine: 0,
    interp: null,
};

Debugger.toggleBreakpoint = function (fileName, line) {
    if (!Debugger.breakpoints.has(fileName)) Debugger.breakpoints.set(fileName, new Set());
    const set = Debugger.breakpoints.get(fileName);
    if (set.has(line)) set.delete(line); else set.add(line);
    return set.has(line);
};
Debugger.hasBreakpoint = function (fileName, line) {
    const s = Debugger.breakpoints.get(fileName);
    return !!(s && s.has(line));
};
Debugger.removeAll = function () {
    Debugger.breakpoints.clear();
    App.refreshBreakpoints();
};

Debugger.start = async function () {
    if (Debugger.active) { Debugger.cont(); return; }
    if (!Build.lastBuild && !await Build.doBuild()) return;

    Debugger.active = true;
    Debugger.mode = 'go';
    Debugger.state = 'running';
    App.selectLogTab('debugger');
    App.logAppend('debugger', 'Building to ensure sources are up-to-date\n');
    App.logAppend('debugger', `Selecting target: ${App.activeTarget}\n`);
    App.logAppend('debugger', `Adding source dir: ${App.projectPath}\\\n`);
    App.logAppend('debugger', `Adding file: ${App.projectPath}\\${Build.lastBuild.exe}\n`);
    App.logAppend('debugger', 'Changing directory to: ' + App.projectPath.replace(/\\/g, '/') + '\n');
    App.updateDebugUI();

    await Build.launch(Build.lastBuild, Debugger);

    Debugger.active = false;
    Debugger.state = 'idle';
    App.clearDebugLine();
    App.updateDebugUI();
};

Debugger.attach = function (cp, proc) {
    Debugger.interp = cp.interp;
    Debugger.proc = proc;
};
Debugger.setState = function (s) { Debugger.state = s; };

Debugger.onLine = async function (line, interp) {
    if (!Debugger.active) return null;
    const file = Build.lastBuild.file.name;
    const shouldStop = Debugger.mode === 'step' ||
                       (Debugger.mode === 'stepOver' && interp.callDepth <= Debugger.stepDepth) ||
                       Debugger.hasBreakpoint(file, line);
    if (!shouldStop) return null;

    Debugger.state = 'paused';
    Debugger.currentLine = line;
    Debugger.interp = interp;
    Debugger.scope = interp.currentScope;      // for Watches and Examine memory
    App.showDebugLine(line);
    App.updateDebugUI();
    App.updateWatches(interp);

    const action = await new Promise(r => { Debugger.resume = r; });
    Debugger.resume = null;
    Debugger.state = 'running';
    App.clearDebugLine();
    App.updateDebugUI();
    return action;
};

Debugger.cont = function () { Debugger.mode = 'go'; if (Debugger.resume) Debugger.resume(null); };
Debugger.next = function () {
    Debugger.mode = 'stepOver';
    Debugger.stepDepth = Debugger.interp ? Debugger.interp.callDepth : 0;
    if (Debugger.resume) Debugger.resume(null);
};
Debugger.stepInto = function () { Debugger.mode = 'step'; if (Debugger.resume) Debugger.resume(null); };
Debugger.stepOut = function () {
    Debugger.mode = 'stepOver';
    Debugger.stepDepth = Math.max(0, (Debugger.interp ? Debugger.interp.callDepth : 1) - 1);
    if (Debugger.resume) Debugger.resume(null);
};
Debugger.stop = function () {
    Debugger.mode = 'go';
    Debugger.active = false;
    if (Debugger.resume) Debugger.resume('abort');
    else if (Build.process) Build.process.abort = true;
};
Debugger.finished = function (code) {
    App.logAppend('debugger', `Debugger finished with status ${code}\n`);
};
