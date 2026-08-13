/* ---------------------------------------------------------------------------
   cpp.js - a self contained C++ front end (lexer / preprocessor / parser) and
   a generator driven interpreter.

   Everything runs inside the browser, which is what makes the console window
   genuinely interactive: when the program reaches a `cin >>` and the input
   buffer is empty the interpreter simply yields, the console asks the user for
   a line, and execution resumes exactly where it stopped.  The same mechanism
   provides breakpoints and single stepping for the debugger.

   Diagnostics are formatted the way g++ formats them so the Build log and the
   Build messages grid look like the real thing.
--------------------------------------------------------------------------- */
'use strict';

var CPP = (function () {

/* ============================================================ diagnostics */

class CompileError extends Error {
    constructor(msg, line, col, kind) {
        super(msg);
        this.line = line || 0;
        this.col = col || 0;
        this.kind = kind || 'error';
    }
}

/* ================================================================== lexer */

const KEYWORDS = new Set(('alignas alignof asm auto bool break case catch char char16_t char32_t ' +
    'class const const_cast constexpr continue decltype default delete do double dynamic_cast else ' +
    'enum explicit export extern false final float for friend goto if inline int long mutable ' +
    'namespace new noexcept nullptr operator override private protected public register ' +
    'reinterpret_cast return short signed sizeof static static_assert static_cast struct switch ' +
    'template this thread_local throw true try typedef typeid typename union unsigned using ' +
    'virtual void volatile wchar_t while').split(/\s+/));

const PUNCT = [
    '<<=', '>>=', '...', '->*', '<=>',
    '++', '--', '->', '::', '<<', '>>', '<=', '>=', '==', '!=', '&&', '||',
    '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '.*',
    '{', '}', '[', ']', '(', ')', ';', ':', '?', '.', ',',
    '+', '-', '*', '/', '%', '^', '&', '|', '~', '!', '=', '<', '>', '#',
];

function lex(src, fileName) {
    const toks = [];
    let i = 0, line = 1, col = 1, bol = true;
    const n = src.length;

    const push = (type, value, l, c) => {
        toks.push({ type, value, line: l, col: c, bol });
        bol = false;
    };

    while (i < n) {
        const ch = src[i];

        if (ch === '\n') { i++; line++; col = 1; bol = true; continue; }
        if (ch === ' ' || ch === '\t' || ch === '\r') { i++; col++; continue; }

        // line continuation
        if (ch === '\\' && (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n'))) {
            i += src[i + 1] === '\r' ? 3 : 2; line++; col = 1; continue;
        }
        // comments
        if (ch === '/' && src[i + 1] === '/') {
            while (i < n && src[i] !== '\n') i++;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const sl = line;
            i += 2;
            while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') { line++; col = 1; }
                i++;
            }
            if (i >= n) throw new CompileError('unterminated comment', sl, col);
            i += 2;
            continue;
        }
        // numbers
        if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            const start = i, sc = col;
            let isFloat = false;
            if (ch === '0' && /[xX]/.test(src[i + 1] || '')) {
                i += 2;
                while (i < n && /[0-9a-fA-F']/.test(src[i])) { i++; col++; }
            } else if (ch === '0' && /[bB]/.test(src[i + 1] || '')) {
                i += 2;
                while (i < n && /[01']/.test(src[i])) { i++; col++; }
            } else {
                while (i < n && /[0-9']/.test(src[i])) { i++; col++; }
                if (src[i] === '.') { isFloat = true; i++; col++; while (i < n && /[0-9']/.test(src[i])) { i++; col++; } }
                if (/[eE]/.test(src[i] || '') && /[0-9+\-]/.test(src[i + 1] || '')) {
                    isFloat = true; i++; col++;
                    if (/[+\-]/.test(src[i])) { i++; col++; }
                    while (i < n && /[0-9]/.test(src[i])) { i++; col++; }
                }
            }
            let text = src.slice(start, i);
            let suffix = '';
            while (i < n && /[uUlLfF]/.test(src[i])) { suffix += src[i]; i++; col++; }
            const clean = text.replace(/'/g, '');
            let val;
            if (/^0[xX]/.test(clean)) val = parseInt(clean, 16);
            else if (/^0[bB]/.test(clean)) val = parseInt(clean.slice(2), 2);
            else if (!isFloat && /^0[0-7]+$/.test(clean)) val = parseInt(clean, 8);
            else val = parseFloat(clean);
            if (/[fF]/.test(suffix)) isFloat = true;
            push('num', { v: val, isFloat: isFloat || /\./.test(clean), suffix }, line, sc);
            continue;
        }
        // identifiers
        if (/[A-Za-z_]/.test(ch)) {
            const start = i, sc = col;
            while (i < n && /[A-Za-z0-9_]/.test(src[i])) { i++; col++; }
            const word = src.slice(start, i);
            // string / char literal prefixes
            if ((word === 'u8' || word === 'u' || word === 'U' || word === 'L') && src[i] === '"') continue;
            push(KEYWORDS.has(word) ? 'kw' : 'id', word, line, sc);
            continue;
        }
        // strings
        if (ch === '"') {
            const sc = col, sl = line;
            i++; col++;
            let out = '';
            while (i < n && src[i] !== '"') {
                if (src[i] === '\\') { out += unescapeChar(src, i); i += escapeLen(src, i); col += 2; }
                else if (src[i] === '\n') throw new CompileError('missing terminating " character', sl, sc);
                else { out += src[i]; i++; col++; }
            }
            if (i >= n) throw new CompileError('missing terminating " character', sl, sc);
            i++; col++;
            push('str', out, sl, sc);
            continue;
        }
        // char literals
        if (ch === "'") {
            const sc = col, sl = line;
            i++; col++;
            let code = 0;
            if (src[i] === '\\') { code = unescapeChar(src, i).charCodeAt(0); i += escapeLen(src, i); col += 2; }
            else { code = src.charCodeAt(i); i++; col++; }
            if (src[i] !== "'") throw new CompileError('missing terminating \' character', sl, sc);
            i++; col++;
            push('char', code, sl, sc);
            continue;
        }
        // punctuation
        let matched = null;
        for (const p of PUNCT) {
            if (src.startsWith(p, i)) { matched = p; break; }
        }
        if (matched) {
            push('punct', matched, line, col);
            i += matched.length; col += matched.length;
            continue;
        }
        throw new CompileError(`stray '${ch}' in program`, line, col);
    }
    toks.push({ type: 'eof', value: null, line, col, bol: true });
    return toks;
}

function escapeLen(s, i) {
    if (s[i] !== '\\') return 1;
    if (s[i + 1] === 'x') {
        let j = i + 2;
        while (/[0-9a-fA-F]/.test(s[j] || '')) j++;
        return j - i;
    }
    if (/[0-7]/.test(s[i + 1])) {
        let j = i + 1;
        while (/[0-7]/.test(s[j] || '') && j - i <= 3) j++;
        return j - i;
    }
    return 2;
}
function unescapeChar(s, i) {
    const c = s[i + 1];
    switch (c) {
        case 'n': return '\n'; case 't': return '\t'; case 'r': return '\r';
        case '0': return /[0-7]/.test(s[i + 2] || '') ? String.fromCharCode(parseInt(s.slice(i + 1, i + escapeLen(s, i)), 8)) : '\0';
        case 'a': return '\x07'; case 'b': return '\b'; case 'f': return '\f';
        case 'v': return '\v'; case '\\': return '\\'; case "'": return "'";
        case '"': return '"'; case '?': return '?';
        case 'x': return String.fromCharCode(parseInt(s.slice(i + 2, i + escapeLen(s, i)), 16));
        default:
            if (/[0-7]/.test(c)) return String.fromCharCode(parseInt(s.slice(i + 1, i + escapeLen(s, i)), 8));
            return c;
    }
}

/* =========================================================== preprocessor */

const KNOWN_HEADERS = new Set([
    'iostream', 'string', 'vector', 'algorithm', 'cmath', 'math.h', 'cstdio', 'stdio.h',
    'cstdlib', 'stdlib.h', 'cstring', 'string.h', 'cctype', 'ctype.h', 'ctime', 'time.h',
    'iomanip', 'map', 'set', 'utility', 'numeric', 'climits', 'limits.h', 'cfloat',
    'sstream', 'fstream', 'queue', 'stack', 'list', 'deque', 'bits/stdc++.h',
    'unordered_map', 'unordered_set', 'functional', 'memory', 'iterator', 'array',
    'complex', 'exception', 'stdexcept', 'cassert', 'assert.h', 'bitset', 'random',
    'chrono', 'tuple', 'type_traits', 'limits', 'iosfwd', 'new', 'typeinfo', 'cerrno',
]);

/* Runs the directives and expands macros at token level. */
function preprocess(toks, diagnostics) {
    const macros = new Map();
    const out = [];
    const condStack = [];   // {active, taken, hasElse}
    let i = 0;

    const activeNow = () => condStack.every(c => c.active);

    const readLine = () => {
        const l = [];
        while (toks[i].type !== 'eof' && !toks[i].bol) l.push(toks[i++]);
        return l;
    };

    while (toks[i].type !== 'eof') {
        const t = toks[i];
        if (t.type === 'punct' && t.value === '#' && t.bol) {
            i++;
            const dirTok = toks[i];
            const dir = (dirTok && (dirTok.type === 'id' || dirTok.type === 'kw')) ? dirTok.value : '';
            if (dirTok && !dirTok.bol) i++;
            const rest = readLine();

            switch (dir) {
                case 'include': {
                    if (!activeNow()) break;
                    let hdr = '';
                    if (rest.length && rest[0].type === 'str') hdr = rest[0].value;
                    else {
                        // <iostream> was lexed as punctuation + identifiers
                        hdr = rest.map(x => x.type === 'num' ? String(x.value.v) : String(x.value)).join('');
                        hdr = hdr.replace(/^</, '').replace(/>$/, '');
                    }
                    if (hdr && !KNOWN_HEADERS.has(hdr)) {
                        diagnostics.push(new CompileError(`${hdr}: No such file or directory`, t.line, t.col));
                    }
                    break;
                }
                case 'define': {
                    if (!activeNow()) break;
                    if (!rest.length) break;
                    const name = String(rest[0].value);
                    if (rest[1] && rest[1].type === 'punct' && rest[1].value === '(' &&
                        rest[1].col === rest[0].col + name.length) {
                        // function-like macro
                        let k = 2;
                        const params = [];
                        while (k < rest.length && !(rest[k].type === 'punct' && rest[k].value === ')')) {
                            if (rest[k].type === 'id') params.push(rest[k].value);
                            k++;
                        }
                        macros.set(name, { params, body: rest.slice(k + 1) });
                    } else {
                        macros.set(name, { params: null, body: rest.slice(1) });
                    }
                    break;
                }
                case 'undef':
                    if (activeNow() && rest.length) macros.delete(String(rest[0].value));
                    break;
                case 'ifdef':
                    condStack.push({ active: activeNow() && macros.has(String(rest[0] && rest[0].value)), taken: false });
                    condStack[condStack.length - 1].taken = condStack[condStack.length - 1].active;
                    break;
                case 'ifndef':
                    condStack.push({ active: activeNow() && !macros.has(String(rest[0] && rest[0].value)), taken: false });
                    condStack[condStack.length - 1].taken = condStack[condStack.length - 1].active;
                    break;
                case 'if': {
                    const v = evalPPExpr(rest, macros);
                    condStack.push({ active: activeNow() && !!v, taken: !!v });
                    break;
                }
                case 'elif': {
                    const c = condStack[condStack.length - 1];
                    if (c) {
                        const v = evalPPExpr(rest, macros);
                        c.active = !c.taken && !!v;
                        if (c.active) c.taken = true;
                    }
                    break;
                }
                case 'else': {
                    const c = condStack[condStack.length - 1];
                    if (c) { c.active = !c.taken; c.taken = true; }
                    break;
                }
                case 'endif':
                    condStack.pop();
                    break;
                case 'pragma': case 'error': case 'warning': case 'line':
                    break;
                default:
                    break;
            }
            continue;
        }

        if (!activeNow()) { i++; continue; }

        // macro expansion
        if ((t.type === 'id') && macros.has(t.value)) {
            const m = macros.get(t.value);
            if (m.params === null) {
                out.push(...m.body.map(b => ({ ...b, line: t.line, col: t.col, bol: false })));
                i++;
                continue;
            }
            if (toks[i + 1] && toks[i + 1].type === 'punct' && toks[i + 1].value === '(') {
                let k = i + 2, depth = 1;
                const args = [[]];
                while (toks[k].type !== 'eof' && depth > 0) {
                    const tk = toks[k];
                    if (tk.type === 'punct' && tk.value === '(') depth++;
                    if (tk.type === 'punct' && tk.value === ')') { depth--; if (!depth) break; }
                    if (tk.type === 'punct' && tk.value === ',' && depth === 1) args.push([]);
                    else args[args.length - 1].push(tk);
                    k++;
                }
                const body = [];
                for (const bt of m.body) {
                    const pi = bt.type === 'id' ? m.params.indexOf(bt.value) : -1;
                    if (pi >= 0 && args[pi]) body.push(...args[pi].map(a => ({ ...a, line: t.line })));
                    else body.push({ ...bt, line: t.line });
                }
                out.push(...body);
                i = k + 1;
                continue;
            }
        }
        out.push(t);
        i++;
    }
    out.push(toks[toks.length - 1]);
    return out;
}

function evalPPExpr(toks, macros) {
    // Enough for the usual `#if 0`, `#if defined(X)`, `#if X > 2`.
    let s = '';
    for (let k = 0; k < toks.length; k++) {
        const t = toks[k];
        if (t.type === 'id' && t.value === 'defined') {
            let name = null, j = k + 1;
            if (toks[j] && toks[j].value === '(') { name = toks[j + 1] && toks[j + 1].value; k = j + 2; }
            else { name = toks[j] && toks[j].value; k = j; }
            s += macros.has(String(name)) ? '1' : '0';
            continue;
        }
        if (t.type === 'num') { s += t.value.v; continue; }
        if (t.type === 'id') {
            const m = macros.get(t.value);
            s += (m && m.body.length === 1 && m.body[0].type === 'num') ? m.body[0].value.v : '0';
            continue;
        }
        if (t.type === 'punct') { s += t.value; continue; }
        s += ' ';
    }
    try { return Function('"use strict";return (' + (s || '0') + ')')(); }
    catch (e) { return 0; }
}

/* ================================================================= parser */

const BUILTIN_TYPES = new Set(['void', 'bool', 'char', 'short', 'int', 'long', 'float',
    'double', 'signed', 'unsigned', 'wchar_t', 'auto', 'size_t', 'string', 'vector',
    'map', 'set', 'pair', 'queue', 'stack', 'deque', 'list', 'multiset', 'multimap',
    'unordered_map', 'unordered_set', 'priority_queue', 'ostream', 'istream',
    'stringstream', 'ostringstream', 'istringstream', 'int8_t', 'int16_t', 'int32_t',
    'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t', 'll', 'ull']);

class Parser {
    constructor(toks) {
        this.toks = toks;
        this.p = 0;
        this.types = new Set(BUILTIN_TYPES);
        this.classes = new Map();
        this.diagnostics = [];
    }
    peek(k) { return this.toks[this.p + (k || 0)]; }
    get cur() { return this.toks[this.p]; }
    next() { return this.toks[this.p++]; }
    is(type, value) {
        const t = this.cur;
        return t.type === type && (value === undefined || t.value === value);
    }
    isP(v) { return this.is('punct', v); }
    isKw(v) { return this.is('kw', v); }
    accept(type, value) { if (this.is(type, value)) { return this.next(); } return null; }
    expect(type, value) {
        if (this.is(type, value)) return this.next();
        const t = this.cur;
        throw new CompileError(`expected '${value !== undefined ? value : type}' before '${
            t.type === 'eof' ? 'end of input' : tokText(t)}'`, t.line, t.col);
    }
    err(msg) { throw new CompileError(msg, this.cur.line, this.cur.col); }

    /* ---- type parsing --------------------------------------------------- */

    looksLikeType() {
        let k = 0;
        while (this.peek(k) && this.peek(k).type === 'kw' &&
              ['const', 'static', 'unsigned', 'signed', 'long', 'short', 'constexpr',
               'volatile', 'inline', 'extern', 'register', 'mutable'].includes(this.peek(k).value)) k++;
        const t = this.peek(k);
        if (!t) return false;
        if (t.type === 'kw' && ['void', 'bool', 'char', 'int', 'float', 'double', 'auto',
                                'wchar_t', 'long', 'short', 'unsigned', 'signed'].includes(t.value)) return true;
        if (t.type === 'kw' && (t.value === 'struct' || t.value === 'class' || t.value === 'enum')) return true;
        if (t.type === 'id' && this.types.has(t.value)) {
            // `string s;` yes, but `string(x)` used as a cast/ctor call is also fine
            return true;
        }
        return false;
    }

    parseType() {
        const start = this.cur;
        let isConst = false, isStatic = false, isUnsigned = false, longCount = 0, isShort = false;
        for (;;) {
            if (this.isKw('const')) { this.next(); isConst = true; continue; }
            if (this.isKw('constexpr')) { this.next(); isConst = true; continue; }
            if (this.isKw('static')) { this.next(); isStatic = true; continue; }
            if (this.isKw('volatile') || this.isKw('inline') || this.isKw('extern') ||
                this.isKw('register') || this.isKw('mutable') || this.isKw('virtual') ||
                this.isKw('explicit') || this.isKw('friend')) { this.next(); continue; }
            if (this.isKw('unsigned')) { this.next(); isUnsigned = true; continue; }
            if (this.isKw('signed')) { this.next(); continue; }
            if (this.isKw('long')) { this.next(); longCount++; continue; }
            if (this.isKw('short')) { this.next(); isShort = true; continue; }
            break;
        }
        let name;
        if (this.isKw('struct') || this.isKw('class') || this.isKw('enum')) {
            this.next();
            name = this.expect('id').value;
        } else if (this.cur.type === 'kw' || this.cur.type === 'id') {
            name = this.next().value;
        } else if (longCount || isShort || isUnsigned) {
            name = 'int';
        } else {
            this.err(`expected type name before '${tokText(this.cur)}'`);
        }
        if (name === 'long' || name === 'short') { name = 'int'; }
        if (longCount >= 1 && (name === 'int')) name = longCount >= 2 ? 'long long' : 'long';
        if (isShort) name = 'short';
        if (name === 'double' && longCount) name = 'double';

        const type = {
            name, const: isConst, static: isStatic, unsigned: isUnsigned,
            ptr: 0, ref: false, args: null, line: start.line, col: start.col,
        };
        // template arguments
        if (this.isP('<') && ['vector', 'map', 'set', 'pair', 'queue', 'stack', 'deque',
                              'list', 'multiset', 'multimap', 'unordered_map', 'unordered_set',
                              'priority_queue', 'array', 'tuple', 'function'].includes(name)) {
            this.next();
            type.args = [];
            let depth = 1;
            if (!this.isP('>')) {
                for (;;) {
                    type.args.push(this.parseType());
                    if (this.isP(',')) { this.next(); continue; }
                    break;
                }
            }
            if (this.isP('>>')) { // vector<vector<int>>
                this.cur.value = '>';
                depth--;
            } else this.expect('punct', '>');
            void depth;
        }
        while (this.isP('*')) { this.next(); type.ptr++; }
        if (this.isP('&')) { this.next(); type.ref = true; }
        else if (this.isP('&&')) { this.next(); type.ref = true; }
        while (this.isKw('const')) { this.next(); type.const = true; }
        return type;
    }

    /* ---- top level ------------------------------------------------------ */

    parseProgram() {
        const decls = [];
        while (!this.is('eof')) {
            const d = this.parseTopLevel();
            if (d) decls.push(...(Array.isArray(d) ? d : [d]));
        }
        return { kind: 'Program', decls };
    }

    parseTopLevel() {
        if (this.isP(';')) { this.next(); return null; }

        if (this.isKw('using')) {
            this.next();
            if (this.isKw('namespace')) { while (!this.isP(';') && !this.is('eof')) this.next(); this.expect('punct', ';'); return null; }
            // using alias = type;
            const alias = this.expect('id').value;
            this.types.add(alias);
            if (this.isP('=')) { this.next(); const t = this.parseType(); this.expect('punct', ';'); return { kind: 'TypeAlias', alias, type: t }; }
            while (!this.isP(';') && !this.is('eof')) this.next();
            this.expect('punct', ';');
            return null;
        }
        if (this.isKw('namespace')) {
            this.next();
            if (this.cur.type === 'id') this.next();
            this.expect('punct', '{');
            const inner = [];
            while (!this.isP('}') && !this.is('eof')) {
                const d = this.parseTopLevel();
                if (d) inner.push(...(Array.isArray(d) ? d : [d]));
            }
            this.expect('punct', '}');
            return inner;
        }
        if (this.isKw('template')) {
            this.next();
            this.expect('punct', '<');
            const params = [];
            let depth = 1;
            while (depth > 0 && !this.is('eof')) {
                if (this.isP('<')) depth++;
                else if (this.isP('>')) { depth--; if (!depth) { this.next(); break; } }
                else if ((this.isKw('typename') || this.isKw('class'))) {
                    this.next();
                    if (this.cur.type === 'id') { params.push(this.cur.value); this.types.add(this.cur.value); }
                    continue;
                }
                this.next();
            }
            const d = this.parseTopLevel();
            if (d && !Array.isArray(d)) d.templateParams = params;
            return d;
        }
        if (this.isKw('typedef')) {
            this.next();
            const base = this.parseType();
            const alias = this.expect('id').value;
            this.types.add(alias);
            while (!this.isP(';') && !this.is('eof')) this.next();
            this.expect('punct', ';');
            return { kind: 'TypeAlias', alias, type: base };
        }
        if ((this.isKw('struct') || this.isKw('class')) && this.peek(1).type === 'id' &&
            (this.peek(2).value === '{' || this.peek(2).value === ':')) {
            return this.parseClass();
        }
        if (this.isKw('enum')) return this.parseEnum();

        return this.parseDeclarationOrFunction(true);
    }

    parseClass() {
        const kwTok = this.next();                       // struct | class
        const name = this.expect('id').value;
        this.types.add(name);
        const cls = { kind: 'ClassDecl', name, fields: [], methods: [], line: kwTok.line, bases: [] };
        this.classes.set(name, cls);
        if (this.isP(':')) {                              // inheritance
            this.next();
            for (;;) {
                while (this.isKw('public') || this.isKw('private') || this.isKw('protected') || this.isKw('virtual')) this.next();
                cls.bases.push(this.expect('id').value);
                if (this.isP(',')) { this.next(); continue; }
                break;
            }
        }
        this.expect('punct', '{');
        while (!this.isP('}') && !this.is('eof')) {
            if (this.isKw('public') || this.isKw('private') || this.isKw('protected')) {
                this.next();
                this.expect('punct', ':');
                continue;
            }
            if (this.isP(';')) { this.next(); continue; }
            if (this.isKw('template')) { this.parseTopLevel(); continue; }

            // constructor / destructor
            const isDtor = this.isP('~');
            if ((this.cur.type === 'id' && this.cur.value === name && this.peek(1).value === '(') ||
                (isDtor && this.peek(1).value === name)) {
                const line = this.cur.line;
                if (isDtor) this.next();
                this.next();                              // name
                const params = this.parseParams();
                const inits = [];
                if (this.isP(':')) {                      // member initialiser list
                    this.next();
                    for (;;) {
                        const mname = this.expect('id').value;
                        const open = this.cur.value;
                        this.expect('punct', open === '{' ? '{' : '(');
                        const args = [];
                        if (!this.isP(open === '{' ? '}' : ')')) {
                            for (;;) { args.push(this.parseAssign()); if (this.isP(',')) { this.next(); continue; } break; }
                        }
                        this.expect('punct', open === '{' ? '}' : ')');
                        inits.push({ name: mname, args });
                        if (this.isP(',')) { this.next(); continue; }
                        break;
                    }
                }
                const body = this.isP('{') ? this.parseBlock() : (this.expect('punct', ';'), null);
                cls.methods.push({
                    kind: 'FuncDecl', name: isDtor ? '~' + name : name, params, body,
                    isCtor: !isDtor, isDtor, inits, line, retType: { name: 'void', ptr: 0 },
                });
                continue;
            }

            const save = this.p;
            const type = this.parseType();
            if (this.cur.type !== 'id' && !this.isKw('operator')) { this.p = save; this.next(); continue; }
            if (this.isKw('operator')) {                  // operator overloads: parsed, then skipped
                while (!this.isP('{') && !this.isP(';') && !this.is('eof')) this.next();
                if (this.isP('{')) this.parseBlock(); else this.next();
                continue;
            }
            const mname = this.next().value;
            if (this.isP('(')) {
                const params = this.parseParams();
                while (this.isKw('const') || this.isKw('override') || this.isKw('final') ||
                       this.isKw('noexcept')) this.next();
                if (this.isP('=')) { this.next(); this.next(); }   // = 0 / = default
                const body = this.isP('{') ? this.parseBlock() : (this.expect('punct', ';'), null);
                cls.methods.push({ kind: 'FuncDecl', name: mname, params, body, retType: type, line: type.line });
            } else {
                const decls = this.finishVarDecls(type, mname, true);
                cls.fields.push(...decls.decls);
            }
        }
        this.expect('punct', '}');
        this.accept('punct', ';');
        return cls;
    }

    parseEnum() {
        this.next();
        if (this.isKw('class') || this.isKw('struct')) this.next();
        let name = null;
        if (this.cur.type === 'id') { name = this.next().value; this.types.add(name); }
        if (this.isP(':')) { this.next(); this.parseType(); }
        const members = [];
        if (this.isP('{')) {
            this.next();
            let auto = 0;
            while (!this.isP('}') && !this.is('eof')) {
                const id = this.expect('id').value;
                let val = null;
                if (this.isP('=')) { this.next(); val = this.parseAssign(); }
                members.push({ name: id, value: val, auto: auto++ });
                if (this.isP(',')) { this.next(); continue; }
                break;
            }
            this.expect('punct', '}');
        }
        this.accept('punct', ';');
        return { kind: 'EnumDecl', name, members };
    }

    parseParams() {
        this.expect('punct', '(');
        const params = [];
        if (!this.isP(')')) {
            for (;;) {
                if (this.isP('...')) { this.next(); params.push({ variadic: true }); break; }
                if (this.isKw('void') && this.peek(1).value === ')') { this.next(); break; }
                const type = this.parseType();
                let pname = null;
                if (this.cur.type === 'id') pname = this.next().value;
                const dims = [];
                while (this.isP('[')) {
                    this.next();
                    dims.push(this.isP(']') ? null : this.parseAssign());
                    this.expect('punct', ']');
                }
                let def = null;
                if (this.isP('=')) { this.next(); def = this.parseAssign(); }
                params.push({ type, name: pname, dims, def });
                if (this.isP(',')) { this.next(); continue; }
                break;
            }
        }
        this.expect('punct', ')');
        return params;
    }

    parseDeclarationOrFunction(topLevel) {
        const line = this.cur.line, col = this.cur.col;
        const type = this.parseType();

        // Class::method definitions written outside the class body
        if (this.cur.type === 'id' && this.peek(1).value === '::') {
            const clsName = this.next().value;
            this.next();
            const mname = this.cur.type === 'id' ? this.next().value : (this.next(), this.next().value);
            const params = this.parseParams();
            while (this.isKw('const') || this.isKw('noexcept')) this.next();
            const body = this.parseBlock();
            const cls = this.classes.get(clsName);
            const m = { kind: 'FuncDecl', name: mname, params, body, retType: type, line, isCtor: mname === clsName };
            if (cls) cls.methods.push(m);
            return null;
        }

        if (this.isKw('operator')) {
            while (!this.isP('{') && !this.isP(';') && !this.is('eof')) this.next();
            if (this.isP('{')) this.parseBlock(); else this.next();
            return null;
        }

        if (this.cur.type !== 'id') this.err(`expected identifier before '${tokText(this.cur)}'`);
        const name = this.next().value;

        if (this.isP('(')) {
            const params = this.parseParams();
            while (this.isKw('const') || this.isKw('noexcept') || this.isKw('override') ||
                   this.isKw('final')) this.next();
            if (this.isP(';')) { this.next(); return { kind: 'FuncProto', name, params, retType: type, line }; }
            const body = this.parseBlock();
            return { kind: 'FuncDecl', name, params, body, retType: type, line, col };
        }
        return this.finishVarDecls(type, name, false, topLevel);
    }

    finishVarDecls(type, firstName, fieldMode) {
        const decls = [];
        let name = firstName;
        for (;;) {
            const dims = [];
            while (this.isP('[')) {
                this.next();
                dims.push(this.isP(']') ? null : this.parseAssign());
                this.expect('punct', ']');
            }
            let init = null, initKind = null;
            if (this.isP('=')) {
                this.next();
                init = this.isP('{') ? this.parseBraceInit() : this.parseAssign();
                initKind = 'copy';
            } else if (this.isP('(') && !fieldMode) {
                this.next();
                const args = [];
                if (!this.isP(')')) {
                    for (;;) { args.push(this.parseAssign()); if (this.isP(',')) { this.next(); continue; } break; }
                }
                this.expect('punct', ')');
                init = { kind: 'CtorArgs', args };
                initKind = 'ctor';
            } else if (this.isP('{')) {
                init = this.parseBraceInit();
                initKind = 'copy';
            }
            decls.push({ kind: 'VarDecl', type, name, dims, init, initKind, line: type.line });
            if (this.isP(',')) {
                this.next();
                let t2 = { ...type, ptr: 0, ref: false };
                while (this.isP('*')) { this.next(); t2.ptr++; }
                if (this.isP('&')) { this.next(); t2.ref = true; }
                type = t2;
                name = this.expect('id').value;
                continue;
            }
            break;
        }
        this.expect('punct', ';');
        return { kind: 'DeclGroup', decls, line: type.line };
    }

    parseBraceInit() {
        const line = this.cur.line;
        this.expect('punct', '{');
        const items = [];
        if (!this.isP('}')) {
            for (;;) {
                items.push(this.isP('{') ? this.parseBraceInit() : this.parseAssign());
                if (this.isP(',')) { this.next(); if (this.isP('}')) break; continue; }
                break;
            }
        }
        this.expect('punct', '}');
        return { kind: 'InitList', items, line };
    }

    /* ---- statements ----------------------------------------------------- */

    parseBlock() {
        const line = this.cur.line;
        this.expect('punct', '{');
        const body = [];
        while (!this.isP('}') && !this.is('eof')) body.push(this.parseStatement());
        this.expect('punct', '}');
        return { kind: 'Block', body, line };
    }

    parseStatement() {
        const t = this.cur;
        const line = t.line;

        if (this.isP('{')) return this.parseBlock();
        if (this.isP(';')) { this.next(); return { kind: 'Empty', line }; }

        if (this.isKw('if')) {
            this.next();
            this.expect('punct', '(');
            const cond = this.parseExpression();
            this.expect('punct', ')');
            const then = this.parseStatement();
            let alt = null;
            if (this.isKw('else')) { this.next(); alt = this.parseStatement(); }
            return { kind: 'If', cond, then, alt, line };
        }
        if (this.isKw('while')) {
            this.next();
            this.expect('punct', '(');
            const cond = this.parseExpression();
            this.expect('punct', ')');
            return { kind: 'While', cond, body: this.parseStatement(), line };
        }
        if (this.isKw('do')) {
            this.next();
            const body = this.parseStatement();
            this.expect('kw', 'while');
            this.expect('punct', '(');
            const cond = this.parseExpression();
            this.expect('punct', ')');
            this.expect('punct', ';');
            return { kind: 'DoWhile', cond, body, line };
        }
        if (this.isKw('for')) {
            this.next();
            this.expect('punct', '(');
            // range-based for?
            const save = this.p;
            if (this.looksLikeType()) {
                try {
                    const type = this.parseType();
                    if (this.cur.type === 'id' && this.peek(1).value === ':') {
                        const name = this.next().value;
                        this.next();
                        const range = this.parseExpression();
                        this.expect('punct', ')');
                        return { kind: 'RangeFor', type, name, range, body: this.parseStatement(), line };
                    }
                } catch (e) { /* fall through to the classic form */ }
                this.p = save;
            }
            let init = null;
            if (!this.isP(';')) {
                if (this.looksLikeType()) init = this.parseSimpleDecl();
                else { init = { kind: 'ExprStmt', expr: this.parseExpression(), line }; this.expect('punct', ';'); }
            } else this.next();
            const cond = this.isP(';') ? null : this.parseExpression();
            this.expect('punct', ';');
            const step = this.isP(')') ? null : this.parseExpression();
            this.expect('punct', ')');
            return { kind: 'For', init, cond, step, body: this.parseStatement(), line };
        }
        if (this.isKw('switch')) {
            this.next();
            this.expect('punct', '(');
            const disc = this.parseExpression();
            this.expect('punct', ')');
            this.expect('punct', '{');
            const cases = [];
            while (!this.isP('}') && !this.is('eof')) {
                if (this.isKw('case')) {
                    this.next();
                    const v = this.parseAssign();
                    this.expect('punct', ':');
                    cases.push({ test: v, body: [] });
                } else if (this.isKw('default')) {
                    this.next();
                    this.expect('punct', ':');
                    cases.push({ test: null, body: [] });
                } else {
                    if (!cases.length) cases.push({ test: null, body: [] });
                    cases[cases.length - 1].body.push(this.parseStatement());
                }
            }
            this.expect('punct', '}');
            return { kind: 'Switch', disc, cases, line };
        }
        if (this.isKw('return')) {
            this.next();
            const v = this.isP(';') ? null : this.parseExpression();
            this.expect('punct', ';');
            return { kind: 'Return', value: v, line };
        }
        if (this.isKw('break')) { this.next(); this.expect('punct', ';'); return { kind: 'Break', line }; }
        if (this.isKw('continue')) { this.next(); this.expect('punct', ';'); return { kind: 'Continue', line }; }
        if (this.isKw('typedef') || this.isKw('using')) { const d = this.parseTopLevel(); return d || { kind: 'Empty', line }; }
        if (this.isKw('struct') || this.isKw('class')) {
            if (this.peek(1).type === 'id' && (this.peek(2).value === '{' || this.peek(2).value === ':'))
                return this.parseClass();
        }
        if (this.isKw('enum')) return this.parseEnum();
        if (this.isKw('try')) {
            this.next();
            const body = this.parseBlock();
            const handlers = [];
            while (this.isKw('catch')) {
                this.next();
                this.expect('punct', '(');
                let ptype = null, pname = null;
                if (this.isP('...')) this.next();
                else { ptype = this.parseType(); if (this.cur.type === 'id') pname = this.next().value; }
                this.expect('punct', ')');
                handlers.push({ type: ptype, name: pname, body: this.parseBlock() });
            }
            return { kind: 'Try', body, handlers, line };
        }
        if (this.isKw('throw')) {
            this.next();
            const v = this.isP(';') ? null : this.parseExpression();
            this.expect('punct', ';');
            return { kind: 'Throw', value: v, line };
        }

        if (this.looksLikeType()) {
            const save = this.p;
            try { return this.parseSimpleDecl(); }
            catch (e) { this.p = save; }
        }
        const expr = this.parseExpression();
        this.expect('punct', ';');
        return { kind: 'ExprStmt', expr, line };
    }

    parseSimpleDecl() {
        const type = this.parseType();
        if (this.cur.type !== 'id') this.err(`expected identifier before '${tokText(this.cur)}'`);
        const name = this.next().value;
        if (this.isP('(') && (type.name === 'auto')) this.err('not a declaration');
        return this.finishVarDecls(type, name, false);
    }

    /* ---- expressions ---------------------------------------------------- */

    parseExpression() {
        let e = this.parseAssign();
        while (this.isP(',')) {
            const line = this.next().line;
            e = { kind: 'Comma', left: e, right: this.parseAssign(), line };
        }
        return e;
    }

    parseAssign() {
        const left = this.parseTernary();
        const ops = ['=', '+=', '-=', '*=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^='];
        if (this.cur.type === 'punct' && ops.includes(this.cur.value)) {
            const op = this.next();
            const right = this.parseAssign();
            return { kind: 'Assign', op: op.value, left, right, line: op.line, col: op.col };
        }
        return left;
    }

    parseTernary() {
        const cond = this.parseBinary(0);
        if (this.isP('?')) {
            const line = this.next().line;
            const then = this.parseAssign();
            this.expect('punct', ':');
            const alt = this.parseAssign();
            return { kind: 'Ternary', cond, then, alt, line };
        }
        return cond;
    }

    binPrec(v) {
        switch (v) {
            case '||': return 1;
            case '&&': return 2;
            case '|': return 3;
            case '^': return 4;
            case '&': return 5;
            case '==': case '!=': return 6;
            case '<': case '>': case '<=': case '>=': return 7;
            case '<<': case '>>': return 8;
            case '+': case '-': return 9;
            case '*': case '/': case '%': return 10;
            default: return -1;
        }
    }

    parseBinary(minPrec) {
        let left = this.parseUnary();
        for (;;) {
            if (this.cur.type !== 'punct') break;
            const prec = this.binPrec(this.cur.value);
            if (prec < 0 || prec < minPrec) break;
            const op = this.next();
            const right = this.parseBinary(prec + 1);
            left = { kind: 'Binary', op: op.value, left, right, line: op.line, col: op.col };
        }
        return left;
    }

    parseUnary() {
        const t = this.cur;
        if (t.type === 'punct' && ['+', '-', '!', '~', '*', '&', '++', '--'].includes(t.value)) {
            this.next();
            const operand = this.parseUnary();
            if (t.value === '++' || t.value === '--')
                return { kind: 'PreIncDec', op: t.value, operand, line: t.line, col: t.col };
            return { kind: 'Unary', op: t.value, operand, line: t.line, col: t.col };
        }
        if (this.isKw('sizeof')) {
            this.next();
            if (this.isP('(')) {
                const save = this.p;
                this.next();
                if (this.looksLikeType()) {
                    const type = this.parseType();
                    if (this.isP(')')) { this.next(); return { kind: 'SizeofType', type, line: t.line }; }
                }
                this.p = save;
            }
            return { kind: 'SizeofExpr', operand: this.parseUnary(), line: t.line };
        }
        if (this.isKw('new')) {
            this.next();
            const type = this.parseType();
            let count = null, args = null;
            if (this.isP('[')) { this.next(); count = this.parseExpression(); this.expect('punct', ']'); }
            else if (this.isP('(')) {
                this.next();
                args = [];
                if (!this.isP(')')) { for (;;) { args.push(this.parseAssign()); if (this.isP(',')) { this.next(); continue; } break; } }
                this.expect('punct', ')');
            } else if (this.isP('{')) {
                const il = this.parseBraceInit();
                args = il.items;
            }
            return { kind: 'New', type, count, args, line: t.line };
        }
        if (this.isKw('delete')) {
            this.next();
            if (this.isP('[')) { this.next(); this.expect('punct', ']'); }
            return { kind: 'Delete', operand: this.parseUnary(), line: t.line };
        }
        if (this.isKw('static_cast') || this.isKw('const_cast') ||
            this.isKw('reinterpret_cast') || this.isKw('dynamic_cast')) {
            this.next();
            this.expect('punct', '<');
            const type = this.parseType();
            this.expect('punct', '>');
            this.expect('punct', '(');
            const operand = this.parseExpression();
            this.expect('punct', ')');
            return { kind: 'Cast', type, operand, line: t.line };
        }
        // C style cast: (int)x  -- only when it is unambiguously a type
        if (this.isP('(')) {
            const save = this.p;
            this.next();
            if (this.looksLikeType()) {
                try {
                    const type = this.parseType();
                    if (this.isP(')')) {
                        const after = this.peek(1);
                        const castable = after && !(after.type === 'punct' &&
                            [')', ']', ',', ';', '*', '/', '%', '+', '<', '>', '=', '?', ':',
                             '==', '!=', '<=', '>=', '&&', '||', '<<', '>>'].includes(after.value));
                        if (castable) {
                            this.next();
                            return { kind: 'Cast', type, operand: this.parseUnary(), line: t.line };
                        }
                    }
                } catch (e) { /* not a cast */ }
            }
            this.p = save;
        }
        return this.parsePostfix();
    }

    parsePostfix() {
        let e = this.parsePrimary();
        for (;;) {
            const t = this.cur;
            if (this.isP('(')) {
                this.next();
                const args = [];
                if (!this.isP(')')) {
                    for (;;) { args.push(this.parseAssign()); if (this.isP(',')) { this.next(); continue; } break; }
                }
                this.expect('punct', ')');
                e = { kind: 'Call', callee: e, args, line: t.line, col: t.col };
                continue;
            }
            if (this.isP('[')) {
                this.next();
                const idx = this.parseExpression();
                this.expect('punct', ']');
                e = { kind: 'Index', obj: e, index: idx, line: t.line, col: t.col };
                continue;
            }
            if (this.isP('.') || this.isP('->')) {
                const arrow = this.cur.value === '->';
                this.next();
                const name = (this.cur.type === 'id' || this.cur.type === 'kw') ? this.next().value : this.err('expected member name');
                e = { kind: 'Member', obj: e, name, arrow, line: t.line, col: t.col };
                continue;
            }
            if (this.isP('++') || this.isP('--')) {
                const op = this.next().value;
                e = { kind: 'PostIncDec', op, operand: e, line: t.line, col: t.col };
                continue;
            }
            if (this.isP('::')) {
                this.next();
                const name = this.next().value;
                e = { kind: 'Scope', scope: e, name, line: t.line, col: t.col };
                continue;
            }
            break;
        }
        return e;
    }

    parsePrimary() {
        const t = this.cur;
        if (t.type === 'num') { this.next(); return { kind: 'Num', value: t.value.v, isFloat: t.value.isFloat, suffix: t.value.suffix, line: t.line, col: t.col }; }
        if (t.type === 'str') {
            this.next();
            let s = t.value;
            while (this.cur.type === 'str') s += this.next().value;   // adjacent literals
            return { kind: 'Str', value: s, line: t.line, col: t.col };
        }
        if (t.type === 'char') { this.next(); return { kind: 'Char', value: t.value, line: t.line, col: t.col }; }
        if (this.isKw('true')) { this.next(); return { kind: 'Bool', value: 1, line: t.line }; }
        if (this.isKw('false')) { this.next(); return { kind: 'Bool', value: 0, line: t.line }; }
        if (this.isKw('nullptr')) { this.next(); return { kind: 'Null', line: t.line }; }
        if (this.isKw('this')) { this.next(); return { kind: 'This', line: t.line }; }

        if (this.isP('[')) {                       // lambda
            const save = this.p;
            this.next();
            let depth = 1;
            while (depth && !this.is('eof')) {
                if (this.isP('[')) depth++;
                if (this.isP(']')) depth--;
                this.next();
            }
            if (this.isP('(') || this.isP('{')) {
                const params = this.isP('(') ? this.parseParams() : [];
                while (this.isKw('mutable') || this.isKw('const') || this.isKw('noexcept')) this.next();
                let ret = null;
                if (this.isP('->')) { this.next(); ret = this.parseType(); }
                const body = this.parseBlock();
                return { kind: 'Lambda', params, body, retType: ret, line: t.line };
            }
            this.p = save;
        }

        if (this.isP('(')) {
            this.next();
            const e = this.parseExpression();
            this.expect('punct', ')');
            return { kind: 'Paren', expr: e, line: t.line };
        }
        if (this.isP('{')) return this.parseBraceInit();

        if (t.type === 'id' || (t.type === 'kw' && BUILTIN_TYPES.has(t.value))) {
            this.next();
            // template-id used as a constructor call, e.g. vector<int>(n)
            if (this.isP('<') && ['vector', 'pair', 'map', 'set', 'queue', 'stack'].includes(t.value)) {
                const save = this.p;
                try {
                    this.next();
                    const args = [];
                    if (!this.isP('>')) {
                        for (;;) { args.push(this.parseType()); if (this.isP(',')) { this.next(); continue; } break; }
                    }
                    if (this.isP('>>')) this.cur.value = '>'; else this.expect('punct', '>');
                    return { kind: 'Ident', name: t.value, targs: args, line: t.line, col: t.col };
                } catch (e) { this.p = save; }
            }
            return { kind: 'Ident', name: t.value, line: t.line, col: t.col };
        }
        this.err(`expected primary-expression before '${tokText(t)}'`);
    }
}

function tokText(t) {
    if (!t) return 'end of input';
    if (t.type === 'eof') return 'end of input';
    if (t.type === 'num') return String(t.value.v);
    if (t.type === 'str') return '"' + t.value + '"';
    if (t.type === 'char') return "'" + String.fromCharCode(t.value) + "'";
    return String(t.value);
}

/* ================================================================= values */

const INT_TYPES = new Set(['int', 'short', 'long', 'long long', 'char', 'bool', 'size_t',
    'int8_t', 'int16_t', 'int32_t', 'int64_t', 'uint8_t', 'uint16_t', 'uint32_t', 'uint64_t']);

const num = (v, t) => ({ k: 'n', t: t || 'int', v });
const dbl = v => ({ k: 'n', t: 'double', v });
const chr = v => ({ k: 'n', t: 'char', v });
const bl = v => ({ k: 'n', t: 'bool', v: v ? 1 : 0 });
const str = s => ({ k: 's', v: s });
const VOID = { k: 'void' };
const NULLPTR = { k: 'p', a: null, i: 0 };

function slot(v) { return { v }; }

function isNum(x) { return x && x.k === 'n'; }
function isStr(x) { return x && x.k === 's'; }
function isInt(x) { return isNum(x) && INT_TYPES.has(x.t); }

function truthy(x) {
    if (!x) return false;
    switch (x.k) {
        case 'n': return x.v !== 0;
        case 's': return x.v.length > 0;
        case 'p': return x.a !== null;
        case 'void': return false;
        default: return true;
    }
}

function toNumber(x) {
    if (isNum(x)) return x.v;
    if (x && x.k === 'p') return x.a ? 1 : 0;
    if (isStr(x)) return NaN;
    return 0;
}

function clampInt(v, t) {
    if (!Number.isFinite(v)) return v;
    v = Math.trunc(v);
    switch (t) {
        case 'char': case 'int8_t': return ((v + 128) & 255) - 128;
        case 'uint8_t': return v & 255;
        case 'bool': return v ? 1 : 0;
        case 'short': case 'int16_t': return ((v + 32768) & 65535) - 32768;
        case 'uint16_t': return v & 65535;
        case 'int': case 'long': case 'int32_t': return v | 0;
        case 'uint32_t': case 'unsigned': return v >>> 0;
        default: return v;      // long long: kept as a JS double
    }
}

function copyValue(v) {
    if (!v) return v;
    switch (v.k) {
        case 'n': return { k: 'n', t: v.t, v: v.v };
        case 's': return { k: 's', v: v.v };
        case 'a': case 'v': return { k: v.k, et: v.et, a: v.a.map(s => slot(copyValue(s.v))) };
        case 'o': {
            const f = {};
            for (const key in v.f) f[key] = slot(copyValue(v.f[key].v));
            return { k: 'o', cls: v.cls, f };
        }
        case 'm': return { k: 'm', ordered: v.ordered, e: v.e.map(p => ({ key: copyValue(p.key), slot: slot(copyValue(p.slot.v)) })) };
        case 'set': return { k: 'set', ordered: v.ordered, e: v.e.map(x => copyValue(x)) };
        default: return v;
    }
}

/* A string literal is a `const char*`; as a map/set key or in a comparison it
   has to behave like the string it spells, not like an address. */
function asKey(v) {
    return (v && v.k === 'p' && v.charPtr) ? str(valueToString(v)) : v;
}

/* Ordering used by map/set/sort for the built-in value kinds. */
function cmpValues(a, b) {
    a = asKey(a); b = asKey(b);
    if (isStr(a) && isStr(b)) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (isNum(a) && isNum(b)) return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
    if (a.k === 'o' && b.k === 'o') {
        for (const key of Object.keys(a.f)) {
            const c = cmpValues(a.f[key].v, b.f[key].v);
            if (c) return c;
        }
        return 0;
    }
    if (a.k === 'v' && b.k === 'v') {
        for (let i = 0; i < Math.min(a.a.length, b.a.length); i++) {
            const c = cmpValues(a.a[i].v, b.a[i].v);
            if (c) return c;
        }
        return a.a.length - b.a.length;
    }
    return toNumber(a) - toNumber(b);
}
function eqValues(a, b) { return cmpValues(a, b) === 0; }

/* --------------------------------------------------- number -> text (cout) */

function fmtG(v, precision) {
    if (!Number.isFinite(v)) return v > 0 ? 'inf' : (v < 0 ? '-inf' : 'nan');
    if (Number.isNaN(v)) return 'nan';
    if (v === 0) return '0';
    const exp = Math.floor(Math.log10(Math.abs(v)));
    let s;
    if (exp < -5 || exp >= precision) {
        s = v.toExponential(Math.max(0, precision - 1));
        let [m, e] = s.split('e');
        if (m.indexOf('.') >= 0) m = m.replace(/0+$/, '').replace(/\.$/, '');
        const sign = e[0] === '-' ? '-' : '+';
        let digits = e.replace(/[+\-]/, '');
        if (digits.length < 2) digits = '0' + digits;
        return m + 'e' + sign + digits;
    }
    s = v.toFixed(Math.max(0, precision - 1 - exp));
    if (s.indexOf('.') >= 0) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s;
}

function valueToString(v, st) {
    st = st || { precision: 6, fixed: false, scientific: false, boolalpha: false };
    if (!v) return '';
    switch (v.k) {
        case 'n':
            if (v.t === 'char') return String.fromCharCode(v.v);
            if (v.t === 'bool') return st.boolalpha ? (v.v ? 'true' : 'false') : String(v.v ? 1 : 0);
            if (INT_TYPES.has(v.t)) return String(Math.trunc(v.v));
            if (st.fixed) return v.v.toFixed(st.precision);
            if (st.scientific) return v.v.toExponential(st.precision);
            return fmtG(v.v, st.precision);
        case 's': return v.v;
        case 'p':
            if (!v.a) return '0';
            if (v.charPtr) return v.a.slice(v.i).map(s => String.fromCharCode(s.v.v)).join('').replace(/\0[\s\S]*$/, '');
            return '0x' + (0x60000000 + v.i * 4).toString(16);
        case 'v': return '[vector]';
        case 'o': return '[object]';
        case 'void': return '';
        default: return String(v.v);
    }
}

/* ================================================================ runtime */

class ReturnSignal { constructor(value) { this.value = value; } }
class BreakSignal { }
class ContinueSignal { }
class ThrowSignal { constructor(value) { this.value = value; } }

class RuntimeError extends Error {
    constructor(msg, line) { super(msg); this.line = line; }
}

class Scope {
    constructor(parent) { this.vars = new Map(); this.parent = parent; }
    lookup(name) {
        let s = this;
        while (s) { if (s.vars.has(name)) return s.vars.get(name); s = s.parent; }
        return null;
    }
    define(name, sl) { this.vars.set(name, sl); return sl; }
}

/* ============================================================ interpreter */

class Interpreter {
    constructor(program, io) {
        this.program = program;
        this.io = io;                    // {write(s), needInput()}
        this.globals = new Scope(null);
        this.funcs = new Map();          // name -> [FuncDecl]
        this.classes = new Map();
        this.enums = new Map();
        this.input = '';
        this.inputClosed = false;
        this.streamState = { precision: 6, fixed: false, scientific: false, boolalpha: false, width: 0, fill: ' ' };
        this.callDepth = 0;
        this.steps = 0;
        this.exitCode = 0;
        this.randSeed = 1;
        this.callStack = [];
    }

    out(s) { this.io.write(s); }

    error(msg, line) { throw new RuntimeError(msg, line); }

    /* --- program setup -------------------------------------------------- */

    prepare() {
        const declare = decls => {
            for (const d of decls) {
                switch (d.kind) {
                    case 'FuncDecl': {
                        if (!this.funcs.has(d.name)) this.funcs.set(d.name, []);
                        this.funcs.get(d.name).push(d);
                        break;
                    }
                    case 'ClassDecl':
                        this.classes.set(d.name, d);
                        break;
                    case 'EnumDecl': {
                        let auto = 0;
                        for (const m of d.members) {
                            let v = auto;
                            if (m.value && m.value.kind === 'Num') v = m.value.value;
                            this.globals.define(m.name, slot(num(v)));
                            auto = v + 1;
                        }
                        break;
                    }
                    default: break;
                }
            }
        };
        declare(this.program.decls);
        this.globalVarDecls = this.program.decls.filter(d => d.kind === 'DeclGroup');
    }

    *initGlobals() {
        for (const g of this.globalVarDecls) yield* this.execStatement(g, this.globals);
    }

    /* --- helpers -------------------------------------------------------- */

    defaultValue(type) {
        const n = type.name;
        if (type.ptr > 0) return { k: 'p', a: null, i: 0 };
        if (n === 'string') return str('');
        if (n === 'vector' || n === 'deque' || n === 'list' || n === 'array')
            return { k: 'v', et: (type.args && type.args[0]) || { name: 'int', ptr: 0 }, a: [] };
        if (n === 'map' || n === 'unordered_map' || n === 'multimap')
            return { k: 'm', ordered: n === 'map' || n === 'multimap', e: [], kt: type.args && type.args[0], vt: type.args && type.args[1] };
        if (n === 'set' || n === 'unordered_set' || n === 'multiset')
            return { k: 'set', ordered: n === 'set' || n === 'multiset', e: [] };
        if (n === 'pair') {
            return {
                k: 'o', cls: '#pair',
                f: {
                    first: slot(this.defaultValue((type.args && type.args[0]) || { name: 'int', ptr: 0 })),
                    second: slot(this.defaultValue((type.args && type.args[1]) || { name: 'int', ptr: 0 })),
                },
            };
        }
        if (n === 'queue' || n === 'stack' || n === 'priority_queue')
            return { k: 'q', kind: n, a: [] };
        if (n === 'bool') return bl(0);
        if (n === 'char') return chr(0);
        if (n === 'float' || n === 'double') return { k: 'n', t: 'double', v: 0 };
        if (INT_TYPES.has(n)) return num(0, n);
        if (this.classes.has(n)) return this.makeObject(n);
        if (n === 'auto' || n === 'void') return num(0);
        return num(0);
    }

    makeObject(clsName) {
        const cls = this.classes.get(clsName);
        const o = { k: 'o', cls: clsName, f: {} };
        const addFields = c => {
            if (!c) return;
            for (const b of (c.bases || [])) addFields(this.classes.get(b));
            for (const f of c.fields) o.f[f.name] = slot(this.makeFieldValue(f));
        };
        addFields(cls);
        return o;
    }
    makeFieldValue(f) {
        if (f.dims && f.dims.length) {
            const dims = f.dims.map(d => (d && d.kind === 'Num') ? d.value : 0);
            return this.makeArray(f.type, dims, 0);
        }
        return this.defaultValue(f.type);
    }
    makeArray(type, dims, depth) {
        const n = dims[depth] || 0;
        const a = [];
        for (let i = 0; i < n; i++)
            a.push(slot(depth + 1 < dims.length ? this.makeArray(type, dims, depth + 1)
                                                : this.defaultValue(type)));
        return { k: 'a', et: type, a };
    }

    findMethod(clsName, method) {
        let c = this.classes.get(clsName);
        const seen = new Set();
        while (c && !seen.has(c.name)) {
            seen.add(c.name);
            const m = c.methods.filter(x => x.name === method);
            if (m.length) return m;
            c = c.bases && c.bases.length ? this.classes.get(c.bases[0]) : null;
        }
        return null;
    }

    /* --- statements ----------------------------------------------------- */

    *execBlock(block, scope) {
        const s = new Scope(scope);
        for (const st of block.body) yield* this.execStatement(st, s);
    }

    *execStatement(node, scope) {
        if (!node) return;
        this.steps++;
        if (node.line) {
            // the debugger reads locals out of the scope that is live here
            this.currentScope = scope;
            const sig = yield { t: 'stmt', line: node.line };
            if (sig === 'abort') throw new RuntimeError('aborted', node.line);
        }

        switch (node.kind) {
            case 'Block': yield* this.execBlock(node, scope); return;
            case 'Empty': return;
            case 'ExprStmt': yield* this.eval(node.expr, scope); return;

            case 'DeclGroup':
                for (const d of node.decls) yield* this.execVarDecl(d, scope);
                return;

            case 'If':
                if (truthy(yield* this.eval(node.cond, scope))) yield* this.execStatement(node.then, new Scope(scope));
                else if (node.alt) yield* this.execStatement(node.alt, new Scope(scope));
                return;

            case 'While':
                while (truthy(yield* this.eval(node.cond, scope))) {
                    try { yield* this.execStatement(node.body, new Scope(scope)); }
                    catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (e instanceof ContinueSignal) continue;
                        throw e;
                    }
                }
                return;

            case 'DoWhile':
                do {
                    try { yield* this.execStatement(node.body, new Scope(scope)); }
                    catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (!(e instanceof ContinueSignal)) throw e;
                    }
                } while (truthy(yield* this.eval(node.cond, scope)));
                return;

            case 'For': {
                const s = new Scope(scope);
                if (node.init) yield* this.execStatement(node.init, s);
                for (;;) {
                    if (node.cond && !truthy(yield* this.eval(node.cond, s))) break;
                    try { yield* this.execStatement(node.body, new Scope(s)); }
                    catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (!(e instanceof ContinueSignal)) throw e;
                    }
                    if (node.step) yield* this.eval(node.step, s);
                }
                return;
            }

            case 'RangeFor': {
                const cont = yield* this.eval(node.range, scope);
                const items = this.iterableSlots(cont, node.line);
                for (const it of items) {
                    const s = new Scope(scope);
                    s.define(node.name, node.type.ref ? it : slot(copyValue(it.v)));
                    try { yield* this.execStatement(node.body, s); }
                    catch (e) {
                        if (e instanceof BreakSignal) break;
                        if (!(e instanceof ContinueSignal)) throw e;
                    }
                }
                return;
            }

            case 'Switch': {
                const d = yield* this.eval(node.disc, scope);
                let start = node.cases.findIndex(c => c.test && eqValues(d, this.constEval(c.test, scope)));
                if (start < 0) start = node.cases.findIndex(c => !c.test);
                if (start < 0) return;
                const s = new Scope(scope);
                try {
                    for (let i = start; i < node.cases.length; i++)
                        for (const st of node.cases[i].body) yield* this.execStatement(st, s);
                } catch (e) {
                    if (!(e instanceof BreakSignal)) throw e;
                }
                return;
            }

            case 'Return':
                throw new ReturnSignal(node.value ? copyValue(yield* this.eval(node.value, scope)) : VOID);
            case 'Break': throw new BreakSignal();
            case 'Continue': throw new ContinueSignal();
            case 'Throw': throw new ThrowSignal(node.value ? yield* this.eval(node.value, scope) : VOID);

            case 'Try':
                try { yield* this.execStatement(node.body, scope); }
                catch (e) {
                    if (e instanceof ThrowSignal && node.handlers.length) {
                        const h = node.handlers[0];
                        const s = new Scope(scope);
                        if (h.name) s.define(h.name, slot(e.value));
                        yield* this.execStatement(h.body, s);
                        return;
                    }
                    if (e instanceof RuntimeError && node.handlers.length) {
                        const h = node.handlers[0];
                        const s = new Scope(scope);
                        if (h.name) s.define(h.name, slot(str(e.message)));
                        yield* this.execStatement(h.body, s);
                        return;
                    }
                    throw e;
                }
                return;

            case 'ClassDecl': this.classes.set(node.name, node); return;
            case 'EnumDecl': {
                let auto = 0;
                for (const m of node.members) {
                    let v = auto;
                    if (m.value) v = toNumber(this.constEval(m.value, scope));
                    scope.define(m.name, slot(num(v)));
                    auto = v + 1;
                }
                return;
            }
            case 'TypeAlias': case 'FuncDecl': case 'FuncProto': return;
            default:
                this.error(`unsupported statement '${node.kind}'`, node.line);
        }
    }

    constEval(node, scope) {
        const g = this.eval(node, scope);
        let r = g.next();
        while (!r.done) r = g.next();
        return r.value;
    }

    iterableSlots(cont, line) {
        if (!cont) return [];
        if (cont.k === 'v' || cont.k === 'a') return cont.a;
        if (cont.k === 's') return Array.from(cont.v).map(c => slot(chr(c.charCodeAt(0))));
        if (cont.k === 'set') return cont.e.map(x => slot(x));
        if (cont.k === 'm') return cont.e.map(p => slot({ k: 'o', cls: '#pair', f: { first: slot(p.key), second: p.slot } }));
        this.error('range-based for requires a container', line);
    }

    *execVarDecl(d, scope) {
        let type = d.type;
        let value;

        if (d.dims && d.dims.length) {
            const dims = [];
            for (const dim of d.dims) dims.push(dim ? Math.trunc(toNumber(yield* this.eval(dim, scope))) : -1);
            let init = null;
            if (d.init && d.init.kind === 'InitList') init = d.init;
            if (dims[0] === -1) dims[0] = init ? init.items.length : 0;
            const arr = this.makeArray(type, dims, 0);
            if (init) yield* this.fillArray(arr, init, scope);
            else if (d.init && d.init.kind === 'Str') {
                const s = (yield* this.eval(d.init, scope)).v;
                for (let i = 0; i < arr.a.length; i++) arr.a[i].v = chr(i < s.length ? s.charCodeAt(i) : 0);
            }
            scope.define(d.name, slot(arr));
            return;
        }

        if (d.initKind === 'copy' && d.init) {
            if (d.init.kind === 'InitList') {
                value = yield* this.makeFromInitList(type, d.init, scope);
            } else {
                const v = yield* this.eval(d.init, scope, type.ref);
                if (type.ref) {
                    // bind the alias to the very same slot
                    const sl = this.lastLValue || slot(v);
                    scope.define(d.name, sl);
                    return;
                }
                value = this.convert(copyValue(v), type);
            }
        } else if (d.initKind === 'ctor') {
            value = yield* this.constructValue(type, d.init.args, scope, d.line);
        } else {
            value = this.defaultValue(type);
            if (this.classes.has(type.name)) {
                const ctors = this.findMethod(type.name, type.name);
                if (ctors && ctors.some(c => c.params.length === 0))
                    yield* this.callFunction(ctors.find(c => c.params.length === 0), [], value, d.line);
            }
        }
        scope.define(d.name, slot(value));
    }

    *fillArray(arr, init, scope) {
        for (let i = 0; i < init.items.length && i < arr.a.length; i++) {
            const item = init.items[i];
            if (item.kind === 'InitList' && arr.a[i].v.k === 'a') yield* this.fillArray(arr.a[i].v, item, scope);
            else arr.a[i].v = this.convert(copyValue(yield* this.eval(item, scope)), arr.et);
        }
    }

    *makeFromInitList(type, init, scope) {
        const base = this.defaultValue(type);
        if (base.k === 'v') {
            for (const item of init.items) {
                const v = item.kind === 'InitList'
                    ? yield* this.makeFromInitList(type.args ? type.args[0] : { name: 'int', ptr: 0 }, item, scope)
                    : copyValue(yield* this.eval(item, scope));
                base.a.push(slot(v));
            }
            return base;
        }
        if (base.k === 'set') {
            for (const item of init.items) this.setInsert(base, copyValue(yield* this.eval(item, scope)));
            return base;
        }
        if (base.k === 'o' && base.cls === '#pair') {
            if (init.items[0]) base.f.first.v = copyValue(yield* this.eval(init.items[0], scope));
            if (init.items[1]) base.f.second.v = copyValue(yield* this.eval(init.items[1], scope));
            return base;
        }
        if (base.k === 'o') {
            const cls = this.classes.get(type.name);
            const names = cls ? cls.fields.map(f => f.name) : Object.keys(base.f);
            for (let i = 0; i < init.items.length && i < names.length; i++)
                base.f[names[i]].v = copyValue(yield* this.eval(init.items[i], scope));
            return base;
        }
        if (init.items.length) return this.convert(copyValue(yield* this.eval(init.items[0], scope)), type);
        return base;
    }

    *constructValue(type, args, scope, line) {
        const vals = [];
        for (const a of args) vals.push(yield* this.eval(a, scope));

        if (type.name === 'string') {
            if (!vals.length) return str('');
            if (vals.length === 1 && isStr(vals[0])) return str(vals[0].v);
            if (vals.length === 2 && isNum(vals[0]) && isNum(vals[1]))
                return str(String.fromCharCode(vals[1].v).repeat(Math.max(0, vals[0].v)));
            if (vals.length === 1 && vals[0].k === 'p' && vals[0].charPtr) return str(valueToString(vals[0]));
            return str(valueToString(vals[0]));
        }
        if (type.name === 'vector') {
            const et = (type.args && type.args[0]) || { name: 'int', ptr: 0 };
            const v = { k: 'v', et, a: [] };
            if (vals.length >= 1 && isNum(vals[0])) {
                const n = Math.max(0, Math.trunc(vals[0].v));
                const fill = vals.length >= 2 ? vals[1] : this.defaultValue(et);
                for (let i = 0; i < n; i++) v.a.push(slot(copyValue(fill)));
            } else if (vals.length === 1 && vals[0].k === 'v') {
                return copyValue(vals[0]);
            }
            return v;
        }
        if (type.name === 'pair') {
            return {
                k: 'o', cls: '#pair',
                f: { first: slot(vals[0] ? copyValue(vals[0]) : num(0)), second: slot(vals[1] ? copyValue(vals[1]) : num(0)) },
            };
        }
        if (this.classes.has(type.name)) {
            const obj = this.makeObject(type.name);
            const ctors = this.findMethod(type.name, type.name);
            if (ctors) {
                const c = this.pickOverload(ctors, vals);
                if (c) yield* this.callFunction(c, vals, obj, line);
            } else if (vals.length) {
                const cls = this.classes.get(type.name);
                cls.fields.forEach((f, i) => { if (vals[i]) obj.f[f.name].v = copyValue(vals[i]); });
            }
            return obj;
        }
        if (vals.length === 1) return this.convert(copyValue(vals[0]), type);
        return this.defaultValue(type);
    }

    convert(v, type) {
        if (!type || !v) return v;
        if (type.ptr > 0) return v;
        const n = type.name;
        if (n === 'auto') return v;
        if (n === 'string') return isStr(v) ? v : str(valueToString(v));
        if (n === 'bool') return bl(truthy(v));
        if (n === 'double' || n === 'float') return { k: 'n', t: 'double', v: toNumber(v) };
        if (INT_TYPES.has(n) && isNum(v)) return { k: 'n', t: n, v: clampInt(v.v, n) };
        return v;
    }

    pickOverload(cands, args) {
        let best = null, bestScore = -1;
        for (const f of cands) {
            const required = f.params.filter(p => !p.def && !p.variadic).length;
            const maxp = f.params.some(p => p.variadic) ? 99 : f.params.length;
            if (args.length < required || args.length > maxp) continue;
            let score = 1;
            for (let i = 0; i < Math.min(args.length, f.params.length); i++) {
                const p = f.params[i];
                if (!p.type) continue;
                const a = args[i];
                const want = p.type.name;
                if (want === 'string' && isStr(a)) score += 2;
                else if ((want === 'double' || want === 'float') && isNum(a) && !INT_TYPES.has(a.t)) score += 2;
                else if (INT_TYPES.has(want) && isNum(a) && INT_TYPES.has(a.t)) score += 2;
                else if (want === 'auto' || p.type.templateParam) score += 1;
                else if (a && a.k === 'o' && a.cls === want) score += 3;
                else if (a && a.k === 'v' && want === 'vector') score += 2;
            }
            if (score > bestScore) { bestScore = score; best = f; }
        }
        return best;
    }

    *callFunction(decl, args, thisObj, line) {
        if (this.callDepth > 900)
            this.error('stack overflow (too deep recursion)', line);
        const scope = new Scope(this.globals);
        if (thisObj) scope.define('this', slot({ k: 'p', a: [slot(thisObj)], i: 0, isThis: true, obj: thisObj }));
        if (thisObj && thisObj.f) for (const key in thisObj.f) scope.vars.set(key, thisObj.f[key]);

        for (let i = 0; i < decl.params.length; i++) {
            const p = decl.params[i];
            if (p.variadic) break;
            let v;
            if (i < args.length) v = args[i];
            else if (p.def) v = yield* this.eval(p.def, scope);
            else v = this.defaultValue(p.type);
            if (p.type && p.type.ref && this.argSlots && this.argSlots[i]) scope.define(p.name, this.argSlots[i]);
            else if (p.dims && p.dims.length) scope.define(p.name, slot(v));
            else scope.define(p.name, slot(this.convert(copyValue(v), p.type)));
        }

        // constructor member-initialiser list
        if (decl.inits && thisObj) {
            for (const ini of decl.inits) {
                const vals = [];
                for (const a of ini.args) vals.push(yield* this.eval(a, scope));
                if (thisObj.f[ini.name]) thisObj.f[ini.name].v = vals[0] ? copyValue(vals[0]) : thisObj.f[ini.name].v;
            }
        }

        this.callDepth++;
        this.callStack.push({ name: decl.name, line: decl.line });
        try {
            if (decl.body) yield* this.execStatement(decl.body, scope);
            return this.convert(this.defaultValue(decl.retType || { name: 'void', ptr: 0 }), decl.retType);
        } catch (e) {
            if (e instanceof ReturnSignal) return this.convert(e.value, decl.retType);
            throw e;
        } finally {
            this.callDepth--;
            this.callStack.pop();
        }
    }

    /* --- expressions ---------------------------------------------------- */

    /* Evaluates `node`. When `wantSlot` is set the resulting storage location
       is left in this.lastLValue so references and assignment can use it. */
    *eval(node, scope, wantSlot) {
        if (!node) return VOID;
        this.steps++;
        if ((this.steps & 1023) === 0) {
            const sig = yield { t: 'tick' };
            if (sig === 'abort') throw new RuntimeError('aborted', node.line);
        }
        this.lastLValue = null;

        switch (node.kind) {
            case 'Num':
                if (node.isFloat) return dbl(node.value);
                if (/[uU]?[lL]{2}/.test(node.suffix || '')) return num(node.value, 'long long');
                return num(node.value, 'int');
            case 'Str': { const p = this.makeCharPtr(node.value); return p; }
            case 'Char': return chr(node.value);
            case 'Bool': return bl(node.value);
            case 'Null': return NULLPTR;
            case 'Paren': return yield* this.eval(node.expr, scope, wantSlot);
            case 'Comma': yield* this.eval(node.left, scope); return yield* this.eval(node.right, scope, wantSlot);

            case 'This': {
                const sl = scope.lookup('this');
                return sl ? sl.v : NULLPTR;
            }

            case 'Ident': {
                const sl = scope.lookup(node.name);
                if (sl) { this.lastLValue = sl; return sl.v; }
                if (BUILTINS.streams[node.name]) return BUILTINS.streams[node.name];
                if (this.funcs.has(node.name)) return { k: 'f', decls: this.funcs.get(node.name), name: node.name };
                if (BUILTINS.consts[node.name] !== undefined) return BUILTINS.consts[node.name];
                if (BUILTINS.funcs[node.name] || this.classes.has(node.name) || BUILTIN_TYPES.has(node.name))
                    return { k: 'f', native: node.name, targs: node.targs };
                this.error(`'${node.name}' was not declared in this scope`, node.line);
                break;
            }

            case 'Scope': {
                // std::something / Class::member
                if (node.scope.kind === 'Ident' && node.scope.name === 'std')
                    return yield* this.eval({ kind: 'Ident', name: node.name, line: node.line }, scope, wantSlot);
                const cls = node.scope.kind === 'Ident' ? node.scope.name : null;
                if (cls && this.classes.has(cls)) {
                    const m = this.findMethod(cls, node.name);
                    if (m) return { k: 'f', decls: m, name: node.name };
                }
                return yield* this.eval({ kind: 'Ident', name: node.name, line: node.line }, scope, wantSlot);
            }

            case 'Assign': return yield* this.evalAssign(node, scope);

            case 'Binary': return yield* this.evalBinary(node, scope);

            case 'Unary': {
                if (node.op === '&') {
                    yield* this.eval(node.operand, scope, true);
                    const sl = this.lastLValue;
                    if (!sl) this.error('lvalue required as unary \'&\' operand', node.line);
                    if (this.lastContainer)
                        return { k: 'p', a: this.lastContainer.a, i: this.lastContainer.i, charPtr: this.lastContainer.charPtr };
                    return { k: 'p', a: [sl], i: 0 };
                }
                const v = yield* this.eval(node.operand, scope, node.op === '*');
                switch (node.op) {
                    case '+': return v;
                    case '-': return isNum(v) && INT_TYPES.has(v.t) ? num(-v.v, v.t) : dbl(-toNumber(v));
                    case '!': return bl(!truthy(v));
                    case '~': return num(~toNumber(v), 'int');
                    case '*': {
                        if (!v || v.k !== 'p' || !v.a) this.error('dereferencing a null pointer', node.line);
                        const sl = v.a[v.i];
                        if (!sl) this.error('dereferencing an out-of-range pointer', node.line);
                        this.lastLValue = sl;
                        this.lastContainer = { a: v.a, i: v.i, charPtr: v.charPtr };
                        return sl.v;
                    }
                }
                break;
            }

            case 'PreIncDec': {
                yield* this.eval(node.operand, scope, true);
                const sl = this.lastLValue;
                if (!sl) this.error('lvalue required as increment operand', node.line);
                sl.v = this.step(sl.v, node.op === '++' ? 1 : -1, node.line);
                this.lastLValue = sl;
                return sl.v;
            }
            case 'PostIncDec': {
                yield* this.eval(node.operand, scope, true);
                const sl = this.lastLValue;
                if (!sl) this.error('lvalue required as increment operand', node.line);
                const old = copyValue(sl.v);
                sl.v = this.step(sl.v, node.op === '++' ? 1 : -1, node.line);
                return old;
            }

            case 'Ternary':
                return truthy(yield* this.eval(node.cond, scope))
                    ? yield* this.eval(node.then, scope, wantSlot)
                    : yield* this.eval(node.alt, scope, wantSlot);

            case 'Cast': {
                const v = yield* this.eval(node.operand, scope);
                if (node.type.ptr > 0) return v;
                return this.convert(copyValue(v), node.type);
            }

            case 'SizeofType': return num(sizeofType(node.type), 'size_t');
            case 'SizeofExpr': {
                const v = yield* this.eval(node.operand, scope);
                return num(sizeofValue(v), 'size_t');
            }

            case 'New': {
                if (node.count) {
                    const n = Math.trunc(toNumber(yield* this.eval(node.count, scope)));
                    const a = [];
                    for (let i = 0; i < n; i++) a.push(slot(this.defaultValue(node.type)));
                    return { k: 'p', a, i: 0, heap: true };
                }
                const v = yield* this.constructValue(node.type, node.args || [], scope, node.line);
                return { k: 'p', a: [slot(v)], i: 0, heap: true };
            }
            case 'Delete': yield* this.eval(node.operand, scope); return VOID;

            case 'Index': {
                const obj = yield* this.eval(node.obj, scope, true);
                const idx = yield* this.eval(node.index, scope);
                return this.indexInto(obj, idx, node.line);
            }

            case 'Member': {
                const obj = yield* this.eval(node.obj, scope, true);
                return this.memberOf(obj, node.name, node.line, node.arrow);
            }

            case 'Call': return yield* this.evalCall(node, scope);

            case 'Lambda':
                return { k: 'f', lambda: node, closure: scope };

            case 'InitList': {
                const v = { k: 'v', et: { name: 'auto', ptr: 0 }, a: [] };
                for (const it of node.items) v.a.push(slot(copyValue(yield* this.eval(it, scope))));
                return v;
            }

            default:
                this.error(`unsupported expression '${node.kind}'`, node.line);
        }
    }

    makeCharPtr(s) {
        const a = [];
        for (const c of s) a.push(slot(chr(c.charCodeAt(0))));
        a.push(slot(chr(0)));
        return { k: 'p', a, i: 0, charPtr: true, literal: s };
    }

    step(v, delta, line) {
        if (isNum(v)) return { k: 'n', t: v.t, v: INT_TYPES.has(v.t) ? clampInt(v.v + delta, v.t) : v.v + delta };
        if (v && v.k === 'p' && v.a) return { k: 'p', a: v.a, i: v.i + delta, charPtr: v.charPtr };
        if (v && v.k === 'it') return { k: 'it', c: v.c, i: v.i + delta, cont: v.cont };
        this.error('invalid operand to increment', line);
    }

    indexInto(obj, idx, line) {
        if (!obj) this.error('invalid subscript', line);
        if (obj.k === 'a' || obj.k === 'v') {
            const i = Math.trunc(toNumber(idx));
            if (i < 0 || i >= obj.a.length) {
                // Out of range reads are what C++ would do silently; report it,
                // because a hard error here is much more useful than garbage.
                this.error(`index ${i} is out of bounds (size ${obj.a.length})`, line);
            }
            this.lastLValue = obj.a[i];
            this.lastContainer = { a: obj.a, i };
            return obj.a[i].v;
        }
        if (obj.k === 's') {
            const i = Math.trunc(toNumber(idx));
            const self = obj;
            const sl = {
                get v() { return chr(self.v.charCodeAt(i) || 0); },
                set v(nv) {
                    const c = String.fromCharCode(toNumber(nv));
                    self.v = self.v.slice(0, i) + c + self.v.slice(i + 1);
                },
            };
            this.lastLValue = sl;
            return sl.v;
        }
        if (obj.k === 'p') {
            if (!obj.a) this.error('dereferencing a null pointer', line);
            const i = obj.i + Math.trunc(toNumber(idx));
            if (!obj.a[i]) this.error(`index ${i} is out of bounds`, line);
            this.lastLValue = obj.a[i];
            this.lastContainer = { a: obj.a, i };
            return obj.a[i].v;
        }
        if (obj.k === 'm') {
            const e = this.mapFind(obj, idx);
            if (e) { this.lastLValue = e.slot; return e.slot.v; }
            const ne = { key: asKey(copyValue(idx)), slot: slot(this.defaultValue(obj.vt || { name: 'int', ptr: 0 })) };
            obj.e.push(ne);
            if (obj.ordered) obj.e.sort((x, y) => cmpValues(x.key, y.key));
            this.lastLValue = ne.slot;
            return ne.slot.v;
        }
        this.error('invalid types for array subscript', line);
    }

    mapFind(m, key) { return m.e.find(p => eqValues(p.key, key)); }
    setInsert(s, v) {
        if (s.e.some(x => eqValues(x, v))) return false;
        s.e.push(v);
        if (s.ordered) s.e.sort(cmpValues);
        return true;
    }

    memberOf(obj, name, line, arrow) {
        let target = obj;
        if (obj && obj.k === 'p') {
            if (!obj.a) this.error('dereferencing a null pointer', line);
            target = obj.a[obj.i].v;
        }
        if (target && target.k === 'o' && target.f && Object.prototype.hasOwnProperty.call(target.f, name)) {
            this.lastLValue = target.f[name];
            return target.f[name].v;
        }
        // method or built-in container member: return a bound callable
        if (target && target.k === 'o' && this.classes.has(target.cls)) {
            const m = this.findMethod(target.cls, name);
            if (m) return { k: 'f', decls: m, thisObj: target, name };
        }
        void arrow;
        return { k: 'bound', obj: target, name, holder: this.lastLValue };
    }

    /* --- assignment ----------------------------------------------------- */

    *evalAssign(node, scope) {
        yield* this.eval(node.left, scope, true);
        const sl = this.lastLValue;
        if (!sl) this.error('lvalue required as left operand of assignment', node.line);
        const rhs = yield* this.eval(node.right, scope);

        if (node.op === '=') {
            const cur = sl.v;
            let v = copyValue(rhs);
            if (cur && isNum(cur) && isNum(v)) v = { k: 'n', t: cur.t, v: INT_TYPES.has(cur.t) ? clampInt(v.v, cur.t) : v.v };
            else if (cur && isStr(cur) && !isStr(v)) v = str(valueToString(v));
            sl.v = v;
            this.lastLValue = sl;
            return sl.v;
        }
        const op = node.op.slice(0, -1);
        sl.v = this.binop(op, sl.v, rhs, node.line, sl.v);
        this.lastLValue = sl;
        return sl.v;
    }

    /* --- binary operators ------------------------------------------------ */

    *evalBinary(node, scope) {
        // stream insertion / extraction
        if (node.op === '<<' || node.op === '>>') {
            const left = yield* this.eval(node.left, scope, true);
            if (left && left.k === 'stream') {
                if (node.op === '<<') {
                    const v = yield* this.eval(node.right, scope);
                    yield* this.streamOut(left, v, node.line);
                    return left;
                }
                yield* this.eval(node.right, scope, true);
                const sl = this.lastLValue;
                if (!sl) this.error('invalid operand for >>', node.line);
                const ok = yield* this.readInto(sl, node.line);
                left.eof = !ok;
                return left;
            }
        }
        if (node.op === '&&') {
            const l = yield* this.eval(node.left, scope);
            if (!truthy(l)) return bl(0);
            return bl(truthy(yield* this.eval(node.right, scope)));
        }
        if (node.op === '||') {
            const l = yield* this.eval(node.left, scope);
            if (truthy(l)) return bl(1);
            return bl(truthy(yield* this.eval(node.right, scope)));
        }
        const l = yield* this.eval(node.left, scope);
        const lc = this.lastContainer;
        const r = yield* this.eval(node.right, scope);
        this.lastContainer = lc;
        return this.binop(node.op, l, r, node.line);
    }

    binop(op, l, r, line, targetHint) {
        // string concatenation
        if (op === '+' && (isStr(l) || isStr(r))) {
            if (isStr(l) || isStr(r)) {
                const ls = isStr(l) ? l.v : (l.k === 'p' && l.charPtr ? valueToString(l) : valueToString(l));
                const rs = isStr(r) ? r.v : (r.k === 'p' && r.charPtr ? valueToString(r) : valueToString(r));
                return str(ls + rs);
            }
        }
        if ((isStr(l) || isStr(r)) && ['==', '!=', '<', '>', '<=', '>='].includes(op)) {
            const ls = isStr(l) ? l.v : valueToString(l);
            const rs = isStr(r) ? r.v : valueToString(r);
            switch (op) {
                case '==': return bl(ls === rs);
                case '!=': return bl(ls !== rs);
                case '<': return bl(ls < rs);
                case '>': return bl(ls > rs);
                case '<=': return bl(ls <= rs);
                case '>=': return bl(ls >= rs);
            }
        }
        if ((l && l.k === 'o') && (r && r.k === 'o') && ['==', '!=', '<', '>', '<=', '>='].includes(op)) {
            const c = cmpValues(l, r);
            switch (op) {
                case '==': return bl(c === 0); case '!=': return bl(c !== 0);
                case '<': return bl(c < 0); case '>': return bl(c > 0);
                case '<=': return bl(c <= 0); case '>=': return bl(c >= 0);
            }
        }
        // pointer / iterator arithmetic
        if (l && (l.k === 'p' || l.k === 'it') && isNum(r) && (op === '+' || op === '-')) {
            const d = op === '+' ? r.v : -r.v;
            return l.k === 'p' ? { k: 'p', a: l.a, i: l.i + d, charPtr: l.charPtr }
                               : { k: 'it', c: l.c, i: l.i + d, cont: l.cont };
        }
        if (l && r && (l.k === 'p' || l.k === 'it') && (r.k === 'p' || r.k === 'it')) {
            if (op === '-') return num(l.i - r.i, 'long');
            const c = l.i - r.i;
            switch (op) {
                case '==': return bl((l.a === r.a || l.c === r.c) && c === 0);
                case '!=': return bl(!((l.a === r.a || l.c === r.c) && c === 0));
                case '<': return bl(c < 0); case '>': return bl(c > 0);
                case '<=': return bl(c <= 0); case '>=': return bl(c >= 0);
            }
        }
        if (l && l.k === 'p' && (op === '==' || op === '!=')) {
            const rn = r && r.k === 'p' ? (r.a ? 1 : 0) : toNumber(r);
            const ln = l.a ? 1 : 0;
            return bl(op === '==' ? ln === rn && (r.k !== 'p' || l.a === r.a) : !(ln === rn && (r.k !== 'p' || l.a === r.a)));
        }

        const a = toNumber(l), b = toNumber(r);
        const bothInt = (isNum(l) ? INT_TYPES.has(l.t) : true) && (isNum(r) ? INT_TYPES.has(r.t) : true);
        const rt = (targetHint && isNum(targetHint)) ? targetHint.t
                 : bothInt ? ((isNum(l) && l.t === 'long long') || (isNum(r) && r.t === 'long long') ? 'long long' : 'int')
                 : 'double';
        const mk = v => (rt === 'double' || !INT_TYPES.has(rt)) ? { k: 'n', t: 'double', v }
                                                                : { k: 'n', t: rt, v: clampInt(v, rt) };
        switch (op) {
            case '+': return mk(a + b);
            case '-': return mk(a - b);
            case '*': return mk(a * b);
            case '/':
                if (b === 0 && bothInt) this.error('division by zero', line);
                return mk(bothInt ? Math.trunc(a / b) : a / b);
            case '%':
                if (b === 0) this.error('division by zero', line);
                return mk(a % b);
            case '<': return bl(a < b);
            case '>': return bl(a > b);
            case '<=': return bl(a <= b);
            case '>=': return bl(a >= b);
            case '==': return bl(a === b);
            case '!=': return bl(a !== b);
            case '&': return num(a & b, 'int');
            case '|': return num(a | b, 'int');
            case '^': return num(a ^ b, 'int');
            case '<<': return num(a * Math.pow(2, b), rt === 'double' ? 'long long' : rt);
            case '>>': return num(Math.floor(a / Math.pow(2, b)), rt === 'double' ? 'long long' : rt);
            default: this.error(`unsupported operator '${op}'`, line);
        }
    }

    /* --- streams -------------------------------------------------------- */

    *streamOut(stream, v, line) {
        void line;
        const st = this.streamState;
        if (v && v.k === 'manip') {
            switch (v.name) {
                case 'endl': this.out('\n'); return;
                case 'flush': return;
                case 'setprecision': st.precision = v.arg; return;
                case 'fixed': st.fixed = true; st.scientific = false; return;
                case 'scientific': st.scientific = true; st.fixed = false; return;
                case 'setw': st.width = v.arg; return;
                case 'setfill': st.fill = String.fromCharCode(v.arg); return;
                case 'boolalpha': st.boolalpha = true; return;
                case 'noboolalpha': st.boolalpha = false; return;
                case 'left': st.left = true; return;
                case 'right': st.left = false; return;
                default: return;
            }
        }
        let s = valueToString(v, st);
        if (st.width && s.length < st.width) {
            const pad = st.fill.repeat(st.width - s.length);
            s = st.left ? s + pad : pad + s;
        }
        st.width = 0;
        if (stream.which === 'cerr' || stream.which === 'clog') this.io.writeErr ? this.io.writeErr(s) : this.out(s);
        else this.out(s);
    }

    *ensureInput(needToken) {
        for (;;) {
            if (needToken) {
                if (/\S/.test(this.input)) return true;
            } else if (this.input.length) return true;
            if (this.inputClosed) return false;
            const got = yield { t: 'input' };
            if (got === null || got === undefined) { this.inputClosed = true; return false; }
            this.input += got;
        }
    }

    *readInto(sl, line) {
        const cur = sl.v;
        if (cur && cur.k === 's') {
            if (!(yield* this.ensureInput(true))) return false;
            this.input = this.input.replace(/^\s+/, '');
            const m = /^\S+/.exec(this.input);
            if (!m) return false;
            this.input = this.input.slice(m[0].length);
            sl.v = str(m[0]);
            return true;
        }
        if (cur && cur.k === 'n' && cur.t === 'char') {
            if (!(yield* this.ensureInput(true))) return false;
            this.input = this.input.replace(/^\s+/, '');
            if (!this.input.length) return false;
            sl.v = chr(this.input.charCodeAt(0));
            this.input = this.input.slice(1);
            return true;
        }
        if (cur && cur.k === 'p' && cur.charPtr) {
            if (!(yield* this.ensureInput(true))) return false;
            this.input = this.input.replace(/^\s+/, '');
            const m = /^\S+/.exec(this.input);
            if (!m) return false;
            this.input = this.input.slice(m[0].length);
            for (let i = 0; i < m[0].length && cur.i + i < cur.a.length; i++)
                cur.a[cur.i + i].v = chr(m[0].charCodeAt(i));
            if (cur.a[cur.i + m[0].length]) cur.a[cur.i + m[0].length].v = chr(0);
            return true;
        }
        // numeric
        if (!(yield* this.ensureInput(true))) return false;
        this.input = this.input.replace(/^\s+/, '');
        const isFloatTarget = cur && isNum(cur) && !INT_TYPES.has(cur.t);
        const re = isFloatTarget ? /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/ : /^[-+]?\d+/;
        const m = re.exec(this.input);
        if (!m) {
            // failbit: C++ leaves the variable untouched and stops extracting
            return false;
        }
        this.input = this.input.slice(m[0].length);
        const v = parseFloat(m[0]);
        sl.v = isFloatTarget ? dbl(v) : { k: 'n', t: (cur && cur.t) || 'int', v: clampInt(v, (cur && cur.t) || 'int') };
        void line;
        return true;
    }

    *readLine(sl, delim) {
        if (!(yield* this.ensureInput(false))) { sl.v = str(''); return false; }
        const d = delim === undefined ? '\n' : delim;
        let idx = this.input.indexOf(d);
        while (idx < 0 && !this.inputClosed) {
            const got = yield { t: 'input' };
            if (got === null || got === undefined) { this.inputClosed = true; break; }
            this.input += got;
            idx = this.input.indexOf(d);
        }
        if (idx < 0) { sl.v = str(this.input); this.input = ''; return true; }
        sl.v = str(this.input.slice(0, idx));
        this.input = this.input.slice(idx + 1);
        return true;
    }

    /* --- calls ---------------------------------------------------------- */

    *evalCall(node, scope) {
        const callee = node.callee;

        // member call: obj.method(...)
        if (callee.kind === 'Member') {
            const objVal = yield* this.eval(callee.obj, scope, true);
            const holder = this.lastLValue;
            let target = objVal;
            if (target && target.k === 'p' && target.a) target = target.a[target.i].v;

            const args = [];
            this.argSlots = [];
            for (const a of node.args) {
                const v = yield* this.eval(a, scope, true);
                this.argSlots.push(this.lastLValue);
                args.push(v);
            }
            const slots = this.argSlots;

            if (target && target.k === 'o' && this.classes.has(target.cls)) {
                const m = this.findMethod(target.cls, callee.name);
                if (m) {
                    const f = this.pickOverload(m, args) || m[0];
                    this.argSlots = slots;
                    return yield* this.callFunction(f, args, target, node.line);
                }
            }
            return yield* this.builtinMethod(target, callee.name, args, slots, holder, node.line, scope);
        }

        // plain call
        const fn = yield* this.eval(callee, scope);
        const args = [];
        this.argSlots = [];
        for (const a of node.args) {
            const v = yield* this.eval(a, scope, true);
            this.argSlots.push(this.lastLValue);
            args.push(v);
        }
        const slots = this.argSlots;
        return yield* this.invoke(fn, args, slots, node, scope);
    }

    *invoke(fn, args, slots, node, scope) {
        if (!fn) this.error('call of a non-function', node.line);
        if (fn.k === 'f' && fn.decls) {
            const f = this.pickOverload(fn.decls, args) || fn.decls[0];
            this.argSlots = slots;
            return yield* this.callFunction(f, args, fn.thisObj || null, node.line);
        }
        if (fn.k === 'f' && fn.lambda) {
            const decl = { name: '<lambda>', params: fn.lambda.params, body: fn.lambda.body, retType: fn.lambda.retType, line: fn.lambda.line };
            const saved = this.globals;
            const sc = new Scope(fn.closure);
            const g = this.callLambda(decl, args, slots, sc);
            const r = yield* g;
            void saved;
            return r;
        }
        if (fn.k === 'f' && fn.native) {
            return yield* this.callNative(fn.native, args, slots, node, scope, fn.targs);
        }
        this.error('expression is not callable', node.line);
    }

    *callLambda(decl, args, slots, scope) {
        for (let i = 0; i < decl.params.length; i++) {
            const p = decl.params[i];
            if (p.type && p.type.ref && slots[i]) scope.define(p.name, slots[i]);
            else scope.define(p.name, slot(this.convert(copyValue(args[i] !== undefined ? args[i] : this.defaultValue(p.type)), p.type)));
        }
        this.callDepth++;
        try {
            yield* this.execStatement(decl.body, scope);
            return VOID;
        } catch (e) {
            if (e instanceof ReturnSignal) return e.value;
            throw e;
        } finally { this.callDepth--; }
    }

    /* Calls a comparator (function pointer or lambda) from sort/count_if/... */
    *callPredicate(fn, args, line) {
        return yield* this.invoke(fn, args, args.map(a => slot(a)), { line }, this.globals);
    }

    /* --- built-in free functions ---------------------------------------- */

    *callNative(name, args, slots, node, scope, targs) {
        const line = node.line;
        const A = args;
        const n0 = () => toNumber(A[0]);
        const n1 = () => toNumber(A[1]);

        switch (name) {
            /* --- construction of library types --------------------------- */
            case 'string': case 'vector': case 'pair': case 'map': case 'set':
            case 'queue': case 'stack': case 'deque': case 'list':
                return yield* this.constructValue({ name, ptr: 0, args: targs }, node.args, scope, line);
            case 'make_pair':
                return { k: 'o', cls: '#pair', f: { first: slot(copyValue(A[0])), second: slot(copyValue(A[1])) } };

            /* --- io ------------------------------------------------------ */
            case 'getline': {
                const target = slots[1];
                if (!target) this.error('getline requires a string variable', line);
                const delim = A[2] !== undefined ? String.fromCharCode(toNumber(A[2])) : undefined;
                const ok = yield* this.readLine(target, delim);
                const st = A[0] && A[0].k === 'stream' ? A[0] : BUILTINS.streams.cin;
                st.eof = !ok;
                return st;
            }
            case 'endl': return { k: 'manip', name: 'endl' };
            case 'setprecision': return { k: 'manip', name: 'setprecision', arg: n0() };
            case 'setw': return { k: 'manip', name: 'setw', arg: n0() };
            case 'setfill': return { k: 'manip', name: 'setfill', arg: n0() };

            /* --- math ---------------------------------------------------- */
            case 'sqrt': return dbl(Math.sqrt(n0()));
            case 'pow': return dbl(Math.pow(n0(), n1()));
            case 'abs': case 'fabs': case 'labs': case 'llabs': {
                const v = A[0];
                if (isNum(v) && INT_TYPES.has(v.t) && name !== 'fabs') return num(Math.abs(v.v), v.t);
                return dbl(Math.abs(toNumber(v)));
            }
            case 'floor': return dbl(Math.floor(n0()));
            case 'ceil': return dbl(Math.ceil(n0()));
            case 'round': return dbl(Math.round(n0()));
            case 'trunc': return dbl(Math.trunc(n0()));
            case 'sin': return dbl(Math.sin(n0()));
            case 'cos': return dbl(Math.cos(n0()));
            case 'tan': return dbl(Math.tan(n0()));
            case 'asin': return dbl(Math.asin(n0()));
            case 'acos': return dbl(Math.acos(n0()));
            case 'atan': return dbl(Math.atan(n0()));
            case 'atan2': return dbl(Math.atan2(n0(), n1()));
            case 'exp': return dbl(Math.exp(n0()));
            case 'log': return dbl(Math.log(n0()));
            case 'log2': return dbl(Math.log2(n0()));
            case 'log10': return dbl(Math.log10(n0()));
            case 'fmod': return dbl(n0() % n1());
            case 'hypot': return dbl(Math.hypot(n0(), n1()));
            case 'cbrt': return dbl(Math.cbrt(n0()));
            case '__gcd': case 'gcd': {
                let a = Math.abs(Math.trunc(n0())), b = Math.abs(Math.trunc(n1()));
                while (b) { const t = a % b; a = b; b = t; }
                return num(a, 'long long');
            }

            /* --- algorithm ----------------------------------------------- */
            case 'max': case 'min': {
                if (A.length === 1 && (A[0].k === 'v')) {
                    const vals = A[0].a.map(s => s.v);
                    let best = vals[0];
                    for (const v of vals) if ((name === 'max') === (cmpValues(v, best) > 0)) best = v;
                    return copyValue(best);
                }
                const c = cmpValues(A[0], A[1]);
                return copyValue((name === 'max') ? (c >= 0 ? A[0] : A[1]) : (c <= 0 ? A[0] : A[1]));
            }
            case 'swap': {
                if (slots[0] && slots[1]) {
                    const t = slots[0].v; slots[0].v = slots[1].v; slots[1].v = t;
                }
                return VOID;
            }
            case 'sort': case 'stable_sort': {
                const range = this.rangeOf(A[0], A[1], line);
                const vals = range.slots.map(s => copyValue(s.v));
                if (A[2]) {
                    const cmpFn = A[2];
                    const arr = vals.slice();
                    // insertion sort keeps the generator based comparator simple
                    for (let i = 1; i < arr.length; i++) {
                        const cur = arr[i];
                        let j = i - 1;
                        while (j >= 0) {
                            const less = truthy(yield* this.callPredicate(cmpFn, [cur, arr[j]], line));
                            if (!less) break;
                            arr[j + 1] = arr[j];
                            j--;
                        }
                        arr[j + 1] = cur;
                    }
                    arr.forEach((v, i) => { range.slots[i].v = v; });
                    return VOID;
                }
                vals.sort(cmpValues);
                vals.forEach((v, i) => { range.slots[i].v = v; });
                return VOID;
            }
            case 'reverse': {
                const range = this.rangeOf(A[0], A[1], line);
                const vals = range.slots.map(s => s.v).reverse();
                vals.forEach((v, i) => { range.slots[i].v = v; });
                return VOID;
            }
            case 'find': {
                const range = this.rangeOf(A[0], A[1], line);
                for (let i = 0; i < range.slots.length; i++)
                    if (eqValues(range.slots[i].v, A[2])) return { k: 'it', c: range.cont, i: range.start + i };
                return { k: 'it', c: range.cont, i: range.end };
            }
            case 'count': {
                const range = this.rangeOf(A[0], A[1], line);
                return num(range.slots.filter(s => eqValues(s.v, A[2])).length, 'int');
            }
            case 'accumulate': {
                const range = this.rangeOf(A[0], A[1], line);
                let acc = copyValue(A[2]);
                for (const s of range.slots) acc = this.binop('+', acc, s.v, line);
                return acc;
            }
            case 'max_element': case 'min_element': {
                const range = this.rangeOf(A[0], A[1], line);
                let bi = 0;
                for (let i = 1; i < range.slots.length; i++) {
                    const c = cmpValues(range.slots[i].v, range.slots[bi].v);
                    if ((name === 'max_element') ? c > 0 : c < 0) bi = i;
                }
                return { k: 'it', c: range.cont, i: range.start + bi };
            }
            case 'next_permutation': {
                const range = this.rangeOf(A[0], A[1], line);
                return bl(nextPermutation(range.slots));
            }
            case 'fill': {
                const range = this.rangeOf(A[0], A[1], line);
                range.slots.forEach(s => { s.v = copyValue(A[2]); });
                return VOID;
            }
            case 'begin': return this.beginOf(A[0]);
            case 'end': return this.endOf(A[0]);
            case 'to_string': return str(valueToString(A[0], { precision: 6 }));
            case 'stoi': case 'atoi': return num(parseInt(valueToString(A[0]), 10) || 0, 'int');
            case 'stoll': return num(parseInt(valueToString(A[0]), 10) || 0, 'long long');
            case 'stod': case 'atof': return dbl(parseFloat(valueToString(A[0])) || 0);

            /* --- character classification -------------------------------- */
            case 'isalpha': return num(/[A-Za-z]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'isdigit': return num(/[0-9]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'isalnum': return num(/[0-9A-Za-z]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'isspace': return num(/\s/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'isupper': return num(/[A-Z]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'islower': return num(/[a-z]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'ispunct': return num(/[!-\/:-@\[-`{-~]/.test(String.fromCharCode(n0())) ? 1 : 0, 'int');
            case 'toupper': return num(String.fromCharCode(n0()).toUpperCase().charCodeAt(0), isNum(A[0]) ? A[0].t : 'int');
            case 'tolower': return num(String.fromCharCode(n0()).toLowerCase().charCodeAt(0), isNum(A[0]) ? A[0].t : 'int');

            /* --- C stdio -------------------------------------------------- */
            case 'printf': {
                this.out(cFormat(valueToString(A[0]), A.slice(1)));
                return num(0, 'int');
            }
            case 'sprintf': {
                if (slots[0]) slots[0].v = str(cFormat(valueToString(A[1]), A.slice(2)));
                return num(0, 'int');
            }
            case 'puts': this.out(valueToString(A[0]) + '\n'); return num(0, 'int');
            case 'putchar': this.out(String.fromCharCode(n0())); return num(n0(), 'int');
            case 'scanf': {
                const fmt = valueToString(A[0]);
                const specs = fmt.match(/%[-0-9.]*[difsuclx]+/g) || [];
                let count = 0;
                for (let i = 0; i < specs.length; i++) {
                    const target = slots[i + 1];
                    if (!target) break;
                    let sl = target;
                    if (target.v && target.v.k === 'p' && target.v.a) sl = target.v.a[target.v.i];
                    if (!(yield* this.readInto(sl, line))) break;
                    count++;
                }
                return num(count, 'int');
            }
            case 'getchar': {
                if (!(yield* this.ensureInput(false))) return num(-1, 'int');
                const c = this.input.charCodeAt(0);
                this.input = this.input.slice(1);
                return num(c, 'int');
            }

            /* --- misc ----------------------------------------------------- */
            case 'rand': {
                this.randSeed = (this.randSeed * 1103515245 + 12345) & 0x7fffffff;
                return num(this.randSeed % 32768, 'int');
            }
            case 'srand': this.randSeed = Math.trunc(n0()) || 1; return VOID;
            case 'time': return num(Math.floor(Date.now() / 1000), 'long');
            case 'clock': return num(Math.floor(performance.now() * 1000), 'long');
            case 'exit': throw new ExitSignal(Math.trunc(n0()));
            case 'system': return num(0, 'int');
            case 'strlen': return num(valueToString(A[0]).length, 'size_t');
            case 'strcmp': {
                const a = valueToString(A[0]), b = valueToString(A[1]);
                return num(a < b ? -1 : a > b ? 1 : 0, 'int');
            }
            case 'assert':
                if (!truthy(A[0])) this.error('assertion failed', line);
                return VOID;
            case 'fixed': return { k: 'manip', name: 'fixed' };
            case 'boolalpha': return { k: 'manip', name: 'boolalpha' };
            default:
                this.error(`'${name}' was not declared in this scope`, line);
        }
    }

    beginOf(v) {
        if (v.k === 'v' || v.k === 'a') return { k: 'it', c: v.a, i: 0, cont: v };
        if (v.k === 's') return { k: 'it', c: null, i: 0, cont: v };
        if (v.k === 'set') return { k: 'it', c: v.e.map(x => slot(x)), i: 0, cont: v };
        if (v.k === 'm') return { k: 'it', c: v.e.map(p => slot({ k: 'o', cls: '#pair', f: { first: slot(p.key), second: p.slot } })), i: 0, cont: v };
        if (v.k === 'p') return { k: 'p', a: v.a, i: v.i, charPtr: v.charPtr };
        return { k: 'it', c: [], i: 0, cont: v };
    }
    endOf(v) {
        const b = this.beginOf(v);
        if (b.k === 'p') return { k: 'p', a: b.a, i: b.a ? b.a.length : 0, charPtr: b.charPtr };
        b.i = b.c ? b.c.length : (v.k === 's' ? v.v.length : 0);
        return b;
    }

    /* Normalises (first, last) into a list of slots that can be written to. */
    rangeOf(a, b, line) {
        if (a && a.k === 'it') {
            const cont = a.cont;
            const slotsArr = (cont && (cont.k === 'v' || cont.k === 'a')) ? cont.a : a.c;
            const start = a.i, end = b && (b.k === 'it' || b.k === 'p') ? b.i : slotsArr.length;
            return { slots: slotsArr.slice(start, end), cont: slotsArr, start, end };
        }
        if (a && a.k === 'p' && a.a) {
            const start = a.i, end = b && b.k === 'p' ? b.i : a.a.length;
            return { slots: a.a.slice(start, end), cont: a.a, start, end };
        }
        if (a && (a.k === 'v' || a.k === 'a')) return { slots: a.a, cont: a.a, start: 0, end: a.a.length };
        this.error('invalid iterator range', line);
    }

    /* --- built-in member functions --------------------------------------- */

    *builtinMethod(obj, name, args, slots, holder, line, scope) {
        void scope;
        const A = args;

        if (obj && obj.k === 'stream') {
            switch (name) {
                case 'precision': this.streamState.precision = toNumber(A[0]); return VOID;
                case 'width': this.streamState.width = toNumber(A[0]); return VOID;
                case 'fill': this.streamState.fill = String.fromCharCode(toNumber(A[0])); return VOID;
                case 'get': {
                    if (!(yield* this.ensureInput(false))) return num(-1, 'int');
                    const c = this.input.charCodeAt(0);
                    this.input = this.input.slice(1);
                    return num(c, 'int');
                }
                case 'getline': {
                    if (slots[0]) yield* this.readLine(slots[0]);
                    return obj;
                }
                case 'ignore': {
                    yield* this.ensureInput(false);
                    const idx = this.input.indexOf('\n');
                    this.input = idx >= 0 ? this.input.slice(idx + 1) : '';
                    return obj;
                }
                case 'eof': return bl(this.inputClosed && !this.input.length);
                case 'fail': return bl(!!obj.eof);
                case 'good': return bl(!obj.eof);
                case 'clear': obj.eof = false; return VOID;
                case 'sync': case 'flush': case 'tie': return VOID;
                default: return VOID;
            }
        }

        if (obj && obj.k === 's') {
            const s = obj.v;
            switch (name) {
                case 'size': case 'length': return num(s.length, 'size_t');
                case 'empty': return bl(s.length === 0);
                case 'clear': obj.v = ''; return VOID;
                case 'substr': {
                    const start = A[0] !== undefined ? Math.trunc(toNumber(A[0])) : 0;
                    const len = A[1] !== undefined ? Math.trunc(toNumber(A[1])) : undefined;
                    if (start > s.length) this.error('basic_string::substr: position out of range', line);
                    return str(len === undefined ? s.slice(start) : s.substr(start, len));
                }
                case 'find': {
                    const needle = valueToString(A[0]);
                    const from = A[1] !== undefined ? toNumber(A[1]) : 0;
                    const i = s.indexOf(needle, from);
                    return i < 0 ? num(NPOS, 'size_t') : num(i, 'size_t');
                }
                case 'rfind': {
                    const i = s.lastIndexOf(valueToString(A[0]));
                    return i < 0 ? num(NPOS, 'size_t') : num(i, 'size_t');
                }
                case 'at': {
                    const i = Math.trunc(toNumber(A[0]));
                    if (i < 0 || i >= s.length) this.error(`basic_string::at: __n (which is ${i}) >= this->size() (which is ${s.length})`, line);
                    return chr(s.charCodeAt(i));
                }
                case 'push_back': obj.v = s + String.fromCharCode(toNumber(A[0])); return VOID;
                case 'pop_back': obj.v = s.slice(0, -1); return VOID;
                case 'append': obj.v = s + valueToString(A[0]); return obj;
                case 'insert': obj.v = s.slice(0, toNumber(A[0])) + valueToString(A[1]) + s.slice(toNumber(A[0])); return obj;
                case 'erase': {
                    const start = A[0] !== undefined ? Math.trunc(toNumber(A[0])) : 0;
                    const len = A[1] !== undefined ? Math.trunc(toNumber(A[1])) : s.length - start;
                    obj.v = s.slice(0, start) + s.slice(start + len);
                    return obj;
                }
                case 'replace': {
                    const start = Math.trunc(toNumber(A[0])), len = Math.trunc(toNumber(A[1]));
                    obj.v = s.slice(0, start) + valueToString(A[2]) + s.slice(start + len);
                    return obj;
                }
                case 'compare': { const b = valueToString(A[0]); return num(s < b ? -1 : s > b ? 1 : 0, 'int'); }
                case 'c_str': case 'data': return this.makeCharPtr(s);
                case 'front': return chr(s.charCodeAt(0) || 0);
                case 'back': return chr(s.charCodeAt(s.length - 1) || 0);
                case 'begin': return { k: 'it', c: null, i: 0, cont: obj };
                case 'end': return { k: 'it', c: null, i: s.length, cont: obj };
                case 'resize': {
                    const n = Math.trunc(toNumber(A[0]));
                    const fill = A[1] !== undefined ? String.fromCharCode(toNumber(A[1])) : '\0';
                    obj.v = n <= s.length ? s.slice(0, n) : s + fill.repeat(n - s.length);
                    return VOID;
                }
                default: this.error(`'${name}' is not a member of 'std::string'`, line);
            }
        }

        if (obj && (obj.k === 'v' || obj.k === 'a')) {
            switch (name) {
                case 'size': return num(obj.a.length, 'size_t');
                case 'empty': return bl(obj.a.length === 0);
                case 'clear': obj.a.length = 0; return VOID;
                case 'push_back': case 'emplace_back':
                    obj.a.push(slot(copyValue(A[0]))); return VOID;
                case 'pop_back': obj.a.pop(); return VOID;
                case 'front': if (!obj.a.length) this.error('front() on an empty vector', line); this.lastLValue = obj.a[0]; return obj.a[0].v;
                case 'back': if (!obj.a.length) this.error('back() on an empty vector', line); this.lastLValue = obj.a[obj.a.length - 1]; return obj.a[obj.a.length - 1].v;
                case 'at': {
                    const i = Math.trunc(toNumber(A[0]));
                    if (i < 0 || i >= obj.a.length)
                        this.error(`vector::_M_range_check: __n (which is ${i}) >= this->size() (which is ${obj.a.length})`, line);
                    this.lastLValue = obj.a[i];
                    return obj.a[i].v;
                }
                case 'resize': {
                    const n = Math.trunc(toNumber(A[0]));
                    const fill = A[1] !== undefined ? A[1] : this.defaultValue(obj.et || { name: 'int', ptr: 0 });
                    while (obj.a.length > n) obj.a.pop();
                    while (obj.a.length < n) obj.a.push(slot(copyValue(fill)));
                    return VOID;
                }
                case 'assign': {
                    const n = Math.trunc(toNumber(A[0]));
                    obj.a.length = 0;
                    for (let i = 0; i < n; i++) obj.a.push(slot(copyValue(A[1])));
                    return VOID;
                }
                case 'insert': {
                    const it = A[0];
                    const at = it && it.k === 'it' ? it.i : obj.a.length;
                    obj.a.splice(at, 0, slot(copyValue(A[1])));
                    return VOID;
                }
                case 'erase': {
                    const it = A[0];
                    const at = it && it.k === 'it' ? it.i : 0;
                    const to = A[1] && A[1].k === 'it' ? A[1].i : at + 1;
                    obj.a.splice(at, to - at);
                    return VOID;
                }
                case 'begin': return { k: 'it', c: obj.a, i: 0, cont: obj };
                case 'end': return { k: 'it', c: obj.a, i: obj.a.length, cont: obj };
                case 'rbegin': return { k: 'it', c: obj.a.slice().reverse(), i: 0, cont: obj };
                case 'rend': return { k: 'it', c: obj.a.slice().reverse(), i: obj.a.length, cont: obj };
                default: this.error(`'${name}' is not a member of 'std::vector'`, line);
            }
        }

        if (obj && obj.k === 'm') {
            switch (name) {
                case 'size': return num(obj.e.length, 'size_t');
                case 'empty': return bl(obj.e.length === 0);
                case 'clear': obj.e.length = 0; return VOID;
                case 'count': return num(this.mapFind(obj, A[0]) ? 1 : 0, 'size_t');
                case 'find': {
                    const i = obj.e.findIndex(p => eqValues(p.key, A[0]));
                    const list = obj.e.map(p => slot({ k: 'o', cls: '#pair', f: { first: slot(p.key), second: p.slot } }));
                    return { k: 'it', c: list, i: i < 0 ? list.length : i, cont: obj };
                }
                case 'erase': {
                    const i = obj.e.findIndex(p => eqValues(p.key, A[0]));
                    if (i >= 0) obj.e.splice(i, 1);
                    return VOID;
                }
                case 'insert': {
                    const p = A[0];
                    if (p && p.k === 'o') {
                        const key = p.f.first.v;
                        if (!this.mapFind(obj, key)) {
                            obj.e.push({ key: copyValue(key), slot: slot(copyValue(p.f.second.v)) });
                            if (obj.ordered) obj.e.sort((x, y) => cmpValues(x.key, y.key));
                        }
                    }
                    return VOID;
                }
                case 'at': {
                    const e = this.mapFind(obj, A[0]);
                    if (!e) this.error('map::at: key not found', line);
                    this.lastLValue = e.slot;
                    return e.slot.v;
                }
                case 'begin': case 'end': {
                    const list = obj.e.map(p => slot({ k: 'o', cls: '#pair', f: { first: slot(p.key), second: p.slot } }));
                    return { k: 'it', c: list, i: name === 'begin' ? 0 : list.length, cont: obj };
                }
                default: this.error(`'${name}' is not a member of 'std::map'`, line);
            }
        }

        if (obj && obj.k === 'set') {
            switch (name) {
                case 'size': return num(obj.e.length, 'size_t');
                case 'empty': return bl(obj.e.length === 0);
                case 'clear': obj.e.length = 0; return VOID;
                case 'insert': return bl(this.setInsert(obj, asKey(copyValue(A[0]))));
                case 'count': return num(obj.e.some(x => eqValues(x, A[0])) ? 1 : 0, 'size_t');
                case 'erase': {
                    const i = obj.e.findIndex(x => eqValues(x, A[0]));
                    if (i >= 0) obj.e.splice(i, 1);
                    return VOID;
                }
                case 'find': {
                    const list = obj.e.map(x => slot(x));
                    const i = obj.e.findIndex(x => eqValues(x, A[0]));
                    return { k: 'it', c: list, i: i < 0 ? list.length : i, cont: obj };
                }
                case 'begin': case 'end': {
                    const list = obj.e.map(x => slot(x));
                    return { k: 'it', c: list, i: name === 'begin' ? 0 : list.length, cont: obj };
                }
                default: this.error(`'${name}' is not a member of 'std::set'`, line);
            }
        }

        if (obj && obj.k === 'q') {
            const a = obj.a;
            switch (name) {
                case 'push': a.push(slot(copyValue(A[0]))); if (obj.kind === 'priority_queue') a.sort((x, y) => cmpValues(x.v, y.v)); return VOID;
                case 'pop': obj.kind === 'queue' ? a.shift() : a.pop(); return VOID;
                case 'front': return a.length ? a[0].v : this.error('front() on an empty queue', line);
                case 'back': return a.length ? a[a.length - 1].v : this.error('back() on an empty queue', line);
                case 'top': return a.length ? a[a.length - 1].v : this.error('top() on an empty container', line);
                case 'size': return num(a.length, 'size_t');
                case 'empty': return bl(a.length === 0);
                default: this.error(`'${name}' is not a member of this container`, line);
            }
        }

        if (obj && obj.k === 'it') {
            if (name === 'first' || name === 'second') {
                const v = obj.c[obj.i].v;
                return this.memberOf(v, name, line);
            }
        }

        void holder;
        this.error(`request for member '${name}' in a non-class type`, line);
    }
}

const NPOS = 18446744073709551615;

class ExitSignal { constructor(code) { this.code = code; } }

function nextPermutation(slots) {
    const a = slots.map(s => s.v);
    let i = a.length - 2;
    while (i >= 0 && cmpValues(a[i], a[i + 1]) >= 0) i--;
    if (i < 0) { a.reverse(); a.forEach((v, k) => { slots[k].v = v; }); return false; }
    let j = a.length - 1;
    while (cmpValues(a[j], a[i]) <= 0) j--;
    [a[i], a[j]] = [a[j], a[i]];
    const tail = a.slice(i + 1).reverse();
    for (let k = 0; k < tail.length; k++) a[i + 1 + k] = tail[k];
    a.forEach((v, k) => { slots[k].v = v; });
    return true;
}

function sizeofType(type) {
    if (type.ptr > 0) return 8;
    switch (type.name) {
        case 'char': case 'bool': case 'int8_t': case 'uint8_t': return 1;
        case 'short': case 'int16_t': case 'uint16_t': return 2;
        case 'int': case 'float': case 'int32_t': case 'uint32_t': return 4;
        case 'long': return 4;
        case 'long long': case 'double': case 'size_t': case 'int64_t': case 'uint64_t': return 8;
        case 'string': return 32;
        default: return 4;
    }
}
function sizeofValue(v) {
    if (!v) return 0;
    if (v.k === 'a') return v.a.length * (v.a.length ? sizeofValue(v.a[0].v) : 4);
    if (v.k === 'n') return sizeofType({ name: v.t, ptr: 0 });
    if (v.k === 's') return 32;
    if (v.k === 'p') return 8;
    return 4;
}

/* printf-style formatting */
function cFormat(fmt, args) {
    let ai = 0;
    return fmt.replace(/%([-+ 0#]*)(\d+|\*)?(?:\.(\d+|\*))?(?:hh|h|ll|l|L|z|j|t)?([diuoxXfFeEgGcspn%])/g,
        (m, flags, width, prec, conv) => {
            if (conv === '%') return '%';
            if (width === '*') width = String(Math.trunc(toNumber(args[ai++])));
            if (prec === '*') prec = String(Math.trunc(toNumber(args[ai++])));
            const arg = args[ai++];
            let s;
            switch (conv) {
                case 'd': case 'i': s = String(Math.trunc(toNumber(arg))); break;
                case 'u': s = String(Math.max(0, Math.trunc(toNumber(arg)))); break;
                case 'o': s = Math.trunc(toNumber(arg)).toString(8); break;
                case 'x': s = (Math.trunc(toNumber(arg)) >>> 0).toString(16); break;
                case 'X': s = (Math.trunc(toNumber(arg)) >>> 0).toString(16).toUpperCase(); break;
                case 'f': case 'F': s = toNumber(arg).toFixed(prec === undefined ? 6 : +prec); break;
                case 'e': s = toNumber(arg).toExponential(prec === undefined ? 6 : +prec); break;
                case 'E': s = toNumber(arg).toExponential(prec === undefined ? 6 : +prec).toUpperCase(); break;
                case 'g': case 'G': s = fmtG(toNumber(arg), prec === undefined ? 6 : (+prec || 1)); break;
                case 'c': s = String.fromCharCode(toNumber(arg)); break;
                case 's': s = valueToString(arg); if (prec !== undefined) s = s.slice(0, +prec); break;
                case 'p': s = '0x' + (0x60000000).toString(16); break;
                default: s = '';
            }
            if (flags.includes('+') && /^[0-9]/.test(s) && 'dif'.includes(conv)) s = '+' + s;
            if (width) {
                const w = +width;
                if (s.length < w) {
                    if (flags.includes('-')) s = s + ' '.repeat(w - s.length);
                    else if (flags.includes('0') && 'dioxXfFeEgG'.includes(conv)) {
                        const neg = s[0] === '-' || s[0] === '+';
                        s = (neg ? s[0] : '') + '0'.repeat(w - s.length) + (neg ? s.slice(1) : s);
                    } else s = ' '.repeat(w - s.length) + s;
                }
            }
            return s;
        });
}

/* Names the interpreter recognises without a user declaration. */
const BUILTINS = {
    streams: {
        cout: { k: 'stream', which: 'cout' },
        cerr: { k: 'stream', which: 'cerr' },
        clog: { k: 'stream', which: 'clog' },
        cin: { k: 'stream', which: 'cin' },
    },
    consts: {
        endl: { k: 'manip', name: 'endl' },
        fixed: { k: 'manip', name: 'fixed' },
        scientific: { k: 'manip', name: 'scientific' },
        boolalpha: { k: 'manip', name: 'boolalpha' },
        noboolalpha: { k: 'manip', name: 'noboolalpha' },
        left: { k: 'manip', name: 'left' },
        right: { k: 'manip', name: 'right' },
        flush: { k: 'manip', name: 'flush' },
        NULL: NULLPTR,
        INT_MAX: num(2147483647, 'int'), INT_MIN: num(-2147483648, 'int'),
        LONG_MAX: num(2147483647, 'long'), LONG_MIN: num(-2147483648, 'long'),
        LLONG_MAX: num(9223372036854775807, 'long long'),
        LLONG_MIN: num(-9223372036854775808, 'long long'),
        UINT_MAX: num(4294967295, 'unsigned'),
        CHAR_MAX: num(127, 'char'), CHAR_MIN: num(-128, 'char'),
        RAND_MAX: num(32767, 'int'),
        M_PI: dbl(Math.PI), M_E: dbl(Math.E),
        EXIT_SUCCESS: num(0, 'int'), EXIT_FAILURE: num(1, 'int'),
        npos: num(NPOS, 'size_t'),
    },
    funcs: {},
};
for (const f of ('sqrt pow abs fabs labs llabs floor ceil round trunc sin cos tan asin acos atan ' +
    'atan2 exp log log2 log10 fmod hypot cbrt __gcd gcd max min swap sort stable_sort reverse find ' +
    'count accumulate max_element min_element next_permutation fill begin end to_string stoi stoll ' +
    'stod atoi atof isalpha isdigit isalnum isspace isupper islower ispunct toupper tolower printf ' +
    'sprintf puts putchar scanf getchar rand srand time clock exit system strlen strcmp assert ' +
    'getline setprecision setw setfill make_pair').split(' ')) BUILTINS.funcs[f] = true;

/* ============================================================== public API */

function compile(source, fileName) {
    const diagnostics = [];
    let program = null;
    try {
        const toks = lex(source, fileName);
        const pp = preprocess(toks, diagnostics);
        const parser = new Parser(pp);
        program = parser.parseProgram();
        diagnostics.push(...parser.diagnostics);

        const hasMain = program.decls.some(d => d.kind === 'FuncDecl' && d.name === 'main');
        if (!hasMain)
            diagnostics.push(new CompileError("undefined reference to `WinMain'", 0, 0, 'link'));
    } catch (e) {
        if (e instanceof CompileError) diagnostics.push(e);
        else diagnostics.push(new CompileError('internal compiler error: ' + e.message, 0, 0));
    }
    const errors = diagnostics.filter(d => d.kind !== 'warning');
    return { ok: errors.length === 0, program, diagnostics };
}

/* Creates the coroutine that actually runs the program. */
function createProcess(program, io) {
    const interp = new Interpreter(program, io);
    interp.prepare();

    function* body() {
        yield* interp.initGlobals();
        const mains = interp.funcs.get('main');
        if (!mains || !mains.length) throw new RuntimeError('no main function', 0);
        const argcArgv = [];
        const ret = yield* interp.callFunction(mains[0], argcArgv, null, mains[0].line);
        return isNum(ret) ? Math.trunc(ret.v) : 0;
    }

    return { interp, gen: body() };
}

return {
    compile, createProcess, CompileError, RuntimeError, ExitSignal,
    valueToString, Interpreter,
};

})();
