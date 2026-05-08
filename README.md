<div align="center">

# ⚡ HackEval

**The complete, multi-tenant hackathon platform.**
Organizers create. Admins approve. Participants submit. Judges score — with optional AI assist.

[![Node.js](https://img.shields.io/badge/Node.js-20+-43853d?logo=node.js&logoColor=white)](https://nodejs.org)
[![Postgres](https://img.shields.io/badge/Postgres-13+-336791?logo=postgresql&logoColor=white)](https://www.postgresql.org)
[![Tests](https://img.shields.io/badge/tests-105_passing-10b981)](#development)
[![License](https://img.shields.io/badge/license-MIT-6366f1)](#license)

</div>

---

## What it is

HackEval is a self-hostable web app for running hackathons end-to-end. A single deployment hosts any number of events, each with its own projects, judges, criteria, and leaderboard. The app blends human scoring (1–10 sliders) with AI evaluation (OpenAI → AWS Bedrock fallback chain) on a configurable weight.

```
ORGANIZER ── creates hackathon ──→ pending
                                     │
SYSTEM ADMIN ── approves ──────────→ active ──→ joinable
                                     │
USER ── submits profile ─→ joins ──→ participant ─→ submits project & files
                                                       │
JUDGE ── scores with sliders + reads AI eval ────→ leaderboard
```

## Highlights

| | |
|---|---|
| 🏟️ **Multi-tenant** | Run any number of hackathons in one deployment. Every project, criterion, evaluation and audit entry is scoped by `hackathon_id`. |
| 🤖 **AI evaluation** | OpenAI GPT-4o → AWS Bedrock Claude → simulated fallback. Hybrid leaderboard blends human & AI scores. |
| ✅ **Approval workflow** | Organizers create; system admins approve. Pending events stay invisible to participants until live. |
| 👤 **Profiles + applications** | Users build a profile (bio, skills, links) and join active events. Judges read profiles before scoring. |
| 📦 **Cloud storage** | Pluggable S3 or GCS backend with V4 signed URLs. Local FS fallback for dev. |
| 🔐 **Hardened auth** | JWT in HttpOnly cookie + double-submit CSRF. Per-hackathon roles. Rate limiting + retry on AI calls. |
| 📋 **Audit log** | Every mutation recorded — actor, action, target, payload, IP. Per-hackathon and global views. |
| 🧱 **Real migrations** | Versioned SQL files in `migrations/`. Transactional, idempotent, applied at startup. |

## Roles

System roles (column `users.system_role`):

- **`user`** — default. Registers, builds a profile, joins active events as a participant.
- **`organizer`** — creates new hackathons (start in `pending` status), configures criteria, assigns judges and admins to events they run.
- **`system_admin`** — approves/rejects pending hackathons, manages the global user list, full cross-event powers.

Per-hackathon roles (table `hackathon_memberships`):

- **`admin`** — runs that one event: settings, criteria, members, projects.
- **`judge`** — submits evaluations on projects.
- **`participant`** — submits one project per event.

A user can be admin of event A, judge of event B, and participant in event C. System admins implicitly act as `admin` on every hackathon.

## Quick start

### Prerequisites

- **Node.js 20+**
- **Postgres** (Neon, Supabase, RDS, or local — anything with `pg`)
- **AWS or OpenAI credentials** (optional — AI evaluation falls back to a simulated scorer if neither is configured)

### Run locally

```bash
git clone https://github.com/spothineni/hackeval
cd hackeval
npm install
DATABASE_URL=postgres://... npm start
```

Open http://localhost:3000 — the landing page renders, click **Get started** to sign up.

On first start the server creates a seeded `admin` user. If `ADMIN_PASSWORD` is unset, a random one is generated and printed to the logs **once**:

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  INITIAL ADMIN CREDENTIALS — save this now (shown once):
     username: admin
     password: ABc1d_… (random)
  Change this password immediately after first login.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Run tests

```bash
npm test          # 105 tests via node:test, ~2s
```

## Configuration

### Required environment

| Variable | Description |
|---|---|
| `DATABASE_URL` | Postgres connection string. Server fails fast if unset. |
| `JWT_SECRET` | Cookie/token signing key. **Required** in production (`NODE_ENV=production`). |

### Storage

| Variable | Default | Description |
|---|---|---|
| `STORAGE_BUCKET` | _none → local FS_ | Bucket for upload blobs. **Strongly recommended in production.** |
| `STORAGE_PROVIDER` | auto-detect | `s3` (default if bucket set) · `gcs` · `local` |
| `STORAGE_REGION` | `us-east-1` | S3 region (ignored for GCS) |
| `STORAGE_PREFIX` | `uploads/` | Object key prefix |
| `SIGNED_URL_TTL_SEC` | `300` | Lifetime of presigned download URLs |

AWS credentials use the standard SDK chain (env vars, IAM role, shared config) for both Bedrock and S3. GCS uses Application Default Credentials — set `GOOGLE_APPLICATION_CREDENTIALS` to a key file in dev, or rely on the runtime service account on Cloud Run / GCE / GKE.

### AI evaluation

| Variable | Default | Description |
|---|---|---|
| `OPENAI_API_KEY` | _none_ | If set, OpenAI is the primary evaluator |
| `OPENAI_MODEL` | `gpt-4o` | OpenAI model ID |
| `AWS_REGION` | `us-east-1` | Bedrock region |
| `BEDROCK_MODEL` | `us.anthropic.claude-sonnet-4-5-…` | Claude model ID (used when OpenAI is unavailable) |

Without either, AI evaluation falls back to a deterministic simulated scorer.

### Other

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `NODE_ENV` | _dev_ | Set `production` for strict mode (requires `JWT_SECRET`, hides errors, warns on `STORAGE_BUCKET` unset) |
| `ADMIN_PASSWORD` | _generated_ | Initial admin password (printed once if unset) |
| `CORS_ORIGIN` | _same-origin only_ | Comma-separated list, or `*` |
| `DB_SSL` | `verify` | TLS for Postgres: `verify` · `insecure` · `disable` |

## Architecture

```
hackeval/
├── server.js              # Express backend (auth, routes, AI, storage)
├── init-db.js             # Runs migrations + seeds defaults at startup
├── db.js                  # Postgres pool wrapper
├── lib/
│   ├── audit.js           #   audit log writer (best-effort)
│   ├── cookies.js         #   cookie parsing + Set-Cookie builder
│   ├── hackathon.js       #   parseHackathonId, requireHackathonRole, …
│   ├── migrate.js         #   transactional SQL migration runner
│   ├── retry.js           #   exponential backoff for AI calls
│   ├── scoring.js         #   pure score-math functions
│   ├── storage.js         #   S3 / GCS / local backends
│   └── validate.js        #   input + URL + profile validators
├── migrations/            # numbered .sql files, run at startup in order
├── public/
│   ├── index.html         #   landing page + auth screen + SPA shell
│   ├── app.js             #   router, components, API client, modals
│   └── styles.css         #   dark theme + landing styles
├── test/                  # node:test suites (105 tests)
└── docs/screenshots/
```

| Layer | Tech |
|---|---|
| Server | Node.js 20+, Express 4 |
| Database | PostgreSQL (Neon-compatible) |
| Auth | JWT in HttpOnly cookie + bcrypt; CSRF via double-submit |
| Storage | S3 (`@aws-sdk/client-s3`), GCS (`@google-cloud/storage`), or local FS |
| AI | OpenAI SDK + AWS Bedrock SDK with retry + fallback |
| Frontend | Vanilla JS SPA, no build step |
| Styling | Hand-rolled dark theme + glassmorphism |

## How requests are scoped

Clients send `X-Hackathon-Id: <id>` on every request. The backend's `parseHackathonId` middleware reads it into `req.hackathonId`; downstream middleware (`requireHackathonRole`, `requireActiveHackathon`, `verifyProjectInHackathon`) enforce membership and status. The SPA stores the current hackathon in `localStorage` and shows a picker on login when the user belongs to multiple events.

A `default-hackathon` row is created automatically by migration 005 so existing single-event installs keep working with zero config.

## Key endpoints

| Method | Path | Auth |
|---|---|---|
| `POST` | `/api/auth/register` · `/login` · `/logout` | public · public · cookie |
| `GET/PUT` | `/api/profile` | any user |
| `GET` | `/api/hackathons` | hackathons the caller is in |
| `GET` | `/api/hackathons?discover=1` | active events caller could join |
| `POST` | `/api/hackathons` | organizer or system_admin (organizer → pending) |
| `POST` | `/api/hackathons/:hid/approve` · `/reject` | system_admin |
| `POST` | `/api/hackathons/:hid/join` | any user with a profile |
| `GET/POST/DELETE` | `/api/hackathons/:hid/members` | hackathon admin |
| `GET/POST/PUT/DELETE` | `/api/projects[/:id]` | scoped, see source |
| `POST` | `/api/projects/:id/ai-evaluate` | hackathon admin · rate-limited |
| `POST` | `/api/evaluations` | judge or admin |
| `GET` | `/api/leaderboard` · `/dashboard` · `/audit-log` | scoped |
| `GET` | `/api/files/:storedName` | cookie or short-lived ticket |
| `GET` | `/health` · `/healthz` | public (load balancer) |

## Hybrid scoring

```
final = humanAvg × (1 - aiWeight)  +  aiScore × aiWeight
```

Default `aiWeight = 0.4` (60% human / 40% AI). Configurable per hackathon in **Settings → AI Scoring Weight**. If only human or only AI scores exist, the available value is used at full weight.

## Development

### Migrations

Schema lives in `migrations/*.sql`. The runner ([lib/migrate.js](lib/migrate.js)) runs at startup, applies any unapplied files in alphabetical order — each in its own transaction — and records the filename in `schema_migrations` so it's not re-applied. Migrations should be idempotent (`CREATE TABLE IF NOT EXISTS`, `DO $$ … EXCEPTION WHEN duplicate_object`) so they're safe to re-run against legacy databases. There are no down-migrations — to roll back, deploy the previous code and write a corrective forward migration.

### Tests

```bash
npm test
```

Pure-function tests for scoring math, validators, retry classification, cookie parsing, audit writes, and middleware authorization. No DB required — DB-bound flows use mocks.

### Adding a hackathon programmatically

```bash
curl -X POST http://localhost:3000/api/hackathons \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d '{"slug":"my-hack-2026","name":"My Hack 2026"}'
```

Organizers get `status: pending`; system admins get `status: active` immediately.

## Screenshots

<details>
<summary>Click to expand</summary>

| | |
|---|---|
| ![Login](docs/screenshots/login.png) | ![Dashboard](docs/screenshots/dashboard.png) |
| ![Projects](docs/screenshots/projects.png) | ![File Upload](docs/screenshots/file_upload.png) |
| ![Judging](docs/screenshots/judging.png) | ![Leaderboard](docs/screenshots/leaderboard.png) |
| ![Settings](docs/screenshots/settings.png) | ![User Management](docs/screenshots/user_management.png) |

</details>

## License

MIT
