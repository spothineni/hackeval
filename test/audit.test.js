const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildAudit, auditFromReq } = require('../lib/audit');

function makeMockDb({ failNext = false } = {}) {
    const calls = [];
    return {
        calls,
        async run(sql, params) {
            if (failNext) throw new Error('db down');
            calls.push({ sql, params });
        },
    };
}

test('buildAudit: writes a row with expected columns', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    await audit({
        actorUserId: 'u1',
        actorUsername: 'alice',
        action: 'project.delete',
        targetType: 'project',
        targetId: 'p123',
        payload: { name: 'My Hack' },
        ip: '1.2.3.4',
    });
    assert.equal(db.calls.length, 1);
    const { sql, params } = db.calls[0];
    assert.match(sql, /INSERT INTO audit_log/);
    assert.deepEqual(params, [
        'u1', 'alice', 'project.delete', 'project', 'p123',
        '{"name":"My Hack"}', '1.2.3.4', null,
    ]);
});

test('buildAudit: nulls out missing optional fields', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    await audit({ action: 'data.reset' });
    assert.deepEqual(
        db.calls[0].params,
        [null, null, 'data.reset', null, null, null, null, null]
    );
});

test('buildAudit: skips events with no action and warns', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    await audit({});
    await audit({ action: '' });
    await audit(null);
    assert.equal(db.calls.length, 0);
});

test('buildAudit: db failure does NOT throw — best-effort by design', async () => {
    const db = makeMockDb({ failNext: true });
    const audit = buildAudit({ db });
    // Must resolve, not reject. A failed audit must never break the request.
    await audit({ action: 'project.delete' });
    assert.equal(db.calls.length, 0); // failed insert wasn't recorded
});

test('buildAudit: stringifies payload as JSON', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    await audit({ action: 'user.role_change', payload: { from: 'judge', to: 'admin' } });
    const payloadParam = db.calls[0].params[5];
    assert.equal(typeof payloadParam, 'string');
    assert.deepEqual(JSON.parse(payloadParam), { from: 'judge', to: 'admin' });
});

test('auditFromReq: pulls actor + ip from request', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    const req = { user: { id: 'u9', username: 'bob' }, ip: '10.0.0.1' };
    const helper = auditFromReq(req, audit);
    await helper({ action: 'project.create', targetType: 'project', targetId: 'p1' });
    assert.deepEqual(
        db.calls[0].params,
        ['u9', 'bob', 'project.create', 'project', 'p1', null, '10.0.0.1', null]
    );
});

test('auditFromReq: explicit actor in event overrides req.user', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    const req = { user: { id: 'admin1', username: 'admin' }, ip: '10.0.0.1' };
    const helper = auditFromReq(req, audit);
    // Self-registration: the new user is the actor, not whoever's session
    // happens to be on the request (typically nobody for register).
    await helper({ actorUserId: 'newUser', actorUsername: 'newbie', action: 'user.register', targetType: 'user', targetId: 'newUser' });
    assert.equal(db.calls[0].params[0], 'newUser');
    assert.equal(db.calls[0].params[1], 'newbie');
});

test('auditFromReq: handles unauthenticated requests', async () => {
    const db = makeMockDb();
    const audit = buildAudit({ db });
    const req = {}; // no user, no ip
    const helper = auditFromReq(req, audit);
    await helper({ action: 'user.register', targetType: 'user', targetId: 'x' });
    assert.equal(db.calls[0].params[0], null);
    assert.equal(db.calls[0].params[1], null);
    assert.equal(db.calls[0].params[6], null);
});
