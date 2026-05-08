// Hackathon scoping helpers.
//
// Two layers of authorization in this codebase:
//
//   1. SYSTEM role (`users.system_role`): 'system_admin' or 'user'.
//      System admins can create/delete hackathons, manage users globally.
//      Stored on the user row; read from JWT (`req.user.systemRole`).
//
//   2. HACKATHON membership role (`hackathon_memberships.role`):
//      'admin' | 'judge' | 'participant', scoped to one hackathon.
//      Read fresh from DB on each request via `requireHackathonRole`,
//      so role changes take effect without needing a new JWT.
//
// Per-hackathon routes use `parseHackathonId` to read the X-Hackathon-Id
// header (or `?hackathonId=` query) into `req.hackathonId`, then
// `requireHackathonRole(...allowed)` to enforce membership.
//
// System routes use `requireSystemAdmin`.

// Adapter that turns an async (req, res, next) middleware into one that
// forwards rejections to next(err). Express 4 doesn't do this natively.
const wrap = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

function buildHackathonHelpers({ db }) {
    // Look up a user's role in a hackathon. Returns null if not a member.
    async function getMembershipRole(userId, hackathonId) {
        if (!userId || !hackathonId) return null;
        const row = await db.get(
            'SELECT role FROM hackathon_memberships WHERE user_id = ? AND hackathon_id = ?',
            [userId, hackathonId]
        );
        return row ? row.role : null;
    }

    // Reads X-Hackathon-Id header (preferred) or ?hackathonId= query as a
    // fallback. Stores the value on req.hackathonId; downstream middleware
    // verifies it exists and the user is a member.
    function parseHackathonId(req, res, next) {
        const hid = req.headers['x-hackathon-id'] || req.query.hackathonId;
        if (hid) req.hackathonId = String(hid);
        next();
    }

    // Returns 400/403 if the request isn't validly scoped or the user lacks
    // an allowed role in the target hackathon. System admins bypass the
    // membership check (they can act on any hackathon).
    function requireHackathonRole(...allowed) {
        return wrap(async function (req, res, next) {
            if (!req.hackathonId) {
                return res.status(400).json({ error: 'X-Hackathon-Id header required' });
            }
            const exists = await db.get('SELECT id FROM hackathons WHERE id = ?', [req.hackathonId]);
            if (!exists) return res.status(404).json({ error: 'Hackathon not found' });

            // System admins can act on any hackathon as 'admin'.
            if (req.user?.systemRole === 'system_admin') {
                req.hackathonRole = 'admin';
                return next();
            }
            const role = await getMembershipRole(req.user?.id, req.hackathonId);
            if (!role) return res.status(403).json({ error: 'Not a member of this hackathon' });
            if (allowed.length && !allowed.includes(role)) {
                return res.status(403).json({ error: `Requires role: ${allowed.join(' or ')}` });
            }
            req.hackathonRole = role;
            next();
        });
    }

    function requireSystemAdmin(req, res, next) {
        if (req.user?.systemRole !== 'system_admin') {
            return res.status(403).json({ error: 'System admin access required' });
        }
        next();
    }

    // Asserts the requested hackathon is in 'active' status. Use on routes
    // that should fail closed on pending/rejected/archived events: joining,
    // submitting projects, uploading files, scoring, AI evaluation.
    const requireActiveHackathon = wrap(async function (req, res, next) {
        if (!req.hackathonId) {
            return res.status(400).json({ error: 'X-Hackathon-Id header required' });
        }
        const h = await db.get('SELECT status FROM hackathons WHERE id = ?', [req.hackathonId]);
        if (!h) return res.status(404).json({ error: 'Hackathon not found' });
        if (h.status !== 'active') {
            return res.status(400).json({ error: `Hackathon is ${h.status}, not active` });
        }
        next();
    });

    return {
        getMembershipRole,
        parseHackathonId,
        requireHackathonRole,
        requireSystemAdmin,
        requireActiveHackathon,
    };
}

module.exports = { buildHackathonHelpers };
