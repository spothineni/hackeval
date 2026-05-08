const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    parseCookieHeader,
    cookieMiddleware,
    buildSetCookie,
    timingSafeEqual,
} = require('../lib/cookies');

test('parseCookieHeader: empty / missing returns {}', () => {
    assert.deepEqual(parseCookieHeader(''), {});
    assert.deepEqual(parseCookieHeader(null), {});
    assert.deepEqual(parseCookieHeader(undefined), {});
});

test('parseCookieHeader: parses single and multiple cookies', () => {
    assert.deepEqual(parseCookieHeader('a=1'), { a: '1' });
    assert.deepEqual(parseCookieHeader('a=1; b=2; c=3'), { a: '1', b: '2', c: '3' });
});

test('parseCookieHeader: trims whitespace and decodes %XX sequences', () => {
    assert.deepEqual(parseCookieHeader('a = hello%20world ; b= foo'), { a: 'hello world', b: 'foo' });
});

test('parseCookieHeader: ignores malformed pairs gracefully', () => {
    assert.deepEqual(parseCookieHeader('=onlyValue; ; key=val'), { key: 'val' });
});

test('parseCookieHeader: supports = inside the value', () => {
    assert.deepEqual(parseCookieHeader('jwt=eyJ.foo=bar'), { jwt: 'eyJ.foo=bar' });
});

test('cookieMiddleware: populates req.cookies and calls next()', () => {
    const req = { headers: { cookie: 'sid=abc; csrf=xyz' } };
    const res = {};
    let nextCalled = false;
    cookieMiddleware(req, res, () => { nextCalled = true; });
    assert.deepEqual(req.cookies, { sid: 'abc', csrf: 'xyz' });
    assert.equal(nextCalled, true);
});

test('cookieMiddleware: empty cookies still produces an object', () => {
    const req = { headers: {} };
    cookieMiddleware(req, {}, () => {});
    assert.deepEqual(req.cookies, {});
});

test('buildSetCookie: emits the basic Path/Max-Age combo', () => {
    const out = buildSetCookie('sid', 'abc', { path: '/', maxAge: 60 });
    assert.equal(out, 'sid=abc; Path=/; Max-Age=60');
});

test('buildSetCookie: HttpOnly + Secure + SameSite flags', () => {
    const out = buildSetCookie('sid', 'abc', {
        path: '/', maxAge: 3600, httpOnly: true, secure: true, sameSite: 'Lax',
    });
    assert.equal(out, 'sid=abc; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax');
});

test('buildSetCookie: encodes special characters in the value', () => {
    const out = buildSetCookie('csrf', 'a b/c', { path: '/' });
    assert.match(out, /csrf=a%20b%2Fc/);
});

test('buildSetCookie: empty value (used for clearing) is left as-is', () => {
    const out = buildSetCookie('sid', '', { path: '/', maxAge: 0 });
    assert.equal(out, 'sid=; Path=/; Max-Age=0');
});

test('timingSafeEqual: equal strings return true', () => {
    assert.equal(timingSafeEqual('abc123', 'abc123'), true);
});

test('timingSafeEqual: differing strings return false', () => {
    assert.equal(timingSafeEqual('abc123', 'xyz456'), false);
});

test('timingSafeEqual: different lengths short-circuit to false', () => {
    assert.equal(timingSafeEqual('abc', 'abcd'), false);
});

test('timingSafeEqual: non-string inputs return false', () => {
    assert.equal(timingSafeEqual(null, 'a'), false);
    assert.equal(timingSafeEqual('a', undefined), false);
    assert.equal(timingSafeEqual(123, 123), false);
});
