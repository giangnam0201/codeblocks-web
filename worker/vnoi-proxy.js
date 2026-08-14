/* ---------------------------------------------------------------------------
   vnoi-proxy.js - a Cloudflare Worker that lets the Code::Blocks web edition
   talk to VNOI (oj.vnoi.info).

   Why this exists: oj.vnoi.info sends no CORS headers and exposes no JSON API
   (/api/v2/* is 404), so a page on another origin cannot read a single
   response from it.  The browser enforces that; no amount of client code gets
   around it.  This Worker sits in the middle, adds the CORS headers, and hands
   the raw HTML back to the IDE, which does the parsing.

   Two rules it holds to:

     * It is stateless.  Nothing is stored - no credentials, no sessions, no
       request bodies.  The VNOI session cookie lives in the browser and passes
       through here on its way to the judge, in the same request the user just
       made.
     * It only ever talks to oj.vnoi.info.  An open relay would be abused
       within a day, so the upstream host is fixed rather than taken from the
       request, and only the origins listed below may use it at all.

   Cookies cannot ride along on their own: the browser will not attach VNOI's
   SameSite=Lax cookies to a cross-site request, and it will not let a page
   read Set-Cookie.  So the IDE keeps the cookie jar itself and passes it in
   X-VNOI-Cookie; whatever the judge sets comes back in X-VNOI-Set-Cookie.
--------------------------------------------------------------------------- */

const UPSTREAM = 'https://oj.vnoi.info';

/* Origins allowed to use this Worker.  Anything else gets a plain 403 - this
   is what stops it becoming a public proxy for someone else's scraper. */
const ALLOWED_ORIGINS = [
    'https://vnoi.codeblocks.bond',        // the IDE, on Cloudflare Pages
    'https://codeblocks.bond',
    'https://www.codeblocks.bond',
    'http://localhost:8899',
    'http://127.0.0.1:8899',
];

const HOP_BY_HOP = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'proxy-authorization', 'proxy-authenticate', 'te', 'trailer',
]);

const STRIP = new Set([
    'set-cookie', 'content-encoding', 'content-length',
    'content-security-policy', 'x-frame-options',
]);

function corsHeaders(origin) {
    return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-VNOI-Cookie, X-VNOI-Referer',
        'Access-Control-Expose-Headers': 'X-VNOI-Set-Cookie, X-VNOI-Status, X-VNOI-Url',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
    };
}

export default {
    async fetch(request) {
        /* A thrown exception here reaches the browser as Cloudflare's bare
           "error 1101", which says nothing.  Anything that goes wrong should
           come back as a message the IDE can show. */
        try {
            return await handle(request);
        } catch (e) {
            const origin = request.headers.get('Origin') || '';
            return new Response('vnoi-proxy failed: ' + (e && e.stack ? e.stack : e), {
                status: 502,
                headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' },
                                       ALLOWED_ORIGINS.includes(origin) ? corsHeaders(origin) : {}),
            });
        }
    },
};

async function handle(request) {
    {
        const origin = request.headers.get('Origin') || '';
        const allowed = ALLOWED_ORIGINS.includes(origin);

        if (request.method === 'OPTIONS') {
            return new Response(null, {
                status: allowed ? 204 : 403,
                headers: allowed ? corsHeaders(origin) : {},
            });
        }
        if (!allowed) {
            return new Response('This proxy only serves the Code::Blocks web edition.\n', {
                status: 403,
                headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            });
        }

        const url = new URL(request.url);
        // /vnoi/<path on the judge>?<query>
        const path = url.pathname.replace(/^\/vnoi/, '') || '/';
        if (!path.startsWith('/')) {
            return new Response('Bad path', { status: 400, headers: corsHeaders(origin) });
        }
        const target = UPSTREAM + path + url.search;

        const headers = new Headers();
        headers.set('User-Agent',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
        headers.set('Accept-Language', 'vi,en;q=0.9');
        const cookie = request.headers.get('X-VNOI-Cookie');
        if (cookie) headers.set('Cookie', cookie);
        headers.set('Referer', request.headers.get('X-VNOI-Referer') || UPSTREAM + '/');
        headers.set('Origin', UPSTREAM);
        const ct = request.headers.get('Content-Type');
        if (ct) headers.set('Content-Type', ct);

        let upstream;
        try {
            upstream = await fetch(target, {
                method: request.method,
                headers,
                body: request.method === 'POST' ? await request.arrayBuffer() : undefined,
                redirect: 'manual',        // the IDE needs to see where a submit landed
            });
        } catch (e) {
            return new Response('Could not reach oj.vnoi.info: ' + e.message, {
                status: 502, headers: corsHeaders(origin),
            });
        }

        /* Follow redirects here, carrying the cookie jar, so the client learns
           the final URL - a successful submit is a redirect to
           /submission/<id>, and that id is the whole point. */
        let hops = 0;
        let finalUrl = target;
        const setCookies = [];
        collect(upstream, setCookies);
        while (upstream.status >= 300 && upstream.status < 400 && hops < 5) {
            const loc = upstream.headers.get('Location');
            if (!loc) break;
            finalUrl = new URL(loc, finalUrl).toString();
            if (!finalUrl.startsWith(UPSTREAM)) break;      // never leave the judge
            const h2 = new Headers(headers);
            const jar = mergeJar(cookie, setCookies);
            if (jar) h2.set('Cookie', jar);
            h2.delete('Content-Type');
            upstream = await fetch(finalUrl, { method: 'GET', headers: h2, redirect: 'manual' });
            collect(upstream, setCookies);
            hops++;
        }

        const out = new Headers(corsHeaders(origin));
        for (const [k, v] of upstream.headers) {
            const lower = k.toLowerCase();
            if (HOP_BY_HOP.has(lower) || STRIP.has(lower)) continue;
            out.set(k, v);
        }
        /* Only the name=value pairs go back, joined the way a Cookie header
           is written.  The attributes are dropped on purpose: the client has
           no use for them, and a header value may not contain the newline a
           list of full Set-Cookie lines would need. */
        if (setCookies.length) {
            const pairs = setCookies
                .map(sc => sc.split(';')[0].trim())
                .filter(p => p.includes('='));
            if (pairs.length) out.set('X-VNOI-Set-Cookie', pairs.join('; '));
        }
        out.set('X-VNOI-Status', String(upstream.status));
        out.set('X-VNOI-Url', finalUrl);

        return new Response(upstream.body, { status: upstream.status, headers: out });
    }
}

function collect(res, into) {
    // getSetCookie() is the only way to see every Set-Cookie separately
    const list = typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : [res.headers.get('set-cookie')].filter(Boolean);
    for (const c of list) into.push(c);
}

/* Merges the jar the client sent with anything the judge just set, so a
   redirect chain keeps the session it was given. */
function mergeJar(clientCookie, setCookies) {
    const jar = new Map();
    (clientCookie || '').split(';').forEach(p => {
        const i = p.indexOf('=');
        if (i > 0) jar.set(p.slice(0, i).trim(), p.slice(i + 1).trim());
    });
    setCookies.forEach(sc => {
        const first = sc.split(';')[0];
        const i = first.indexOf('=');
        if (i > 0) jar.set(first.slice(0, i).trim(), first.slice(i + 1).trim());
    });
    return Array.from(jar, ([k, v]) => k + '=' + v).join('; ');
}
