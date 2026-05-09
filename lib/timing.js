// Hackathon timing helpers. Pure functions over a hackathon's
// (status, starts_at, submission_deadline, ends_at) — no DB access.
//
// Phase semantics:
//   draft         — status pending or rejected; no public access
//   upcoming      — active, but starts_at is in the future
//   submissions   — active, between starts_at and submission_deadline
//   judging       — active, after submission_deadline up to ends_at
//   ended         — active, but past ends_at, OR status archived
//   live          — active with no dates set (legacy / loosely-managed events)
//
// Submissions are allowed in: submissions, live
// Judging is allowed in:      submissions (judges can score early), judging, live
// (Two events can overlap submissions+judging if the organizer wants.)

function toMs(v) {
    if (v == null) return null;
    const n = (v instanceof Date) ? v.getTime() : new Date(v).getTime();
    return Number.isFinite(n) ? n : null;
}

function computePhase(hack, now = new Date()) {
    if (!hack) return 'draft';
    const status = hack.status;
    if (status === 'pending' || status === 'rejected') return 'draft';
    if (status === 'archived') return 'ended';

    const t = now.getTime();
    const starts = toMs(hack.starts_at ?? hack.startsAt);
    const sub    = toMs(hack.submission_deadline ?? hack.submissionDeadline);
    const ends   = toMs(hack.ends_at ?? hack.endsAt);

    // No dates → loosely-managed event, just gate on status.
    if (starts == null && sub == null && ends == null) return 'live';

    if (starts != null && t < starts) return 'upcoming';
    if (ends != null && t > ends) return 'ended';
    if (sub != null && t > sub) return 'judging';
    return 'submissions';
}

function isSubmissionsOpen(hack, now) {
    const p = computePhase(hack, now);
    return p === 'submissions' || p === 'live';
}

function isJudgingOpen(hack, now) {
    const p = computePhase(hack, now);
    return p === 'submissions' || p === 'judging' || p === 'live';
}

// Validates ordering when set. Returns null if OK, or a string message.
function validateOrdering({ startsAt, submissionDeadline, endsAt }) {
    const s = toMs(startsAt);
    const d = toMs(submissionDeadline);
    const e = toMs(endsAt);
    if (s != null && d != null && d < s) return 'submissionDeadline must be on or after startsAt';
    if (d != null && e != null && e < d) return 'endsAt must be on or after submissionDeadline';
    if (s != null && e != null && e < s) return 'endsAt must be on or after startsAt';
    return null;
}

// Coerce input to ISO or null. Throws on values that look like dates but
// aren't parseable.
function coerceIso(v) {
    if (v == null || v === '') return null;
    const ms = toMs(v);
    if (ms == null) throw new Error(`invalid date value: ${v}`);
    return new Date(ms).toISOString();
}

module.exports = {
    computePhase,
    isSubmissionsOpen,
    isJudgingOpen,
    validateOrdering,
    coerceIso,
};
