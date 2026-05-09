// Password reset tokens.
//
// Design:
//   - Token is 256 bits of crypto.randomBytes, base64url-encoded → 43 chars.
//   - Only the SHA-256 hash is stored. A DB leak doesn't yield live tokens.
//   - Tokens have a TTL (default 30 minutes) and are single-use (used_at set
//     on first successful reset).
//   - On a successful reset, ALL of that user's outstanding tokens are
//     invalidated to prevent reuse if multiple were issued.

const crypto = require('node:crypto');

const DEFAULT_TTL_MIN = 30;

function generateToken() {
    return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
    return crypto.createHash('sha256').update(String(token)).digest('hex');
}

// Returns true if `now` is past the timestamp.
function isExpired(expiresAt, now = new Date()) {
    return new Date(expiresAt).getTime() < now.getTime();
}

function ttlMs(envValue) {
    const n = parseInt(envValue || '', 10);
    const minutes = Number.isFinite(n) && n > 0 ? n : DEFAULT_TTL_MIN;
    return minutes * 60 * 1000;
}

module.exports = {
    generateToken,
    hashToken,
    isExpired,
    ttlMs,
    DEFAULT_TTL_MIN,
};
