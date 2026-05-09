const express = require('express');
const db = require('./db');
const initDb = require('./init-db');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const AdmZip = require('adm-zip');
const rateLimit = require('express-rate-limit');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const OpenAI = require('openai');
const { validateRegister, validateLogin, validateProject, validateProfile, sanitizeForPrompt } = require('./lib/validate');
const { weightedAverage, averageHumanScore, blendScores, clampScore, round2 } = require('./lib/scoring');
const { withRetry } = require('./lib/retry');
const storageLib = require('./lib/storage');
const { cookieMiddleware, buildSetCookie, timingSafeEqual } = require('./lib/cookies');
const { buildAudit } = require('./lib/audit');
const { buildHackathonHelpers } = require('./lib/hackathon');
const { generateToken: genResetToken, hashToken: hashResetToken, isExpired: isResetExpired, ttlMs: resetTtlMs } = require('./lib/reset-tokens');
const { sendPasswordReset } = require('./lib/mailer');
const { computePhase, isSubmissionsOpen, isJudgingOpen, validateOrdering, coerceIso } = require('./lib/timing');

// ─── Required env (fail fast) ───────────────────────────────
const isProd = process.env.NODE_ENV === 'production';
const missingEnv = [];
if (!process.env.DATABASE_URL) missingEnv.push('DATABASE_URL');
if (isProd && !process.env.JWT_SECRET) missingEnv.push('JWT_SECRET');
if (missingEnv.length) {
    console.error(`[FATAL] Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('Set them before starting the server. Aborting.');
    process.exit(1);
}

const JWT_SECRET = process.env.JWT_SECRET || 'dev-only-insecure-secret-do-not-use-in-prod';
if (!process.env.JWT_SECRET) {
    console.warn('[WARN] JWT_SECRET not set — using an insecure dev fallback. Do not deploy this way.');
}
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'us.anthropic.claude-sonnet-4-5-20250514-v1:0';
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Uploads Dir ────────────────────────────────────────────
// In S3 mode, files are pushed to the bucket and UPLOADS_DIR is just a
// short-lived staging area for multipart uploads (multer writes here, we
// upload, we unlink). In local mode, this is the durable home of all files.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = storageLib.init(UPLOADS_DIR);
if (storageLib.provider === 's3') {
    console.log(`[STORAGE] S3 backend → s3://${storageLib.BUCKET}/${storageLib.PREFIX}* (region=${storageLib.REGION}, signed-url TTL=${storageLib.SIGNED_URL_TTL}s)`);
} else if (storageLib.provider === 'gcs') {
    console.log(`[STORAGE] GCS backend → gs://${storageLib.BUCKET}/${storageLib.PREFIX}* (signed-url TTL=${storageLib.SIGNED_URL_TTL}s)`);
} else if (isProd) {
    console.warn('[STORAGE] WARNING: STORAGE_BUCKET not set — files live on the local filesystem and will be lost on container restart.');
} else {
    console.log('[STORAGE] Local filesystem backend (dev mode).');
}

// ─── Multer Config ──────────────────────────────────────────
// 64 bits of entropy (crypto.randomBytes) — Math.random was too predictable
// and made stored URLs guessable.
function makeStoredName(originalName) {
    const ext = path.extname(originalName).toLowerCase();
    return `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
}

const multerStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => cb(null, makeStoredName(file.originalname))
});
const upload = multer({
    storage: multerStorage,
    limits: { fileSize: 50 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowed = ['.txt', '.md', '.pdf', '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.cpp', '.c', '.h',
            '.go', '.rs', '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.csv', '.png', '.jpg', '.jpeg',
            '.gif', '.svg', '.pptx', '.ppt', '.docx', '.doc', '.zip', '.sh', '.sql', '.rb', '.php',
            '.swift', '.kt', '.scala', '.r', '.vue', '.svelte', '.toml', '.ini', '.cfg', '.env',
            '.dockerfile', '.makefile', '.gitignore', '.lock', '.mod', '.sum', '.gradle', '.xml'];
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext) || ext === '');
    }
});


// ─── Bedrock Client ─────────────────────────────────────────
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// ─── OpenAI Client ──────────────────────────────────────────
const openaiClient = process.env.OPENAI_API_KEY
    ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
    : null;

// ─── Middleware ──────────────────────────────────────────────
// Trust the first proxy (Cloud Run / load balancer) so that
// express-rate-limit reads the real client IP from X-Forwarded-For.
app.set('trust proxy', 1);
// CORS: same-origin only by default (frontend is served from this server).
// Set CORS_ORIGIN to a comma-separated list to allow specific cross-origin
// callers, or "*" to allow any (not recommended in production).
const corsOriginEnv = process.env.CORS_ORIGIN;
let corsOptions;
if (!corsOriginEnv) {
    corsOptions = { origin: false };
} else if (corsOriginEnv.trim() === '*') {
    corsOptions = { origin: true };
} else {
    const allowed = corsOriginEnv.split(',').map(s => s.trim()).filter(Boolean);
    corsOptions = {
        origin: (origin, cb) => {
            // No Origin header (same-origin or curl) is always fine.
            if (!origin) return cb(null, true);
            cb(null, allowed.includes(origin));
        },
    };
}
app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));
// ─── Hackathon helpers ───────────────────────────────────────
const { parseHackathonId, requireHackathonRole, requireSystemAdmin, requireActiveHackathon, getMembershipRole } = buildHackathonHelpers({ db });

app.use(cookieMiddleware);
app.use(parseHackathonId);
// ─── Security headers ────────────────────────────────────────
// Hand-rolled to avoid pulling in helmet for a small surface. CSP allows
// inline styles only (the SPA injects style="…" attributes); scripts must be
// same-origin. Tighten further by removing 'unsafe-inline' from style-src once
// the inline styles are migrated to CSS classes.
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
        'Content-Security-Policy',
        [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
            "font-src 'self' https://fonts.gstatic.com data:",
            "img-src 'self' data: blob:",
            "connect-src 'self'",
            "frame-ancestors 'none'",
            "form-action 'self'",
            "base-uri 'self'",
            "object-src 'none'",
        ].join('; ')
    );
    next();
});

// ─── Request logging ─────────────────────────────────────────
// Structured JSON line per request. Health checks and static assets are
// excluded so logs stay readable in the absence of a sampler/aggregator.
app.use((req, res, next) => {
    if (req.path === '/health' || req.path === '/healthz') return next();
    const start = process.hrtime.bigint();
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    res.on('finish', () => {
        // Skip noisy static asset fetches (only log API + page loads).
        if (req.path.startsWith('/api') || req.path === '/' || !path.extname(req.path)) {
            const durMs = Math.round(Number(process.hrtime.bigint() - start) / 1e6);
            console.log(JSON.stringify({
                ts: new Date().toISOString(),
                level: res.statusCode >= 500 ? 'error' : (res.statusCode >= 400 ? 'warn' : 'info'),
                reqId: req.id,
                method: req.method,
                path: req.originalUrl || req.url,
                status: res.statusCode,
                durMs,
                ip: req.ip,
                user: req.user?.username || null,
            }));
        }
    });
    next();
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── Rate Limiters ───────────────────────────────────────────
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many auth attempts. Try again later.' },
});
const aiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'AI evaluation rate limit reached. Try again later.' },
});
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 600,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
});
app.use('/api/', apiLimiter);

// ─── Async error wrapper ─────────────────────────────────────
const asyncHandler = (fn) => (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// ─── Phase-aware gates ───────────────────────────────────────
// Extend requireActiveHackathon with the event's clock — submissions and
// judging each have their own window.
const requireSubmissionsOpen = asyncHandler(async (req, res, next) => {
    if (!req.hackathonId) return res.status(400).json({ error: 'X-Hackathon-Id header required' });
    const h = await db.get(
        'SELECT status, starts_at, submission_deadline, ends_at FROM hackathons WHERE id = ?',
        [req.hackathonId]
    );
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (!isSubmissionsOpen(h)) {
        return res.status(400).json({ error: 'Submissions are not open for this hackathon', phase: computePhase(h) });
    }
    next();
});

const requireJudgingOpen = asyncHandler(async (req, res, next) => {
    if (!req.hackathonId) return res.status(400).json({ error: 'X-Hackathon-Id header required' });
    const h = await db.get(
        'SELECT status, starts_at, submission_deadline, ends_at FROM hackathons WHERE id = ?',
        [req.hackathonId]
    );
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (!isJudgingOpen(h)) {
        return res.status(400).json({ error: 'Judging is not open for this hackathon', phase: computePhase(h) });
    }
    next();
});

// ─── Audit ───────────────────────────────────────────────────
// Records who did what, when. Best-effort — never fails the request.
const audit = buildAudit({ db });
async function recordAudit(req, action, targetType, targetId, payload) {
    return audit({
        actorUserId: req.user?.id,
        actorUsername: req.user?.username,
        ip: req.ip,
        action, targetType, targetId, payload,
        hackathonId: req.hackathonId,
    });
}


// ─── Health checks ───────────────────────────────────────────
// Liveness — process is up. No DB call so SIGTERM-draining stays cheap.
app.get('/healthz', (req, res) => res.json({ ok: true, ts: Date.now() }));

// Readiness — process is up AND DB is reachable. Use this for LB checks.
app.get('/health', async (req, res) => {
    try {
        await db.get('SELECT 1 AS ok');
        res.json({ ok: true, db: 'up', ts: Date.now() });
    } catch (err) {
        res.status(503).json({ ok: false, db: 'down', error: err.message });
    }
});

// ─── Helper: UUID ───────────────────────────────────────────
function uuid() {
    return 'xxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });

}

// ─── Auth Cookies & CSRF ─────────────────────────────────────
// Session token lives in an HttpOnly cookie so XSS can't read it. The CSRF
// cookie is intentionally not HttpOnly — the SPA reads it and echoes it back
// as X-CSRF-Token on mutating requests (double-submit cookie pattern).
const SESSION_COOKIE = 'hackeval_session';
const CSRF_COOKIE = 'hackeval_csrf';
const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

function setAuthCookies(res, token) {
    const csrf = crypto.randomBytes(32).toString('base64url');
    res.append('Set-Cookie', buildSetCookie(SESSION_COOKIE, token, {
        path: '/', maxAge: SESSION_TTL_SEC, httpOnly: true, sameSite: 'Lax', secure: isProd,
    }));
    res.append('Set-Cookie', buildSetCookie(CSRF_COOKIE, csrf, {
        path: '/', maxAge: SESSION_TTL_SEC, httpOnly: false, sameSite: 'Lax', secure: isProd,
    }));
}

function clearAuthCookies(res) {
    res.append('Set-Cookie', buildSetCookie(SESSION_COOKIE, '', {
        path: '/', maxAge: 0, httpOnly: true, sameSite: 'Lax', secure: isProd,
    }));
    res.append('Set-Cookie', buildSetCookie(CSRF_COOKIE, '', {
        path: '/', maxAge: 0, httpOnly: false, sameSite: 'Lax', secure: isProd,
    }));
}

// ─── Auth Middleware ─────────────────────────────────────────
// Tries cookie first (browser flow), falls back to Bearer header (scripted /
// curl clients). For cookie-authenticated mutating requests, requires a
// matching X-CSRF-Token header. Bearer requests skip CSRF — they're not
// vulnerable since the browser won't auto-send a Bearer header cross-origin.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function requireAuth(req, res, next) {
    let token = req.cookies?.[SESSION_COOKIE];
    let authMethod = token ? 'cookie' : null;

    if (!token) {
        const authHeader = req.headers.authorization;
        if (authHeader && authHeader.startsWith('Bearer ')) {
            token = authHeader.slice(7);
            authMethod = 'bearer';
        }
    }

    if (!token) return res.status(401).json({ error: 'Authentication required' });

    try {
        req.user = jwt.verify(token, JWT_SECRET);
        req.authMethod = authMethod;
    } catch {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Legacy JWTs (issued before multi-tenancy) lack `systemRole`. Look it up
    // once from the DB so policy checks work; new tokens will carry it.
    if (req.user.systemRole === undefined) {
        try {
            const u = await db.get('SELECT system_role FROM users WHERE id = ?', [req.user.id]);
            req.user.systemRole = u?.system_role || 'user';
        } catch {
            req.user.systemRole = 'user';
        }
    }

    // Double-submit CSRF check for cookie-authed mutating requests.
    if (authMethod === 'cookie' && !SAFE_METHODS.has(req.method)) {
        const headerToken = req.headers['x-csrf-token'];
        const cookieToken = req.cookies?.[CSRF_COOKIE];
        if (!headerToken || !cookieToken || !timingSafeEqual(String(headerToken), String(cookieToken))) {
            return res.status(403).json({ error: 'Invalid CSRF token' });
        }
    }
    next();
}

// Per-hackathon role gates. The names predate multi-tenancy; they now check
// the requester's role IN THE HACKATHON identified by X-Hackathon-Id.
const requireAdmin = requireHackathonRole('admin');
const requireJudgeOrAdmin = requireHackathonRole('admin', 'judge');
// Any role (admin / judge / participant) — just verifies membership.
const requireHackathonAccess = requireHackathonRole();

// ─── File access tickets ────────────────────────────────────
// `<img src>` and `<a href>` can't carry a Bearer header, so we issue a short
// JWT scoped to one stored_name and accept it via ?t=… on the file route.
// The token leaks the storedName but nothing else; the storedName is already
// random per upload.
const FILE_TICKET_TTL = '5m';
function signFileTicket(storedName) {
    return jwt.sign({ p: 'file', s: storedName }, JWT_SECRET, { expiresIn: FILE_TICKET_TTL });
}
function verifyFileTicket(token, storedName) {
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        return decoded.p === 'file' && decoded.s === storedName;
    } catch { return false; }
}

// urlFor returns a URL the browser can hit directly without an auth header.
// In a cloud backend → presigned URL; in local mode → a ticket-stamped self URL.
async function urlFor(storedName, originalName) {
    if (storageLib.isCloud) {
        return await storage.getDownloadUrl(storedName, { filename: originalName, disposition: 'inline' });
    }
    const ticket = signFileTicket(storedName);
    return `/api/files/${encodeURIComponent(storedName)}?t=${encodeURIComponent(ticket)}`;
}

// Accepts either Bearer auth (existing behavior) OR a valid file ticket.
function requireAuthOrFileTicket(req, res, next) {
    const ticket = req.query.t;
    if (ticket && verifyFileTicket(String(ticket), req.params.storedName)) return next();
    return requireAuth(req, res, next);
}

// Verifies a `:id` (or `:projectId`) belongs to the currently scoped
// hackathon. Use on read routes; mutation routes go through
// `requireProjectOwnerOrAdmin` which checks the same thing.
async function verifyProjectInHackathon(req, res, next) {
    if (!req.hackathonId) return res.status(400).json({ error: 'X-Hackathon-Id header required' });
    const projectId = req.params.id || req.params.projectId;
    const project = await db.get('SELECT hackathon_id FROM projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.hackathon_id !== req.hackathonId) {
        return res.status(404).json({ error: 'Project not found in this hackathon' });
    }
    next();
}

async function requireProjectOwnerOrAdmin(req, res, next) {
    if (!req.hackathonId) return res.status(400).json({ error: 'X-Hackathon-Id header required' });
    const project = await db.get(
        'SELECT created_by, hackathon_id FROM projects WHERE id = ?',
        [req.params.id || req.params.projectId]
    );
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.hackathon_id !== req.hackathonId) {
        return res.status(404).json({ error: 'Project not found in this hackathon' });
    }
    // System admins or hackathon admins always pass.
    if (req.user.systemRole === 'system_admin') return next();
    const role = await getMembershipRole(req.user.id, req.hackathonId);
    if (role === 'admin') return next();
    if (project.created_by !== req.user.id) {
        return res.status(403).json({ error: 'You can only modify your own project' });
    }
    next();
}

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/register', authLimiter, asyncHandler(async (req, res) => {
    const err = validateRegister(req.body);
    if (err) return res.status(400).json({ error: err });
    const { username, email, password, displayName } = req.body;
    const existing = await db.get('SELECT id FROM users WHERE username = ? OR email = ?', [username, email]);
    if (existing) {
        return res.status(409).json({ error: 'Username or email already taken' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const id = uuid();
    const role = 'participant';
    // Self-claim "organizer" at registration. Their hackathons still need
    // admin approval before going live, so the damage is bounded.
    const wantsOrganizer = req.body?.wantsOrganizer === true;
    const systemRole = wantsOrganizer ? 'organizer' : 'user';
    await db.run('INSERT INTO users (id, username, email, password_hash, role, display_name, system_role) VALUES (?, ?, ?, ?, ?, ?, ?)', [id, username, email, hash, role, displayName, systemRole]);
    await audit({
        actorUserId: id, actorUsername: username, ip: req.ip,
        action: 'user.register', targetType: 'user', targetId: id,
        payload: { systemRole },
    });
    const token = jwt.sign({ id, username, role, displayName, systemRole }, JWT_SECRET, { expiresIn: '7d' });
    setAuthCookies(res, token);
    // Token is also returned in the body for non-browser clients (curl / scripts).
    res.json({ token, user: { id, username, role, displayName, systemRole } });
}));

app.post('/api/auth/login', authLimiter, asyncHandler(async (req, res) => {
    const err = validateLogin(req.body);
    if (err) return res.status(400).json({ error: err });
    const { username, password } = req.body;
    const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    const systemRole = user.system_role || 'user';
    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, displayName: user.display_name, systemRole },
        JWT_SECRET, { expiresIn: '7d' }
    );
    setAuthCookies(res, token);
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name, systemRole } });
}));

// Logout clears both cookies. No CSRF check — clearing a session is safe even
// if forged (worst case: a user gets unexpectedly logged out).
app.post('/api/auth/logout', (req, res) => {
    clearAuthCookies(res);
    res.json({ success: true });
});

// ─── Forgot / reset password ────────────────────────────────
// We always return 200 with a generic success message, regardless of whether
// the email is registered, so a stranger can't enumerate accounts.
//
// Email delivery is intentionally NOT wired up here — operators set their own
// SMTP/transactional provider. In dev (NODE_ENV != production), the reset
// link is logged to stderr so you can complete the flow without email.

const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '') || null;
function buildResetUrl(req, token) {
    const origin = APP_URL || `${req.protocol}://${req.get('host')}`;
    return `${origin}/?reset=${encodeURIComponent(token)}`;
}

app.post('/api/auth/forgot-password', authLimiter, asyncHandler(async (req, res) => {
    const { email } = req.body || {};
    // Always return the generic message — no account enumeration.
    const generic = { success: true, message: 'If that email is registered, a reset link has been sent.' };

    if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.json(generic);
    }
    const user = await db.get('SELECT id, username FROM users WHERE email = ?', [email.toLowerCase()]);
    if (!user) return res.json(generic);

    const token = genResetToken();
    const tokenHash = hashResetToken(token);
    const expiresAt = new Date(Date.now() + resetTtlMs(process.env.RESET_TOKEN_TTL_MIN));
    await db.run(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)`,
        [uuid(), user.id, tokenHash, expiresAt.toISOString()]
    );

    const link = buildResetUrl(req, token);
    await audit({
        actorUserId: user.id, actorUsername: user.username, ip: req.ip,
        action: 'password_reset.requested', targetType: 'user', targetId: user.id,
    });

    if (!isProd) {
        // Dev convenience: dump the link so you can finish the flow without
        // an SMTP provider.
        console.log(`[PASSWORD-RESET] (dev) link for ${email}: ${link}`);
    }

    // Send the real reset email via Zoho SMTP
    try {
        await sendPasswordReset({ to: email, name: user.username, resetLink: link });
    } catch (emailErr) {
        console.error(`[PASSWORD-RESET] Failed to send email to ${email}:`, emailErr.message);
        // Still return success — don't expose internal errors to the caller.
    }

    res.json(generic);
}));

app.post('/api/auth/reset-password', authLimiter, asyncHandler(async (req, res) => {
    const { token, password } = req.body || {};
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) {
        return res.status(400).json({ error: 'Invalid token' });
    }
    if (typeof password !== 'string' || password.length < 8 || password.length > 200) {
        return res.status(400).json({ error: 'Password must be 8-200 characters' });
    }

    const tokenHash = hashResetToken(token);
    const row = await db.get(
        `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ?`,
        [tokenHash]
    );
    if (!row || row.used_at || isResetExpired(row.expires_at)) {
        return res.status(400).json({ error: 'Reset link is invalid or has expired' });
    }

    const hash = bcrypt.hashSync(password, 10);
    await db.transaction(async (client) => {
        await client.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, row.user_id]);
        await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [row.id]);
        // Invalidate any other outstanding tokens for this user.
        await client.query(
            'UPDATE password_reset_tokens SET used_at = NOW() WHERE user_id = $1 AND used_at IS NULL',
            [row.user_id]
        );
    });
    const user = await db.get('SELECT id, username FROM users WHERE id = ?', [row.user_id]);
    await audit({
        actorUserId: user?.id, actorUsername: user?.username, ip: req.ip,
        action: 'password_reset.completed', targetType: 'user', targetId: row.user_id,
    });
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// USER PROFILES
// ═══════════════════════════════════════════════════════════

function rowToProfile(row) {
    if (!row) return null;
    return {
        userId: row.user_id,
        bio: row.bio,
        skills: JSON.parse(row.skills || '[]'),
        githubUrl: row.github_url,
        linkedinUrl: row.linkedin_url,
        portfolioUrl: row.portfolio_url,
        experienceLevel: row.experience_level,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
    };
}

// The current user's own profile. Returns null (200) when not yet submitted —
// the frontend uses that as the cue to show the profile-setup modal.
app.get('/api/profile', requireAuth, asyncHandler(async (req, res) => {
    const row = await db.get('SELECT * FROM user_profiles WHERE user_id = ?', [req.user.id]);
    res.json(rowToProfile(row));
}));

app.put('/api/profile', requireAuth, asyncHandler(async (req, res) => {
    const err = validateProfile(req.body);
    if (err) return res.status(400).json({ error: err });
    const { bio, skills, githubUrl, linkedinUrl, portfolioUrl, experienceLevel } = req.body || {};
    await db.run(
        `INSERT INTO user_profiles (user_id, bio, skills, github_url, linkedin_url, portfolio_url, experience_level, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
         ON CONFLICT (user_id) DO UPDATE SET
             bio = EXCLUDED.bio,
             skills = EXCLUDED.skills,
             github_url = EXCLUDED.github_url,
             linkedin_url = EXCLUDED.linkedin_url,
             portfolio_url = EXCLUDED.portfolio_url,
             experience_level = EXCLUDED.experience_level,
             updated_at = NOW()`,
        [
            req.user.id,
            bio || null,
            JSON.stringify(skills || []),
            githubUrl || null,
            linkedinUrl || null,
            portfolioUrl || null,
            experienceLevel || null,
        ]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'profile.update', targetType: 'user', targetId: req.user.id,
    });
    const row = await db.get('SELECT * FROM user_profiles WHERE user_id = ?', [req.user.id]);
    res.json(rowToProfile(row));
}));

// Read another user's profile. Allowed when:
//   • caller is system_admin
//   • OR caller and target are members of the same hackathon (so judges and
//     organizers can review participants they're working with)
app.get('/api/users/:id/profile', requireAuth, asyncHandler(async (req, res) => {
    const targetId = req.params.id;
    if (req.user.id !== targetId && req.user.systemRole !== 'system_admin') {
        const shared = await db.get(
            `SELECT 1 FROM hackathon_memberships m1
             JOIN hackathon_memberships m2 ON m1.hackathon_id = m2.hackathon_id
             WHERE m1.user_id = ? AND m2.user_id = ?
             LIMIT 1`,
            [req.user.id, targetId]
        );
        if (!shared) return res.status(403).json({ error: 'Not allowed' });
    }
    const row = await db.get('SELECT * FROM user_profiles WHERE user_id = ?', [targetId]);
    if (!row) return res.status(404).json({ error: 'No profile on file' });
    res.json(rowToProfile(row));
}));

app.get('/api/auth/me', requireAuth, asyncHandler(async (req, res) => {
    const user = await db.get('SELECT id, username, email, role, display_name, system_role, created_at FROM users WHERE id = ?', [req.user.id]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        displayName: user.display_name,
        systemRole: user.system_role,
        createdAt: user.created_at,
    });
}));

// ═══════════════════════════════════════════════════════════
// HACKATHONS (multi-tenancy)
// ═══════════════════════════════════════════════════════════

// Hackathons visible to the caller:
//   • system_admin: every hackathon, regardless of status
//   • everyone else: hackathons they are a member of (any status — includes
//     their own pending creations) plus active ones they can discover (only
//     when ?discover=1)
app.get('/api/hackathons', requireAuth, asyncHandler(async (req, res) => {
    const wantsDiscover = req.query.discover === '1';
    const cols = `h.id, h.slug, h.name, h.status, h.description, h.created_at,
                  h.starts_at, h.submission_deadline, h.ends_at`;
    let rows;
    if (req.user.systemRole === 'system_admin') {
        rows = await db.all(
            `SELECT ${cols}, COALESCE(m.role, 'admin') AS role
             FROM hackathons h
             LEFT JOIN hackathon_memberships m ON m.hackathon_id = h.id AND m.user_id = ?
             ORDER BY h.created_at DESC`,
            [req.user.id]
        );
    } else if (wantsDiscover) {
        // Active events the caller is NOT yet a member of — for "join" UX.
        rows = await db.all(
            `SELECT ${cols}, NULL AS role
             FROM hackathons h
             LEFT JOIN hackathon_memberships m ON m.hackathon_id = h.id AND m.user_id = ?
             WHERE h.status = 'active' AND m.user_id IS NULL
             ORDER BY h.created_at DESC`,
            [req.user.id]
        );
    } else {
        rows = await db.all(
            `SELECT ${cols}, m.role
             FROM hackathons h
             JOIN hackathon_memberships m ON m.hackathon_id = h.id
             WHERE m.user_id = ?
             ORDER BY h.created_at DESC`,
            [req.user.id]
        );
    }
    res.json(rows.map(r => ({
        id: r.id, slug: r.slug, name: r.name, status: r.status,
        description: r.description, role: r.role, createdAt: r.created_at,
        startsAt: r.starts_at,
        submissionDeadline: r.submission_deadline,
        endsAt: r.ends_at,
        phase: computePhase(r),
    })));
}));

// Create a new hackathon.
//   • system_admin → status='active' immediately, no review needed
//   • organizer    → status='pending', awaiting admin approval
//   • everyone else → 403
// Either way, the creator becomes admin of the new event so they can configure
// it (criteria, judges) while it's pending.
app.post('/api/hackathons', requireAuth, asyncHandler(async (req, res) => {
    const isSystemAdmin = req.user.systemRole === 'system_admin';
    const isOrganizer = req.user.systemRole === 'organizer';
    if (!isSystemAdmin && !isOrganizer) {
        return res.status(403).json({ error: 'Only organizers and system admins can create hackathons' });
    }

    const { slug, name, description, startsAt, submissionDeadline, endsAt } = req.body || {};
    if (!slug || !/^[a-z0-9][a-z0-9-]{1,40}$/.test(slug)) {
        return res.status(400).json({ error: 'slug must be 2-41 chars, lowercase alphanumerics + hyphens' });
    }
    if (!name || typeof name !== 'string' || name.length > 200) {
        return res.status(400).json({ error: 'name required (max 200 chars)' });
    }
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 5000)) {
        return res.status(400).json({ error: 'description must be a string up to 5000 chars' });
    }
    let startsIso, deadlineIso, endsIso;
    try {
        startsIso = coerceIso(startsAt);
        deadlineIso = coerceIso(submissionDeadline);
        endsIso = coerceIso(endsAt);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    const orderErr = validateOrdering({ startsAt: startsIso, submissionDeadline: deadlineIso, endsAt: endsIso });
    if (orderErr) return res.status(400).json({ error: orderErr });

    const dupe = await db.get('SELECT id FROM hackathons WHERE slug = ?', [slug]);
    if (dupe) return res.status(409).json({ error: 'slug already taken' });

    const id = uuid();
    const initialStatus = isSystemAdmin ? 'active' : 'pending';
    await db.transaction(async (client) => {
        await client.query(
            `INSERT INTO hackathons (id, slug, name, description, status, created_by, approved_by, approved_at,
                                    starts_at, submission_deadline, ends_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
                id, slug, name, description || null, initialStatus, req.user.id,
                isSystemAdmin ? req.user.id : null,
                isSystemAdmin ? new Date() : null,
                startsIso, deadlineIso, endsIso,
            ]
        );
        await client.query(
            'INSERT INTO hackathon_memberships (hackathon_id, user_id, role) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
            [id, req.user.id, 'admin']
        );
        // Default settings + criteria so the new event is usable immediately.
        await client.query(
            "INSERT INTO settings (key, value, hackathon_id) VALUES ('hackathonName', $1, $2)",
            [name, id]
        );
        await client.query(
            "INSERT INTO settings (key, value, hackathon_id) VALUES ('aiWeight', '0.4', $1)",
            [id]
        );
        const defaults = [
            ['innovation', 'Innovation', 1.0, 0],
            ['technical', 'Technical Complexity', 1.0, 1],
            ['design', 'Design & UX', 1.0, 2],
            ['presentation', 'Presentation', 0.8, 3],
            ['impact', 'Impact & Viability', 1.0, 4],
        ];
        for (const [cid, cname, weight, sort] of defaults) {
            await client.query(
                'INSERT INTO criteria (id, name, weight, sort_order, hackathon_id) VALUES ($1, $2, $3, $4, $5)',
                [cid, cname, weight, sort, id]
            );
        }
    });
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.create', targetType: 'hackathon', targetId: id,
        payload: { slug, name, status: initialStatus }, hackathonId: id,
    });
    res.json({ id, slug, name, status: initialStatus });
}));

// Approval workflow — only system admins can approve / reject pending hackathons.
app.post('/api/hackathons/:hid/approve', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    const h = await db.get('SELECT id, status FROM hackathons WHERE id = ?', [req.params.hid]);
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (h.status !== 'pending') {
        return res.status(400).json({ error: `Cannot approve a hackathon in status '${h.status}'` });
    }
    await db.run(
        `UPDATE hackathons SET status = 'active', approved_by = ?, approved_at = NOW(), rejection_reason = NULL
         WHERE id = ?`,
        [req.user.id, req.params.hid]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.approve', targetType: 'hackathon', targetId: req.params.hid,
        hackathonId: req.params.hid,
    });
    res.json({ success: true, status: 'active' });
}));

app.post('/api/hackathons/:hid/reject', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    const { reason } = req.body || {};
    const h = await db.get('SELECT id, status FROM hackathons WHERE id = ?', [req.params.hid]);
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (h.status !== 'pending') {
        return res.status(400).json({ error: `Cannot reject a hackathon in status '${h.status}'` });
    }
    if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 1000)) {
        return res.status(400).json({ error: 'reason must be a string up to 1000 chars' });
    }
    await db.run(
        `UPDATE hackathons SET status = 'rejected', rejection_reason = ? WHERE id = ?`,
        [reason || null, req.params.hid]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.reject', targetType: 'hackathon', targetId: req.params.hid,
        payload: { reason: reason || null }, hackathonId: req.params.hid,
    });
    res.json({ success: true, status: 'rejected' });
}));

// Join a hackathon as a participant. Requires:
//   • the hackathon to be active (not pending/rejected/archived)
//   • the user to have a profile on file (so judges can review them)
// The first time a participant joins, they're auto-added with role='participant'.
app.post('/api/hackathons/:hid/join', requireAuth, asyncHandler(async (req, res) => {
    const h = await db.get('SELECT id, status FROM hackathons WHERE id = ?', [req.params.hid]);
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (h.status !== 'active') {
        return res.status(400).json({ error: `Cannot join a hackathon in status '${h.status}'` });
    }
    const profile = await db.get('SELECT user_id FROM user_profiles WHERE user_id = ?', [req.user.id]);
    if (!profile) {
        return res.status(400).json({ error: 'Submit your profile first (PUT /api/profile)' });
    }
    const existing = await db.get(
        'SELECT role FROM hackathon_memberships WHERE hackathon_id = ? AND user_id = ?',
        [req.params.hid, req.user.id]
    );
    if (existing) {
        return res.status(200).json({ success: true, alreadyMember: true, role: existing.role });
    }
    await db.run(
        `INSERT INTO hackathon_memberships (hackathon_id, user_id, role) VALUES (?, ?, 'participant')`,
        [req.params.hid, req.user.id]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.join', targetType: 'hackathon', targetId: req.params.hid,
        hackathonId: req.params.hid,
    });
    res.json({ success: true, role: 'participant' });
}));

app.get('/api/hackathons/:hid', requireAuth, asyncHandler(async (req, res) => {
    const h = await db.get('SELECT * FROM hackathons WHERE id = ?', [req.params.hid]);
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    if (req.user.systemRole !== 'system_admin') {
        const role = await getMembershipRole(req.user.id, h.id);
        if (!role) return res.status(403).json({ error: 'Not a member of this hackathon' });
    }
    res.json({
        id: h.id, slug: h.slug, name: h.name, description: h.description, status: h.status,
        createdAt: h.created_at, archivedAt: h.archived_at,
        startsAt: h.starts_at, submissionDeadline: h.submission_deadline, endsAt: h.ends_at,
        phase: computePhase(h),
    });
}));

app.put('/api/hackathons/:hid', requireAuth, asyncHandler(async (req, res) => {
    if (req.user.systemRole !== 'system_admin') {
        const role = await getMembershipRole(req.user.id, req.params.hid);
        if (role !== 'admin') return res.status(403).json({ error: 'Hackathon admin access required' });
    }
    const { name, description, status, startsAt, submissionDeadline, endsAt } = req.body || {};
    const updates = [];
    const params = [];
    if (name !== undefined) {
        if (typeof name !== 'string' || !name || name.length > 200) {
            return res.status(400).json({ error: 'invalid name' });
        }
        updates.push('name = ?'); params.push(name);
    }
    if (description !== undefined) {
        if (description !== null && (typeof description !== 'string' || description.length > 5000)) {
            return res.status(400).json({ error: 'invalid description' });
        }
        updates.push('description = ?'); params.push(description || null);
    }
    if (status !== undefined) {
        if (!['active', 'archived'].includes(status)) {
            return res.status(400).json({ error: 'status must be active or archived' });
        }
        updates.push('status = ?'); params.push(status);
        if (status === 'archived') updates.push('archived_at = NOW()');
        else updates.push('archived_at = NULL');
    }

    // Date fields: undefined = no change, null/'' = clear, valid date = set.
    let startsIso, deadlineIso, endsIso;
    try {
        if (startsAt !== undefined) startsIso = coerceIso(startsAt);
        if (submissionDeadline !== undefined) deadlineIso = coerceIso(submissionDeadline);
        if (endsAt !== undefined) endsIso = coerceIso(endsAt);
    } catch (e) {
        return res.status(400).json({ error: e.message });
    }
    // Validate ordering against the merged final state (read existing, layer changes).
    if (startsAt !== undefined || submissionDeadline !== undefined || endsAt !== undefined) {
        const current = await db.get(
            'SELECT starts_at, submission_deadline, ends_at FROM hackathons WHERE id = ?',
            [req.params.hid]
        );
        const merged = {
            startsAt:           startsAt !== undefined ? startsIso : current?.starts_at,
            submissionDeadline: submissionDeadline !== undefined ? deadlineIso : current?.submission_deadline,
            endsAt:             endsAt !== undefined ? endsIso : current?.ends_at,
        };
        const orderErr = validateOrdering(merged);
        if (orderErr) return res.status(400).json({ error: orderErr });
    }
    if (startsAt !== undefined)           { updates.push('starts_at = ?');           params.push(startsIso); }
    if (submissionDeadline !== undefined) { updates.push('submission_deadline = ?'); params.push(deadlineIso); }
    if (endsAt !== undefined)             { updates.push('ends_at = ?');             params.push(endsIso); }

    if (updates.length === 0) return res.status(400).json({ error: 'nothing to update' });
    params.push(req.params.hid);
    await db.run(`UPDATE hackathons SET ${updates.join(', ')} WHERE id = ?`, params);
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.update', targetType: 'hackathon', targetId: req.params.hid,
        payload: { name, description, status, startsAt: startsIso, submissionDeadline: deadlineIso, endsAt: endsIso },
        hackathonId: req.params.hid,
    });
    res.json({ success: true });
}));

app.delete('/api/hackathons/:hid', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    if (req.params.hid === 'default-hackathon') {
        return res.status(400).json({ error: 'The default hackathon cannot be deleted' });
    }
    const h = await db.get('SELECT slug, name FROM hackathons WHERE id = ?', [req.params.hid]);
    if (!h) return res.status(404).json({ error: 'Hackathon not found' });
    // FKs cascade: projects/files/evaluations/criteria/settings/memberships go away.
    await db.run('DELETE FROM hackathons WHERE id = ?', [req.params.hid]);
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.delete', targetType: 'hackathon', targetId: req.params.hid,
        payload: { slug: h.slug, name: h.name }, hackathonId: req.params.hid,
    });
    res.json({ success: true });
}));

// ── Members of a specific hackathon ────────────────────────
app.get('/api/hackathons/:hid/members', requireAuth, asyncHandler(async (req, res) => {
    if (req.user.systemRole !== 'system_admin') {
        const role = await getMembershipRole(req.user.id, req.params.hid);
        if (!role) return res.status(403).json({ error: 'Not a member' });
    }
    const rows = await db.all(
        `SELECT u.id, u.username, u.display_name, u.email, m.role, m.created_at
         FROM hackathon_memberships m
         JOIN users u ON u.id = m.user_id
         WHERE m.hackathon_id = ?
         ORDER BY m.created_at DESC`,
        [req.params.hid]
    );
    res.json(rows.map(r => ({
        id: r.id, username: r.username, displayName: r.display_name, email: r.email,
        role: r.role, createdAt: r.created_at,
    })));
}));

// Add (or update) a member of a hackathon.
app.post('/api/hackathons/:hid/members', requireAuth, asyncHandler(async (req, res) => {
    const isSystemAdmin = req.user.systemRole === 'system_admin';
    if (!isSystemAdmin) {
        const role = await getMembershipRole(req.user.id, req.params.hid);
        if (role !== 'admin') return res.status(403).json({ error: 'Hackathon admin access required' });
    }
    const { username, role } = req.body || {};
    if (!username || !['admin', 'judge', 'participant'].includes(role)) {
        return res.status(400).json({ error: 'username and role (admin|judge|participant) required' });
    }
    const user = await db.get('SELECT id, username FROM users WHERE username = ?', [username]);
    if (!user) return res.status(404).json({ error: 'User not found' });
    await db.run(
        `INSERT INTO hackathon_memberships (hackathon_id, user_id, role) VALUES (?, ?, ?)
         ON CONFLICT (hackathon_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [req.params.hid, user.id, role]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.member_set', targetType: 'user', targetId: user.id,
        payload: { username: user.username, role }, hackathonId: req.params.hid,
    });
    res.json({ success: true });
}));

app.delete('/api/hackathons/:hid/members/:uid', requireAuth, asyncHandler(async (req, res) => {
    if (req.user.systemRole !== 'system_admin') {
        const role = await getMembershipRole(req.user.id, req.params.hid);
        if (role !== 'admin') return res.status(403).json({ error: 'Hackathon admin access required' });
    }
    if (req.user.id === req.params.uid) {
        return res.status(400).json({ error: 'Cannot remove yourself; ask another admin' });
    }
    await db.run(
        'DELETE FROM hackathon_memberships WHERE hackathon_id = ? AND user_id = ?',
        [req.params.hid, req.params.uid]
    );
    await audit({
        actorUserId: req.user.id, actorUsername: req.user.username, ip: req.ip,
        action: 'hackathon.member_remove', targetType: 'user', targetId: req.params.uid,
        hackathonId: req.params.hid,
    });
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// USER MANAGEMENT (System admins only)
// ═══════════════════════════════════════════════════════════

app.get('/api/users', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    const users = await db.all('SELECT id, username, email, role, display_name, system_role, created_at FROM users ORDER BY created_at DESC', []);
    res.json(users.map(u => ({
        ...u,
        displayName: u.display_name,
        systemRole: u.system_role,
        createdAt: u.created_at,
    })));
}));

app.delete('/api/users/:id', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    const target = await db.get('SELECT username, role FROM users WHERE id = ?', [req.params.id]);
    await db.run('DELETE FROM users WHERE id = ?', [req.params.id]);
    await recordAudit(req, 'user.delete', 'user', req.params.id, target ? { username: target.username, role: target.role } : null);
    res.json({ success: true });
}));

// Legacy global role change. Kept for backwards compat with existing UI; acts
// on the user's row-level role and propagates to their default-hackathon
// membership so behaviour is unchanged for single-event deployments.
app.put('/api/users/:id/role', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    const { role } = req.body;
    if (!['admin', 'judge', 'participant'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'Cannot change your own role' });
    }
    const before = await db.get('SELECT role FROM users WHERE id = ?', [req.params.id]);
    await db.run('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]);
    await db.run(
        `INSERT INTO hackathon_memberships (hackathon_id, user_id, role)
         VALUES ('default-hackathon', ?, ?)
         ON CONFLICT (hackathon_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
        [req.params.id, role]
    );
    await recordAudit(req, 'user.role_change', 'user', req.params.id, { from: before?.role, to: role });
    res.json({ success: true });
}));

// Promote / demote between system-level roles.
app.put('/api/users/:id/system-role', requireAuth, requireSystemAdmin, asyncHandler(async (req, res) => {
    const { systemRole } = req.body || {};
    if (!['user', 'organizer', 'system_admin'].includes(systemRole)) {
        return res.status(400).json({ error: 'systemRole must be user, organizer, or system_admin' });
    }
    if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'Cannot change your own system role' });
    }
    const before = await db.get('SELECT system_role FROM users WHERE id = ?', [req.params.id]);
    await db.run('UPDATE users SET system_role = ? WHERE id = ?', [systemRole, req.params.id]);
    await recordAudit(req, 'user.system_role_change', 'user', req.params.id, { from: before?.system_role, to: systemRole });
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════

app.get('/api/settings', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT key, value FROM settings WHERE hackathon_id = ?', [req.hackathonId]);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
}));

app.put('/api/settings', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
    await db.run(
        `INSERT INTO settings (key, value, hackathon_id) VALUES ($1, $2, $3)
         ON CONFLICT (hackathon_id, key) DO UPDATE SET value = EXCLUDED.value`,
        [key, String(value), req.hackathonId]
    );
    await recordAudit(req, 'settings.update', 'setting', String(key), { value: String(value) });
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// CRITERIA
// ═══════════════════════════════════════════════════════════

app.get('/api/criteria', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    const rows = await db.all(
        'SELECT * FROM criteria WHERE hackathon_id = ? ORDER BY sort_order',
        [req.hackathonId]
    );
    res.json(rows);
}));

app.post('/api/criteria', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const { name, weight } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const existing = await db.get(
        'SELECT id FROM criteria WHERE id = ? AND hackathon_id = ?',
        [id, req.hackathonId]
    );
    if (existing) return res.status(409).json({ error: 'Criterion already exists' });
    const maxOrder = await db.get(
        'SELECT MAX(sort_order) as mx FROM criteria WHERE hackathon_id = ?',
        [req.hackathonId]
    );
    const finalWeight = Math.max(0.1, Math.min(2, weight || 1.0));
    await db.run(
        'INSERT INTO criteria (id, name, weight, sort_order, hackathon_id) VALUES (?, ?, ?, ?, ?)',
        [id, name, finalWeight, (maxOrder.mx || 0) + 1, req.hackathonId]
    );
    await recordAudit(req, 'criteria.create', 'criteria', id, { name, weight: finalWeight });
    res.json({ id, name, weight: weight || 1.0 });
}));

app.put('/api/criteria/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const { name, weight } = req.body;
    const { id } = req.params;
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (weight !== undefined) { updates.push('weight = ?'); params.push(Math.max(0.1, Math.min(2, weight))); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id, req.hackathonId);
    await db.run(`UPDATE criteria SET ${updates.join(', ')} WHERE id = ? AND hackathon_id = ?`, params);

    // If name changed, update the id too
    let newId = id;
    if (name !== undefined) {
        newId = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (newId !== id) {
            await db.run(
                'UPDATE criteria SET id = ? WHERE id = ? AND hackathon_id = ?',
                [newId, id, req.hackathonId]
            );
            // Update scores JSON in evaluations scoped to this hackathon
            const evals = await db.all(
                'SELECT id, scores FROM evaluations WHERE hackathon_id = ?',
                [req.hackathonId]
            );
            for (const ev of evals) {
                const scores = JSON.parse(ev.scores);
                if (scores[id] !== undefined) {
                    scores[newId] = scores[id];
                    delete scores[id];
                    await db.run('UPDATE evaluations SET scores = ? WHERE id = ?', [JSON.stringify(scores), ev.id]);
                }
            }
        }
    }
    await recordAudit(req, 'criteria.update', 'criteria', newId, { name, weight, renamed: newId !== id ? { from: id, to: newId } : undefined });
    res.json({ success: true });
}));

app.delete('/api/criteria/:id', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const count = await db.get(
        'SELECT COUNT(*) as cnt FROM criteria WHERE hackathon_id = ?',
        [req.hackathonId]
    );
    if (parseInt(count.cnt) <= 1) return res.status(400).json({ error: 'Need at least one criterion' });
    await db.run(
        'DELETE FROM criteria WHERE id = ? AND hackathon_id = ?',
        [req.params.id, req.hackathonId]
    );
    await recordAudit(req, 'criteria.delete', 'criteria', req.params.id);
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════

app.get('/api/projects', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    const rows = await db.all(
        'SELECT * FROM projects WHERE hackathon_id = ? ORDER BY created_at DESC',
        [req.hackathonId]
    );
    res.json(rows.map(p => ({
        ...p,
        members: JSON.parse(p.members),
        techStack: JSON.parse(p.tech_stack)
    })));
}));

app.post('/api/projects', requireAuth, requireHackathonAccess, requireSubmissionsOpen, asyncHandler(async (req, res) => {
    const err = validateProject(req.body);
    if (err) return res.status(400).json({ error: err });
    const { name, members, description, techStack, demoUrl } = req.body;
    // Participants can only have one project per hackathon
    if (req.hackathonRole === 'participant') {
        const existing = await db.get(
            'SELECT id FROM projects WHERE created_by = ? AND hackathon_id = ?',
            [req.user.id, req.hackathonId]
        );
        if (existing) return res.status(400).json({ error: 'Participants can only have one project per hackathon' });
    }
    const id = uuid();
    await db.run(
        `INSERT INTO projects (id, name, members, description, tech_stack, demo_url, created_by, hackathon_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, name, JSON.stringify(members || []), description || '', JSON.stringify(techStack || []), demoUrl || '', req.user.id, req.hackathonId]
    );
    await recordAudit(req, 'project.create', 'project', id, { name });
    res.json({ id, name });
}));

app.put('/api/projects/:id', requireAuth, requireProjectOwnerOrAdmin, asyncHandler(async (req, res) => {
    const err = validateProject(req.body);
    if (err) return res.status(400).json({ error: err });
    const { name, members, description, techStack, demoUrl } = req.body;
    await db.run(`UPDATE projects SET name = ?, members = ?, description = ?, tech_stack = ?, demo_url = ? WHERE id = ?`, [name, JSON.stringify(members || []), description || '', JSON.stringify(techStack || []), demoUrl || '', req.params.id]);
    await recordAudit(req, 'project.update', 'project', req.params.id, { name });
    res.json({ success: true });
}));

app.delete('/api/projects/:id', requireAuth, requireProjectOwnerOrAdmin, asyncHandler(async (req, res) => {
    // Clean up file blobs in storage. The DB rows are removed via FK CASCADE
    // when the project is deleted; we just need to release the bytes.
    const project = await db.get('SELECT name FROM projects WHERE id = ?', [req.params.id]);
    const files = await db.all('SELECT stored_name FROM project_files WHERE project_id = ?', [req.params.id]);
    await Promise.all(files.map(f => storage.delete(f.stored_name).catch(err => {
        console.warn(`[STORAGE] failed to delete ${f.stored_name}:`, err.message);
    })));
    await db.run('DELETE FROM projects WHERE id = ?', [req.params.id]);
    await recordAudit(req, 'project.delete', 'project', req.params.id, { name: project?.name, fileCount: files.length });
    res.json({ success: true });
}));

// ═══════════════════════════════════════════════════════════
// PROJECT FILES (Upload / Download)
// ═══════════════════════════════════════════════════════════

app.post('/api/projects/:id/files', requireAuth, requireProjectOwnerOrAdmin, requireSubmissionsOpen, upload.array('files', 50), asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const project = await db.get('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const inserted = [];

    for (const f of (req.files || [])) {
        const ext = path.extname(f.originalname).toLowerCase();

        if (ext === '.zip') {
            // Extract zip and store each file. Defenses:
            //  - cap entry count (prevents millions-of-empty-files DoS)
            //  - cap cumulative uncompressed size (zip-bomb defense)
            //  - reject entries that path-traverse
            const MAX_ENTRIES = 5000;
            const MAX_TOTAL_UNCOMPRESSED = 200 * 1024 * 1024;
            const MAX_ENTRY_SIZE = 10 * 1024 * 1024;
            try {
                const zip = new AdmZip(f.path);
                const entries = zip.getEntries();
                if (entries.length > MAX_ENTRIES) {
                    throw new Error(`Zip has too many entries (${entries.length} > ${MAX_ENTRIES})`);
                }
                let totalUncompressed = 0;
                for (const entry of entries) {
                    if (entry.isDirectory) continue;

                    const normalized = path.posix.normalize(entry.entryName);
                    if (path.isAbsolute(normalized) ||
                        normalized.startsWith('../') ||
                        normalized.includes('/../')) continue;

                    if (normalized.startsWith('__MACOSX') ||
                        normalized.includes('node_modules/') ||
                        normalized.includes('.git/') ||
                        normalized.startsWith('.')) continue;

                    const data = entry.getData();
                    if (!data || data.length === 0) continue;
                    if (data.length > MAX_ENTRY_SIZE) continue;

                    totalUncompressed += data.length;
                    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED) {
                        throw new Error(`Zip uncompressed size exceeds ${MAX_TOTAL_UNCOMPRESSED} bytes (zip-bomb guard)`);
                    }

                    const storedName = makeStoredName(normalized);
                    const mimeType = getMimeType(normalized);
                    await storage.putBuffer(storedName, data, mimeType);

                    const id = uuid();
                    await db.run('INSERT INTO project_files (id, project_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)', [id, projectId, normalized, storedName, mimeType, data.length]);
                    inserted.push({ id, originalName: normalized, size: data.length });
                }
                // Remove the uploaded zip file from the staging dir
                fs.unlinkSync(f.path);
            } catch (err) {
                console.error('Zip extraction error:', err);
                // If zip extraction fails, fall back to storing the .zip as-is
                await storage.putFromPath(f.filename, f.path, f.mimetype);
                if (storageLib.isCloud) fs.unlinkSync(f.path);
                const id = uuid();
                await db.run('INSERT INTO project_files (id, project_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)', [id, projectId, f.originalname, f.filename, f.mimetype, f.size]);
                inserted.push({ id, originalName: f.originalname, size: f.size });
            }
        } else {
            // Regular file — push to backing storage and unlink the temp file in S3 mode.
            await storage.putFromPath(f.filename, f.path, f.mimetype);
            if (storageLib.isS3) fs.unlinkSync(f.path);
            const id = uuid();
            await db.run('INSERT INTO project_files (id, project_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)', [id, projectId, f.originalname, f.filename, f.mimetype, f.size]);
            inserted.push({ id, originalName: f.originalname, size: f.size });
        }
    }
    res.json({ files: inserted });
}));

function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const types = {
        '.txt': 'text/plain', '.md': 'text/markdown', '.py': 'text/x-python',
        '.js': 'application/javascript', '.ts': 'text/typescript', '.html': 'text/html',
        '.css': 'text/css', '.json': 'application/json', '.xml': 'application/xml',
        '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
        '.zip': 'application/zip', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    };
    return types[ext] || 'application/octet-stream';
}

app.get('/api/projects/:id/files', requireAuth, requireHackathonAccess, asyncHandler(verifyProjectInHackathon), asyncHandler(async (req, res) => {
    const rows = await db.all('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at', [req.params.id]);
    const files = await Promise.all(rows.map(async f => ({
        id: f.id,
        originalName: f.original_name,
        storedName: f.stored_name,
        mimeType: f.mime_type,
        size: f.size,
        createdAt: f.created_at,
        url: await urlFor(f.stored_name, f.original_name),
    })));
    res.json(files);
}));

app.delete('/api/projects/:projectId/files/:fileId', requireAuth, requireProjectOwnerOrAdmin, asyncHandler(async (req, res) => {
    const file = await db.get('SELECT * FROM project_files WHERE id = ? AND project_id = ?', [req.params.fileId, req.params.projectId]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await storage.delete(file.stored_name).catch(err => {
        console.warn(`[STORAGE] failed to delete ${file.stored_name}:`, err.message);
    });
    await db.run('DELETE FROM project_files WHERE id = ?', [file.id]);
    await recordAudit(req, 'file.delete', 'file', file.id, { projectId: req.params.projectId, name: file.original_name });
    res.json({ success: true });
}));

// Download / inline view. In S3 mode this 302s to a short-lived signed URL;
// in local mode it streams from disk. Accepts either a Bearer token (for
// fetch() callers) or a `?t=<ticket>` query param (for direct browser
// navigation via <a href> / <img src>).
app.get('/api/files/:storedName', requireAuthOrFileTicket, asyncHandler(async (req, res) => {
    const file = await db.get('SELECT * FROM project_files WHERE stored_name = ?', [req.params.storedName]);
    if (!file) return res.status(404).json({ error: 'File not found' });
    await storage.sendFile(res, file.stored_name, {
        filename: file.original_name,
        disposition: 'inline',
    });
}));

app.get('/api/files/:storedName/content', requireAuth, asyncHandler(async (req, res) => {
    const file = await db.get('SELECT * FROM project_files WHERE stored_name = ?', [req.params.storedName]);
    if (!file) return res.status(404).json({ error: 'File not found' });

    const textExtensions = ['.txt', '.md', '.py', '.js', '.ts', '.jsx', '.tsx', '.java', '.cpp', '.c', '.h',
        '.go', '.rs', '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.csv', '.sh', '.bash',
        '.sql', '.rb', '.php', '.swift', '.kt', '.scala', '.r', '.m', '.vue', '.svelte',
        '.dockerfile', '.toml', '.ini', '.cfg', '.env', '.gitignore', '.makefile'];
    const ext = path.extname(file.original_name).toLowerCase();
    const baseName = path.basename(file.original_name).toLowerCase();
    const isText = textExtensions.includes(ext) || ['makefile', 'dockerfile', 'readme', 'license', '.gitignore', '.env'].includes(baseName);

    if (!isText) {
        return res.json({ type: 'binary', message: `Binary file (${file.mime_type})`, mimeType: file.mime_type });
    }
    try {
        const MAX_PREVIEW = 100_000;
        // Read one byte past the cap so we know whether to flag `truncated`.
        const content = await storage.readText(file.stored_name, MAX_PREVIEW + 1);
        const truncated = content.length > MAX_PREVIEW;
        res.json({
            type: 'text',
            content: truncated ? content.slice(0, MAX_PREVIEW) : content,
            truncated,
            language: getLanguage(ext),
        });
    } catch (e) {
        console.warn('[STORAGE] readText failed:', e.message);
        res.json({ type: 'binary', message: 'Could not read file as text' });
    }
}));

function getLanguage(ext) {
    const map = {
        '.py': 'python', '.js': 'javascript', '.ts': 'typescript', '.jsx': 'javascript', '.tsx': 'typescript',
        '.java': 'java', '.cpp': 'cpp', '.c': 'c', '.h': 'c', '.go': 'go', '.rs': 'rust',
        '.html': 'html', '.css': 'css', '.json': 'json', '.yaml': 'yaml', '.yml': 'yaml',
        '.xml': 'xml', '.sql': 'sql', '.sh': 'bash', '.bash': 'bash', '.rb': 'ruby',
        '.php': 'php', '.swift': 'swift', '.kt': 'kotlin', '.md': 'markdown', '.txt': 'text',
        '.csv': 'text', '.r': 'r', '.vue': 'html', '.svelte': 'html'
    };
    return map[ext] || 'text';
}

// ═══════════════════════════════════════════════════════════
// AI EVALUATION (OpenAI GPT-4o → AWS Bedrock → Simulated)
// ═══════════════════════════════════════════════════════════

app.post('/api/projects/:id/ai-evaluate', aiLimiter, requireAuth, requireAdmin, requireJudgingOpen, asyncHandler(verifyProjectInHackathon), asyncHandler(async (req, res) => {
    const projectId = req.params.id;
    const project = await db.get('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const criteria = await db.all(
        'SELECT * FROM criteria WHERE hackathon_id = ? ORDER BY sort_order',
        [req.hackathonId]
    );
    const files = await db.all('SELECT * FROM project_files WHERE project_id = ?', [projectId]);

    // Read text content from uploaded files
    const textExtensions = ['.txt', '.md', '.py', '.js', '.ts', '.java', '.cpp', '.c', '.go', '.rs',
        '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.csv'];
    let projectContent = '';
    for (const f of files) {
        const ext = path.extname(f.original_name).toLowerCase();
        if (textExtensions.includes(ext)) {
            try {
                const content = await storage.readText(f.stored_name, 15_000);
                const safeName = sanitizeForPrompt(f.original_name, 256);
                const safeContent = sanitizeForPrompt(content, 15000);
                projectContent += `\n\n--- FILE: ${safeName} ---\n${safeContent}`;
            } catch (e) { /* skip unreadable files */ }
        }
    }

    if (!projectContent.trim() && !project.description) {
        return res.status(400).json({ error: 'No content to evaluate. Upload text files (README, code, etc.) first.' });
    }

    // Build shared prompt — all user-controlled fields are sanitized to limit
    // prompt-injection surface and keep the JSON contract intact.
    const criteriaList = criteria.map(c => `- ${sanitizeForPrompt(c.name, 100)} (weight: ${Number(c.weight) || 1})`).join('\n');
    const members = JSON.parse(project.members || '[]');
    const techStack = JSON.parse(project.tech_stack || '[]');
    const safeName = sanitizeForPrompt(project.name, 200);
    const safeMembers = members.map(m => sanitizeForPrompt(m, 80)).join(', ') || 'Unknown';
    const safeTech = techStack.map(t => sanitizeForPrompt(t, 80)).join(', ') || 'Unknown';
    const safeDescription = sanitizeForPrompt(project.description, 5000) || 'No description provided';
    const safeDemoUrl = sanitizeForPrompt(project.demo_url, 500);

    const prompt = `You are an expert hackathon judge. Evaluate this hackathon project based on the given criteria.

PROJECT: ${safeName}
TEAM: ${safeMembers}
TECH STACK: ${safeTech}
DESCRIPTION: ${safeDescription}
${safeDemoUrl ? `DEMO URL: ${safeDemoUrl}` : ''}

EVALUATION CRITERIA:
${criteriaList}

PROJECT FILES AND CODE:
${projectContent || '(No files uploaded)'}

INSTRUCTIONS:
1. Score each criterion from 1 to 10 (integers only).
2. Provide a brief reasoning (1-2 sentences) for each score.
3. Provide overall feedback (2-3 sentences) about the project.
4. Return ONLY a valid JSON object with this exact structure:

{
  "scores": { "criterion_id": score_number, ... },
  "reasoning": { "criterion_id": "brief reasoning", ... },
  "overall_feedback": "Overall assessment of the project"
}

Use these exact criterion IDs: ${criteria.map(c => c.id).join(', ')}

Respond with ONLY the JSON object, no other text.`;

    let aiResult;
    let modelUsed;
    let tokenUsage = null;

    // ── 1. Try OpenAI GPT-4o first ───────────────────────────
    if (openaiClient) {
        try {
            console.log(`[AI] Calling OpenAI ${OPENAI_MODEL}...`);
            const completion = await withRetry(
                () => openaiClient.chat.completions.create({
                    model: OPENAI_MODEL,
                    messages: [{ role: 'user', content: prompt }],
                    max_tokens: 2000,
                    temperature: 0.3,
                    response_format: { type: 'json_object' }
                }),
                { retries: 2, baseMs: 800, label: `openai/${OPENAI_MODEL}` }
            );
            const aiText = completion.choices[0].message.content;
            aiResult = JSON.parse(aiText);
            modelUsed = `openai/${OPENAI_MODEL}`;
            // Capture token usage from OpenAI response
            if (completion.usage) {
                tokenUsage = {
                    promptTokens: completion.usage.prompt_tokens,
                    completionTokens: completion.usage.completion_tokens,
                    totalTokens: completion.usage.total_tokens
                };
                console.log(`[AI] OpenAI evaluation complete. Tokens used — prompt: ${tokenUsage.promptTokens}, completion: ${tokenUsage.completionTokens}, total: ${tokenUsage.totalTokens}`);
            } else {
                console.log(`[AI] OpenAI evaluation complete.`);
            }
        } catch (err) {
            console.warn(`[AI] OpenAI failed (${err.message}), falling back to Bedrock...`);
        }
    }

    // ── 2. Fallback: AWS Bedrock (Claude) ────────────────────
    if (!aiResult) {
        try {
            console.log(`[AI] Calling AWS Bedrock ${BEDROCK_MODEL}...`);
            const command = new InvokeModelCommand({
                modelId: BEDROCK_MODEL,
                contentType: 'application/json',
                accept: 'application/json',
                body: JSON.stringify({
                    anthropic_version: 'bedrock-2023-05-31',
                    max_tokens: 2000,
                    messages: [{ role: 'user', content: prompt }]
                })
            });
            const response = await withRetry(
                () => bedrockClient.send(command),
                { retries: 2, baseMs: 800, label: `bedrock/${BEDROCK_MODEL}` }
            );
            const responseBody = JSON.parse(new TextDecoder().decode(response.body));
            const aiText = responseBody.content[0].text;
            const jsonMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, aiText];
            aiResult = JSON.parse(jsonMatch[1].trim());
            modelUsed = `bedrock/${BEDROCK_MODEL}`;
            console.log(`[AI] Bedrock evaluation complete.`);
        } catch (err) {
            console.warn(`[AI] Bedrock failed (${err.message}), using simulated evaluation.`);
        }
    }

    // ── 3. Fallback: Simulated scoring ───────────────────────
    if (!aiResult) {
        modelUsed = 'simulated-ai-evaluator';
        const simScores = {};
        const simReasoning = {};
        criteria.forEach(c => {
            const base = projectContent.length > 500 ? 7 : projectContent.length > 100 ? 6 : 5;
            simScores[c.id] = Math.min(10, Math.max(1, base + Math.floor(Math.random() * 3) - 1));
            simReasoning[c.id] = `The project demonstrates ${simScores[c.id] >= 7 ? 'strong' : 'adequate'} capability in ${c.name.toLowerCase()}. ${projectContent.length > 200 ? 'The submitted code and documentation show thoughtful implementation.' : 'More detailed submissions would allow deeper evaluation.'}`;
        });
        aiResult = {
            scores: simScores,
            reasoning: simReasoning,
            overall_feedback: `${project.name} is ${projectContent.length > 500 ? 'a well-documented project with comprehensive code submissions' : 'a promising project'}. The team shows ${members.length > 2 ? 'excellent collaboration' : 'solid effort'}. ${techStack.length > 1 ? 'The diverse tech stack demonstrates versatility.' : 'Consider expanding the technology choices for broader impact.'}`
        };
        console.log(`[AI] Using simulated evaluation.`);
    }

    // Validate and clamp scores
    const scores = {};
    const reasoning = {};
    criteria.forEach(c => {
        scores[c.id] = clampScore(aiResult.scores?.[c.id] ?? 5);
        reasoning[c.id] = aiResult.reasoning?.[c.id] || 'No reasoning provided';
    });

    // Upsert AI evaluation
    const existing = await db.get('SELECT id FROM ai_evaluations WHERE project_id = ?', [projectId]);
    if (existing) {
        await db.run('UPDATE ai_evaluations SET scores = ?, reasoning = ?, overall_feedback = ?, model_used = ?, created_at = NOW() WHERE project_id = ?', [JSON.stringify(scores), JSON.stringify(reasoning), aiResult.overall_feedback || '', modelUsed, projectId]);
    } else {
        await db.run(
            'INSERT INTO ai_evaluations (id, project_id, scores, reasoning, overall_feedback, model_used, hackathon_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [uuid(), projectId, JSON.stringify(scores), JSON.stringify(reasoning), aiResult.overall_feedback || '', modelUsed, req.hackathonId]
        );
    }

    await recordAudit(req, 'ai_evaluation.run', 'project', projectId, { model: modelUsed, tokenUsage });
    res.json({
        scores,
        reasoning,
        overallFeedback: aiResult.overall_feedback || '',
        model: modelUsed,
        tokenUsage
    });
}));

app.get('/api/projects/:id/ai-evaluation', requireAuth, requireHackathonAccess, asyncHandler(verifyProjectInHackathon), asyncHandler(async (req, res) => {
    const row = await db.get('SELECT * FROM ai_evaluations WHERE project_id = ?', [req.params.id]);
    if (!row) return res.json(null);
    res.json({
        id: row.id,
        projectId: row.project_id,
        scores: JSON.parse(row.scores),
        reasoning: JSON.parse(row.reasoning),
        overallFeedback: row.overall_feedback,
        model: row.model_used,
        createdAt: row.created_at
    });
}));

// ═══════════════════════════════════════════════════════════
// EVALUATIONS
// ═══════════════════════════════════════════════════════════

app.get('/api/evaluations', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    let rows;
    if (req.query.projectId) {
        rows = await db.all(
            'SELECT * FROM evaluations WHERE project_id = ? AND hackathon_id = ? ORDER BY created_at DESC',
            [req.query.projectId, req.hackathonId]
        );
    } else {
        rows = await db.all(
            'SELECT * FROM evaluations WHERE hackathon_id = ? ORDER BY created_at DESC',
            [req.hackathonId]
        );
    }
    res.json(rows.map(e => ({
        ...e,
        projectId: e.project_id,
        judgeName: e.judge_name,
        scores: JSON.parse(e.scores),
        createdAt: e.created_at
    })));
}));

app.post('/api/evaluations', requireAuth, requireJudgeOrAdmin, requireJudgingOpen, asyncHandler(async (req, res) => {
    const { projectId, scores, notes } = req.body;
    const judgeName = req.user.displayName;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    // Ensure the project is in the same hackathon as the judge.
    const project = await db.get('SELECT hackathon_id FROM projects WHERE id = ?', [projectId]);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.hackathon_id !== req.hackathonId) {
        return res.status(404).json({ error: 'Project not found in this hackathon' });
    }
    const id = uuid();
    await db.run(
        `INSERT INTO evaluations (id, project_id, judge_name, scores, notes, hackathon_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [id, projectId, judgeName, JSON.stringify(scores || {}), notes || '', req.hackathonId]
    );
    res.json({ id });
}));

// ═══════════════════════════════════════════════════════════
// LEADERBOARD (hybrid: human + AI scoring)
// ═══════════════════════════════════════════════════════════

app.get('/api/leaderboard', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    const projects = await db.all('SELECT * FROM projects WHERE hackathon_id = ?', [req.hackathonId]);
    const criteria = await db.all('SELECT * FROM criteria WHERE hackathon_id = ? ORDER BY sort_order', [req.hackathonId]);
    const evals = await db.all('SELECT * FROM evaluations WHERE hackathon_id = ?', [req.hackathonId]);
    const aiEvals = await db.all('SELECT * FROM ai_evaluations WHERE hackathon_id = ?', [req.hackathonId]);

    const aiWeightSetting = await db.get(
        "SELECT value FROM settings WHERE key = 'aiWeight' AND hackathon_id = ?",
        [req.hackathonId]
    );
    const aiWeight = aiWeightSetting ? parseFloat(aiWeightSetting.value) : 0.4;

    const aiEvalMap = {};
    aiEvals.forEach(ae => { aiEvalMap[ae.project_id] = JSON.parse(ae.scores); });

    const ranked = projects.map(p => {
        const pEvals = evals.filter(e => e.project_id === p.id);
        const aiScores = aiEvalMap[p.id] || null;
        const hasHuman = pEvals.length > 0;
        const hasAI = !!aiScores;

        const humanScore = hasHuman ? averageHumanScore(pEvals, criteria) : 0;
        const aiScore = hasAI ? weightedAverage(aiScores, criteria) : 0;
        const finalScore = blendScores({ humanScore, aiScore, hasHuman, hasAI, aiWeight });

        const criteriaAvgs = {};
        if (hasHuman) {
            criteria.forEach(c => {
                criteriaAvgs[c.id] = pEvals.reduce((s, ev) => s + (JSON.parse(ev.scores)[c.id] || 0), 0) / pEvals.length;
            });
        }

        return {
            id: p.id,
            name: p.name,
            avgScore: round2(finalScore),
            humanScore: round2(humanScore),
            aiScore: round2(aiScore),
            evalCount: pEvals.length,
            hasAI,
            criteriaAvgs,
            aiScores: aiScores || {}
        };
    }).sort((a, b) => b.avgScore - a.avgScore);

    res.json(ranked);
}));

// ═══════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════

app.get('/api/dashboard', requireAuth, requireHackathonAccess, asyncHandler(async (req, res) => {
    const r1 = await db.get('SELECT COUNT(*) as cnt FROM projects WHERE hackathon_id = ?', [req.hackathonId]);
    const r2 = await db.get('SELECT COUNT(*) as cnt FROM evaluations WHERE hackathon_id = ?', [req.hackathonId]);
    const r3 = await db.get('SELECT COUNT(DISTINCT judge_name) as cnt FROM evaluations WHERE hackathon_id = ?', [req.hackathonId]);
    const totalProjects = parseInt(r1.cnt);
    const totalEvals = parseInt(r2.cnt);
    const judges = parseInt(r3.cnt);
    const rows = await db.all(`
        SELECT e.*, p.name as project_name
        FROM evaluations e
        LEFT JOIN projects p ON e.project_id = p.id
        WHERE e.hackathon_id = ?
        ORDER BY e.created_at DESC
        LIMIT 5
    `, [req.hackathonId]);
    const recentEvals = rows.map(e => ({
        id: e.id,
        judgeName: e.judge_name,
        projectName: e.project_name,
        createdAt: e.created_at
    }));
    res.json({ totalProjects, totalEvals, judges, recentEvals });
}));

// ═══════════════════════════════════════════════════════════
// EXPORT / IMPORT / RESET
// ═══════════════════════════════════════════════════════════

app.get('/api/export', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const settings = {};
    const settingRows = await db.all('SELECT key, value FROM settings WHERE hackathon_id = ?', [req.hackathonId]);
    settingRows.forEach(r => { settings[r.key] = r.value; });
    const criteria = await db.all('SELECT * FROM criteria WHERE hackathon_id = ? ORDER BY sort_order', [req.hackathonId]);
    const projectRows = await db.all('SELECT * FROM projects WHERE hackathon_id = ?', [req.hackathonId]);
    const projects = projectRows.map(p => ({
        ...p, members: JSON.parse(p.members), techStack: JSON.parse(p.tech_stack)
    }));
    const evalRows = await db.all('SELECT * FROM evaluations WHERE hackathon_id = ?', [req.hackathonId]);
    const evaluations = evalRows.map(e => ({
        ...e, scores: JSON.parse(e.scores), projectId: e.project_id, judgeName: e.judge_name, createdAt: e.created_at
    }));
    res.json({ settings, criteria, projects, evaluations });
}));

app.post('/api/import', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const { settings, criteria, projects, evaluations } = req.body;
    const hid = req.hackathonId;
    try {
        // Scope all destructive ops to the current hackathon only — other
        // events stay untouched.
        await db.run('DELETE FROM evaluations WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM projects WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM criteria WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM settings WHERE hackathon_id = ?', [hid]);
        if (settings) {
            for (const [k, v] of Object.entries(settings))
                await db.run('INSERT INTO settings (key, value, hackathon_id) VALUES (?, ?, ?)', [k, String(v), hid]);
        }
        if (criteria) {
            for (let i = 0; i < criteria.length; i++) {
                const c = criteria[i];
                await db.run(
                    'INSERT INTO criteria (id, name, weight, sort_order, hackathon_id) VALUES (?, ?, ?, ?, ?)',
                    [c.id, c.name, c.weight, i, hid]
                );
            }
        }
        if (projects) {
            for (const p of projects) {
                await db.run(
                    `INSERT INTO projects (id, name, members, description, tech_stack, demo_url, created_at, hackathon_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [p.id, p.name, JSON.stringify(p.members || []), p.description || '',
                     JSON.stringify(p.techStack || p.tech_stack || []), p.demoUrl || p.demo_url || '',
                     p.createdAt || p.created_at || new Date().toISOString(), hid]
                );
            }
        }
        if (evaluations) {
            for (const e of evaluations) {
                await db.run(
                    `INSERT INTO evaluations (id, project_id, judge_name, scores, notes, created_at, hackathon_id)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [e.id, e.projectId || e.project_id, e.judgeName || e.judge_name,
                     JSON.stringify(e.scores || {}), e.notes || '',
                     e.createdAt || e.created_at || new Date().toISOString(), hid]
                );
            }
        }
        await recordAudit(req, 'data.import', null, null, {
            counts: {
                settings: settings ? Object.keys(settings).length : 0,
                criteria: criteria?.length || 0,
                projects: projects?.length || 0,
                evaluations: evaluations?.length || 0,
            },
        });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

app.post('/api/reset', requireAuth, requireAdmin, asyncHandler(async (req, res) => {
    const hid = req.hackathonId;
    try {
        await db.run('DELETE FROM evaluations WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM projects WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM criteria WHERE hackathon_id = ?', [hid]);
        await db.run('DELETE FROM settings WHERE hackathon_id = ?', [hid]);
        await db.run("INSERT INTO settings (key, value, hackathon_id) VALUES ('hackathonName', 'TechHack 2026', ?)", [hid]);
        await db.run("INSERT INTO settings (key, value, hackathon_id) VALUES ('aiWeight', '0.4', ?)", [hid]);
        const defaults = [
            ['innovation', 'Innovation', 1.0, 0],
            ['technical', 'Technical Complexity', 1.0, 1],
            ['design', 'Design & UX', 1.0, 2],
            ['presentation', 'Presentation', 0.8, 3],
            ['impact', 'Impact & Viability', 1.0, 4]
        ];
        for (const [cid, cname, weight, sort] of defaults) {
            await db.run(
                'INSERT INTO criteria (id, name, weight, sort_order, hackathon_id) VALUES (?, ?, ?, ?, ?)',
                [cid, cname, weight, sort, hid]
            );
        }
        await recordAudit(req, 'data.reset', null, null);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
}));

// ═══════════════════════════════════════════════════════════
// AUDIT LOG (Admin only)
// ═══════════════════════════════════════════════════════════

// Audit log is admin-scoped per hackathon. System admins reading the
// global view should pass `?scope=all`.
app.get('/api/audit-log', requireAuth, asyncHandler(async (req, res) => {
    const wantsAll = req.query.scope === 'all';
    if (wantsAll) {
        if (req.user.systemRole !== 'system_admin') {
            return res.status(403).json({ error: 'system admin required for global audit log' });
        }
    } else {
        if (!req.hackathonId) return res.status(400).json({ error: 'X-Hackathon-Id header required (or use ?scope=all)' });
        const role = req.user.systemRole === 'system_admin'
            ? 'admin'
            : await getMembershipRole(req.user.id, req.hackathonId);
        if (role !== 'admin') return res.status(403).json({ error: 'Hackathon admin access required' });
    }

    const limit = Math.min(500, Math.max(1, parseInt(req.query.limit || '100', 10)));
    const offset = Math.max(0, parseInt(req.query.offset || '0', 10));

    const where = [];
    const params = [];
    if (!wantsAll) {
        where.push('hackathon_id = ?');
        params.push(req.hackathonId);
    }
    if (req.query.action) {
        where.push('action = ?');
        params.push(String(req.query.action));
    }
    if (req.query.actorId) {
        where.push('actor_user_id = ?');
        params.push(String(req.query.actorId));
    }
    if (req.query.targetType) {
        where.push('target_type = ?');
        params.push(String(req.query.targetType));
    }
    if (req.query.targetId) {
        where.push('target_id = ?');
        params.push(String(req.query.targetId));
    }
    if (req.query.since) {
        where.push('created_at >= ?');
        params.push(String(req.query.since));
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await db.all(
        `SELECT id, actor_user_id, actor_username, action, target_type, target_id, payload, ip, hackathon_id, created_at
         FROM audit_log ${whereClause}
         ORDER BY id DESC
         LIMIT ? OFFSET ?`,
        [...params, limit, offset]
    );
    const totalRow = await db.get(
        `SELECT COUNT(*) AS cnt FROM audit_log ${whereClause}`,
        params
    );

    res.json({
        total: parseInt(totalRow.cnt, 10),
        limit,
        offset,
        events: rows.map(r => ({
            id: r.id,
            actorUserId: r.actor_user_id,
            actorUsername: r.actor_username,
            action: r.action,
            targetType: r.target_type,
            targetId: r.target_id,
            payload: r.payload,
            ip: r.ip,
            hackathonId: r.hackathon_id,
            createdAt: r.created_at,
        })),
    });
}));

// ─── SPA Fallback ───────────────────────────────────────────
app.get('*', async (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Global error handler ───────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
    console.error(JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        reqId: req.id,
        method: req.method,
        path: req.path,
        msg: err.message,
        stack: err.stack,
    }));
    if (res.headersSent) return;
    res.status(500).json({ error: isProd ? 'Internal server error' : err.message, reqId: req.id });
});

// ─── Start ──────────────────────────────────────────────
if (require.main === module) {
    initDb().then(() => {
        const server = app.listen(PORT, () => {
            console.log(`🚀 Hackathon Evaluator running at http://localhost:${PORT}`);
            console.log(`[DB] Connected to Neon PostgreSQL`);
        });

        // ── Graceful shutdown ──
        // Orchestrators (k8s/Fly/Render/Cloud Run) send SIGTERM, then SIGKILL
        // after a grace period. Stop accepting new connections, drain in-flight
        // requests, close the DB pool, then exit.
        const shutdown = (signal) => {
            console.log(`[SHUTDOWN] ${signal} received, draining…`);
            const force = setTimeout(() => {
                console.warn('[SHUTDOWN] force exit after 15s timeout');
                process.exit(1);
            }, 15_000).unref();
            server.close((err) => {
                if (err) console.error('[SHUTDOWN] server.close error:', err);
                db.pool.end().catch((e) => console.error('[SHUTDOWN] pool.end error:', e)).finally(() => {
                    clearTimeout(force);
                    process.exit(err ? 1 : 0);
                });
            });
        };
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    }).catch(err => {
        console.error('[DB] Failed to initialize database:', err);
        process.exit(1);
    });
}

module.exports = app;
