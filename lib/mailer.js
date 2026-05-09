'use strict';
const nodemailer = require('nodemailer');

// Lazily create the transporter so startup doesn't fail if env vars are missing
let _transporter = null;

function getTransporter() {
    if (_transporter) return _transporter;

    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASS;

    if (!user || !pass) {
        console.warn('[mailer] SMTP_USER or SMTP_PASS not set — emails will not be sent.');
        return null;
    }

    _transporter = nodemailer.createTransport({
        host: 'smtp.zoho.com',
        port: 587,
        secure: false, // STARTTLS
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

    const from = `"HackEval" <${process.env.SMTP_USER}>`;
    const info = await transporter.sendMail({ from, to, subject, html, text });
    console.log(`[mailer] Sent "${subject}" to ${to} (messageId: ${info.messageId})`);
}

// ─── Pre-built email templates ───────────────────────────────────────────────

async function sendPasswordReset({ to, name, resetLink }) {
    const subject = 'Reset your HackEval password';
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: 'Inter', Arial, sans-serif; background: #0f0f1a; color: #e2e8f0; margin: 0; padding: 32px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid rgba(99,102,241,0.2);">
    <h1 style="color: #818cf8; font-size: 1.4rem; margin-top: 0;">🔐 Password Reset</h1>
    <p>Hi <strong>${name || 'there'}</strong>,</p>
    <p>Someone requested a password reset for your HackEval account. Click the button below to set a new password. This link expires in <strong>1 hour</strong>.</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${resetLink}" style="background: #6366f1; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Reset Password</a>
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
    const html = `
<!DOCTYPE html>
<html>
<body style="font-family: 'Inter', Arial, sans-serif; background: #0f0f1a; color: #e2e8f0; margin: 0; padding: 32px;">
  <div style="max-width: 480px; margin: 0 auto; background: #1a1a2e; border-radius: 12px; padding: 32px; border: 1px solid rgba(99,102,241,0.2);">
    <h1 style="color: #818cf8; font-size: 1.4rem; margin-top: 0;">🚀 Welcome to HackEval</h1>
    <p>Hi <strong>${name || 'there'}</strong>,</p>
    <p>Your account has been created. You can now log in and start evaluating hackathon projects!</p>
    <div style="text-align: center; margin: 28px 0;">
      <a href="${loginLink || 'https://hackeval.com'}" style="background: #6366f1; color: #fff; padding: 12px 28px; border-radius: 8px; text-decoration: none; font-weight: 600; display: inline-block;">Go to HackEval</a>
    </div>
    <hr style="border-color: rgba(99,102,241,0.15); margin: 24px 0;">
    <p style="color: #64748b; font-size: 0.75rem; margin: 0;">HackEval · <a href="https://hackeval.com" style="color: #818cf8;">hackeval.com</a></p>
  </div>
</body>
</html>`;
    await sendMail({ to, subject, html });
}

module.exports = { sendMail, sendPasswordReset, sendWelcome };
