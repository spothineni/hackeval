// Minimal cookie utilities. Pulled out of server.js for testability and to
// avoid an extra dependency.

function parseCookieHeader(header) {
    const out = {};
    if (!header) return out;
    String(header).split(';').forEach((pair) => {
        const i = pair.indexOf('=');
        if (i < 0) return;
        const k = pair.slice(0, i).trim();
        if (!k) return;
        const v = pair.slice(i + 1).trim();
        try { out[k] = decodeURIComponent(v); }
        catch { out[k] = v; }
    });
    return out;
}

// Express middleware: populates req.cookies from the Cookie header.
function cookieMiddleware(req, res, next) {
    req.cookies = parseCookieHeader(req.headers.cookie);
    next();
}

// Build a Set-Cookie header value. `opts` honors a small subset of attrs.
function buildSetCookie(name, value, opts = {}) {
    const segs = [`${name}=${value === '' ? '' : encodeURIComponent(value)}`];
    if (opts.path) segs.push(`Path=${opts.path}`);
    if (opts.maxAge != null) segs.push(`Max-Age=${opts.maxAge}`);
    if (opts.httpOnly) segs.push('HttpOnly');
    if (opts.secure) segs.push('Secure');
    if (opts.sameSite) segs.push(`SameSite=${opts.sameSite}`);
    return segs.join('; ');
}

// Constant-time string compare for CSRF tokens. Falls back to !== if buffers
// don't have the same length (which already means the tokens don't match).
function timingSafeEqual(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string') return false;
    if (a.length !== b.length) return false;
    const crypto = require('node:crypto');
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

module.exports = { parseCookieHeader, cookieMiddleware, buildSetCookie, timingSafeEqual };
