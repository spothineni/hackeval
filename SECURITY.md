# Security

## Reporting a vulnerability

Please email the operator of this HackEval instance — see the contact in
[`public/privacy.html`](public/privacy.html). Do **not** open a public GitHub
issue for security reports.

We aim to acknowledge within 72 hours and ship a fix or mitigation within
30 days for high/critical issues.

## Security posture

This codebase opts into a defensive baseline:

| Area | Control |
|---|---|
| Auth | JWT in HttpOnly cookie + bcrypt; double-submit cookie CSRF on every state-changing request |
| Sessions | 7-day TTL; legacy `Authorization: Bearer` still accepted for scripted clients (CSRF-exempt by design — Bearer headers can't be auto-sent cross-origin) |
| Password reset | Single-use tokens; SHA-256 hashed at rest; 30-min default TTL |
| Rate limiting | `express-rate-limit` on `/api/auth/*` and `/api/projects/:id/ai-evaluate`; global API limiter on `/api/*` |
| Input validation | All write routes validate via [`lib/validate.js`](lib/validate.js); URL fields require `http(s)://` |
| Multi-tenant isolation | Every scoped row carries `hackathon_id`; middleware enforces membership before any query |
| File access | Stored names are 64-bit `crypto.randomBytes`; downloads gated by membership in the file's hackathon (or a single-purpose ticket) |
| Storage | S3 / GCS with V4 signed URLs (5-min TTL); ephemeral local FS is dev-only |
| Email templates | All dynamic values HTML-escaped; URL fields validated to `http(s)://` to neutralize `javascript:` payloads |
| Mutation audit | `audit_log` records actor, action, target, payload, IP — append-only |
| TLS | `pg` connection verifies the server cert by default; opt-out only via `DB_SSL=insecure` |
| Headers | `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` denies camera/mic/geolocation, CSP with `script-src 'self'` |
| IDs | `crypto.randomUUID` for all entity IDs |
| Migrations | Transactional + recorded in `schema_migrations`; failed migrations roll back |

See `migrations/` for the schema and `lib/` for the helpers behind each control.

## Known accepted vulnerabilities

`npm audit --omit=dev` will report the following advisories. They are
**accepted, tracked, and revisited on each `npm install`** because no
upstream fix path currently resolves them.

### `@google-cloud/storage` transitive chain (5 × low)

| Advisory | Path |
|---|---|
| `http-proxy-agent < 1.0.0` SSRF (low) | `@google-cloud/storage → teeny-request → http-proxy-agent` |
| `agent-base < 5.1.1` (low) | same chain |
| `https-proxy-agent < 7.0.6` (low) | same chain |
| `@tootallnate/once` deprecation (low) | same chain |
| `teeny-request 7.1.3 - 10.1.0` (low) | direct dep of `@google-cloud/storage` |

**Status:** accepted.

**Why:**
- All five are **low severity**; none are exploitable in our usage pattern (we don't make outbound proxied HTTP calls — we use the GCS client to read/write our own bucket).
- `npm audit fix` does not resolve them — they're transitive under a Google-published package whose latest stable release still pins `teeny-request`.
- `npm audit fix --force` does not resolve them either — there's no version of `@google-cloud/storage` available that drops the chain.
- Replacing `@google-cloud/storage` with a generic S3-compatible client would work (GCS supports the S3 API via the XML interop endpoint) but is a meaningful refactor.

**Tracked at:** revisit on every `npm install`. If `@google-cloud/storage`
ships a release that drops `teeny-request`, run `npm update @google-cloud/storage`
and re-run `npm audit`.

If your operator's risk model requires zero transitive lows, switch
`STORAGE_PROVIDER` to `s3` (which has no equivalent advisories) or pin
storage to local FS in non-production environments.

## What's NOT in scope

- **Account enumeration via email.** `/api/auth/forgot-password` always
  returns 200 to prevent enumeration. Login does the same — incorrect
  username and incorrect password produce the same error message.
- **Side-channel timing attacks.** Login uses `bcrypt.compareSync`; CSRF
  comparison uses `crypto.timingSafeEqual`. Not perfectly hardened against
  CPU-cache or memory-pressure side channels — out of scope for a hackathon
  evaluation tool.
- **Quantum-resistant crypto.** Not relevant to the threat model.

## Hardening checklist for operators

When deploying:

- [ ] Set `JWT_SECRET` to a 64+ byte random value (not the dev fallback)
- [ ] Set `DATABASE_URL` and confirm `DB_SSL=verify` (the default)
- [ ] Set `APP_URL` to your public origin (required in production)
- [ ] Set `STORAGE_PROVIDER` and `STORAGE_BUCKET` — local FS uploads vanish
      on container restart on most platforms
- [ ] Set `CORS_ORIGIN` to an explicit allowlist if your frontend lives on
      a different origin
- [ ] Provision SMTP credentials (`SMTP_HOST`, `SMTP_USER`, `SMTP_PASS`,
      optional `MAIL_FROM`) so password resets actually deliver
- [ ] Rotate the seeded `admin` password on first login
- [ ] Confirm the cloud bucket has versioning + lifecycle rules configured
      to your retention policy
- [ ] If on EC2: confirm the IAM role grants `ssm:GetParameter`,
      `kms:Decrypt`, and S3 access scoped to your prefix/bucket only
      (these are wired in [`terraform/ec2.tf`](terraform/ec2.tf))
- [ ] If on Cloud Run: confirm the service account has `roles/storage.objectAdmin`
      on the bucket and `roles/iam.serviceAccountTokenCreator` on itself
      (V4 signed URL signing under workload identity)
