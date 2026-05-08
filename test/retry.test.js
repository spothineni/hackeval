const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withRetry, isTransient } = require('../lib/retry');

const noSleep = () => Promise.resolve();

test('isTransient: 5xx and 429 are retryable', () => {
    assert.equal(isTransient({ status: 500 }), true);
    assert.equal(isTransient({ status: 503 }), true);
    assert.equal(isTransient({ status: 429 }), true);
    assert.equal(isTransient({ statusCode: 502 }), true);
    assert.equal(isTransient({ $metadata: { httpStatusCode: 504 } }), true);
});

test('isTransient: 4xx (except 429) is not retryable', () => {
    assert.equal(isTransient({ status: 400 }), false);
    assert.equal(isTransient({ status: 401 }), false);
    assert.equal(isTransient({ status: 404 }), false);
    assert.equal(isTransient({ status: 422 }), false);
});

test('isTransient: network errors are retryable', () => {
    assert.equal(isTransient({ code: 'ETIMEDOUT' }), true);
    assert.equal(isTransient({ code: 'ECONNRESET' }), true);
    assert.equal(isTransient({ code: 'ECONNREFUSED' }), true);
});

test('isTransient: AWS throttling names are retryable', () => {
    assert.equal(isTransient({ name: 'ThrottlingException' }), true);
    assert.equal(isTransient({ name: 'TooManyRequestsException' }), true);
    assert.equal(isTransient({ name: 'ServiceUnavailableException' }), true);
});

test('isTransient: unknown errors not retryable', () => {
    assert.equal(isTransient(new Error('boom')), false);
    assert.equal(isTransient({}), false);
});

test('withRetry: returns immediately on success', async () => {
    let calls = 0;
    const result = await withRetry(async () => { calls++; return 'ok'; }, { sleep: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 1);
});

test('withRetry: retries on transient and eventually succeeds', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
        calls++;
        if (calls < 3) { const e = new Error('temp'); e.status = 503; throw e; }
        return 'ok';
    }, { retries: 3, baseMs: 1, sleep: noSleep });
    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('withRetry: gives up after exhausting retries', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            const e = new Error('always fails');
            e.status = 503;
            throw e;
        }, { retries: 2, baseMs: 1, sleep: noSleep }),
        /always fails/
    );
    assert.equal(calls, 3); // 1 initial + 2 retries
});

test('withRetry: does not retry non-transient errors', async () => {
    let calls = 0;
    await assert.rejects(
        withRetry(async () => {
            calls++;
            const e = new Error('bad input');
            e.status = 400;
            throw e;
        }, { retries: 5, baseMs: 1, sleep: noSleep }),
        /bad input/
    );
    assert.equal(calls, 1);
});
