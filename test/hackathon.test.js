const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildHackathonHelpers } = require('../lib/hackathon');

// Mock db that answers two specific lookups: hackathon existence and the
// caller's membership row. Tests configure both via the constructor.
function makeMockDb({ existing = [], memberships = {} } = {}) {
    return {
        async get(sql, params) {
            if (sql.includes('FROM hackathons')) {
                return existing.includes(params[0]) ? { id: params[0] } : null;
            }
            if (sql.includes('FROM hackathon_memberships')) {
                const [userId, hid] = params;
                const role = memberships[`${userId}:${hid}`];
                return role ? { role } : null;
            }
            return null;
        },
    };
}

function runMiddleware(mw, req, res = {}) {
    return new Promise((resolve, reject) => {
        const wrappedRes = {
            status(code) {
                this.statusCode = code;
                return { json: (body) => resolve({ statusCode: code, body }) };
            },
            ...res,
        };
        Promise.resolve(mw(req, wrappedRes, () => resolve({ next: true, req }))).catch(reject);
    });
}

test('parseHackathonId: reads X-Hackathon-Id header', async () => {
    const { parseHackathonId } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { headers: { 'x-hackathon-id': 'h-123' }, query: {} };
    const out = await runMiddleware(parseHackathonId, req);
    assert.equal(out.next, true);
    assert.equal(req.hackathonId, 'h-123');
});

test('parseHackathonId: falls back to ?hackathonId= query', async () => {
    const { parseHackathonId } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { headers: {}, query: { hackathonId: 'h-q' } };
    await runMiddleware(parseHackathonId, req);
    assert.equal(req.hackathonId, 'h-q');
});

test('parseHackathonId: no header is fine — leaves req.hackathonId undefined', async () => {
    const { parseHackathonId } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { headers: {}, query: {} };
    await runMiddleware(parseHackathonId, req);
    assert.equal(req.hackathonId, undefined);
});

test('requireHackathonRole: 400 when no hackathonId set', async () => {
    const { requireHackathonRole } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { user: { id: 'u1' }, headers: {} };
    const out = await runMiddleware(requireHackathonRole('admin'), req);
    assert.equal(out.statusCode, 400);
    assert.match(out.body.error, /X-Hackathon-Id/);
});

test('requireHackathonRole: 404 when hackathon does not exist', async () => {
    const { requireHackathonRole } = buildHackathonHelpers({ db: makeMockDb({ existing: [] }) });
    const req = { user: { id: 'u1' }, hackathonId: 'h-missing' };
    const out = await runMiddleware(requireHackathonRole('admin'), req);
    assert.equal(out.statusCode, 404);
});

test('requireHackathonRole: 403 when user is not a member', async () => {
    const db = makeMockDb({ existing: ['h-1'], memberships: {} });
    const { requireHackathonRole } = buildHackathonHelpers({ db });
    const req = { user: { id: 'u1' }, hackathonId: 'h-1' };
    const out = await runMiddleware(requireHackathonRole('admin'), req);
    assert.equal(out.statusCode, 403);
    assert.match(out.body.error, /Not a member/);
});

test('requireHackathonRole: 403 when user has wrong role', async () => {
    const db = makeMockDb({ existing: ['h-1'], memberships: { 'u1:h-1': 'judge' } });
    const { requireHackathonRole } = buildHackathonHelpers({ db });
    const req = { user: { id: 'u1' }, hackathonId: 'h-1' };
    const out = await runMiddleware(requireHackathonRole('admin'), req);
    assert.equal(out.statusCode, 403);
    assert.match(out.body.error, /Requires role/);
});

test('requireHackathonRole: passes when role matches', async () => {
    const db = makeMockDb({ existing: ['h-1'], memberships: { 'u1:h-1': 'admin' } });
    const { requireHackathonRole } = buildHackathonHelpers({ db });
    const req = { user: { id: 'u1' }, hackathonId: 'h-1' };
    const out = await runMiddleware(requireHackathonRole('admin', 'judge'), req);
    assert.equal(out.next, true);
    assert.equal(req.hackathonRole, 'admin');
});

test('requireHackathonRole: any-role mode (no allowed list) accepts any membership', async () => {
    const db = makeMockDb({ existing: ['h-1'], memberships: { 'u1:h-1': 'participant' } });
    const { requireHackathonRole } = buildHackathonHelpers({ db });
    const req = { user: { id: 'u1' }, hackathonId: 'h-1' };
    const out = await runMiddleware(requireHackathonRole(), req);
    assert.equal(out.next, true);
    assert.equal(req.hackathonRole, 'participant');
});

test('requireHackathonRole: system admins bypass membership and act as admin', async () => {
    // No membership row exists for this user
    const db = makeMockDb({ existing: ['h-1'], memberships: {} });
    const { requireHackathonRole } = buildHackathonHelpers({ db });
    const req = { user: { id: 'sys', systemRole: 'system_admin' }, hackathonId: 'h-1' };
    const out = await runMiddleware(requireHackathonRole('admin'), req);
    assert.equal(out.next, true);
    assert.equal(req.hackathonRole, 'admin');
});

test('requireSystemAdmin: 403 for non-system-admin', async () => {
    const { requireSystemAdmin } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { user: { id: 'u1', systemRole: 'user' } };
    const out = await runMiddleware(requireSystemAdmin, req);
    assert.equal(out.statusCode, 403);
});

test('requireSystemAdmin: passes for system admin', async () => {
    const { requireSystemAdmin } = buildHackathonHelpers({ db: makeMockDb() });
    const req = { user: { id: 'u1', systemRole: 'system_admin' } };
    const out = await runMiddleware(requireSystemAdmin, req);
    assert.equal(out.next, true);
});

test('requireSystemAdmin: 403 when no user', async () => {
    const { requireSystemAdmin } = buildHackathonHelpers({ db: makeMockDb() });
    const out = await runMiddleware(requireSystemAdmin, {});
    assert.equal(out.statusCode, 403);
});

test('getMembershipRole: returns null when not a member', async () => {
    const db = makeMockDb({ memberships: {} });
    const { getMembershipRole } = buildHackathonHelpers({ db });
    assert.equal(await getMembershipRole('u1', 'h-1'), null);
});

test('getMembershipRole: returns the role string when a member', async () => {
    const db = makeMockDb({ memberships: { 'u1:h-1': 'judge' } });
    const { getMembershipRole } = buildHackathonHelpers({ db });
    assert.equal(await getMembershipRole('u1', 'h-1'), 'judge');
});

test('getMembershipRole: returns null with missing args', async () => {
    const { getMembershipRole } = buildHackathonHelpers({ db: makeMockDb() });
    assert.equal(await getMembershipRole(null, 'h-1'), null);
    assert.equal(await getMembershipRole('u1', null), null);
});
