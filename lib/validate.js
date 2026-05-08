// Lightweight input validation/sanitization helpers.

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isString(v, { min = 0, max = Infinity } = {}) {
    return typeof v === 'string' && v.length >= min && v.length <= max;
}

function validateRegister(body) {
    const { username, email, password, displayName } = body || {};
    if (!isString(username) || !USERNAME_RE.test(username)) {
        return 'Username must be 3-32 chars: letters, digits, _ . -';
    }
    if (!isString(email, { max: 254 }) || !EMAIL_RE.test(email)) {
        return 'Invalid email address';
    }
    if (!isString(password, { min: 8, max: 200 })) {
        return 'Password must be 8-200 characters';
    }
    if (!isString(displayName, { min: 1, max: 80 })) {
        return 'Display name is required (1-80 chars)';
    }
    return null;
}

function validateLogin(body) {
    const { username, password } = body || {};
    if (!isString(username, { min: 1, max: 254 })) return 'Username required';
    if (!isString(password, { min: 1, max: 200 })) return 'Password required';
    return null;
}

function validateProject(body) {
    const { name, members, description, techStack, demoUrl } = body || {};
    if (!isString(name, { min: 1, max: 200 })) return 'Project name is required (1-200 chars)';
    if (members !== undefined && !Array.isArray(members)) return 'members must be an array';
    if (techStack !== undefined && !Array.isArray(techStack)) return 'techStack must be an array';
    if (description !== undefined && !isString(description, { max: 10_000 })) return 'description too long';
    if (demoUrl !== undefined && !isString(demoUrl, { max: 2000 })) return 'demoUrl too long';
    return null;
}

// Strip control chars and clamp length so user-controlled text can't easily inject
// instructions or break JSON parsing when concatenated into an LLM prompt.
function sanitizeForPrompt(value, maxLen = 1000) {
    if (value == null) return '';
    const str = String(value);
    // Remove ASCII control chars (except \n, \r, \t) and triple-backtick fences.
    const cleaned = str
        .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
        .replace(/```/g, "'''");
    return cleaned.length > maxLen ? cleaned.slice(0, maxLen) + '…[truncated]' : cleaned;
}

const URL_RE = /^https?:\/\/[^\s]{1,2000}$/i;
const EXPERIENCE_LEVELS = new Set(['beginner', 'intermediate', 'advanced', 'expert']);

function validateProfile(body) {
    const { bio, skills, githubUrl, linkedinUrl, portfolioUrl, experienceLevel } = body || {};
    if (bio !== undefined && bio !== null && !isString(bio, { max: 5000 })) {
        return 'bio must be a string up to 5000 chars';
    }
    if (skills !== undefined && skills !== null) {
        if (!Array.isArray(skills) || skills.length > 50) return 'skills must be an array of up to 50 entries';
        for (const s of skills) {
            if (!isString(s, { min: 1, max: 60 })) return 'each skill must be 1-60 chars';
        }
    }
    for (const [key, val] of [['githubUrl', githubUrl], ['linkedinUrl', linkedinUrl], ['portfolioUrl', portfolioUrl]]) {
        if (val !== undefined && val !== null && val !== '' && !URL_RE.test(String(val))) {
            return `${key} must be a valid http(s) URL`;
        }
    }
    if (experienceLevel !== undefined && experienceLevel !== null && experienceLevel !== '' && !EXPERIENCE_LEVELS.has(experienceLevel)) {
        return 'experienceLevel must be beginner, intermediate, advanced, or expert';
    }
    return null;
}

module.exports = {
    isString,
    validateRegister,
    validateLogin,
    validateProject,
    validateProfile,
    sanitizeForPrompt,
};
