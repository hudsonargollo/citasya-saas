# CitasYa → multi-tenant SaaS on the CixNail engine — migration plan

Status: planning only. No repos, DNS, nginx, systemd or databases were modified.
Date: 2026-11-26.
Target repo: https://github.com/hudsonargollo/citasya-saas.git (cloned at `/root/ClubeMkt/citasya-saas`, HEAD `1b328fc`, initially empty).
Confirmed tenant-1 slug: `cixnailspa`. Legacy `cixnails.clubemkt.digital` is out of scope — no alias or redirect required.

## 0. Repos and live state (verified)

- CitasYa source: `/root/ClubeMkt/CitasYa` — already cloned, origin `git@github.com:hudsonargollo/citasya.git`, clean HEAD `6e831fa`. The empty `/root/ClubeMkt/citasya/` folder is not a git repo and was left untouched.
- CixNail source: `/root/ClubeMkt/cixnails` — already cloned, origin `https://github.com/hudsonargollo/cixnalspa.git`, HEAD `371a6b9`.
- Live landing: `https://citasya.clubemkt.digital/` → 200, PHP 8.2 (Laravel), nginx `clubemkt-legacy` → `172.17.0.1:8085`, Cloudflare in front. Source: `backend/resources/views/landing.blade.php` + route `Route::get('/', ...)->name('home')` in `backend/routes/web.php`.
- Live engine: `cixnails.service`, `node dist/web.js`, port 3021, data dir `/var/lib/cixnails`, nginx exact block `cixnails.clubemkt.digital` → 3021 with `location = / { return 302 /agendar; }`. `/agendar` and `/auth/login/` both live 200.
- `cixnailspa.clubemkt.digital` resolves (wildcard DNS → Cloudflare) but currently 404 via the krikkit wildcard. No DNS change needed for new tenants.
- `*.clubemkt.digital` wildcard DNS already points to this host.

## 1. Target architecture

```
citasya.clubemkt.digital   → UNCHANGED global marketing landing (Laravel/PHP)
                              only its CTA targets get rewired to tenant pages
        │
        ├── https://cixnailspa.clubemkt.digital/  → 302 /agendar
        │       /agendar                          → public booking (CixNail frontend)
        │       /auth/login/                      → staff login → /pos + backoffice
        │       /pos /agenda /dashboard /orders /products /customers
        │       /staff /sucursales /settings      → admin (JWT-gated)
        │
        └── https://<newtenant>.clubemkt.digital/ → same app, isolated DB + branding
```

One Node process (`dist/web.js` of the new SaaS repo), one wildcard nginx vhost. Tenant resolution by `Host` header. Per-tenant SQLite database and asset overlay.

Key decision: **port cixnalspa into the existing new repo `/root/ClubeMkt/citasya-saas`** (currently empty) and convert it there. Do not mutate the working `cixnails` deployment — it is production. Cixnails stays live on its own domain until cutover.

## 2. What stays, what is replaced

| Concern | Decision |
|---|---|
| Landing page visuals/content | Keep byte-for-byte: `landing.blade.php` (1,328 lines, Tailwind Play CDN, static sections). |
| Landing runtime | Keep Laravel serving it on `citasya.clubemkt.digital`. Change only its 4 CTA/API targets (see §7). |
| CitasYa Laravel backoffice/API/Flutter apps | Decommission after cutover. They are the old marketplace, not the SaaS engine. |
| Booking + backoffice engine | Replace with cixnalspa's Next.js static export + Express/SQLite. Already has `/agendar`, `/auth/login/`, `/pos`, `/agenda`, `/dashboard`, `/orders`, `/products`, `/customers`, `/staff`, `/sucursales`, `/settings`. |
| Tenant 1 | `cixnailspa` — data dir `/var/lib/citasya-saas/cixnailspa/`, seeded from the existing production SQLite DB, not a fresh install. |
| Branches ("sucursales") | Keep as-is: they are within-tenant locations (`branches` table + CRUD + public modal), not tenants. |

## 3. Engine changes — file-level work

### 3.1 Tenant registry + resolution (new)
- New `main/tenants.ts`: control DB (SQLite, e.g. `/var/lib/citasya-saas/control.db`) with table `tenants(slug TEXT PK, name, data_dir, branding_dir, public_url, jwt_secret, status, created_at)`.
- New `main/middleware/tenant.ts`: Express middleware, registered **before** all routes in `main/server.ts`. Parse `req.hostname` (nginx already forwards `X-Forwarded-Host`), strip `.clubemkt.digital`, look up slug, attach `req.tenant`. Unknown host → 404. Map `citasya.clubemkt.digital` explicitly (landing stays on Laravel; no engine route needed). No mapping for `cixnails.clubemkt.digital` — out of scope.
- Provision CLI `scripts/provision-tenant.mjs <slug> <name> [source-db]`: inserts registry row, creates `<data_dir>/<slug>/`, copies source DB or runs `initDatabase()` for that dir, writes branding overlay dir, prints a summary. Idempotent.

### 3.2 Break the DB singleton (biggest hotspot)
Current: `main/db.ts:8 let db: Database.Database`, `getDatabase()` module-level singleton; every route/service imports it. Change to:
- `Map<slug, Database.Database>` cache; `getDb(tenantId)` lazy-open; per-tenant `initDatabase(tenant)` running the existing schema/migrations/seed logic on that handle.
- AsyncLocalStorage or explicit `db` argument through `main/routes/*.ts`, `main/services/booking.ts`, `order-builder.ts`, `tax.ts`, `auth.ts`, `printers/*`.
- `CIXNAILARTIST_DATA_DIR` becomes the root; path becomes `<root>/<slug>/cixnailartist.db`.
- Parameterize `getDbPath()`, `createBackup()`, `restoreBackup()` — today all global (`main/db.ts:26`, `main/routes/database.ts:149`).
- Tenant 1 bootstrap: `cp /var/lib/cixnails/cixnailartist.db /var/lib/citasya-saas/cixnailspa/cixnailartist.db` (plus `-wal`/`-shm` with a clean checkpoint) so all current appointments/settings/customers survive. Then update settings: `business_name`, `business_tagline`, `whatsapp`, `email`, `address`, `instagram`. Existing `INSERT OR IGNORE` seeds will not overwrite.

### 3.3 Auth + authorization (security blocker)
- Replace `buildLocalTenant()` (`main/routes/auth.ts:11`, hard-coded `id:1`, `slug:'local'`, `database_name:'local'`) with the resolved tenant; include `tenantId`/`slug` in JWT and verify it equals `req.tenant.slug` on every authenticated request.
- Today **only `main/routes/auth.ts` calls `jwt.verify`** — verified by grep. All other `/api/*` routes are unauthenticated; `main/routes/index.ts:78,109` and `order-items.ts:32,64` trust the client-supplied `x-user-role` header. This is a cross-tenant data leak the moment tenants share a process. Add JWT middleware to every `/api/*` route except `/api/public/booking/*`, `/api/health`, `/api/auth/*`; derive role from verified token only.
- Keep the existing login flow (email **or** phone + bcrypt, 24h JWT) and the frontend `AuthGuard` (`PUBLIC_PATHS` includes `/auth/login` and `/agendar`).
- Keep `PUBLIC_BOOKING_URL` per tenant (from registry) — `bookingUrls()` currently reads one global env value and can leak the VPS LAN IP.

### 3.4 Branding per tenant
- `frontend/out` is one static build, so runtime branding must come from data:
  - Add `GET /api/public/branding` (or extend `/api/public/booking/config`) returning tenant name, tagline, logo paths, CSS tokens, WhatsApp, Instagram.
  - Serve tenant assets from `tenants/<slug>/assets/*` via Express static with fallback to `frontend/out/cixnails/*`.
  - Replace hardcoded `Cix Nail Artist` strings in `frontend/src/lib/i18n.ts` (lines ~78–90, including "3 sucursales de Santa Cruz de la Sierra") with values from config; same for `agendar/layout.tsx` metadata, `FALLBACK_INSTAGRAM`, featured product IDs `cix-prod-01..03`, and work/shop image paths.
  - `frontend/src/app/brand.css` tokens (rosewood `#a65a4c`, dark `#1c1413`, cream `#E8DDD0`) → CSS variables injected at runtime from tenant config, so tenant 2 need not be a nail salon with the same palette.
  - Per-tenant `<title>`: client-side effect (static export) or Express HTML rewrite — pick one; recommend client effect.
- `frontend/src/lib/public-api.ts` already uses same-origin on non-local hosts — tenant-safe, no change.

### 3.5 Cross-tenant state isolation
- Scope the in-memory public-booking rate buckets (`main/routes/public-booking.ts`) by tenant slug.
- Scope WebSocket notification channels (`main/notification-server.ts`) by tenant; today it broadcasts globally.
- Keep printer detection machine-local; printer rows already live in each tenant DB.
- Per-tenant backup/restore and export/import (`main/routes/database.ts`) — path must come from tenant.

### 3.6 Deployment
- New systemd unit `citasya-saas.service`: `WorkingDirectory=/root/ClubeMkt/citasya-saas`, `EnvironmentFile=/etc/citasya-saas.env`, `ExecStart=/usr/local/bin/node dist/web.js`, `PORT=3021` **after** cixnails is stopped/cut over (or use a distinct port during parallel testing, e.g. 3030).
- New env: `PORT`, `CITASYA_SAAS_DATA_DIR=/var/lib/citasya-saas`, `CONTROL_DB_PATH`, `JWT_SECRET` (global signing secret; tenant binding via claim), `PUBLIC_BOOKING_URL` as fallback only.
- nginx: replace the exact `cixnails.clubemkt.digital` block with a regex catch-all:
  ```
  server {
      listen 80;
      server_name ~^(?<slug>[a-z0-9-]+)\.clubemkt\.digital$;
      client_max_body_size 50M;
      location = / { return 302 /agendar; }
      location / {
          proxy_pass http://127.0.0.1:3021;
          proxy_set_header Host $host;
          proxy_set_header X-Forwarded-Host $host;
          proxy_set_header X-Real-IP $remote_addr;
          proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
          proxy_set_header X-Forwarded-Proto https;
          proxy_http_version 1.1;
          proxy_set_header Upgrade $http_upgrade;
          proxy_set_header Connection "upgrade";
          proxy_read_timeout 300s;
      }
  }
  ```
  Regex `server_name` wins over the `*.clubemkt.digital` literal wildcard but loses to exact names — keep an exact block for `citasya.clubemkt.digital` (in `clubemkt-legacy`, unchanged) and an exact redirect for legacy `cisnails`/`cixnails` hosts if desired. `nginx -t` then reload.
- TLS stays at Cloudflare; nothing to change there.

### 3.7 Landing rewiring (minimal, visual unchanged)
The landing is one Blade file with only 4 live integration points. Options:
- **Recommended:** keep `landing.blade.php` visually and textually identical; change only the CTA destinations:
  - Express booking modal `POST /api/register` + `POST /api/login` + `window.location.href='/app/?token=...'` (lines ~1268–1309) → a single "Reservar ahora" link to `https://cixnailspa.clubemkt.digital/agendar`. To keep the modal's look, keep the modal UI but submit to a new `POST /api/landing/lead` on the Laravel side that 302s to the tenant booking page (or simply change `window.location.href` to the tenant URL).
  - "Para Negocios" CTA (line ~982, currently wa.me) → optionally add tenant admin link `https://cixnailspa.clubemkt.digital/auth/login/`.
  - Everything else (`route('blog.index')`, `asset()` favicons, `SEO::generate()`, anchors, WhatsApp support number) stays.
- Alternative if zero landing edits are required: keep the file untouched and add nginx `location` shims on `citasya.clubemkt.digital` for `/api/register`, `/api/login`, `/api/landing/lead` that proxy to the SaaS engine's default tenant. More moving parts, no visual benefit — not recommended.

## 4. Phases and acceptance criteria

1. **Port + baseline** — copy cixnalspa sources into the already-cloned `/root/ClubeMkt/citasya-saas`; build and run headless on port 3030; verify `/agendar` + `/auth/login/` 200. No production change.
2. **Tenant plumbing** — registry, Host middleware, per-tenant DB cache, parameterized paths. Acceptance: two test slugs serve different DBs; unknown host 404.
3. **Security gate** — JWT middleware on all non-public API routes; tenant claim check; rate buckets/WS scoped. Acceptance: token from tenant A cannot read tenant B's `/api/appointments`, `/api/customers`, `/api/settings`, or `/api/public/booking/config`.
4. **Branding** — config-driven strings/assets/colors. Acceptance: tenant 2 shows its own name/logo/WhatsApp on `/agendar` while tenant 1 is unchanged.
5. **Tenant 1 data migration** — copy live cixnails DB into `cixnailspa`, update settings, keep branches. Acceptance: all existing appointments/services/branches visible on `cixnailspa.clubemkt.digital/agendar`; admin login works.
6. **Cutover** — nginx regex vhost + systemd service; keep cixnails service stopped after verification (rollback = re-enable it and restore its vhost). Acceptance: `cixnailspa.clubemkt.digital/` → `/agendar`, `/auth/login/` → admin, `/pos` after login; legacy `cixnails.clubemkt.digital` intentionally not served.
7. **Landing CTA rewiring** — the minimal Blade edit from §3.7. Acceptance: landing still renders identically; primary CTA lands on tenant booking.
8. **Provision tenant 2** — run `provision-tenant.mjs`, add branding overlay, verify isolation. This proves the SaaS claim rather than a single rebrand.

## 5. Risks / open decisions

- **Single process, shared memory** — tenant scoping must be exhaustive; any missed global (WS, rate buckets, static asset path, backup path) leaks across tenants. Phase 3 tests are mandatory, not optional.
- **Static frontend build** — one Next export for all tenants; anything brand-specific must be runtime data or a client effect. Hardcoded i18n strings are the main cleanup.
- **Old CitasYa data** — no migration path from Laravel MySQL `citasya_db` to the new engine is proposed. The old marketplace's salons/bookings are a different data model. If any of that data must survive, define a field mapping first; otherwise treat it as legacy.
- **Tenant naming** — confirmed by user: `cixnailspa`. Everything above uses this slug.
- **Landing "as is"** — if literally zero edits to the Blade file are required, choose the nginx-shim option in §3.7 and accept that the express modal keeps writing to the old Laravel API.
- **Cixnails legacy** — out of scope per user; no alias or redirect will be created.
- **Payments** — CixNail has no online checkout; CitasYa had Simple QR Bolivia + 7 gateways. If tenant bookings need online payment, that is a separate feature.

## 6. Verification commands (after implementation)

```
curl -sI https://cixnailspa.clubemkt.digital/            # 302 /agendar
curl -sI https://cixnailspa.clubemkt.digital/agendar      # 200
curl -sI https://cixnailspa.clubemkt.digital/auth/login/  # 200
curl -sI https://citasya.clubemkt.digital/                # 200, landing unchanged
curl -sI https://unknown-slug.clubemkt.digital/           # 404
curl -sI https://cixnailspa.clubemkt.digital/api/health   # 200
```
Plus the phase-3 cross-tenant isolation tests against two provisioned slugs.
