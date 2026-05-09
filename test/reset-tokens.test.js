const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    generateToken,
    hashToken,
    isExpired,
    ttlMs,
    DEFAULT_TTL_MIN,
} = require('../lib/reset-tokens');

test('generateToken: returns a base64url string of expected length', () => {
    const t = generateToken();
    assert.match(t, /^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars in base64url (no padding)
    assert.equal(t.length, 43);
});

test('generateToken: produces a different token each call', () => {
    const a = generateToken();
    const b = generateToken();
    assert.notEqual(a, b);
});

test('hashToken: produces 64-char hex (sha256)', () => {
    const h = hashToken('abc');
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]{64}$/);
});

test('hashToken: deterministic for the same input', () => {
    assert.equal(hashToken('abc'), hashToken('abc'));
});

test('hashToken: different inputs produce different hashes', () => {
    assert.notEqual(hashToken('abc'), hashToken('abd'));
});

test('hashToken: coerces non-strings to strings', () => {
    // Number coerces to "123"; should not throw.
    assert.equal(hashToken(123), hashToken('123'));
});

test('isExpired: past timestamp → true', () => {
    const past = new Date(Date.now() - 60_000);
    assert.equal(isExpired(past), true);
});

test('isExpired: future timestamp → false', () => {
    const future = new Date(Date.now() + 60_000);
    assert.equal(isExpired(future), false);
});

test('isExpired: accepts ISO string', () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    assert.equal(isExpired(past), true);
});

test('isExpired: respects custom now', () => {
    const t = new Date('2026-01-01T00:00:00Z');
    assert.equal(isExpired(t, new Date('2025-12-31T23:59:00Z')), false);
    assert.equal(isExpired(t, new Date('2026-01-01T00:01:00Z')), true);
});

test('ttlMs: defaults when env unset / invalid', () => {
    assert.equal(ttlMs(undefined), DEFAULT_TTL_MIN * 60_000);
    assert.equal(ttlMs(''), DEFAULT_TTL_MIN * 60_000);
    assert.equal(ttlMs('not-a-number'), DEFAULT_TTL_MIN * 60_000);
    assert.equal(ttlMs('0'), DEFAULT_TTL_MIN * 60_000);
    assert.equal(ttlMs('-5'), DEFAULT_TTL_MIN * 60_000);
});

test('ttlMs: respects valid env value', () => {
    assert.equal(ttlMs('15'), 15 * 60_000);
    assert.equal(ttlMs('60'), 60 * 60_000);
});
