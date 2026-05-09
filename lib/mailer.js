'use strict';
const nodemailer = require('nodemailer');

// Lazily create the transporter so startup doesn't fail if env vars are missing
let _transporter = null;

// HTML escape for any value interpolated into the email body. Templates
// MUST run every dynamic field through this — even fields like `name` that
// look "safe", because validation rules can change and an attacker who can
// register an account is the threat model here.
function esc(v) {
    if (v == null) return '';
    return String(v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// URLs need extra care: an attacker-controlled string of `javascript:…`
// would otherwise fire on click. Reject anything that isn't http(s).
function safeUrl(u, fallback = '#') {
    if (typeof u !== 'string') return fallback;
    if (!/^https?:\/\//i.test(u.trim())) return fallback;
    return esc(u);
}

function getTransporter() {
    if (_transporter) return _transporter;

    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;
    const host = process.env.SMTP_HOST || 'smtp.zoho.com';
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    // STARTTLS upgrades after the initial unencrypted handshake (port 587).
    // Submission over implicit TLS (port 465) needs `secure: true`.
    const secure = process.env.SMTP_SECURE === 'true' || port === 465;

    if (!user || !pass) {
        console.warn('[mailer] SMTP_USER or SMTP_PASS not set — emails will not be sent.');
        return null;
    }

    _transporter = nodemailer.createTransport({
        host, port, secure,
        auth: { user, pass },
    });

    return _transporter;
}

/**
 * Send an email.
 * @param {Object} opts
 * @param {string} opts.to        - Recipient address
 * @param {string} opts.subject   - Email subject
 * @param {string} opts.html      - HTML body
 * @param {string} [opts.text]    - Optional plain-text body
 * @returns {Promise<void>}
 */
async function sendMail({ to, subject, html, text }) {
    const transporter = getTransporter();
    if (!transporter) {
        console.warn(`[mailer] Skipping email to ${to} — SMTP not configured.`);
        return;
    }

    // `MAIL_FROM` lets operators present a different sender (e.g. a verified
    // domain identity) than the SMTP login user. Falls back to SMTP_USER.
    const from = process.env.MAIL_FROM || `"HackEval" <${process.env.SMTP_USER}>`;
    const info = await transporter.sendMail({ from, to, subject, html, text });
    console.log(`[mailer] Sent "${subject}" to ${to} (messageId: ${info.messageId})`);
}

// ─── Pre-built email templates ───────────────────────────────────────────────

async function sendPasswordReset({ to, name, resetLink }) {
    const subject = 'Reset your HackEval password';
    const safeName = esc(name || 'there');
    const safeLink = safeUrl(resetLink);
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: 'Inter', Arial, sans-serif; background: #0f0f1a; color: #e2e8f0; margin: 0; padding: 32px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid rgba(99,102,241,0.2);">
    <h1 style="color: #818cf8; font-size: 1.4rem; margin-top: 0;">🔐 Password Reset</h1>
    <p>Hi <strong>${safeName}</strong>,</p>
    <p>Someone requested a password reset for your HackEval account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${safeLink}" style="background: #6366f1; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Reset Password</a>
    </div>
    <p style="color: #94a3b8; font-size: 0.82rem;">If you did not request this, you can safely ignore this email. Your password will not change.</p>
    <hr style="border-color: rgba(99,102,241,0.15); margin: 24px 0;">
    <p style="color: #64748b; font-size: 0.75rem; margin: 0;">HackEval · <a href="https://hackeval.com" style="color: #818cf8;">hackeval.com</a></p>
  </div>
</body>
</html>`;
    const text = `Hi ${name || 'there'},\n\nReset your HackEval password by visiting:\n${resetLink}\n\nThis link expires in 1 hour.\n\nIf you did not request this, ignore this email.`;
    await sendMail({ to, subject, html, text });
}

async function sendWelcome({ to, name, loginLink }) {
    const subject = 'Welcome to HackEval!';
    const safeName = esc(name || 'there');
    const safeLink = safeUrl(loginLink, 'https://hackeval.com');
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: 'Inter', Arial, sans-serif; background: #0f0f1a; color: #e2e8f0; margin: 0; padding: 32px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid rgba(99,102,241,0.2);">
    <h1 style="color: #818cf8; font-size: 1.4rem; margin-top: 0;">🚀 Welcome to HackEval</h1>
    <p>Hi <strong>${safeName}</strong>,</p>
    <p>Your account has been created. You can now log in and start evaluating hackathon projects!</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${safeLink}" style="background: #6366f1; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Go to HackEval</a>
    </div>
    <hr style="border-color: rgba(99,102,241,0.15); margin: 24px 0;">
    <p style="color: #64748b; font-size: 0.75rem; margin: 0;">HackEval · <a href="https://hackeval.com" style="color: #818cf8;">hackeval.com</a></p>
  </div>
</body>
</html>`;
    await sendMail({ to, subject, html });
}

module.exports = { sendMail, sendPasswordReset, sendWelcome, _esc: esc, _safeUrl: safeUrl };
