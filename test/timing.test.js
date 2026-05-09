const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
    computePhase,
    isSubmissionsOpen,
    isJudgingOpen,
    validateOrdering,
    coerceIso,
} = require('../lib/timing');

const T = (s) => new Date(s).toISOString();

test('computePhase: status pending/rejected → draft', () => {
    assert.equal(computePhase({ status: 'pending' }), 'draft');
    assert.equal(computePhase({ status: 'rejected' }), 'draft');
});

test('computePhase: status archived → ended', () => {
    assert.equal(computePhase({ status: 'archived' }), 'ended');
});

test('computePhase: active with no dates → live', () => {
    assert.equal(computePhase({ status: 'active' }), 'live');
});

test('computePhase: active before starts_at → upcoming', () => {
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(computePhase({ status: 'active', starts_at: future }), 'upcoming');
});

test('computePhase: active after ends_at → ended', () => {
    const past = T(Date.now() - 60 * 60_000);
    assert.equal(computePhase({ status: 'active', ends_at: past }), 'ended');
});

test('computePhase: active before submission_deadline → submissions', () => {
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(
        computePhase({ status: 'active', submission_deadline: future }),
        'submissions'
    );
});

test('computePhase: active after submission_deadline, before ends_at → judging', () => {
    const past = T(Date.now() - 60 * 60_000);
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(
        computePhase({ status: 'active', submission_deadline: past, ends_at: future }),
        'judging'
    );
});

test('computePhase: full lifecycle with all three dates', () => {
    const now = new Date('2026-06-15T12:00:00Z');
    const e = {
        status: 'active',
        starts_at: '2026-06-01T00:00:00Z',
        submission_deadline: '2026-06-10T23:59:00Z',
        ends_at: '2026-06-20T23:59:00Z',
    };
    assert.equal(computePhase(e, new Date('2026-05-31T00:00:00Z')), 'upcoming');
    assert.equal(computePhase(e, new Date('2026-06-05T00:00:00Z')), 'submissions');
    assert.equal(computePhase(e, now), 'judging');
    assert.equal(computePhase(e, new Date('2026-06-21T00:00:00Z')), 'ended');
});

test('computePhase: accepts camelCase keys (API shape)', () => {
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(
        computePhase({ status: 'active', startsAt: future }),
        'upcoming'
    );
});

test('isSubmissionsOpen: true in submissions phase', () => {
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(
        isSubmissionsOpen({ status: 'active', submission_deadline: future }),
        true
    );
});

test('isSubmissionsOpen: true with no dates (live)', () => {
    assert.equal(isSubmissionsOpen({ status: 'active' }), true);
});

test('isSubmissionsOpen: false after deadline', () => {
    const past = T(Date.now() - 60 * 60_000);
    assert.equal(isSubmissionsOpen({ status: 'active', submission_deadline: past }), false);
});

test('isSubmissionsOpen: false for pending', () => {
    assert.equal(isSubmissionsOpen({ status: 'pending' }), false);
});

test('isJudgingOpen: true in submissions and judging phases', () => {
    const past = T(Date.now() - 60 * 60_000);
    const future = T(Date.now() + 60 * 60_000);
    assert.equal(
        isJudgingOpen({ status: 'active', submission_deadline: future }),
        true
    );
    assert.equal(
        isJudgingOpen({ status: 'active', submission_deadline: past, ends_at: future }),
        true
    );
});

test('isJudgingOpen: false after ends_at', () => {
    const past = T(Date.now() - 60 * 60_000);
    assert.equal(isJudgingOpen({ status: 'active', ends_at: past }), false);
});

test('validateOrdering: returns null when consistent', () => {
    assert.equal(validateOrdering({
        startsAt: '2026-06-01', submissionDeadline: '2026-06-10', endsAt: '2026-06-20',
    }), null);
});

test('validateOrdering: deadline before start → error', () => {
    const out = validateOrdering({ startsAt: '2026-06-10', submissionDeadline: '2026-06-01' });
    assert.match(out, /submissionDeadline/);
});

test('validateOrdering: ends before deadline → error', () => {
    const out = validateOrdering({ submissionDeadline: '2026-06-10', endsAt: '2026-06-05' });
    assert.match(out, /endsAt.*submissionDeadline/);
});

test('validateOrdering: ends before start → error (when no deadline)', () => {
    const out = validateOrdering({ startsAt: '2026-06-10', endsAt: '2026-06-05' });
    assert.match(out, /endsAt.*startsAt/);
});

test('validateOrdering: partial dates accepted', () => {
    assert.equal(validateOrdering({ startsAt: '2026-06-01' }), null);
    assert.equal(validateOrdering({ endsAt: '2026-06-30' }), null);
    assert.equal(validateOrdering({}), null);
});

test('coerceIso: empty / null → null', () => {
    assert.equal(coerceIso(null), null);
    assert.equal(coerceIso(undefined), null);
    assert.equal(coerceIso(''), null);
});

test('coerceIso: valid value → ISO string', () => {
    assert.equal(coerceIso('2026-06-15T12:00:00Z'), '2026-06-15T12:00:00.000Z');
});

test('coerceIso: invalid value throws', () => {
    assert.throws(() => coerceIso('not a date'), /invalid date/);
});
