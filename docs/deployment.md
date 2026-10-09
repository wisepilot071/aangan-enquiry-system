# Deployment

Not yet deployed. The app is a standard Next.js 16 server plus PostgreSQL. Any host that runs Node 20+ and can reach PostgreSQL works (a VM or container; a long-running Node process is preferred over serverless because rate limiters and the Telegram retry loop live in-process).

## Requirements

* Node.js 20+ and a **PostgreSQL 14+** database (managed Postgres is fine). `DATABASE_URL` is **mandatory** in production — the app refuses to start without it (the embedded PGlite database is for demos only).
* HTTPS in front (the session cookie is `Secure` in production), a reverse proxy that **sets** `X-Forwarded-For` (client IPs for rate limiting come from it, so strip any client-supplied value) and forwards `Host`.
* A public URL reachable by the voice provider for `POST /api/webhooks/voice`.

## Environment

| Variable | Production |
|---|---|
| `NODE_ENV` | `production` (set by `next start`) |
| `DATABASE_URL` | **required** |
| `SESSION_SECRET` | **required**, 32+ random chars |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | first admin — hash from `npm run admin:hash -- '<12+ char password>'` |
| `APP_BASE_URL` | recommended (adds a login-protected link to Telegram messages) |
| `VOICE_PROVIDER` | `mock` until the Vaani adapter is finished and verified; then `vaani` |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | for real hand-offs |
| `MOCK_WEBHOOK_SECRET` | only if you intentionally use the signed mock webhook |

Store secrets in the host's secret manager, not in the repository.

## Steps

```bash
npm ci
npm run build
npm run db:migrate        # idempotent; migrations also run automatically on first request
npm run db:seed           # creates the admin from ADMIN_EMAIL / ADMIN_PASSWORD_HASH
npm start                 # next start, port 3000 (PORT / -p to change)
```

Container hint: `node:22-slim`, copy the repo, `npm ci && npm run build`, run `npm start`. `knowledge/` and `drizzle/` must ship with the app (they are read at runtime).

Migrations are forward-only SQL in `drizzle/`. Change `src/db/schema.ts`, run `npm run db:generate`, review the SQL, commit it.

## Backup and restore

* **PostgreSQL:** nightly `pg_dump --format=custom "$DATABASE_URL" > aangan-$(date +%F).dump`; keep 30 days; test a restore monthly:
  ```bash
  createdb aangan_restore && pg_restore --no-owner -d aangan_restore aangan-2026-10-09.dump
  ```
  Managed providers' point-in-time recovery is preferable; enable it.
* **Embedded PGlite (demo only):** stop the app and copy `./data/pglite`; restore by putting the folder back.
* Backups contain personal data and transcripts — encrypt them and apply the same retention as production ([security-privacy.md](security-privacy.md)).

## Monitoring

Poll `GET /api/health` (200 = ok/degraded, 503 = database down). `degraded` means a non-critical integration is missing/pending; read the JSON. Alert on: health 503, rising `failed`/`unavailable` hand-offs (Urgent queue), `webhook.rejected` audit events, and calls with `unmeasurable` response times.

## Go-live checklist

- [ ] Nikhil has answered the **decisions** in [business-rules.md](business-rules.md#decisions-needed-from-nikhil)
- [ ] Vaani checklist complete and adapter implemented ([vaani-integration.md](vaani-integration.md)); contract tests from real payloads pass
- [ ] Real number routed; **one controlled test call** shows: signature check, `first_response_at` populated, actual cost recorded, duplicate delivery ignored
- [ ] Telegram bot added to the designer chat; one real hand-off delivered
- [ ] PostgreSQL, backups and restore tested; `SESSION_SECRET` and admin password set; demo users removed
- [ ] `VOICE_PROVIDER=vaani`; System status shows no pending items; **Demo data** not mixed into Production view
- [ ] Recording/retention/consent decisions made; purge job scheduled
- [ ] `npm audit` reviewed; HTTPS and proxy headers verified
- [ ] Human-fallback process agreed: who watches the Urgent queue and how fast
