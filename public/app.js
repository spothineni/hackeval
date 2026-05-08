/* ================================================================
   HACKATHON EVALUATOR — APP.JS (SQLite Backend + Auth + AI Scoring)
   Full SPA: Auth, Router, API Client, Dashboard, Projects, Judging,
   Leaderboard, Settings, File Upload, AI Evaluation, UI Utilities
   ================================================================ */

(function () {
    'use strict';

    // ─── Auth State ──────────────────────────────────────────────
    // Session lives in an HttpOnly cookie so JS can't read it; we keep only
    // the user profile here for UI rendering. The CSRF token cookie is
    // intentionally readable so we can echo it back as X-CSRF-Token.
    let currentUser = null;
    // Multi-tenancy: which hackathon is the SPA acting on right now? The
    // backend scopes everything by the X-Hackathon-Id header we set below.
    let currentHackathon = null;     // { id, slug, name, role }
    let availableHackathons = [];    // populated by /api/hackathons after login
    const HACKATHON_KEY = 'hackeval_current_hackathon';

    function readCookie(name) {
        const target = name + '=';
        for (const part of document.cookie.split(';')) {
            const trimmed = part.trim();
            if (trimmed.startsWith(target)) {
                try { return decodeURIComponent(trimmed.slice(target.length)); }
                catch { return trimmed.slice(target.length); }
            }
        }
        return null;
    }

    // ─── API Client ──────────────────────────────────────────────
    function buildHeaders(method, hasJsonBody) {
        const h = {};
        if (hasJsonBody) h['Content-Type'] = 'application/json';
        const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
        if (mutating) {
            const csrf = readCookie('hackeval_csrf');
            if (csrf) h['X-CSRF-Token'] = csrf;
        }
        // Scope every API call to the currently-selected hackathon. Routes
        // that don't need it ignore the header.
        if (currentHackathon?.id) h['X-Hackathon-Id'] = currentHackathon.id;
        return h;
    }

    async function request(url, { method = 'GET', body, isFormData = false } = {}) {
        const opts = {
            method,
            credentials: 'same-origin',
            headers: buildHeaders(method, body != null && !isFormData),
        };
        if (body != null) opts.body = isFormData ? body : JSON.stringify(body);
        const res = await fetch(url, opts);
        if (res.status === 401) { logout({ skipServer: true }); throw new Error('Session expired'); }
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            throw new Error(err.error || `Request failed (${res.status})`);
        }
        return res.json();
    }

    const api = {
        get: (url) => request(url),
        post: (url, data) => request(url, { method: 'POST', body: data }),
        put: (url, data) => request(url, { method: 'PUT', body: data }),
        del: (url) => request(url, { method: 'DELETE' }),
        uploadFiles: (url, files) => {
            const formData = new FormData();
            files.forEach(f => formData.append('files', f));
            return request(url, { method: 'POST', body: formData, isFormData: true });
        },
    };

    // ─── Auth Functions ──────────────────────────────────────────
    // Roles are now per-hackathon (membership-based). System-wide capabilities
    // (creating hackathons, managing global users) hang off systemRole instead.
    function isAdmin()       { return currentHackathon?.role === 'admin'; }
    function isParticipant() { return currentHackathon?.role === 'participant'; }
    function isJudge()       { return currentHackathon?.role === 'judge'; }
    function isSystemAdmin() { return currentUser?.systemRole === 'system_admin'; }

    async function setAuth(_token, user) {
        // The session cookie is set by the server; we just track the user
        // profile locally for UI rendering. Token argument is kept in the
        // signature for backwards compat with the login response shape.
        currentUser = user;
        updateUserUI();
        // Switch to the authenticated shell immediately so the user sees
        // they're signed in. The hackathon picker (if any) opens on top
        // of it once the membership list comes back.
        showAppShell(true);
        await loadAndSelectHackathon();
    }

    // ─── Hackathon selection ─────────────────────────────────────
    async function loadAndSelectHackathon() {
        try {
            availableHackathons = await api.get('/api/hackathons');
        } catch {
            availableHackathons = [];
        }

        if (availableHackathons.length === 0) {
            showHackathonEmptyState();
            return;
        }
        const remembered = localStorage.getItem(HACKATHON_KEY);
        const match = availableHackathons.find(h => h.id === remembered);
        if (match) return selectHackathon(match);
        if (availableHackathons.length === 1) return selectHackathon(availableHackathons[0]);
        showHackathonPicker();
    }

    function selectHackathon(h) {
        currentHackathon = h;
        try { localStorage.setItem(HACKATHON_KEY, h.id); } catch {}
        updateUserUI();
        updateHackathonBadge(h.name);
        showAppShell(true);
        // Re-route in case role-based gating changed (e.g. user is participant
        // here but admin elsewhere).
        if (typeof handleRoute === 'function') handleRoute();
    }

    function canCreateHackathon() { return isSystemAdmin() || currentUser?.systemRole === 'organizer'; }

    function statusPill(status) {
        const colors = {
            active: 'var(--accent-green, #10b981)',
            pending: 'var(--accent-amber, #f59e0b)',
            rejected: 'var(--accent-red, #ef4444)',
            archived: 'var(--text-muted)',
        };
        return `<span style="font-size:0.7rem;padding:2px 8px;border-radius:99px;background:${colors[status] || 'var(--text-muted)'};color:#fff;text-transform:uppercase;">${escHtml(status)}</span>`;
    }

    async function showHackathonPicker() {
        // Refresh both lists every open so the modal reflects current state.
        let mine = [];
        let discover = [];
        let pendingApproval = [];
        try {
            mine = await api.get('/api/hackathons');
            discover = await api.get('/api/hackathons?discover=1');
            availableHackathons = mine;
            if (isSystemAdmin()) {
                pendingApproval = mine.filter(h => h.status === 'pending');
            }
        } catch {}

        const renderItem = (h, action) => `
            <div class="hackathon-pick-item" data-hid="${escAttr(h.id)}"
                 style="padding:var(--space-md);border:1px solid var(--glass-border);border-radius:var(--radius-md);margin-bottom:var(--space-sm);display:flex;justify-content:space-between;align-items:center;gap:var(--space-md);">
                <div style="cursor:${action === 'select' ? 'pointer' : 'default'};flex:1;" data-action="select">
                    <div style="font-weight:600;display:flex;gap:var(--space-sm);align-items:center;">
                        ${escHtml(h.name)} ${statusPill(h.status)}
                    </div>
                    <div style="color:var(--text-muted);font-size:0.8rem;">${escHtml(h.slug)}${h.role ? ' · role: ' + escHtml(h.role) : ''}</div>
                </div>
                ${action === 'join' ? `<button class="btn btn-primary" data-action="join">Join</button>` : ''}
                ${action === 'review' ? `
                    <div style="display:flex;gap:var(--space-xs);">
                        <button class="btn btn-primary" data-action="approve">Approve</button>
                        <button class="btn btn-secondary" data-action="reject">Reject</button>
                    </div>` : ''}
                ${action === 'select' ? '<span style="color:var(--text-muted);">→</span>' : ''}
            </div>
        `;

        const sections = [];
        if (mine.length) {
            sections.push(`<h3 style="margin:var(--space-md) 0 var(--space-sm);font-size:0.9rem;color:var(--text-muted);">Your hackathons</h3>
                ${mine.map(h => renderItem(h, 'select')).join('')}`);
        }
        if (discover.length) {
            sections.push(`<h3 style="margin:var(--space-md) 0 var(--space-sm);font-size:0.9rem;color:var(--text-muted);">Discover (open to join)</h3>
                ${discover.map(h => renderItem(h, 'join')).join('')}`);
        }
        if (pendingApproval.length) {
            sections.push(`<h3 style="margin:var(--space-md) 0 var(--space-sm);font-size:0.9rem;color:var(--text-muted);">Awaiting your approval</h3>
                ${pendingApproval.map(h => renderItem(h, 'review')).join('')}`);
        }
        if (sections.length === 0) {
            sections.push(`<p style="color:var(--text-muted);">No hackathons available.${canCreateHackathon() ? ' Create one below.' : ''}</p>`);
        }

        const buttons = [];
        if (canCreateHackathon()) buttons.push(`<button class="btn btn-primary" id="btn-create-hackathon">+ Create new hackathon</button>`);
        buttons.push(`<button class="btn btn-secondary" id="btn-edit-profile">Edit profile</button>`);

        openModal('Choose a hackathon', sections.join(''), buttons.join(' '));

        // Click handlers
        document.querySelectorAll('.hackathon-pick-item').forEach(el => {
            const hid = el.dataset.hid;
            el.addEventListener('click', async (e) => {
                const action = e.target.dataset.action || e.target.closest('[data-action]')?.dataset?.action;
                const fromMine = mine.find(x => x.id === hid);
                const fromDiscover = discover.find(x => x.id === hid);
                const h = fromMine || fromDiscover;
                if (!h) return;
                if (action === 'select' && fromMine) {
                    closeModal(); selectHackathon(h);
                } else if (action === 'join' && fromDiscover) {
                    await joinHackathonFlow(h);
                } else if (action === 'approve') {
                    await approveHackathon(h);
                } else if (action === 'reject') {
                    await rejectHackathon(h);
                }
            });
        });
        const createBtn = document.getElementById('btn-create-hackathon');
        if (createBtn) createBtn.addEventListener('click', createHackathonPrompt);
        const profileBtn = document.getElementById('btn-edit-profile');
        if (profileBtn) profileBtn.addEventListener('click', showProfileModal);
    }

    function showHackathonEmptyState() {
        const action = canCreateHackathon()
            ? `<p>You can create one to get started.</p>
               <button class="btn btn-primary" id="btn-create-hackathon">+ Create hackathon</button>`
            : `<p>Browse open events below or ask an admin to add you to one.</p>
               <button class="btn btn-primary" id="btn-discover">Browse open hackathons</button>`;
        openModal('No hackathons available', action, '<button class="btn btn-secondary" id="btn-edit-profile">Edit profile</button>');
        document.getElementById('btn-create-hackathon')?.addEventListener('click', createHackathonPrompt);
        document.getElementById('btn-discover')?.addEventListener('click', () => { closeModal(); showHackathonPicker(); });
        document.getElementById('btn-edit-profile')?.addEventListener('click', showProfileModal);
    }

    async function createHackathonPrompt() {
        const slug = window.prompt('Slug (e.g. "techhack-2026"):');
        if (!slug) return;
        const name = window.prompt('Display name:');
        if (!name) return;
        const description = window.prompt('Short description (optional):') || '';
        try {
            const res = await api.post('/api/hackathons', { slug, name, description });
            const msg = res.status === 'pending'
                ? 'Hackathon created and submitted for admin approval.'
                : 'Hackathon created.';
            showToast(msg, 'success');
            availableHackathons = await api.get('/api/hackathons');
            const created = availableHackathons.find(h => h.slug === slug);
            closeModal();
            if (created && created.status === 'active') selectHackathon(created);
            else showHackathonPicker();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    async function joinHackathonFlow(h) {
        // Check whether the user already has a profile; if not, force them
        // through the profile modal first so judges have something to review.
        let profile = null;
        try { profile = await api.get('/api/profile'); } catch {}
        if (!profile) {
            showToast('Please fill out your profile first.', 'info');
            showProfileModal({ afterSave: () => joinHackathonFlow(h) });
            return;
        }
        try {
            await api.post(`/api/hackathons/${encodeURIComponent(h.id)}/join`, {});
            showToast(`Joined ${h.name}`, 'success');
            availableHackathons = await api.get('/api/hackathons');
            const joined = availableHackathons.find(x => x.id === h.id);
            closeModal();
            if (joined) selectHackathon(joined);
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    async function approveHackathon(h) {
        if (!window.confirm(`Approve "${h.name}"? It will become active and visible to participants.`)) return;
        try {
            await api.post(`/api/hackathons/${encodeURIComponent(h.id)}/approve`, {});
            showToast(`Approved ${h.name}`, 'success');
            showHackathonPicker();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    async function rejectHackathon(h) {
        const reason = window.prompt(`Reject "${h.name}". Reason (optional):`, '');
        if (reason === null) return; // cancelled
        try {
            await api.post(`/api/hackathons/${encodeURIComponent(h.id)}/reject`, { reason });
            showToast(`Rejected ${h.name}`, 'info');
            showHackathonPicker();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ─── Profile modal ───────────────────────────────────────────
    async function showProfileModal({ afterSave } = {}) {
        let profile = {};
        try { profile = await api.get('/api/profile') || {}; } catch {}
        const safe = (v) => v == null ? '' : escAttr(v);
        const skillsCsv = (profile.skills || []).map(s => s).join(', ');
        const levels = ['', 'beginner', 'intermediate', 'advanced', 'expert'];
        const body = `
            <div class="form-group"><label class="form-label">Bio</label>
                <textarea class="form-textarea" id="pf-bio" maxlength="5000" placeholder="Tell us about yourself">${escHtml(profile.bio || '')}</textarea></div>
            <div class="form-group"><label class="form-label">Skills (comma-separated)</label>
                <input class="form-input" id="pf-skills" value="${safe(skillsCsv)}" placeholder="React, Postgres, ML"></div>
            <div class="form-group"><label class="form-label">GitHub URL</label>
                <input class="form-input" id="pf-github" value="${safe(profile.githubUrl)}" placeholder="https://github.com/..."></div>
            <div class="form-group"><label class="form-label">LinkedIn URL</label>
                <input class="form-input" id="pf-linkedin" value="${safe(profile.linkedinUrl)}" placeholder="https://linkedin.com/in/..."></div>
            <div class="form-group"><label class="form-label">Portfolio URL</label>
                <input class="form-input" id="pf-portfolio" value="${safe(profile.portfolioUrl)}" placeholder="https://..."></div>
            <div class="form-group"><label class="form-label">Experience Level</label>
                <select class="form-input" id="pf-level">
                    ${levels.map(l => `<option value="${l}" ${profile.experienceLevel === l ? 'selected' : ''}>${l || '— select —'}</option>`).join('')}
                </select></div>
        `;
        openModal('Your profile', body, '<button class="btn btn-primary" id="btn-save-profile">Save</button>');
        document.getElementById('btn-save-profile').addEventListener('click', async () => {
            const skills = document.getElementById('pf-skills').value
                .split(',').map(s => s.trim()).filter(Boolean);
            const payload = {
                bio: document.getElementById('pf-bio').value || null,
                skills,
                githubUrl: document.getElementById('pf-github').value || null,
                linkedinUrl: document.getElementById('pf-linkedin').value || null,
                portfolioUrl: document.getElementById('pf-portfolio').value || null,
                experienceLevel: document.getElementById('pf-level').value || null,
            };
            try {
                await api.put('/api/profile', payload);
                showToast('Profile saved', 'success');
                closeModal();
                if (typeof afterSave === 'function') afterSave();
            } catch (err) {
                showToast(err.message, 'error');
            }
        });
    }

    function logout({ skipServer = false } = {}) {
        currentUser = null;
        currentHackathon = null;
        availableHackathons = [];
        // Clear stale legacy keys from older versions that stored the JWT.
        try { localStorage.removeItem('hackeval_token'); } catch {}
        try { localStorage.removeItem(HACKATHON_KEY); } catch {}
        if (!skipServer) {
            // Best-effort — failure to reach the server still logs the user
            // out client-side. The server endpoint clears the cookies.
            fetch('/api/auth/logout', {
                method: 'POST',
                credentials: 'same-origin',
                headers: buildHeaders('POST', false),
            }).catch(() => {});
        }
        showAppShell(false);
    }

    // Three top-level views, only one visible at a time:
    //   landing  → marketing page (default for unauthenticated visitors)
    //   auth    → sign in / register form (clicked into from landing)
    //   app     → authenticated app shell
    function showView(name) {
        const landing = document.getElementById('landing');
        const auth = document.getElementById('auth-screen');
        const app = document.getElementById('app-shell');
        if (landing) landing.style.display = name === 'landing' ? '' : 'none';
        if (auth)    auth.style.display    = name === 'auth' ? 'flex' : 'none';
        if (app)     app.style.display     = name === 'app' ? '' : 'none';
    }
    // Back-compat shim for the rest of the file: showAppShell(true) → app,
    // showAppShell(false) → landing (the public default).
    function showAppShell(authenticated) {
        showView(authenticated ? 'app' : 'landing');
    }
    function showAuthScreen(mode) {
        if (mode === 'register' || mode === 'login') {
            authMode = mode;
            if (typeof updateAuthMode === 'function') updateAuthMode();
        }
        showView('auth');
    }

    function updateUserUI() {
        if (!currentUser) return;
        const avatar = document.getElementById('user-avatar');
        const nameEl = document.getElementById('user-name');
        const roleEl = document.getElementById('user-role');
        if (avatar) avatar.textContent = currentUser.displayName.charAt(0);
        if (nameEl) nameEl.textContent = currentUser.displayName;
        if (roleEl) {
            // Role shown is the user's role IN THE SELECTED HACKATHON. Falls
            // back to the legacy global role until a hackathon is picked.
            const role = currentHackathon?.role || currentUser.role || '—';
            roleEl.textContent = role;
            roleEl.className = 'user-role role-badge-' + role;
        }
        const settingsItem = document.getElementById('nav-settings-item');
        if (settingsItem) settingsItem.style.display = isAdmin() ? '' : 'none';
        const judgingItem = document.getElementById('nav-judging-item');
        if (judgingItem) judgingItem.style.display = isParticipant() ? 'none' : '';
        const projectsItem = document.getElementById('nav-projects-item');
        if (projectsItem) projectsItem.style.display = isParticipant() ? 'none' : '';
        const myprojectItem = document.getElementById('nav-myproject-item');
        if (myprojectItem) myprojectItem.style.display = isParticipant() ? '' : 'none';
    }

    async function checkAuth() {
        // Cookie is HttpOnly so we can't peek at it from JS — just ask the
        // server who we are. 401 means no valid session, show landing.
        try {
            const user = await api.get('/api/auth/me');
            currentUser = user;
            updateUserUI();
            showAppShell(true);
            await loadAndSelectHackathon();
        } catch (e) {
            // /api/auth/me 401 throws "Session expired" — that's the expected
            // unauthenticated state on first load; just show the landing page.
            // (Note: api wrapper already called logout on 401 which set the
            // view to landing; this is belt-and-braces.)
            showAppShell(false);
        }
    }

    // ─── Auth Form Logic ─────────────────────────────────────────
    let authMode = 'login';

    function setupAuthForm() {
        const form = document.getElementById('auth-form');
        const toggleLink = document.getElementById('auth-toggle-link');
        toggleLink.addEventListener('click', (e) => {
            e.preventDefault();
            authMode = authMode === 'login' ? 'register' : 'login';
            updateAuthMode();
        });
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const errorEl = document.getElementById('auth-error');
            errorEl.style.display = 'none';
            const username = document.getElementById('auth-username').value.trim();
            const password = document.getElementById('auth-password').value;
            if (!username || !password) {
                errorEl.textContent = 'Please fill in all required fields';
                errorEl.style.display = 'block';
                return;
            }
            try {
                if (authMode === 'login') {
                    const res = await api.post('/api/auth/login', { username, password });
                    showToast(`Welcome back, ${res.user.displayName}!`);
                    // Await — setAuth now switches the view and loads the
                    // user's hackathons. Calling handleRoute here too races
                    // with selectHackathon's own handleRoute call.
                    await setAuth(res.token, res.user);
                } else {
                    const email = document.getElementById('auth-email').value.trim();
                    const displayName = document.getElementById('auth-displayname').value.trim();
                    if (!email || !displayName) {
                        errorEl.textContent = 'All fields are required for registration';
                        errorEl.style.display = 'block';
                        return;
                    }
                    const wantsOrganizer = document.getElementById('auth-wants-organizer')?.checked === true;
                    const res = await api.post('/api/auth/register', { username, email, password, displayName, wantsOrganizer });
                    showToast(
                        wantsOrganizer
                            ? `Welcome, ${res.user.displayName}! You're now an organizer.`
                            : `Welcome, ${res.user.displayName}! Account created.`
                    );
                    await setAuth(res.token, res.user);
                }
            } catch (err) {
                errorEl.textContent = err.message;
                errorEl.style.display = 'block';
            }
        });
    }

    function updateAuthMode() {
        const subtitle = document.getElementById('auth-subtitle');
        const submitBtn = document.getElementById('auth-submit');
        const toggleText = document.getElementById('auth-toggle-text');
        const toggleLink = document.getElementById('auth-toggle-link');
        const registerFields = document.querySelectorAll('.auth-register-field');
        document.getElementById('auth-error').style.display = 'none';
        if (authMode === 'login') {
            subtitle.textContent = 'Sign in to your account';
            submitBtn.textContent = 'Sign In';
            toggleText.textContent = "Don't have an account?";
            toggleLink.textContent = 'Create one';
            registerFields.forEach(f => f.style.display = 'none');
        } else {
            subtitle.textContent = 'Create a new account';
            submitBtn.textContent = 'Create Account';
            toggleText.textContent = 'Already have an account?';
            toggleLink.textContent = 'Sign in';
            registerFields.forEach(f => f.style.display = 'block');
        }
    }

    // ─── Utilities ───────────────────────────────────────────────
    function timeAgo(dateStr) {
        const diff = Date.now() - new Date(dateStr).getTime();
        const mins = Math.floor(diff / 60000);
        if (mins < 1) return 'just now';
        if (mins < 60) return `${mins}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function getFileIcon(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        const icons = {
            py: '🐍', js: '📜', ts: '📜', jsx: '📜', tsx: '📜',
            java: '☕', cpp: '⚙️', c: '⚙️', h: '⚙️', go: '🔵', rs: '🦀',
            html: '🌐', css: '🎨', json: '📋', yaml: '📋', yml: '📋', xml: '📋',
            md: '📝', txt: '📄', pdf: '📕', pptx: '📊', ppt: '📊', docx: '📘', doc: '📘',
            png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
            zip: '📦', sh: '💻', sql: '🗄️', rb: '💎', php: '🐘',
            vue: '💚', svelte: '🧡', swift: '🍎', kt: '🟣'
        };
        return icons[ext] || '📄';
    }

    // Recursively read files from a dropped folder via webkitGetAsEntry()
    async function getAllFilesFromDrop(items) {
        const files = [];
        const readEntry = (entry) => new Promise((resolve) => {
            if (entry.isFile) {
                entry.file(f => { files.push(f); resolve(); });
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                reader.readEntries(async entries => {
                    for (const e of entries) await readEntry(e);
                    resolve();
                });
            } else { resolve(); }
        });
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) await readEntry(entry);
        }
        return files;
    }

    function escHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function escAttr(str) { return String(str).replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }

    function updateHackathonBadge(name) {
        const badge = document.getElementById('hackathon-badge');
        if (badge) {
            badge.querySelector('.badge-text').textContent = name;
            // Click to switch — useful when the user belongs to >1 event.
            // Re-attach each call so we don't accumulate listeners.
            badge.style.cursor = 'pointer';
            badge.title = 'Click to switch hackathon';
            badge.onclick = () => showHackathonPicker();
        }
        document.title = `${name} — Hackathon Evaluator`;
    }

    function downloadFile(content, filename, type) {
        const blob = new Blob([content], { type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = filename; a.click();
        URL.revokeObjectURL(url);
    }

    // ─── Toast ───────────────────────────────────────────────────
    function showToast(message, type = 'success') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;
        const icons = { success: '✅', error: '❌', info: 'ℹ️' };
        toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escHtml(message)}</span>`;
        container.appendChild(toast);
        setTimeout(() => { toast.classList.add('toast-exit'); setTimeout(() => toast.remove(), 300); }, 3000);
    }

    // ─── Modal ───────────────────────────────────────────────────
    function openModal(title, bodyHtml, footerHtml = '') {
        document.getElementById('modal-title').textContent = title;
        document.getElementById('modal-body').innerHTML = bodyHtml;
        document.getElementById('modal-footer').innerHTML = footerHtml;
        document.getElementById('modal-overlay').classList.add('show');
    }
    function closeModal() { document.getElementById('modal-overlay').classList.remove('show'); }
    document.getElementById('modal-close').addEventListener('click', closeModal);
    document.getElementById('modal-overlay').addEventListener('click', e => {
        if (e.target === document.getElementById('modal-overlay')) closeModal();
    });

    // ─── Router ──────────────────────────────────────────────────
    const pages = { dashboard: renderDashboard, projects: renderProjects, judging: renderJudging, leaderboard: renderLeaderboard, settings: renderSettings, myproject: renderMyProject };

    function navigate(page) {
        if (!pages[page]) page = 'dashboard';
        if (page === 'settings' && !isAdmin()) page = 'dashboard';
        if (page === 'judging' && isParticipant()) page = 'myproject';
        if (page === 'projects' && isParticipant()) page = 'myproject';
        window.location.hash = page;
    }

    function handleRoute() {
        if (!currentUser) return;
        let hash = window.location.hash.replace('#', '') || (isParticipant() ? 'myproject' : 'dashboard');
        let page = pages[hash] ? hash : (isParticipant() ? 'myproject' : 'dashboard');
        if (page === 'settings' && !isAdmin()) page = isParticipant() ? 'myproject' : 'dashboard';
        if (page === 'judging' && isParticipant()) page = 'myproject';
        if (page === 'projects' && isParticipant()) page = 'myproject';
        document.querySelectorAll('.nav-link').forEach(link => {
            link.classList.toggle('active', link.dataset.page === page);
        });
        const container = document.getElementById('page-container');
        container.style.animation = 'none'; container.offsetHeight; container.style.animation = '';
        pages[page](container);
    }

    window.addEventListener('hashchange', handleRoute);
    document.getElementById('sidebar-toggle').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('collapsed');
    });
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', e => { e.preventDefault(); navigate(link.dataset.page); });
    });
    document.getElementById('btn-logout').addEventListener('click', () => { logout(); showToast('Signed out', 'info'); });

    // ─── DASHBOARD ───────────────────────────────────────────────
    async function renderDashboard(container) {
        container.innerHTML = '<div class="page-header"><h1>Dashboard</h1><p class="subtitle">Loading...</p></div>';
        try {
            const [dash, leaderboard, settings] = await Promise.all([
                api.get('/api/dashboard'), api.get('/api/leaderboard'), api.get('/api/settings')
            ]);
            const hackathonName = settings.hackathonName || 'Hackathon';
            const top3 = leaderboard.slice(0, 3);
            const avgOverall = leaderboard.length > 0 ? (leaderboard.reduce((s, p) => s + p.avgScore, 0) / leaderboard.length).toFixed(1) : '0.0';
            const aiCount = leaderboard.filter(p => p.hasAI).length;
            container.innerHTML = `
                <div class="page-header"><h1>Dashboard</h1><p class="subtitle">Overview of ${escHtml(hackathonName)}</p></div>
                <div class="stats-grid">
                    <div class="glass-card stat-card"><div class="stat-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></div><div class="stat-value">${dash.totalProjects}</div><div class="stat-label">Projects</div></div>
                    <div class="glass-card stat-card"><div class="stat-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div><div class="stat-value">${dash.totalEvals}</div><div class="stat-label">Evaluations</div></div>
                    <div class="glass-card stat-card"><div class="stat-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h6M9 13h4"/></svg></div><div class="stat-value">${aiCount}</div><div class="stat-label">AI Evaluated</div></div>
                    <div class="glass-card stat-card"><div class="stat-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#10B981" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg></div><div class="stat-value">${avgOverall}</div><div class="stat-label">Avg Score</div></div>
                </div>
                <div class="two-col">
                    <div class="glass-card no-hover">
                        <h3 style="font-family:var(--font-mono);font-size:0.7rem;font-weight:600;margin-bottom:var(--space-md);text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);">Top Projects</h3>
                        ${top3.length === 0 ? '<p style="color:var(--text-muted);font-size:0.82rem;">No projects evaluated yet</p>' :
                    top3.map((p, i) => `<div class="top-project">
                            <div class="top-project-rank ${i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : 'rank-3'}">${i + 1}</div>
                            <div class="top-project-info">
                                <div class="top-project-name">${escHtml(p.name)} ${p.hasAI ? '<span class="ai-eval-badge">AI</span>' : ''}</div>
                                <div class="top-project-score">${p.avgScore.toFixed(1)} / 10</div>
                            </div></div>`).join('')}
                    </div>
                    <div class="glass-card no-hover">
                        <h3 style="font-family:var(--font-mono);font-size:0.7rem;font-weight:600;margin-bottom:var(--space-md);text-transform:uppercase;letter-spacing:0.06em;color:var(--text-muted);">Recent Activity</h3>
                        ${dash.recentEvals.length === 0 ? '<p style="color:var(--text-muted);font-size:0.82rem;">No evaluations yet</p>' :
                    `<div class="activity-list">${dash.recentEvals.map(ev => `<div class="activity-item">
                                <div class="activity-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#6366F1" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg></div>
                                <div class="activity-text"><strong>${escHtml(ev.judgeName)}</strong> evaluated <strong>${escHtml(ev.projectName || 'Unknown')}</strong></div>
                                <div class="activity-time">${timeAgo(ev.createdAt)}</div></div>`).join('')}</div>`}
                    </div>
                </div>`;
            updateHackathonBadge(hackathonName);
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Error</div><div class="empty-desc">${escHtml(err.message)}</div></div>`;
        }
    }

    // ─── PROJECTS ────────────────────────────────────────────────
    async function renderProjects(container) {
        container.innerHTML = `
            <div class="page-header"><div class="page-header-row">
                <div><h1>Projects</h1><p class="subtitle">Manage hackathon submissions</p></div>
                ${isAdmin() ? '<button class="btn btn-primary" id="btn-add-project"><span>+</span> Add Project</button>' : ''}
            </div></div>
            <div id="projects-content"><p style="color:var(--text-muted);">Loading...</p></div>`;
        if (isAdmin()) document.getElementById('btn-add-project').addEventListener('click', () => openProjectModal());
        await renderProjectsList();
    }

    async function renderProjectsList() {
        const content = document.getElementById('projects-content');
        if (!content) return;
        try {
            const [projects, leaderboard] = await Promise.all([api.get('/api/projects'), api.get('/api/leaderboard')]);
            const scoreMap = {};
            leaderboard.forEach(p => { scoreMap[p.id] = p; });
            if (projects.length === 0) {
                content.innerHTML = `<div class="empty-state"><div class="empty-icon">🚀</div><div class="empty-title">No projects yet</div>
                    <div class="empty-desc">${isAdmin() ? 'Add your first hackathon project' : 'No projects added yet'}</div>
                    ${isAdmin() ? '<button class="btn btn-primary" id="btn-add-first-project">+ Add Project</button>' : ''}</div>`;
                if (isAdmin()) document.getElementById('btn-add-first-project').addEventListener('click', () => openProjectModal());
                return;
            }
            content.innerHTML = `<div class="projects-list">${projects.map(p => {
                const lb = scoreMap[p.id] || { avgScore: 0, evalCount: 0, hasAI: false };
                return `<div class="glass-card project-list-item">
                    <div class="pli-main">
                        <div class="pli-title">${escHtml(p.name)} ${lb.hasAI ? '<span class="ai-eval-badge">AI</span>' : ''}</div>
                        <div class="pli-desc" title="${escAttr(p.description || '')}">${escHtml(p.description || 'No description')}</div>
                    </div>
                    <div class="pli-members">${(p.members || []).map(m => `<span class="member-chip">${escHtml(m)}</span>`).join('')}</div>
                    <div class="pli-tech">${(p.techStack || []).map(t => `<span class="tech-chip">${escHtml(t)}</span>`).join('')}</div>
                    <div class="pli-score">
                        ${lb.evalCount > 0 || lb.hasAI ? `<span class="project-score-badge">${lb.avgScore.toFixed(1)} / 10</span>` : '<span style="font-size:0.8rem;color:var(--text-muted);">Not scored</span>'}
                        <div style="font-size:0.7rem;color:var(--text-muted);margin-top:4px;">${lb.evalCount} eval${lb.evalCount !== 1 ? 's' : ''}</div>
                    </div>
                    ${isAdmin() ? `<div class="pli-actions">
                        <button class="btn btn-ai btn-sm btn-ai-eval" data-id="${p.id}" title="AI Evaluate">AI</button>
                        <button class="btn btn-secondary btn-sm btn-edit-project" data-id="${p.id}" title="Edit">✏️</button>
                        <button class="btn btn-danger btn-sm btn-delete-project" data-id="${p.id}" data-name="${escAttr(p.name)}" title="Delete">🗑️</button>
                    </div>` : ''}
                </div>`;
            }).join('')}</div>`;

            if (isAdmin()) {
                content.querySelectorAll('.btn-edit-project').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        const proj = (await api.get('/api/projects')).find(p => p.id === btn.dataset.id);
                        if (proj) openProjectModal(proj);
                    });
                });
                content.querySelectorAll('.btn-delete-project').forEach(btn => {
                    btn.addEventListener('click', () => deleteProject(btn.dataset.id, btn.dataset.name));
                });
                content.querySelectorAll('.btn-ai-eval').forEach(btn => {
                    btn.addEventListener('click', () => triggerAIEvaluation(btn.dataset.id, btn));
                });
            }
        } catch (err) {
            content.innerHTML = `<p style="color:var(--accent-red);">Error: ${escHtml(err.message)}</p>`;
        }
    }

    async function triggerAIEvaluation(projectId, btn) {
        const origText = btn.innerHTML;
        btn.innerHTML = '<span class="ai-spinner"></span>';
        btn.disabled = true;
        try {
            const result = await api.post(`/api/projects/${projectId}/ai-evaluate`);
            showToast('AI evaluation complete!');
            // Show results in modal
            const criteria = await api.get('/api/criteria');
            const scoreRows = criteria.map(c => `
                <div class="ai-score-row"><div>
                    <div class="ai-score-label">${escHtml(c.name)}</div>
                    <div class="ai-score-reasoning">${escHtml(result.reasoning[c.id] || '')}</div>
                </div><div class="ai-score-value">${result.scores[c.id]}</div></div>`).join('');
            openModal('AI Evaluation Results', `
                <div class="ai-eval-card">
                    <div class="ai-eval-header">
                        <span class="ai-eval-badge">AI Scored</span>
                        <span class="ai-eval-model">${escHtml(result.model)}</span>
                    </div>
                    <div class="ai-eval-feedback">${escHtml(result.overallFeedback)}</div>
                    ${scoreRows}
                </div>`, '<button class="btn btn-secondary" onclick="document.getElementById(\'modal-overlay\').classList.remove(\'show\')">Close</button>');
            await renderProjectsList();
        } catch (err) {
            showToast(err.message, 'error');
        } finally {
            btn.innerHTML = origText;
            btn.disabled = false;
        }
    }

    function openProjectModal(project = null) {
        const isEdit = !!project;
        const body = `
            <div class="form-group"><label class="form-label">Project Name</label>
                <input class="form-input" id="pm-name" value="${isEdit ? escAttr(project.name) : ''}" placeholder="e.g. AI Health Assistant"></div>
            <div class="form-group"><label class="form-label">Team Members (comma-separated)</label>
                <input class="form-input" id="pm-members" value="${isEdit ? escAttr((project.members || []).join(', ')) : ''}" placeholder="e.g. Alice, Bob"></div>
            <div class="form-group"><label class="form-label">Description</label>
                <textarea class="form-textarea" id="pm-desc" placeholder="Brief description...">${isEdit ? escHtml(project.description || '') : ''}</textarea></div>
            <div class="form-group"><label class="form-label">Tech Stack (comma-separated)</label>
                <input class="form-input" id="pm-tech" value="${isEdit ? escAttr((project.techStack || []).join(', ')) : ''}" placeholder="e.g. React, Node.js"></div>
            <div class="form-group"><label class="form-label">Demo URL</label>
                <input class="form-input" id="pm-url" value="${isEdit ? escAttr(project.demoUrl || '') : ''}" placeholder="https://..."></div>
            ${isEdit ? `<div class="form-group"><label class="form-label">📁 Project Files</label>
                <div class="file-dropzone" id="pm-dropzone">
                    <div class="file-dropzone-icon">📂</div>
                    <div class="file-dropzone-text">Drop files, folders, or a ZIP here</div>
                    <div class="file-dropzone-hint">Up to 50 files, 50MB max • ZIP files auto-extracted</div>
                    <div style="margin-top:12px;display:flex;gap:8px;justify-content:center;">
                        <button type="button" class="btn btn-secondary btn-sm" id="pm-select-files">📄 Files</button>
                        <button type="button" class="btn btn-secondary btn-sm" id="pm-select-folder">📁 Folder</button>
                    </div>
                </div>
                <div style="background:var(--accent-indigo-dim); padding:10px 12px; border-radius:var(--radius); margin-bottom:var(--space-md); border:1px solid rgba(99,102,241,0.2); font-size:0.75rem; color:var(--text-secondary); line-height:1.4;">
                    <div style="font-weight:600; color:var(--text-primary); margin-bottom:4px; display:flex; align-items:center; gap:6px;">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--accent-indigo)" stroke-width="2.5"><path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4M4.93 19.07l2.83-2.83M16.24 7.76l2.83-2.83"/></svg> AI Evaluation Constraints
                    </div>
                    Only standard code and text files (e.g. .js, .py, .md) are sent to the AI. Binaries and images are ignored. 
                    <br>To prevent limits, each file is truncated to its first <strong>15,000 characters</strong>.
                </div>
                <div class="upload-progress-wrap" id="pm-progress-wrap">
                    <div class="upload-progress-label">
                        <span id="pm-progress-text">Uploading...</span>
                        <span id="pm-progress-pct">0%</span>
                    </div>
                    <div class="upload-progress-bar"><div class="upload-progress-fill" id="pm-progress-fill"></div></div>
                </div>
                <input type="file" id="pm-file-input" multiple style="display:none;">
                <input type="file" id="pm-folder-input" webkitdirectory style="display:none;">
                <div class="file-list" id="pm-file-list"></div></div>` : '<p style="font-size:0.8rem;color:var(--text-muted);margin-top:var(--space-sm);">💡 Save the project first, then edit it to upload files.</p>'}`;

        const footer = `<button class="btn btn-secondary" id="pm-cancel">Cancel</button>
            <button class="btn btn-primary" id="pm-save">${isEdit ? 'Update' : 'Add'} Project</button>`;
        openModal(isEdit ? 'Edit Project' : 'Add Project', body, footer);

        if (isEdit) setupFileUpload(project.id);

        document.getElementById('pm-cancel').addEventListener('click', closeModal);
        document.getElementById('pm-save').addEventListener('click', async () => {
            const name = document.getElementById('pm-name').value.trim();
            if (!name) { showToast('Project name is required', 'error'); return; }
            const data = {
                name,
                members: document.getElementById('pm-members').value.split(',').map(s => s.trim()).filter(Boolean),
                description: document.getElementById('pm-desc').value.trim(),
                techStack: document.getElementById('pm-tech').value.split(',').map(s => s.trim()).filter(Boolean),
                demoUrl: document.getElementById('pm-url').value.trim()
            };
            try {
                if (isEdit) { await api.put(`/api/projects/${project.id}`, data); showToast('Project updated'); }
                else { await api.post('/api/projects', data); showToast('Project added'); }
                closeModal();
                await renderProjectsList();
            } catch (err) { showToast(err.message, 'error'); }
        });
    }

    async function setupFileUpload(projectId) {
        const dropzone = document.getElementById('pm-dropzone');
        const fileInput = document.getElementById('pm-file-input');
        const folderInput = document.getElementById('pm-folder-input');
        const fileList = document.getElementById('pm-file-list');
        if (!dropzone) return;

        async function refreshFiles() {
            const files = await api.get(`/api/projects/${projectId}/files`);
            fileList.innerHTML = files.map(f => `
                <div class="file-item">
                    <span>${getFileIcon(f.originalName)}</span>
                    <span class="file-item-name" title="${escHtml(f.originalName)}">${escHtml(f.originalName)}</span>
                    <span class="file-item-size">${formatBytes(f.size)}</span>
                    <button class="file-item-remove" data-id="${f.id}" title="Remove">×</button>
                </div>`).join('');
            fileList.querySelectorAll('.file-item-remove').forEach(btn => {
                btn.addEventListener('click', async () => {
                    await api.del(`/api/projects/${projectId}/files/${btn.dataset.id}`);
                    showToast('File removed', 'info');
                    refreshFiles();
                });
            });
        }

        async function uploadFiles(files) {
            if (!files.length) return;
            const progressWrap = document.getElementById('pm-progress-wrap');
            const progressFill = document.getElementById('pm-progress-fill');
            const progressText = document.getElementById('pm-progress-text');
            const progressPct  = document.getElementById('pm-progress-pct');

            // Show progress bar
            if (progressWrap) {
                progressWrap.classList.add('visible');
                progressFill.style.width = '0%';
                progressText.textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`;
                progressPct.textContent = '0%';
            }

            try {
                await new Promise((resolve, reject) => {
                    const formData = new FormData();
                    files.forEach(f => formData.append('files', f));
                    const xhr = new XMLHttpRequest();
                    xhr.open('POST', `/api/projects/${projectId}/files`);
                    // Session cookie flows automatically with `withCredentials`;
                    // the CSRF token must be echoed from its (readable) cookie.
                    xhr.withCredentials = true;
                    const csrf = readCookie('hackeval_csrf');
                    if (csrf) xhr.setRequestHeader('X-CSRF-Token', csrf);
                    xhr.upload.onprogress = (e) => {
                        if (e.lengthComputable && progressFill) {
                            const pct = Math.round((e.loaded / e.total) * 100);
                            progressFill.style.width = pct + '%';
                            if (progressPct) progressPct.textContent = pct + '%';
                        }
                    };
                    xhr.onload = () => {
                        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
                        else reject(new Error(JSON.parse(xhr.responseText)?.error || 'Upload failed'));
                    };
                    xhr.onerror = () => reject(new Error('Network error during upload'));
                    xhr.send(formData);
                });
                // Complete the bar
                if (progressFill) progressFill.style.width = '100%';
                if (progressPct)  progressPct.textContent = '100%';
                if (progressText) progressText.textContent = `✅ ${files.length} file${files.length > 1 ? 's' : ''} uploaded!`;
                showToast(`${files.length} file(s) uploaded`);
                setTimeout(() => { if (progressWrap) progressWrap.classList.remove('visible'); }, 2000);
                refreshFiles();
            } catch (err) {
                if (progressText) progressText.textContent = `❌ ${err.message}`;
                if (progressFill) progressFill.style.background = '#ef4444';
                setTimeout(() => { if (progressWrap) progressWrap.classList.remove('visible'); if (progressFill) progressFill.style.background = ''; }, 3000);
                showToast(err.message, 'error');
            }
        }

        document.getElementById('pm-select-files')?.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
        document.getElementById('pm-select-folder')?.addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
        dropzone.addEventListener('click', (e) => { if (e.target === dropzone || e.target.closest('.file-dropzone-icon,.file-dropzone-text,.file-dropzone-hint')) fileInput.click(); });
        dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
        dropzone.addEventListener('drop', async e => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            const items = e.dataTransfer.items;
            if (items && items[0] && items[0].webkitGetAsEntry) {
                const allFiles = await getAllFilesFromDrop(items);
                await uploadFiles(allFiles);
            } else {
                const files = Array.from(e.dataTransfer.files);
                await uploadFiles(files);
            }
        });
        fileInput.addEventListener('change', async () => {
            await uploadFiles(Array.from(fileInput.files));
            fileInput.value = '';
        });
        folderInput.addEventListener('change', async () => {
            await uploadFiles(Array.from(folderInput.files));
            folderInput.value = '';
        });

        refreshFiles();
    }

    function deleteProject(id, name) {
        const body = `<p>Delete <strong>${escHtml(name)}</strong>? This removes all evaluations and uploaded files.</p>`;
        const footer = `<button class="btn btn-secondary" id="dp-cancel">Cancel</button><button class="btn btn-danger" id="dp-confirm">Delete</button>`;
        openModal('Delete Project', body, footer);
        document.getElementById('dp-cancel').addEventListener('click', closeModal);
        document.getElementById('dp-confirm').addEventListener('click', async () => {
            await api.del(`/api/projects/${id}`);
            closeModal(); showToast('Project deleted', 'info');
            await renderProjectsList();
        });
    }

    // ─── JUDGING ─────────────────────────────────────────────────
    let selectedJudgingProject = null;

    async function renderJudging(container) {
        container.innerHTML = '<div class="page-header"><h1>Judging</h1><p class="subtitle">Loading...</p></div>';
        try {
            const projects = await api.get('/api/projects');
            if (projects.length === 0) {
                container.innerHTML = `<div class="page-header"><h1>Judging</h1><p class="subtitle">Evaluate hackathon projects</p></div>
                    <div class="empty-state"><div class="empty-icon">⭐</div><div class="empty-title">No projects to judge</div>
                    <div class="empty-desc">Add some projects first</div>
                    ${isAdmin() ? '<button class="btn btn-primary" id="btn-goto-projects">Go to Projects</button>' : ''}</div>`;
                if (isAdmin()) document.getElementById('btn-goto-projects').addEventListener('click', () => navigate('projects'));
                return;
            }
            if (!selectedJudgingProject || !projects.find(p => p.id === selectedJudgingProject)) {
                selectedJudgingProject = projects[0].id;
            }
            container.innerHTML = `<div class="page-header"><h1>Judging</h1><p class="subtitle">Select a project and submit your scores</p></div>
                <div class="judging-layout"><div class="judging-sidebar" id="judging-sidebar"></div><div class="judging-form" id="judging-form"></div></div>`;
            await renderJudgingSidebar(projects);
            await renderJudgingForm(projects);
        } catch (err) { container.innerHTML = `<p style="color:var(--accent-red);">Error: ${escHtml(err.message)}</p>`; }
    }

    async function renderJudgingSidebar(projects) {
        const sidebar = document.getElementById('judging-sidebar');
        if (!sidebar) return;
        const leaderboard = await api.get('/api/leaderboard');
        const evalMap = {};
        leaderboard.forEach(p => { evalMap[p.id] = p; });
        sidebar.innerHTML = projects.map(p => {
            const lb = evalMap[p.id] || {};
            return `<div class="judging-project-item ${p.id === selectedJudgingProject ? 'selected' : ''}" data-id="${p.id}">
                <div class="jp-name">${escHtml(p.name)} ${lb.hasAI ? '<span class="ai-eval-badge">AI</span>' : ''}</div>
                <div class="jp-status">${lb.evalCount || 0} eval${(lb.evalCount || 0) !== 1 ? 's' : ''}</div></div>`;
        }).join('');
        sidebar.querySelectorAll('.judging-project-item').forEach(item => {
            item.addEventListener('click', async () => {
                selectedJudgingProject = item.dataset.id;
                await renderJudgingSidebar(projects);
                await renderJudgingForm(projects);
            });
        });
    }

    async function renderJudgingForm(projects) {
        const formContainer = document.getElementById('judging-form');
        if (!formContainer) return;
        const project = projects.find(p => p.id === selectedJudgingProject);
        if (!project) return;
        const [criteria, evals, aiEval, files] = await Promise.all([
            api.get('/api/criteria'),
            api.get(`/api/evaluations?projectId=${project.id}`),
            api.get(`/api/projects/${project.id}/ai-evaluation`),
            api.get(`/api/projects/${project.id}/files`)
        ]);

        const fileIconMap = {
            '.py': '🐍', '.js': '📜', '.ts': '📘', '.jsx': '⚛️', '.tsx': '⚛️',
            '.java': '☕', '.cpp': '⚙️', '.c': '⚙️', '.go': '🔵', '.rs': '🦀',
            '.html': '🌐', '.css': '🎨', '.json': '📋', '.yaml': '📋', '.yml': '📋',
            '.md': '📝', '.txt': '📄', '.pdf': '📕', '.ppt': '📊', '.pptx': '📊',
            '.doc': '📘', '.docx': '📘', '.png': '🖼️', '.jpg': '🖼️', '.zip': '📦',
            '.sh': '💻', '.sql': '🗃️'
        };
        const getFileIcon = (name) => {
            const ext = '.' + name.split('.').pop().toLowerCase();
            return fileIconMap[ext] || '📄';
        };
        const formatSize = (bytes) => {
            if (bytes < 1024) return bytes + ' B';
            if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
            return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
        };

        formContainer.innerHTML = `
            <div class="glass-card no-hover">
                <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:var(--space-xs);">${escHtml(project.name)}</h2>
                <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:var(--space-lg);">${escHtml(project.description || 'No description')}</p>
                ${files.length > 0 ? `
                <div class="file-browser">
                    <div class="file-browser-header">
                        <span class="file-browser-title">📁 Project Files <span class="file-count-badge">${files.length}</span></span>
                        <span class="file-browser-hint">Click a file to view</span>
                    </div>
                    <div class="file-list">
                        ${files.map(f => `
                            <div class="file-item" data-stored="${escHtml(f.storedName)}" data-name="${escHtml(f.originalName)}" data-url="${escAttr(f.url || '')}">
                                <span class="file-icon">${getFileIcon(f.originalName)}</span>
                                <span class="file-name">${escHtml(f.originalName)}</span>
                                <span class="file-size">${formatSize(f.size)}</span>
                                <a href="${escAttr(f.url || '#')}" target="_blank" class="file-download-btn" title="Download" onclick="event.stopPropagation();">⬇</a>
                            </div>
                        `).join('')}
                    </div>
                    <div class="file-viewer" id="file-viewer" style="display:none;">
                        <div class="file-viewer-header">
                            <span class="file-viewer-name" id="file-viewer-name"></span>
                            <button class="file-viewer-close" id="file-viewer-close">✕</button>
                        </div>
                        <div class="file-viewer-content" id="file-viewer-content"></div>
                    </div>
                </div>` : '<div style="color:var(--text-muted);font-size:0.85rem;margin-bottom:var(--space-md);padding:var(--space-md);border:1px dashed var(--glass-border);border-radius:var(--radius-md);text-align:center;">📂 No files uploaded for this project</div>'}
                <div class="judge-label"><span>👤</span><span class="judge-label-text">Judging as <span class="judge-label-name">${escHtml(currentUser.displayName)}</span></span></div>
                ${criteria.map(c => `<div class="score-slider-group">
                    <div class="score-slider-header">
                        <span class="score-slider-label">${escHtml(c.name)} <span style="color:var(--text-muted);font-size:0.75rem;">(weight: ${c.weight})</span>
                        ${aiEval ? `<span style="font-family:var(--font-mono);color:var(--accent-indigo);font-size:0.65rem;margin-left:var(--space-sm);">AI: ${aiEval.scores[c.id] || '?'}</span>` : ''}</span>
                        <span class="score-slider-value" id="sv-${c.id}">5</span>
                    </div>
                    <input type="range" class="score-slider" id="ss-${c.id}" min="1" max="10" value="5" data-criterion="${c.id}">
                </div>`).join('')}
                <div class="form-group"><label class="form-label">Notes (optional)</label>
                    <textarea class="form-textarea" id="jf-notes" placeholder="Additional comments..."></textarea></div>
                <button class="btn btn-primary" id="jf-submit" style="width:100%;">Submit Evaluation</button>
            </div>
            ${aiEval ? `<div class="ai-eval-card">
                <div class="ai-eval-header"><span class="ai-eval-badge">AI Evaluation</span><span class="ai-eval-model">${escHtml(aiEval.model)}</span></div>
                <div class="ai-eval-feedback">${escHtml(aiEval.overallFeedback)}</div>
                ${criteria.map(c => `<div class="ai-score-row"><div>
                    <div class="ai-score-label">${escHtml(c.name)}</div>
                    <div class="ai-score-reasoning">${escHtml(aiEval.reasoning[c.id] || '')}</div>
                </div><div class="ai-score-value">${aiEval.scores[c.id] || '-'}</div></div>`).join('')}
            </div>` : ''}
            ${evals.length > 0 ? `<div class="eval-history"><div class="eval-history-title">Human Evaluations (${evals.length})</div>
                ${evals.map(ev => `<div class="eval-item"><div class="eval-item-header">
                    <span class="eval-judge-name">${escHtml(ev.judgeName)}</span><span class="eval-date">${timeAgo(ev.createdAt)}</span></div>
                    <div class="score-breakdown">${criteria.map(c => `<div class="score-breakdown-item"><div class="sb-value">${ev.scores[c.id] || 0}</div><div class="sb-label">${escHtml(c.name)}</div></div>`).join('')}</div>
                    ${ev.notes ? `<div class="eval-notes">"${escHtml(ev.notes)}"</div>` : ''}</div>`).join('')}</div>` : ''}`;

        // File browser interactions
        formContainer.querySelectorAll('.file-item').forEach(item => {
            item.addEventListener('click', async () => {
                const storedName = item.dataset.stored;
                const fileName = item.dataset.name;
                const fileUrl = item.dataset.url;
                const viewer = document.getElementById('file-viewer');
                const viewerName = document.getElementById('file-viewer-name');
                const viewerContent = document.getElementById('file-viewer-content');

                // Highlight selected file
                formContainer.querySelectorAll('.file-item').forEach(fi => fi.classList.remove('active'));
                item.classList.add('active');

                viewerName.textContent = fileName;
                viewerContent.innerHTML = '<div style="text-align:center;padding:var(--space-lg);color:var(--text-muted);">Loading...</div>';
                viewer.style.display = 'block';

                try {
                    const resp = await api.get(`/api/files/${encodeURIComponent(storedName)}/content`);
                    if (resp.type === 'text') {
                        const lines = resp.content.split('\n');
                        const lineNums = lines.map((_, i) => `<span class="line-num">${i + 1}</span>`).join('\n');
                        const codeContent = lines.map(line => escHtml(line)).join('\n');
                        viewerContent.innerHTML = `
                            <div class="code-viewer">
                                <div class="code-lang-badge">${resp.language}</div>
                                <div class="code-container">
                                    <pre class="line-numbers">${lineNums}</pre>
                                    <pre class="code-content"><code>${codeContent}</code></pre>
                                </div>
                                ${resp.truncated ? '<div style="color:var(--accent-amber);padding:var(--space-sm);font-size:0.75rem;">⚠️ File truncated (showing first 100KB)</div>' : ''}
                            </div>`;
                    } else {
                        const ext = fileName.split('.').pop().toLowerCase();
                        const isImage = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext);
                        if (isImage) {
                            viewerContent.innerHTML = `<div style="text-align:center;padding:var(--space-md);">
                                <img src="${escAttr(fileUrl)}" style="max-width:100%;max-height:500px;border-radius:var(--radius-md);" alt="${escHtml(fileName)}">
                            </div>`;
                        } else {
                            viewerContent.innerHTML = `<div style="text-align:center;padding:var(--space-xl);color:var(--text-muted);">
                                <div style="font-size:3rem;margin-bottom:var(--space-md);">${getFileIcon(fileName)}</div>
                                <div style="margin-bottom:var(--space-sm);">${escHtml(resp.message || 'Binary file')}</div>
                                <a href="${escAttr(fileUrl)}" target="_blank" class="btn btn-secondary" style="display:inline-block;">⬇ Download ${escHtml(fileName)}</a>
                            </div>`;
                        }
                    }
                } catch (err) {
                    viewerContent.innerHTML = `<div style="color:var(--accent-red);padding:var(--space-md);">Error loading file: ${escHtml(err.message)}</div>`;
                }
            });
        });

        // Close file viewer
        const closeBtn = document.getElementById('file-viewer-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                document.getElementById('file-viewer').style.display = 'none';
                formContainer.querySelectorAll('.file-item').forEach(fi => fi.classList.remove('active'));
            });
        }

        formContainer.querySelectorAll('.score-slider').forEach(slider => {
            slider.addEventListener('input', () => { document.getElementById(`sv-${slider.dataset.criterion}`).textContent = slider.value; });
        });
        document.getElementById('jf-submit').addEventListener('click', async (e) => {
            const btn = e.target;
            const origText = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Submitting...';
            
            const scores = {};
            criteria.forEach(c => { scores[c.id] = parseInt(document.getElementById(`ss-${c.id}`).value, 10); });
            try {
                await api.post('/api/evaluations', { projectId: project.id, scores, notes: document.getElementById('jf-notes').value.trim() });
                showToast(`Evaluation submitted for ${project.name}`);
                
                btn.textContent = '✅ Submitted!';
                btn.style.background = 'var(--accent-emerald)';
                btn.style.borderColor = 'var(--accent-emerald)';
                
                setTimeout(async () => {
                    const currentIndex = projects.findIndex(p => p.id === selectedJudgingProject);
                    if (currentIndex >= 0 && currentIndex < projects.length - 1) {
                        selectedJudgingProject = projects[currentIndex + 1].id;
                    }
                    await renderJudgingSidebar(projects);
                    await renderJudgingForm(projects);
                }, 1200);
            } catch (err) { 
                showToast(err.message, 'error');
                btn.disabled = false;
                btn.textContent = origText;
            }
        });
    }

    // ─── LEADERBOARD ─────────────────────────────────────────────
    async function renderLeaderboard(container) {
        container.innerHTML = '<div class="page-header"><h1>Leaderboard</h1><p class="subtitle">Loading...</p></div>';
        try {
            const [ranked, criteria, settings] = await Promise.all([
                api.get('/api/leaderboard'), api.get('/api/criteria'), api.get('/api/settings')
            ]);
            const hackathonName = settings.hackathonName || 'Hackathon';
            container.innerHTML = `
                <div class="page-header"><div class="page-header-row">
                    <div><h1>Leaderboard</h1><p class="subtitle">Rankings for ${escHtml(hackathonName)}</p></div>
                    <div class="btn-group"><button class="btn btn-secondary btn-sm" id="lb-export-csv">📥 Export CSV</button></div>
                </div></div>
                <div id="leaderboard-content"></div>`;
            const content = document.getElementById('leaderboard-content');
            if (ranked.length === 0 || ranked.every(p => p.avgScore === 0)) {
                content.innerHTML = `<div class="empty-state"><div class="empty-icon">🏆</div><div class="empty-title">No rankings yet</div><div class="empty-desc">Evaluate some projects to see the leaderboard</div></div>`;
            } else {
                content.innerHTML = `
                    <div style="display:flex;gap:var(--space-lg);margin-bottom:var(--space-md);font-family:var(--font-mono);font-size:0.6rem;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.04em;">
                        <span><span class="hybrid-legend-dot" style="background:var(--accent-cyan);"></span> Human Score</span>
                        <span><span class="hybrid-legend-dot" style="background:var(--accent-indigo);"></span> AI Score</span>
                        <span>Blend: 60% Human + 40% AI</span>
                    </div>
                    <div class="leaderboard-list">${ranked.map((p, i) => {
                    const pct = (p.avgScore / 10) * 100;
                    const rankClass = i === 0 ? 'rank-1' : i === 1 ? 'rank-2' : i === 2 ? 'rank-3' : 'rank-other';
                    const topGlow = i < 3 ? ' top-glow' : '';
                    return `<div class="leaderboard-item${topGlow}">
                            <div class="leaderboard-rank ${rankClass}">${i + 1}</div>
                            <div class="leaderboard-info">
                                <div class="leaderboard-name">${escHtml(p.name)} ${p.hasAI ? '<span class="ai-eval-badge">AI</span>' : ''}</div>
                                <div class="leaderboard-bar-container"><div class="leaderboard-bar" style="width:0%" data-width="${pct}%"></div></div>
                                ${p.hasAI ? `<div class="hybrid-score-bar">
                                    <div class="hybrid-bar-human" style="flex:${p.humanScore}"></div>
                                    <div class="hybrid-bar-ai" style="flex:${p.aiScore}"></div>
                                </div>
                                <div class="hybrid-legend"><span>H ${p.humanScore.toFixed(1)}</span><span>AI ${p.aiScore.toFixed(1)}</span></div>` : ''}
                                <div class="score-breakdown" style="margin-top:var(--space-sm);">
                                    ${criteria.map(c => `<div class="score-breakdown-item">
                                        <div class="sb-value">${(p.criteriaAvgs[c.id] || 0).toFixed(1)}</div>
                                        <div class="sb-label">${escHtml(c.name)}</div></div>`).join('')}
                                </div>
                            </div>
                            <div class="leaderboard-score">${p.avgScore.toFixed(1)}</div>
                        </div>`;
                }).join('')}</div>`;
                requestAnimationFrame(() => {
                    setTimeout(() => { document.querySelectorAll('.leaderboard-bar').forEach(bar => { bar.style.width = bar.dataset.width; }); }, 100);
                });
            }
            document.getElementById('lb-export-csv').addEventListener('click', () => {
                if (ranked.length === 0) { showToast('No data', 'info'); return; }
                const headers = ['Rank', 'Project', 'Final Score', 'Human Score', 'AI Score', ...criteria.map(c => c.name)];
                const rows = ranked.map((p, i) => [i + 1, `"${p.name}"`, p.avgScore.toFixed(2), p.humanScore.toFixed(2), p.aiScore.toFixed(2), ...criteria.map(c => (p.criteriaAvgs[c.id] || 0).toFixed(2))]);
                const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
                downloadFile(csv, `${hackathonName.replace(/\s+/g, '_')}_leaderboard.csv`, 'text/csv');
                showToast('CSV exported');
            });
        } catch (err) { container.innerHTML = `<p style="color:var(--accent-red);">Error: ${escHtml(err.message)}</p>`; }
    }

    // ─── SETTINGS ────────────────────────────────────────────────
    async function renderSettings(container) {
        if (!isAdmin()) { navigate('dashboard'); return; }
        container.innerHTML = '<div class="page-header"><h1>Settings</h1><p class="subtitle">Loading...</p></div>';
        try {
            // /api/users is system_admin-only; skip the fetch for hackathon
            // admins who aren't system admins so they don't see a 403 toast.
            const userListPromise = isSystemAdmin() ? api.get('/api/users') : Promise.resolve([]);
            const [settings, criteria, users] = await Promise.all([
                api.get('/api/settings'), api.get('/api/criteria'), userListPromise,
            ]);
            const aiWeightVal = settings.aiWeight ? parseFloat(settings.aiWeight) : 0.4;
            container.innerHTML = `
                <div class="page-header"><h1>Settings</h1><p class="subtitle">Configure your hackathon</p></div>
                <div class="glass-card no-hover settings-section"><h3>Hackathon Details</h3>
                    <div class="form-group"><label class="form-label">Hackathon Name</label>
                        <input class="form-input" id="set-name" value="${escAttr(settings.hackathonName || '')}"></div>
                    <button class="btn btn-primary btn-sm" id="set-save-name">Save Name</button></div>
                <div class="glass-card no-hover settings-section"><h3>AI Scoring Weight</h3>
                    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:var(--space-md);">Hybrid formula: (Human × ${(1 - aiWeightVal).toFixed(1)}) + (AI × ${aiWeightVal.toFixed(1)})</p>
                    <div class="form-group"><label class="form-label">AI Weight (0.0 = human only, 1.0 = AI only)</label>
                        <input class="form-input" id="set-ai-weight" type="number" min="0" max="1" step="0.1" value="${aiWeightVal}" style="max-width:150px;"></div>
                    <button class="btn btn-primary btn-sm" id="set-save-ai-weight">Save Weight</button></div>
                <div class="glass-card no-hover settings-section"><h3>Evaluation Criteria</h3>
                    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:var(--space-md);">Customize scoring criteria and weights</p>
                    <div class="criteria-list" id="criteria-list"></div>
                    <div style="margin-top:var(--space-md);"><button class="btn btn-secondary btn-sm" id="btn-add-criterion">+ Add Criterion</button></div></div>
                ${isSystemAdmin() ? `
                <div class="glass-card no-hover settings-section"><h3>👥 User Management</h3>
                    <p style="font-size:0.85rem;color:var(--text-muted);margin-bottom:var(--space-md);">${users.length} registered user${users.length !== 1 ? 's' : ''} · system roles control who can create and approve hackathons</p>
                    <div class="users-list" id="users-list"></div></div>` : ''}
                <div class="glass-card no-hover settings-section"><h3>Data Management</h3>
                    <div class="btn-group">
                        <button class="btn btn-secondary" id="set-export">📥 Export Data</button>
                        <button class="btn btn-secondary" id="set-import">📤 Import Data</button>
                        <button class="btn btn-danger" id="set-reset">🗑️ Reset All</button>
                    </div><input type="file" id="set-import-file" accept=".json" style="display:none;"></div>`;
            renderCriteriaList(criteria);
            renderUsersList(users);

            document.getElementById('set-save-name').addEventListener('click', async () => {
                const name = document.getElementById('set-name').value.trim();
                if (!name) { showToast('Name cannot be empty', 'error'); return; }
                await api.put('/api/settings', { key: 'hackathonName', value: name });
                updateHackathonBadge(name); showToast('Name updated');
            });
            document.getElementById('set-save-ai-weight').addEventListener('click', async () => {
                const w = Math.max(0, Math.min(1, parseFloat(document.getElementById('set-ai-weight').value) || 0.4));
                await api.put('/api/settings', { key: 'aiWeight', value: String(w) });
                showToast(`AI weight set to ${w.toFixed(1)}`);
            });
            document.getElementById('btn-add-criterion').addEventListener('click', () => {
                const body = `<div class="form-group"><label class="form-label">Name</label><input class="form-input" id="ac-name" placeholder="e.g. Scalability"></div>
                    <div class="form-group"><label class="form-label">Weight</label><input class="form-input" id="ac-weight" type="number" min="0.1" max="2" step="0.1" value="1.0"></div>`;
                openModal('Add Criterion', body, `<button class="btn btn-secondary" id="ac-cancel">Cancel</button><button class="btn btn-primary" id="ac-save">Add</button>`);
                document.getElementById('ac-cancel').addEventListener('click', closeModal);
                document.getElementById('ac-save').addEventListener('click', async () => {
                    const name = document.getElementById('ac-name').value.trim();
                    if (!name) { showToast('Name required', 'error'); return; }
                    await api.post('/api/criteria', { name, weight: parseFloat(document.getElementById('ac-weight').value) || 1.0 });
                    closeModal(); showToast('Criterion added');
                    renderCriteriaList(await api.get('/api/criteria'));
                });
            });
            document.getElementById('set-export').addEventListener('click', async () => {
                const data = await api.get('/api/export');
                downloadFile(JSON.stringify(data, null, 2), 'hackathon_data.json', 'application/json');
                showToast('Data exported');
            });
            document.getElementById('set-import').addEventListener('click', () => document.getElementById('set-import-file').click());
            document.getElementById('set-import-file').addEventListener('change', async (e) => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = async (ev) => { try { await api.post('/api/import', JSON.parse(ev.target.result)); showToast('Imported'); handleRoute(); } catch { showToast('Invalid JSON', 'error'); } };
                reader.readAsText(file);
            });
            document.getElementById('set-reset').addEventListener('click', () => {
                openModal('Reset All Data', '<p>Delete <strong>all data</strong>? Cannot be undone.</p>',
                    `<button class="btn btn-secondary" id="rs-cancel">Cancel</button><button class="btn btn-danger" id="rs-confirm">Reset</button>`);
                document.getElementById('rs-cancel').addEventListener('click', closeModal);
                document.getElementById('rs-confirm').addEventListener('click', async () => { await api.post('/api/reset'); closeModal(); showToast('Reset', 'info'); handleRoute(); });
            });
        } catch (err) { container.innerHTML = `<p style="color:var(--accent-red);">Error: ${escHtml(err.message)}</p>`; }
    }

    function renderCriteriaList(criteria) {
        const list = document.getElementById('criteria-list');
        if (!list) return;
        list.innerHTML = criteria.map(c => `<div class="criteria-item">
            <input class="form-input" value="${escAttr(c.name)}" data-id="${c.id}" data-field="name">
            <input class="form-input" type="number" value="${c.weight}" data-id="${c.id}" data-field="weight" min="0.1" max="2" step="0.1" style="text-align:center;">
            <button class="btn btn-danger btn-icon btn-sm btn-del-criterion" data-id="${c.id}">×</button></div>`).join('');
        list.querySelectorAll('.form-input').forEach(input => {
            input.addEventListener('change', async () => {
                const data = {};
                if (input.dataset.field === 'name') data.name = input.value.trim();
                else data.weight = Math.max(0.1, Math.min(2, parseFloat(input.value) || 1));
                await api.put(`/api/criteria/${input.dataset.id}`, data);
                showToast('Updated'); renderCriteriaList(await api.get('/api/criteria'));
            });
        });
        list.querySelectorAll('.btn-del-criterion').forEach(btn => {
            btn.addEventListener('click', async () => {
                await api.del(`/api/criteria/${btn.dataset.id}`);
                showToast('Removed', 'info'); renderCriteriaList(await api.get('/api/criteria'));
            });
        });
    }

    function renderUsersList(users) {
        const list = document.getElementById('users-list');
        if (!list) return;
        // Per-hackathon roles (admin / judge / participant) are managed inside
        // each hackathon's Members panel. This list edits the SYSTEM role —
        // the platform-wide capability that controls who can create
        // hackathons (organizer) and who can approve them (system_admin).
        const sysRoleOptions = [
            ['user', 'User'],
            ['organizer', 'Organizer'],
            ['system_admin', 'System Admin'],
        ];
        list.innerHTML = users.map(u => {
            const sr = u.systemRole || 'user';
            return `<div class="user-list-item">
                <div class="user-list-avatar">${escHtml(u.displayName.charAt(0))}</div>
                <div class="user-list-info">
                    <div class="user-list-name">${escHtml(u.displayName)}
                        <span class="role-badge role-badge-${escAttr(sr)}">${escHtml(sr.replace('_', ' '))}</span>
                    </div>
                    <div class="user-list-email">${escHtml(u.email)} · @${escHtml(u.username)}</div>
                </div>
                <select class="form-select btn-sm user-system-role-select" data-id="${u.id}" data-current="${escAttr(sr)}"
                        style="width:auto;padding:4px 28px 4px 8px;font-size:0.75rem;"
                        ${u.id === currentUser.id ? 'disabled title="You cannot change your own system role"' : ''}>
                    ${sysRoleOptions.map(([v, label]) => `<option value="${v}" ${sr === v ? 'selected' : ''}>${label}</option>`).join('')}
                </select>
                ${u.id !== currentUser.id ? `<button class="btn btn-danger btn-sm btn-del-user" data-id="${u.id}" data-name="${escAttr(u.displayName)}">🗑️</button>` : '<span style="width:36px;"></span>'}
            </div>`;
        }).join('');
        list.querySelectorAll('.user-system-role-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                try {
                    await api.put(`/api/users/${sel.dataset.id}/system-role`, { systemRole: sel.value });
                    showToast('System role updated');
                    renderUsersList(await api.get('/api/users'));
                } catch (err) {
                    showToast(err.message, 'error');
                    sel.value = sel.dataset.current;
                }
            });
        });
        list.querySelectorAll('.btn-del-user').forEach(btn => {
            btn.addEventListener('click', () => {
                openModal('Delete User', `<p>Delete <strong>${escHtml(btn.dataset.name)}</strong>?</p>`,
                    `<button class="btn btn-secondary" id="du-cancel">Cancel</button><button class="btn btn-danger" id="du-confirm">Delete</button>`);
                document.getElementById('du-cancel').addEventListener('click', closeModal);
                document.getElementById('du-confirm').addEventListener('click', async () => {
                    await api.del(`/api/users/${btn.dataset.id}`); closeModal(); showToast('Deleted', 'info'); renderUsersList(await api.get('/api/users'));
                });
            });
        });
    }

    // ─── MY PROJECT (Participant view) ──────────────────────────────
    async function renderMyProject(container) {
        container.innerHTML = '<div class="page-header"><h1>My Project</h1><p class="subtitle">Loading...</p></div>';
        try {
            const projects = await api.get('/api/projects');
            const myProject = projects.find(p => p.created_by === currentUser.id);
            if (!myProject) {
                container.innerHTML = `
                    <div class="page-header"><h1>My Project</h1><p class="subtitle">Submit your hackathon project</p></div>
                    <div class="empty-state">
                        <div class="empty-icon">📂</div>
                        <div class="empty-title">No project yet</div>
                        <div class="empty-desc">Create your hackathon submission</div>
                        <button class="btn btn-primary" id="btn-create-my-project">+ Create My Project</button>
                    </div>`;
                document.getElementById('btn-create-my-project').addEventListener('click', () => {
                    openProjectModal(null, async () => { await renderMyProject(container); });
                });
                return;
            }
            const [files, aiEval, leaderboard] = await Promise.all([
                api.get(`/api/projects/${myProject.id}/files`),
                api.get(`/api/projects/${myProject.id}/ai-evaluation`),
                api.get('/api/leaderboard')
            ]);
            const lb = leaderboard.find(p => p.id === myProject.id) || { avgScore: 0, evalCount: 0, hasAI: false };
            container.innerHTML = `
                <div class="page-header"><div class="page-header-row">
                    <div><h1>My Project</h1><p class="subtitle">Manage your submission</p></div>
                    <button class="btn btn-secondary" id="btn-edit-my-project">✏️ Edit Details</button>
                </div></div>
                <div class="glass-card no-hover" style="margin-bottom:var(--space-lg);">
                    <h2 style="font-size:1.3rem;font-weight:700;margin-bottom:var(--space-sm);">${escHtml(myProject.name)}
                        ${lb.hasAI ? '<span class="ai-eval-badge">AI Scored</span>' : ''}</h2>
                    <p style="color:var(--text-secondary);font-size:0.9rem;margin-bottom:var(--space-md);">${escHtml(myProject.description || 'No description')}</p>
                    <div style="margin-bottom:var(--space-sm);">${(myProject.members || []).map(m => '<span class="member-chip">' + escHtml(m) + '</span>').join('')}</div>
                    <div style="margin-bottom:var(--space-md);">${(myProject.techStack || []).map(t => '<span class="tech-chip">' + escHtml(t) + '</span>').join('')}</div>
                    <div style="display:flex;gap:var(--space-lg);font-size:0.9rem;color:var(--text-muted);">
                        <span>⭐ Score: <strong style="color:var(--text-accent);">${lb.avgScore.toFixed(1)} / 10</strong></span>
                        <span>👤 ${lb.evalCount} evaluation${lb.evalCount !== 1 ? 's' : ''}</span>
                    </div>
                </div>
                <div class="glass-card no-hover" style="margin-bottom:var(--space-lg);">
                    <h3 style="font-size:1rem;font-weight:700;margin-bottom:var(--space-md);">📁 Project Files</h3>
                    <div class="file-dropzone" id="mp-dropzone">
                        <div class="file-dropzone-icon">📂</div>
                        <div class="file-dropzone-text">Drop files, folders, or a ZIP here</div>
                        <div class="file-dropzone-hint">Up to 50 files, 50MB max • ZIP files auto-extracted</div>
                        <div style="margin-top:8px;display:flex;gap:8px;justify-content:center;">
                            <button type="button" class="btn btn-secondary btn-sm" id="mp-select-files">📄 Files</button>
                            <button type="button" class="btn btn-secondary btn-sm" id="mp-select-folder">📁 Folder</button>
                        </div>
                    </div>
                    <input type="file" id="mp-file-input" multiple style="display:none;">
                    <input type="file" id="mp-folder-input" webkitdirectory style="display:none;">
                    <div class="file-list" id="mp-file-list"></div>
                </div>
                ${aiEval ? `<div class="ai-eval-card">
                    <div class="ai-eval-header"><span class="ai-eval-badge">AI Evaluation</span><span class="ai-eval-model">${escHtml(aiEval.model)}</span></div>
                    <div class="ai-eval-feedback">${escHtml(aiEval.overallFeedback)}</div>
                </div>` : ''}`;

            // Setup file upload for own project
            const dropzone = document.getElementById('mp-dropzone');
            const fileInput = document.getElementById('mp-file-input');
            const folderInput = document.getElementById('mp-folder-input');
            const fileList = document.getElementById('mp-file-list');

            async function refreshFiles() {
                const updatedFiles = await api.get(`/api/projects/${myProject.id}/files`);
                fileList.innerHTML = updatedFiles.map(f => `
                    <div class="file-item">
                        <span>${getFileIcon(f.originalName)}</span>
                        <span class="file-item-name" title="${escHtml(f.originalName)}">${escHtml(f.originalName)}</span>
                        <span class="file-item-size">${formatBytes(f.size)}</span>
                        <button class="file-item-remove" data-id="${f.id}" title="Remove">×</button>
                    </div>`).join('');
                fileList.querySelectorAll('.file-item-remove').forEach(btn => {
                    btn.addEventListener('click', async () => {
                        await api.del(`/api/projects/${myProject.id}/files/${btn.dataset.id}`);
                        showToast('File removed', 'info');
                        refreshFiles();
                    });
                });
            }

            async function uploadMyFiles(files) {
                if (files.length) {
                    dropzone.querySelector('.file-dropzone-text').textContent = `Uploading ${files.length} file(s)...`;
                    await api.uploadFiles(`/api/projects/${myProject.id}/files`, files);
                    dropzone.querySelector('.file-dropzone-text').textContent = 'Drop files, folders, or a ZIP here';
                    showToast(`${files.length} file(s) uploaded`);
                    refreshFiles();
                }
            }

            document.getElementById('mp-select-files')?.addEventListener('click', (e) => { e.stopPropagation(); fileInput.click(); });
            document.getElementById('mp-select-folder')?.addEventListener('click', (e) => { e.stopPropagation(); folderInput.click(); });
            dropzone.addEventListener('click', (e) => { if (e.target === dropzone || e.target.closest('.file-dropzone-icon,.file-dropzone-text,.file-dropzone-hint')) fileInput.click(); });
            dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('dragover'); });
            dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
            dropzone.addEventListener('drop', async e => {
                e.preventDefault(); dropzone.classList.remove('dragover');
                const items = e.dataTransfer.items;
                if (items && items[0] && items[0].webkitGetAsEntry) {
                    const allFiles = await getAllFilesFromDrop(items);
                    await uploadMyFiles(allFiles);
                } else {
                    await uploadMyFiles(Array.from(e.dataTransfer.files));
                }
            });
            fileInput.addEventListener('change', async () => {
                await uploadMyFiles(Array.from(fileInput.files));
                fileInput.value = '';
            });
            folderInput.addEventListener('change', async () => {
                await uploadMyFiles(Array.from(folderInput.files));
                folderInput.value = '';
            });
            refreshFiles();

            document.getElementById('btn-edit-my-project').addEventListener('click', () => {
                openProjectModal(myProject, async () => { await renderMyProject(container); });
            });
        } catch (err) {
            container.innerHTML = `<div class="empty-state"><div class="empty-icon">❌</div><div class="empty-title">Error</div><div class="empty-desc">${escHtml(err.message)}</div></div>`;
        }
    }

    // ─── Landing → auth wiring ──────────────────────────────────
    function wireLanding() {
        const goSignIn  = () => showAuthScreen('login');
        const goSignUp  = () => showAuthScreen('register');
        const back      = () => showView('landing');
        const map = {
            'btn-landing-signin': goSignIn,
            'btn-landing-signup': goSignUp,
            'btn-hero-signin':    goSignIn,
            'btn-hero-signup':    goSignUp,
            'btn-cta-signin':     goSignIn,
            'btn-cta-signup':     goSignUp,
            'auth-back':          back,
        };
        for (const [id, fn] of Object.entries(map)) {
            const el = document.getElementById(id);
            if (el) el.addEventListener('click', fn);
        }
    }

    // ─── INIT ────────────────────────────────────────────────────
    wireLanding();
    setupAuthForm();
    checkAuth();
})();
