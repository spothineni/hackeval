// Tiny retry helper with exponential backoff. Only retries transient errors:
// 429s, 5xx, network resets, and the AWS SDK's throttling exceptions.

function isTransient(err) {
    const status = err?.status ?? err?.statusCode ?? err?.$metadata?.httpStatusCode;
    if (status === 429) return true;
    if (typeof status === 'number' && status >= 500 && status < 600) return true;
    const code = err?.code;
    if (code === 'ETIMEDOUT' || code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'EAI_AGAIN') return true;
    const name = err?.name;
    if (name === 'ThrottlingException' || name === 'TooManyRequestsException' ||
        name === 'ServiceUnavailableException' || name === 'InternalServerException') return true;
    return false;
}

async function withRetry(fn, { retries = 2, baseMs = 500, label = 'op', sleep } = {}) {
    const wait = sleep || ((ms) => new Promise(r => setTimeout(r, ms)));
    for (let attempt = 0; ; attempt++) {
        try {
            return await fn();
        } catch (err) {
            if (!isTransient(err) || attempt >= retries) throw err;
            const ms = baseMs * Math.pow(2, attempt);
            console.warn(`[retry] ${label} failed (${err.name || err.code || 'transient'}); retrying in ${ms}ms (attempt ${attempt + 1}/${retries})`);
            await wait(ms);
        }
    }
}

module.exports = { withRetry, isTransient };
