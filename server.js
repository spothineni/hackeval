const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const { BedrockRuntimeClient, InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

const JWT_SECRET = process.env.JWT_SECRET || 'hackathon-eval-secret-key-change-in-production';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const BEDROCK_MODEL = process.env.BEDROCK_MODEL || 'anthropic.claude-3-sonnet-20240229-v1:0';

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Uploads Directory ──────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Multer Config ──────────────────────────────────────────
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
        const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e6)}${path.extname(file.originalname)}`;
        cb(null, uniqueName);
    }
});
const upload = multer({
    storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
    fileFilter: (req, file, cb) => {
        const allowed = ['.txt', '.md', '.pdf', '.py', '.js', '.ts', '.java', '.cpp', '.c', '.go', '.rs',
            '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.csv', '.png', '.jpg', '.jpeg',
            '.gif', '.svg', '.pptx', '.docx', '.zip'];
        const ext = path.extname(file.originalname).toLowerCase();
        cb(null, allowed.includes(ext));
    }
});

// ─── Bedrock Client ─────────────────────────────────────────
const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

// ─── Middleware ──────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Database Setup ─────────────────────────────────────────
const db = new Database(path.join(__dirname, 'hackathon.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS criteria (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 1.0,
        sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        members TEXT NOT NULL DEFAULT '[]',
        description TEXT DEFAULT '',
        tech_stack TEXT NOT NULL DEFAULT '[]',
        demo_url TEXT DEFAULT '',
        created_by TEXT DEFAULT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        judge_name TEXT NOT NULL,
        scores TEXT NOT NULL DEFAULT '{}',
        notes TEXT DEFAULT '',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'judge',
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS project_files (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        original_name TEXT NOT NULL,
        stored_name TEXT NOT NULL,
        mime_type TEXT DEFAULT '',
        size INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS ai_evaluations (
        id TEXT PRIMARY KEY,
        project_id TEXT UNIQUE NOT NULL,
        scores TEXT NOT NULL DEFAULT '{}',
        reasoning TEXT NOT NULL DEFAULT '{}',
        overall_feedback TEXT DEFAULT '',
        model_used TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
`);

// Seed defaults if empty
const criteriaCount = db.prepare('SELECT COUNT(*) as cnt FROM criteria').get();
if (criteriaCount.cnt === 0) {
    const insert = db.prepare('INSERT INTO criteria (id, name, weight, sort_order) VALUES (?, ?, ?, ?)');
    const defaults = [
        ['innovation', 'Innovation', 1.0, 0],
        ['technical', 'Technical Complexity', 1.0, 1],
        ['design', 'Design & UX', 1.0, 2],
        ['presentation', 'Presentation', 0.8, 3],
        ['impact', 'Impact & Viability', 1.0, 4]
    ];
    const tx = db.transaction(() => {
        for (const c of defaults) insert.run(...c);
    });
    tx();
}

const settingsCount = db.prepare('SELECT COUNT(*) as cnt FROM settings').get();
if (settingsCount.cnt === 0) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('hackathonName', 'TechHack 2026')").run();
}

// Seed default admin user
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
    const hash = bcrypt.hashSync('admin123', 10);
    db.prepare('INSERT INTO users (id, username, email, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(uuid(), 'admin', 'admin@hackathon.local', hash, 'admin', 'Administrator');
}

// ─── Helper: UUID ───────────────────────────────────────────
function uuid() {
    return 'xxxx-xxxx-4xxx-yxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ─── Auth Middleware ─────────────────────────────────────────
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Authentication required' });
    }
    try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ error: 'Invalid or expired token' });
    }
}

function requireAdmin(req, res, next) {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
}

function requireJudgeOrAdmin(req, res, next) {
    if (req.user.role !== 'admin' && req.user.role !== 'judge') {
        return res.status(403).json({ error: 'Judge or admin access required' });
    }
    next();
}

function requireProjectOwnerOrAdmin(req, res, next) {
    if (req.user.role === 'admin') return next();
    const project = db.prepare('SELECT created_by FROM projects WHERE id = ?').get(req.params.id || req.params.projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    if (project.created_by !== req.user.id) return res.status(403).json({ error: 'You can only modify your own project' });
    next();
}

// ═══════════════════════════════════════════════════════════
// AUTH ROUTES
// ═══════════════════════════════════════════════════════════

app.post('/api/auth/register', (req, res) => {
    const { username, email, password, displayName } = req.body;
    if (!username || !email || !password || !displayName) {
        return res.status(400).json({ error: 'All fields are required' });
    }
    if (password.length < 4) {
        return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    const existing = db.prepare('SELECT id FROM users WHERE username = ? OR email = ?').get(username, email);
    if (existing) {
        return res.status(409).json({ error: 'Username or email already taken' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const id = uuid();
    const role = 'participant';
    db.prepare('INSERT INTO users (id, username, email, password_hash, role, display_name) VALUES (?, ?, ?, ?, ?, ?)')
        .run(id, username, email, hash, role, displayName);
    const token = jwt.sign({ id, username, role, displayName }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id, username, role, displayName } });
});

app.post('/api/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
        return res.status(401).json({ error: 'Invalid username or password' });
    }
    const token = jwt.sign(
        { id: user.id, username: user.username, role: user.role, displayName: user.display_name },
        JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({ token, user: { id: user.id, username: user.username, role: user.role, displayName: user.display_name } });
});

app.get('/api/auth/me', requireAuth, (req, res) => {
    const user = db.prepare('SELECT id, username, email, role, display_name, created_at FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ id: user.id, username: user.username, email: user.email, role: user.role, displayName: user.display_name, createdAt: user.created_at });
});

// ═══════════════════════════════════════════════════════════
// USER MANAGEMENT (Admin only)
// ═══════════════════════════════════════════════════════════

app.get('/api/users', requireAuth, requireAdmin, (req, res) => {
    const users = db.prepare('SELECT id, username, email, role, display_name, created_at FROM users ORDER BY created_at DESC').all();
    res.json(users.map(u => ({ ...u, displayName: u.display_name, createdAt: u.created_at })));
});

app.delete('/api/users/:id', requireAuth, requireAdmin, (req, res) => {
    if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'Cannot delete your own account' });
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

app.put('/api/users/:id/role', requireAuth, requireAdmin, (req, res) => {
    const { role } = req.body;
    if (!['admin', 'judge', 'participant'].includes(role)) {
        return res.status(400).json({ error: 'Invalid role' });
    }
    if (req.user.id === req.params.id) {
        return res.status(400).json({ error: 'Cannot change your own role' });
    }
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// SETTINGS
// ═══════════════════════════════════════════════════════════

app.get('/api/settings', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT key, value FROM settings').all();
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json(settings);
});

app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
    const { key, value } = req.body;
    if (!key || value === undefined) return res.status(400).json({ error: 'key and value required' });
    db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// CRITERIA
// ═══════════════════════════════════════════════════════════

app.get('/api/criteria', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM criteria ORDER BY sort_order').all();
    res.json(rows);
});

app.post('/api/criteria', requireAuth, requireAdmin, (req, res) => {
    const { name, weight } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const id = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
    const existing = db.prepare('SELECT id FROM criteria WHERE id = ?').get(id);
    if (existing) return res.status(409).json({ error: 'Criterion already exists' });
    const maxOrder = db.prepare('SELECT MAX(sort_order) as mx FROM criteria').get();
    db.prepare('INSERT INTO criteria (id, name, weight, sort_order) VALUES (?, ?, ?, ?)')
        .run(id, name, Math.max(0.1, Math.min(2, weight || 1.0)), (maxOrder.mx || 0) + 1);
    res.json({ id, name, weight: weight || 1.0 });
});

app.put('/api/criteria/:id', requireAuth, requireAdmin, (req, res) => {
    const { name, weight } = req.body;
    const { id } = req.params;
    const updates = [];
    const params = [];
    if (name !== undefined) { updates.push('name = ?'); params.push(name); }
    if (weight !== undefined) { updates.push('weight = ?'); params.push(Math.max(0.1, Math.min(2, weight))); }
    if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update' });
    params.push(id);
    db.prepare(`UPDATE criteria SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // If name changed, update the id too
    if (name !== undefined) {
        const newId = name.toLowerCase().replace(/[^a-z0-9]/g, '_');
        if (newId !== id) {
            db.prepare('UPDATE criteria SET id = ? WHERE id = ?').run(newId, id);
            // Update scores JSON in evaluations
            const evals = db.prepare('SELECT id, scores FROM evaluations').all();
            const updateEval = db.prepare('UPDATE evaluations SET scores = ? WHERE id = ?');
            const tx = db.transaction(() => {
                for (const ev of evals) {
                    const scores = JSON.parse(ev.scores);
                    if (scores[id] !== undefined) {
                        scores[newId] = scores[id];
                        delete scores[id];
                        updateEval.run(JSON.stringify(scores), ev.id);
                    }
                }
            });
            tx();
        }
    }
    res.json({ success: true });
});

app.delete('/api/criteria/:id', requireAuth, requireAdmin, (req, res) => {
    const count = db.prepare('SELECT COUNT(*) as cnt FROM criteria').get();
    if (count.cnt <= 1) return res.status(400).json({ error: 'Need at least one criterion' });
    db.prepare('DELETE FROM criteria WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// PROJECTS
// ═══════════════════════════════════════════════════════════

app.get('/api/projects', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all();
    res.json(rows.map(p => ({
        ...p,
        members: JSON.parse(p.members),
        techStack: JSON.parse(p.tech_stack)
    })));
});

app.post('/api/projects', requireAuth, (req, res) => {
    const { name, members, description, techStack, demoUrl } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    // Participants can only have one project
    if (req.user.role === 'participant') {
        const existing = db.prepare('SELECT id FROM projects WHERE created_by = ?').get(req.user.id);
        if (existing) return res.status(400).json({ error: 'Participants can only have one project' });
    }
    const id = uuid();
    db.prepare(`INSERT INTO projects (id, name, members, description, tech_stack, demo_url, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(id, name, JSON.stringify(members || []), description || '', JSON.stringify(techStack || []), demoUrl || '', req.user.id);
    res.json({ id, name });
});

app.put('/api/projects/:id', requireAuth, requireProjectOwnerOrAdmin, (req, res) => {
    const { name, members, description, techStack, demoUrl } = req.body;
    db.prepare(`UPDATE projects SET name = ?, members = ?, description = ?, tech_stack = ?, demo_url = ? WHERE id = ?`)
        .run(name, JSON.stringify(members || []), description || '', JSON.stringify(techStack || []), demoUrl || '', req.params.id);
    res.json({ success: true });
});

app.delete('/api/projects/:id', requireAuth, requireProjectOwnerOrAdmin, (req, res) => {
    // Also clean up uploaded files from disk
    const files = db.prepare('SELECT stored_name FROM project_files WHERE project_id = ?').all(req.params.id);
    files.forEach(f => {
        const filePath = path.join(UPLOADS_DIR, f.stored_name);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    });
    db.prepare('DELETE FROM projects WHERE id = ?').run(req.params.id);
    res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// PROJECT FILES (Upload / Download)
// ═══════════════════════════════════════════════════════════

app.post('/api/projects/:id/files', requireAuth, requireProjectOwnerOrAdmin, upload.array('files', 5), (req, res) => {
    const projectId = req.params.id;
    const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const existingCount = db.prepare('SELECT COUNT(*) as cnt FROM project_files WHERE project_id = ?').get(projectId).cnt;
    if (existingCount + (req.files || []).length > 5) {
        // Clean up just-uploaded files
        (req.files || []).forEach(f => fs.unlinkSync(f.path));
        return res.status(400).json({ error: 'Max 5 files per project' });
    }

    const ins = db.prepare('INSERT INTO project_files (id, project_id, original_name, stored_name, mime_type, size) VALUES (?, ?, ?, ?, ?, ?)');
    const inserted = (req.files || []).map(f => {
        const id = uuid();
        ins.run(id, projectId, f.originalname, f.filename, f.mimetype, f.size);
        return { id, originalName: f.originalname, size: f.size };
    });
    res.json({ files: inserted });
});

app.get('/api/projects/:id/files', requireAuth, (req, res) => {
    const rows = db.prepare('SELECT * FROM project_files WHERE project_id = ? ORDER BY created_at').all(req.params.id);
    res.json(rows.map(f => ({
        id: f.id,
        originalName: f.original_name,
        storedName: f.stored_name,
        mimeType: f.mime_type,
        size: f.size,
        createdAt: f.created_at
    })));
});

app.delete('/api/projects/:projectId/files/:fileId', requireAuth, requireProjectOwnerOrAdmin, (req, res) => {
    const file = db.prepare('SELECT * FROM project_files WHERE id = ? AND project_id = ?').get(req.params.fileId, req.params.projectId);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOADS_DIR, file.stored_name);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    db.prepare('DELETE FROM project_files WHERE id = ?').run(file.id);
    res.json({ success: true });
});

app.get('/api/files/:storedName', requireAuth, (req, res) => {
    const file = db.prepare('SELECT * FROM project_files WHERE stored_name = ?').get(req.params.storedName);
    if (!file) return res.status(404).json({ error: 'File not found' });
    const filePath = path.join(UPLOADS_DIR, file.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File missing from disk' });
    res.setHeader('Content-Disposition', `inline; filename="${file.original_name}"`);
    res.sendFile(filePath);
});

// ═══════════════════════════════════════════════════════════
// AI EVALUATION (AWS Bedrock)
// ═══════════════════════════════════════════════════════════

app.post('/api/projects/:id/ai-evaluate', requireAuth, requireAdmin, async (req, res) => {
    const projectId = req.params.id;
    const project = db.prepare('SELECT * FROM projects WHERE id = ?').get(projectId);
    if (!project) return res.status(404).json({ error: 'Project not found' });

    const criteria = db.prepare('SELECT * FROM criteria ORDER BY sort_order').all();
    const files = db.prepare('SELECT * FROM project_files WHERE project_id = ?').all(projectId);

    // Read text content from uploaded files
    const textExtensions = ['.txt', '.md', '.py', '.js', '.ts', '.java', '.cpp', '.c', '.go', '.rs',
        '.html', '.css', '.json', '.yaml', '.yml', '.xml', '.csv'];
    let projectContent = '';
    for (const f of files) {
        const ext = path.extname(f.original_name).toLowerCase();
        if (textExtensions.includes(ext)) {
            try {
                const filePath = path.join(UPLOADS_DIR, f.stored_name);
                const content = fs.readFileSync(filePath, 'utf-8');
                projectContent += `\n\n--- FILE: ${f.original_name} ---\n${content.slice(0, 15000)}`; // Cap per file
            } catch (e) { /* skip unreadable files */ }
        }
    }

    if (!projectContent.trim() && !project.description) {
        return res.status(400).json({ error: 'No content to evaluate. Upload text files (README, code, etc.) first.' });
    }

    // Build prompt
    const criteriaList = criteria.map(c => `- ${c.name} (weight: ${c.weight})`).join('\n');
    const members = JSON.parse(project.members || '[]');
    const techStack = JSON.parse(project.tech_stack || '[]');

    const prompt = `You are an expert hackathon judge. Evaluate this hackathon project based on the given criteria.

PROJECT: ${project.name}
TEAM: ${members.join(', ') || 'Unknown'}
TECH STACK: ${techStack.join(', ') || 'Unknown'}
DESCRIPTION: ${project.description || 'No description provided'}
${project.demo_url ? `DEMO URL: ${project.demo_url}` : ''}

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

    try {
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

        const response = await bedrockClient.send(command);
        const responseBody = JSON.parse(new TextDecoder().decode(response.body));
        const aiText = responseBody.content[0].text;

        // Parse JSON from response (handle markdown code blocks)
        let aiResult;
        try {
            const jsonMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)```/) || [null, aiText];
            aiResult = JSON.parse(jsonMatch[1].trim());
        } catch (parseErr) {
            return res.status(500).json({ error: 'Failed to parse AI response', raw: aiText });
        }

        // Validate and clamp scores
        const scores = {};
        const reasoning = {};
        criteria.forEach(c => {
            scores[c.id] = Math.max(1, Math.min(10, Math.round(aiResult.scores?.[c.id] || 5)));
            reasoning[c.id] = aiResult.reasoning?.[c.id] || 'No reasoning provided';
        });

        // Upsert AI evaluation
        const existing = db.prepare('SELECT id FROM ai_evaluations WHERE project_id = ?').get(projectId);
        if (existing) {
            db.prepare('UPDATE ai_evaluations SET scores = ?, reasoning = ?, overall_feedback = ?, model_used = ?, created_at = datetime("now") WHERE project_id = ?')
                .run(JSON.stringify(scores), JSON.stringify(reasoning), aiResult.overall_feedback || '', BEDROCK_MODEL, projectId);
        } else {
            db.prepare('INSERT INTO ai_evaluations (id, project_id, scores, reasoning, overall_feedback, model_used) VALUES (?, ?, ?, ?, ?, ?)')
                .run(uuid(), projectId, JSON.stringify(scores), JSON.stringify(reasoning), aiResult.overall_feedback || '', BEDROCK_MODEL);
        }

        res.json({
            scores,
            reasoning,
            overallFeedback: aiResult.overall_feedback || '',
            model: BEDROCK_MODEL
        });
    } catch (err) {
        console.error('Bedrock AI evaluation error:', err);
        res.status(500).json({ error: `AI evaluation failed: ${err.message}` });
    }
});

app.get('/api/projects/:id/ai-evaluation', requireAuth, (req, res) => {
    const row = db.prepare('SELECT * FROM ai_evaluations WHERE project_id = ?').get(req.params.id);
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
});

// ═══════════════════════════════════════════════════════════
// EVALUATIONS
// ═══════════════════════════════════════════════════════════

app.get('/api/evaluations', requireAuth, (req, res) => {
    let rows;
    if (req.query.projectId) {
        rows = db.prepare('SELECT * FROM evaluations WHERE project_id = ? ORDER BY created_at DESC').all(req.query.projectId);
    } else {
        rows = db.prepare('SELECT * FROM evaluations ORDER BY created_at DESC').all();
    }
    res.json(rows.map(e => ({
        ...e,
        projectId: e.project_id,
        judgeName: e.judge_name,
        scores: JSON.parse(e.scores),
        createdAt: e.created_at
    })));
});

app.post('/api/evaluations', requireAuth, requireJudgeOrAdmin, (req, res) => {
    const { projectId, scores, notes } = req.body;
    const judgeName = req.user.displayName;
    if (!projectId) return res.status(400).json({ error: 'projectId required' });
    const id = uuid();
    db.prepare(`INSERT INTO evaluations (id, project_id, judge_name, scores, notes)
                VALUES (?, ?, ?, ?, ?)`)
        .run(id, projectId, judgeName, JSON.stringify(scores || {}), notes || '');
    res.json({ id });
});

// ═══════════════════════════════════════════════════════════
// LEADERBOARD (hybrid: human + AI scoring)
// ═══════════════════════════════════════════════════════════

app.get('/api/leaderboard', requireAuth, (req, res) => {
    const projects = db.prepare('SELECT * FROM projects').all();
    const criteria = db.prepare('SELECT * FROM criteria ORDER BY sort_order').all();
    const evals = db.prepare('SELECT * FROM evaluations').all();
    const aiEvals = db.prepare('SELECT * FROM ai_evaluations').all();

    // Get AI weight from settings (default 0.4)
    const aiWeightSetting = db.prepare("SELECT value FROM settings WHERE key = 'aiWeight'").get();
    const aiWeight = aiWeightSetting ? parseFloat(aiWeightSetting.value) : 0.4;
    const humanWeight = 1 - aiWeight;

    const totalWeight = criteria.reduce((s, c) => s + c.weight, 0) || 1;
    const aiEvalMap = {};
    aiEvals.forEach(ae => { aiEvalMap[ae.project_id] = JSON.parse(ae.scores); });

    const ranked = projects.map(p => {
        const pEvals = evals.filter(e => e.project_id === p.id);
        const aiScores = aiEvalMap[p.id] || null;
        let humanScore = 0;
        let aiScore = 0;
        let finalScore = 0;
        const criteriaAvgs = {};
        const hasHuman = pEvals.length > 0;
        const hasAI = !!aiScores;

        if (hasHuman) {
            const weightedScores = pEvals.map(ev => {
                const scores = JSON.parse(ev.scores);
                let weighted = 0;
                criteria.forEach(c => { weighted += (scores[c.id] || 0) * c.weight; });
                return weighted / totalWeight;
            });
            humanScore = weightedScores.reduce((s, v) => s + v, 0) / weightedScores.length;

            criteria.forEach(c => {
                criteriaAvgs[c.id] = pEvals.reduce((s, ev) => s + (JSON.parse(ev.scores)[c.id] || 0), 0) / pEvals.length;
            });
        }

        if (hasAI) {
            let weighted = 0;
            criteria.forEach(c => { weighted += (aiScores[c.id] || 0) * c.weight; });
            aiScore = weighted / totalWeight;
        }

        // Hybrid blend
        if (hasHuman && hasAI) {
            finalScore = (humanScore * humanWeight) + (aiScore * aiWeight);
        } else if (hasHuman) {
            finalScore = humanScore;
        } else if (hasAI) {
            finalScore = aiScore;
        }

        return {
            id: p.id,
            name: p.name,
            avgScore: Math.round(finalScore * 100) / 100,
            humanScore: Math.round(humanScore * 100) / 100,
            aiScore: Math.round(aiScore * 100) / 100,
            evalCount: pEvals.length,
            hasAI,
            criteriaAvgs,
            aiScores: aiScores || {}
        };
    }).sort((a, b) => b.avgScore - a.avgScore);

    res.json(ranked);
});

// ═══════════════════════════════════════════════════════════
// DASHBOARD STATS
// ═══════════════════════════════════════════════════════════

app.get('/api/dashboard', requireAuth, (req, res) => {
    const totalProjects = db.prepare('SELECT COUNT(*) as cnt FROM projects').get().cnt;
    const totalEvals = db.prepare('SELECT COUNT(*) as cnt FROM evaluations').get().cnt;
    const judges = db.prepare('SELECT COUNT(DISTINCT judge_name) as cnt FROM evaluations').get().cnt;
    const recentEvals = db.prepare(`
        SELECT e.*, p.name as project_name
        FROM evaluations e
        LEFT JOIN projects p ON e.project_id = p.id
        ORDER BY e.created_at DESC
        LIMIT 5
    `).all().map(e => ({
        id: e.id,
        judgeName: e.judge_name,
        projectName: e.project_name,
        createdAt: e.created_at
    }));

    res.json({ totalProjects, totalEvals, judges, recentEvals });
});

// ═══════════════════════════════════════════════════════════
// EXPORT / IMPORT / RESET
// ═══════════════════════════════════════════════════════════

app.get('/api/export', requireAuth, requireAdmin, (req, res) => {
    const settings = {};
    db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; });
    const criteria = db.prepare('SELECT * FROM criteria ORDER BY sort_order').all();
    const projects = db.prepare('SELECT * FROM projects').all().map(p => ({
        ...p, members: JSON.parse(p.members), techStack: JSON.parse(p.tech_stack)
    }));
    const evaluations = db.prepare('SELECT * FROM evaluations').all().map(e => ({
        ...e, scores: JSON.parse(e.scores), projectId: e.project_id, judgeName: e.judge_name, createdAt: e.created_at
    }));
    res.json({ settings, criteria, projects, evaluations });
});

app.post('/api/import', requireAuth, requireAdmin, (req, res) => {
    const { settings, criteria, projects, evaluations } = req.body;
    const tx = db.transaction(() => {
        // Clear
        db.prepare('DELETE FROM evaluations').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM criteria').run();
        db.prepare('DELETE FROM settings').run();

        // Settings
        if (settings) {
            const ins = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)');
            for (const [k, v] of Object.entries(settings)) ins.run(k, String(v));
        }

        // Criteria
        if (criteria) {
            const ins = db.prepare('INSERT INTO criteria (id, name, weight, sort_order) VALUES (?, ?, ?, ?)');
            criteria.forEach((c, i) => ins.run(c.id, c.name, c.weight, i));
        }

        // Projects
        if (projects) {
            const ins = db.prepare('INSERT INTO projects (id, name, members, description, tech_stack, demo_url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
            for (const p of projects) {
                ins.run(p.id, p.name, JSON.stringify(p.members || []), p.description || '',
                    JSON.stringify(p.techStack || p.tech_stack || []), p.demoUrl || p.demo_url || '',
                    p.createdAt || p.created_at || new Date().toISOString());
            }
        }

        // Evaluations
        if (evaluations) {
            const ins = db.prepare('INSERT INTO evaluations (id, project_id, judge_name, scores, notes, created_at) VALUES (?, ?, ?, ?, ?, ?)');
            for (const e of evaluations) {
                ins.run(e.id, e.projectId || e.project_id, e.judgeName || e.judge_name,
                    JSON.stringify(e.scores || {}), e.notes || '',
                    e.createdAt || e.created_at || new Date().toISOString());
            }
        }
    });
    tx();
    res.json({ success: true });
});

app.post('/api/reset', requireAuth, requireAdmin, (req, res) => {
    const tx = db.transaction(() => {
        db.prepare('DELETE FROM evaluations').run();
        db.prepare('DELETE FROM projects').run();
        db.prepare('DELETE FROM criteria').run();
        db.prepare('DELETE FROM settings').run();

        // Re-seed defaults
        db.prepare("INSERT INTO settings (key, value) VALUES ('hackathonName', 'TechHack 2026')").run();
        const ins = db.prepare('INSERT INTO criteria (id, name, weight, sort_order) VALUES (?, ?, ?, ?)');
        [
            ['innovation', 'Innovation', 1.0, 0],
            ['technical', 'Technical Complexity', 1.0, 1],
            ['design', 'Design & UX', 1.0, 2],
            ['presentation', 'Presentation', 0.8, 3],
            ['impact', 'Impact & Viability', 1.0, 4]
        ].forEach(c => ins.run(...c));
    });
    tx();
    res.json({ success: true });
});

// ─── SPA Fallback ───────────────────────────────────────────
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ──────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`🚀 Hackathon Evaluator running at http://localhost:${PORT}`);
});
