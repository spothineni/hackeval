// Audit logger. Records mutation events to the `audit_log` table.
//
// Design choices:
//   - Best-effort: a failed log MUST NOT fail the request. Errors are logged
//     to stderr; the audit row is dropped. (Audit logs that fail loudly
//     create cascading outages when the audit table itself is unreachable.)
//   - Synchronous from the caller's perspective. We `await` the insert so
//     callers can `await audit(...)` and know it's flushed before they
//     respond. If perf becomes an issue, swap to fire-and-forget here.
//   - Payload is JSONB. Pass an object — it's stringified for the driver.
//
// `event` shape:
//   {
//     actorUserId?:   string,    // null for unauthenticated events
//     actorUsername?: string,
//     action:         string,    // dotted: "user.delete", "project.create"
//     targetType?:    string,    // "user" | "project" | "file" | …
//     targetId?:      string,
//     payload?:       object,    // small diff/context, not the whole row
//     ip?:            string,
//   }

function buildAudit({ db }) {
    return async function audit(event) {
        if (!event || typeof event.action !== 'string' || !event.action) {
            console.warn('[AUDIT] skipped — missing required `action`');
            return;
        }
        try {
            await db.run(
                `INSERT INTO audit_log
                    (actor_user_id, actor_username, action, target_type, target_id, payload, ip, hackathon_id)
                 VALUES (?, ?, ?, ?, ?, ?::jsonb, ?, ?)`,
                [
                    event.actorUserId ?? null,
                    event.actorUsername ?? null,
                    event.action,
                    event.targetType ?? null,
                    event.targetId ?? null,
                    event.payload != null ? JSON.stringify(event.payload) : null,
                    event.ip ?? null,
                    event.hackathonId ?? null,
                ]
            );
        } catch (err) {
            console.error('[AUDIT] failed to record event:', { action: event.action }, err.message);
        }
    };
}

// Express helper: pulls actor + ip from the request automatically. Returns a
// function bound to a specific request so route handlers don't repeat plumbing.
function auditFromReq(req, audit) {
    return (event) => audit({
        actorUserId: req.user?.id,
        actorUsername: req.user?.username,
        ip: req.ip,
        ...event,
    });
}

module.exports = { buildAudit, auditFromReq };
