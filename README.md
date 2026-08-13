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

### Known limits of this toolchain

* **No exceptions.** The sysroot's `libc++abi.a` was built with
  `-fno-exceptions`, so `try`/`throw` fails at link time.
* **No threads** — `<thread>`, `<mutex>`, `<future>` and `<filesystem>` are not
  usable, and are left out of `<bits/stdc++.h>`.
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

Two small, commented changes were made to `vendor/wasm-clang/shared.js`: a
`onStdinStarved` hook in `MemFS.host_read`, and one line in `App.run` so our
own control-flow signal unwinds quietly. Both are marked `cbweb:`.

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
js/cpp.js                  stepping interpreter, used by the debugger
tools/gen-menus.js         XRC -> js/menudata.js
tools/test-cpp.js          tests for the stepping interpreter
```

Licence: the Code::Blocks resources are GPL-3.0 (as in this repository);
`vendor/wasm-clang` is Apache-2.0; `vendor/codemirror` is MIT.
