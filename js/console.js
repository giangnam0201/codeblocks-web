/* ---------------------------------------------------------------------------
   console.js - the floating program console.

   Code::Blocks does not run console programs inside the IDE: it launches
   cb_console_runner, which opens a real console window, runs the program and
   then prints the "Process returned ..." footer and waits for a key.  This is
   the same window, as a floating window on the page.
--------------------------------------------------------------------------- */
'use strict';

class ProgramConsole {
    constructor(title) {
        this.text = '';
        this.pendingInput = null;      // resolve() of the promise the program waits on
        this.lineBuffer = '';
        this.waitKey = null;
        this.closed = false;

        this.screen = document.createElement('div');
        this.screen.className = 'console-screen';
        this.screen.tabIndex = 0;

        this.win = UI.window({
            id: 'console-window',
            title,
            icon: 'assets/icons/run.svg',
            width: 660, height: 420,
            x: Math.min(window.innerWidth - 690, 240),
            y: Math.min(window.innerHeight - 460, 120),
            body: this.screen,
            onClose: () => this.terminate(),
        });
        this.win.querySelector('.body').style.padding = '0';

        this.screen.addEventListener('keydown', ev => this.onKey(ev));
        this.screen.addEventListener('mousedown', () => setTimeout(() => this.screen.focus(), 0));
        setTimeout(() => this.screen.focus(), 0);
        this.render();
    }

    /* ---- output ---- */

    write(s) {
        this.text += s;
        this.render();
    }

    render() {
        this.screen.textContent = this.text + this.lineBuffer;
        if (this.pendingInput || this.waitKey) {
            const caret = document.createElement('span');
            caret.className = 'caret';
            this.screen.appendChild(caret);
        }
        this.screen.scrollTop = this.screen.scrollHeight;
    }

    /* ---- input ---- */

    /* Returns a promise for one line of stdin (including the newline), or null
       when the console is closed - which is how EOF reaches the program. */
    readLine() {
        this.screen.focus();
        return new Promise(resolve => {
            this.pendingInput = resolve;
            this.render();
        });
    }

    onKey(ev) {
        if (this.waitKey) {
            ev.preventDefault();
            const k = this.waitKey;
            this.waitKey = null;
            k();
            return;
        }
        if (!this.pendingInput) return;

        if (ev.key === 'Enter') {
            ev.preventDefault();
            const line = this.lineBuffer + '\n';
            this.text += line;
            this.lineBuffer = '';
            const r = this.pendingInput;
            this.pendingInput = null;
            this.render();
            r(line);
            return;
        }
        if (ev.key === 'Backspace') {
            ev.preventDefault();
            this.lineBuffer = this.lineBuffer.slice(0, -1);
            this.render();
            return;
        }
        if (ev.ctrlKey && (ev.key === 'z' || ev.key === 'd')) {   // EOF
            ev.preventDefault();
            const r = this.pendingInput;
            this.pendingInput = null;
            this.render();
            r(null);
            return;
        }
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.altKey) {
            ev.preventDefault();
            this.lineBuffer += ev.key;
            this.render();
        }
    }

    /* ---- the cb_console_runner footer ---- */

    finish(exitCode, seconds) {
        const hex = (exitCode >>> 0).toString(16).toUpperCase();
        this.write(`\nProcess returned ${exitCode} (0x${hex})   execution time : ${seconds.toFixed(3)} s\n` +
                   'Press any key to continue.\n');
        return new Promise(resolve => {
            this.waitKey = () => { this.close(); resolve(); };
            this.render();
            this.screen.focus();
        });
    }

    close() {
        this.closed = true;
        if (this.win) this.win.remove();
    }

    terminate() {
        // window closed by the user: report EOF, then let the runner stop us
        this.closed = true;
        if (this.pendingInput) { const r = this.pendingInput; this.pendingInput = null; r(null); }
        if (this.waitKey) { const k = this.waitKey; this.waitKey = null; k(); }
        if (this.onTerminate) this.onTerminate();
        if (this.win) this.win.remove();
    }
}
