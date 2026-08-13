# Code::Blocks for the web

A browser build of the Code::Blocks 25.03 interface that compiles and runs C++
**entirely on your machine** — no server, no compiler service, nothing uploaded.

Everything is static, so it can be served straight from GitHub Pages.

## What it is

The UI is rebuilt from this repository's own resources, so it matches the
desktop IDE rather than resembling it:

| Part | Source it is built from |
| --- | --- |
| Menu bar | `src/src/resources/main_menu.xrc`, `compiler_menu.xrc`, `debugger_menu.xrc` — converted by `tools/gen-menus.js` |
| Toolbars | `main_toolbar.xrc`, `compiler_toolbar.xrc` + the original SVG/PNG icons |
| Editor colours | `src/sdk/resources/lexers/lexer_cpp.xml` (keyword `#0000A0` bold, string `#0000FF`, preprocessor `#00A000`, operator `#FF0000`, …) |
| Status bar | the nine fields of `MainStatusBar::CreateAndFill` in `src/src/main.cpp` |
| Start page | `src/src/resources/start_here/start_here.html` and its images |
| Console footer | `src/tools/ConsoleRunner/main.cpp` (`Process returned … Press any key to continue.`) |

Re-run the menu generator after changing the XRC files:

```sh
node tools/gen-menus.js
```

## The compiler

`vendor/wasm-clang/` contains **clang 8.0.1 (`-cc1`), wasm-ld and a WASI
sysroot with the complete libc++** as WebAssembly, from
[binji/wasm-clang](https://github.com/binji/wasm-clang) (Apache-2.0).

* `<iostream>`, `<string>`, `<vector>`, `<algorithm>`, `<map>`, `<set>`,
  `<sstream>`, templates, lambdas, operator overloading — the real library.
* `<bits/stdc++.h>` is not part of libc++, so the toolchain installs an
  equivalent header into the sysroot at startup.
* Compilation runs in a **Web Worker** (`js/toolchain-worker.js`). A clang
  invocation is one multi-second synchronous WebAssembly call, so running it on
  the page would freeze the IDE; on the worker the interface stays live.
* The toolchain (~60 MB) is downloaded, compiled and warmed up in the
  background while you read the Start page, and kept in the Cache API. After
  the first visit a build takes about a second.

### Interactive input

WASI's read hook cannot block, so the program is stopped the instant it reads
past the end of the input collected so far. The console asks for a line and the
program is re-run from the beginning with the longer input: its earlier output
is reproduced byte for byte, only the new tail is printed, and the window
behaves like an ordinary console. Press **Ctrl+Z** for end-of-input.

### Windows and console headers

libc++ has no Windows SDK, but most Windows-flavoured console code only wants a
handful of things, and those are provided for real in the sysroot:

* `<windows.h>` — types, `Sleep`, `GetTickCount`, `GetLocalTime`,
  `GetStdHandle`, `SetConsoleTextAttribute`, `SetConsoleCursorPosition`,
  `MessageBoxA`, `Beep`, `ExitProcess`. The console understands ANSI escapes,
  so console colours and cursor movement genuinely work.
* `<conio.h>` — `getch`, `getche`, `kbhit`, `clrscr`, `gotoxy`, `textcolor`,
  `textbackground`.
* `<tchar.h>`, `<io.h>`, `<direct.h>`, `<process.h>`.
* `<winsock2.h>`, `<ws2tcpip.h>`, `<wininet.h>`, `<winhttp.h>` — **declarations
  only.** WASI has no sockets and a web page cannot open raw TCP, so these
  compile (with a `#warning`) and every call returns a failure code rather than
  pretending to connect.

### Known limits of this toolchain

* **No exceptions.** The sysroot's `libc++abi.a` was built with
  `-fno-exceptions`, so `try`/`throw` fails at link time.
* **No threads** — `<thread>` compiles but traps at runtime; `<mutex>` works
  as a no-op. They are left out of `<bits/stdc++.h>`.
* **No `<regex>`** — libc++'s regex needs atomics that this clang's wasm
  backend cannot select.
* `<chrono>`, `time()` and `clock()` **do** work: `clock_time_get` is
  implemented in the vendored harness.
* Programs are re-run on each input line, so a program whose output depends on
  the clock or on `rand()` without `srand` may print different values than a
  single continuous run would.

## Files on your disk

Open/Save use Chrome's File System Access API, so you get the real OS dialogs:

* **Ctrl+O** — the system Open dialog; the file is read from disk.
* **Ctrl+S** — writes straight back to the file, with no dialog, once the file
  has a location. New files ask for one the first time.
* **File → Save as…** — the system Save dialog.

Browsers without that API fall back to a file picker and a download.

## Debugging

The Debug button (F8), breakpoints (F5), Next line (F7) and Step into
(Shift+F7) run the program through the small stepping interpreter in
`js/cpp.js`, because a compiled wasm module cannot be paused mid-statement.
It covers ordinary teaching/contest C++; anything it cannot parse is reported,
and F9 still runs the program through the full clang toolchain.

## Publishing to GitHub Pages

```sh
git add cbweb && git commit -m "Code::Blocks web edition"
git push
```

Then point Pages at the branch. `.nojekyll` is included so that the
extension-less files in `vendor/wasm-clang/` are served.

The toolchain is about 60 MB — well under the per-file limit, but if you would
rather keep it out of the repository, delete `vendor/wasm-clang/{clang,lld,memfs,sysroot.tar}`
and fetch them at deploy time:

```sh
for f in clang lld memfs sysroot.tar; do
  curl -L -o "cbweb/vendor/wasm-clang/$f" "https://binji.github.io/wasm-clang/$f"
done
```

Three small, commented changes were made to `vendor/wasm-clang/shared.js`: an
`onStdinStarved` hook in `MemFS.host_read`, one line in `App.run` so our own
control-flow signal unwinds quietly, and an implementation of
`clock_time_get`/`clock_res_get` (upstream throws `NotImplemented`, which is
what made `<chrono>` and `time()` fail). All are marked `cbweb:`.

## Layout

```
index.html                 the main frame
css/cb.css                 wxWidgets/wxAUI look (Windows system colours)
js/menudata.js             generated from the XRC resources
js/ui.js                   menus, toolbars, notebooks, trees, dialogs
js/app.js                  editors, project model, commands, status bar
js/build.js                Build / Run / Rebuild / Abort, logs, debugger
js/toolchain.js            main-thread proxy for the compiler
js/toolchain-worker.js     clang + wasm-ld + program execution
js/console.js              the floating program console
js/files.js                real Open/Save through the File System Access API
js/features.js             the rest of the menu commands and the plugins
js/sdk-headers.js          <windows.h>, <conio.h> and friends for the sysroot
js/cpp.js                  stepping interpreter, used by the debugger
tools/gen-menus.js         XRC -> js/menudata.js
tools/test-cpp.js          tests for the stepping interpreter
```

Licence: the Code::Blocks resources are GPL-3.0 (as in this repository);
`vendor/wasm-clang` is Apache-2.0; `vendor/codemirror` is MIT.

## Features

Beyond building and running, the commands below are wired to the same menu ids
the desktop IDE uses, so the accelerators in the menus drive them directly.

**Editor** — bookmarks (toggle/next/previous/clear, shown in the marker margin
next to the breakpoints), folding (all / current block / toggle), end-of-line
mode, file encoding, highlight mode, zoom in/out/reset, and the Special
commands: line duplicate/cut/copy/paste/delete/transpose/move up/move down,
uppercase/lowercase, insert line above/below, paragraph and word-part movement
with and without extending the selection.

**Code intelligence** — code completion (Ctrl+Space) over the keywords, the
library names and everything declared in the file; call tips
(Ctrl+Shift+Space); abbreviations (Ctrl+J expands `for`, `if`, `class`,
`main`, `guard`, …); occurrences highlighting; select next occurrence (Ctrl+E);
swap header/source (F11); goto matching brace; comment, uncomment,
stream-comment and box-comment.

**Search** — find/replace in the editor, find and replace *in files* with the
results listed in the Search results pane, find next/previous selected, and
goto next/previous changed line (the changebar margin tracks edits).

**Plugins** — the source formatter (AStyle, Ctrl+Shift+U), the To-Do list
(scans TODO/FIXME/NOTE/BUG/HACK into its own pane), code statistics, thread
search, the open-files list in the Management panel, the scripting console,
DoxyBlocks comment insertion, and **C::B games — cbTris and Snake** (Plugins →
C::B games), the same idea as the byogames contrib plugin.

**Project / build** — targets, project notes, project tree options, activate
next/previous project, build options, and Export Makefile (writes a real
Makefile for the open sources).

**Debugger** — breakpoints, step into/over/out, run to cursor, and the
debugging windows. These show real data, not decoration: **Watches** lists the
locals of the frame you stopped in (structs, arrays, vectors and maps expand)
followed by the globals; **Call stack** is the live frame list; **Disassembly**
runs `clang -S` and shows the actual generated assembly, mangled symbols and
all; **Examine memory** dumps the real bytes of a variable in scope. The CPU
Registers window reports the interpreter's true state and says plainly that a
tree interpreter has no x86 registers, rather than inventing values.

**Dialogs that do something** — Tip of the Day reads the tips Code::Blocks
ships in `src/tips.txt`; Manage plugins lists the 44 plugins from their real
`manifest.xml` files and toggles the ones implemented here; Environment
settings drive autosave, console font and tab placement; the Find and Replace
dialogs are the desktop ones, with match case, whole word, regular expression,
direction and scope; Goto file is a filtered list; and the Class wizard
generates a real header and implementation pair.

**Right-click menu** — the editor's context menu is the desktop one: open the
`#include` under the caret, find occurrences of the selection, run to cursor,
toggle breakpoint, Edit / Insert-Refactor / Bookmarks / Aligner / DoxyBlocks /
Browse Tracker / Locate in submenus, Add Todo item, and Format use AStyle.
Insert/Refactor really renames a symbol across files, extracts a selection into
a function, and inserts include guards and file headers; the Aligner aligns the
selected lines on `=`, `,`, `:` or `//`.

**Settings that do something** — *Settings → Editor* drives tab size, line
numbers, indentation guides, whitespace display, word wrap, caret-line
highlight and the right margin. *Project → Build options* feeds the real clang
command line: the C++ standard (98/11/14/17), optimisation level per target,
`#define`s and the warning flags.

The rest are the ones that need a
desktop toolchain (attach to process, Fortran, wxSmith).
