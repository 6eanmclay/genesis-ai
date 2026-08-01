# Deployment & production migrations

How code and schema changes actually reach production, and the one step that is deliberately **not** automatic. Edited in place, like `ARCHITECTURE.md` — should describe today's process, not a past one. This is also the living operational reference for deployment safety and infrastructure verification generally — the product/feature roadmap lives elsewhere (see `reference_engineering_roadmap` memory) and stays focused on product and platform evolution, not operational hardening.

**Last updated:** 2026-08-01, after removing automatic `prisma migrate deploy` from the build pipeline (see *Why this changed* below).

## Track 0 checklist — Operational Foundations

Cheap, high-blast-radius operational risks, tracked separately from feature work. Check an item off once it's been verified against the real environment, not just implemented.

- [x] **Remove automatic production schema migrations** — done 2026-08-01, see below.
  - [ ] **Verify Preview deployment database branching** — open. Need to confirm in the Vercel dashboard (Project → Storage → the Neon integration → connection settings) whether Preview deployments get an isolated Neon branch or share the production database. See *Two things worth knowing but not yet resolved* below for why this couldn't be confirmed via CLI. Not blocking anything today (migrations no longer auto-run in either environment), but worth closing out and documenting the answer here.
- [ ] **Per-store AI usage ceilings / proactive cost governance** — not started. `lib/genesisModel.ts` only reacts to Anthropic's own rate-limit/billing errors after the fact; no pre-call budget or ceiling exists.
- [ ] **Production error monitoring (Sentry or equivalent)** — not started. `app/dashboard/error.tsx` only does `console.error`; nothing reports externally.
- [ ] **Structural tenant-isolation enforcement** — not started. Store-scoped queries are correctly filtered everywhere sampled so far, but only by convention (`requireStorePermission`/`resolveUserStore`), not by anything at the Prisma/DB layer that would catch an omission.

## Code deploys — unchanged, still automatic

Pushing to `master` triggers a normal Vercel build (`next build`) and deploy. Nothing about this changed. Most schema evolution in this codebase happens through `Json` columns (`Store.blueprint`, `Product.richContent`, etc.) rather than new tables/columns — see `ARCHITECTURE.md`'s *Database model* section — so the large majority of deploys have no pending migration at all and this section is all that applies to them.

## Schema migrations — now a deliberate, separate step

`package.json`'s `build` script no longer runs `prisma migrate deploy`. It used to — every build, on every push to `master`, silently applied any pending migration to the **production** database with no review step. That's what changed, and why:

- No staging gate, no human in the loop, no way to catch a bad migration before it touched real customer/order data.
- The production Postgres is Neon (`Launch` plan, confirmed via `vercel integration resource inspect`), which does have automatic point-in-time recovery — verified live against Neon's current docs, not assumed: **up to 7 days** of restorable history, on by default, no setup required. That's a real safety net for *recovering* from a bad migration, but it's not a substitute for a gate that prevents one from landing unreviewed in the first place.

**When a change includes a schema migration, the safe order is:**

1. Write and review the migration locally (`npx prisma migrate dev` against your local DB, as always).
2. Read the generated SQL in `prisma/migrations/` before it goes anywhere near production — this is the actual review step. For anything destructive (dropping/renaming a column, changing a type) confirm it's backward-compatible with whatever code is *currently* live, since code and migration no longer deploy atomically.
3. Apply it to production deliberately:
   ```
   npm run migrate:deploy
   ```
   run locally against the real production `DATABASE_URL` (pull it via `vercel env pull .env.production.local --environment=production`, or run through `vercel exec` — either way, this is a conscious action a person takes, not something that fires on every push).
4. Only then push/merge the code that depends on the new schema.

Running migration-then-code (not the reverse) matters because they're no longer coupled to the same build — code that assumes a column exists should never deploy ahead of the column itself.

## Two things worth knowing but not yet resolved

- **Preview deployments may share the production database.** Neon's native Vercel integration *can* give every Preview deployment its own isolated database branch, but only if that's explicitly toggled on when the integration was connected — confirmed via Neon's own docs, not assumed. I could not determine the current toggle state through the Vercel CLI (branch-specific credentials for preview branching, if enabled, are injected only at deploy time, not stored as an inspectable env var). **This needs a direct check in the Vercel dashboard** (Project → the Neon integration card → connection settings) — until confirmed, treat preview deployments as if they might be talking to the same database as production. This is now moot for the migration-gate risk specifically, since `prisma migrate deploy` no longer runs automatically in *either* environment's build — but it's still relevant for anyone testing against a preview URL and wondering why their test data shows up (or doesn't) in production.
- **7-day PITR window.** Fine for catching a bad migration quickly, but if a subtle data issue went unnoticed for longer than a week, Neon's `Scale` plan extends this to 30 days. That's a cost/plan decision, not an engineering one — flagging it, not acting on it.

## If this manual step becomes a real friction point

The natural next step, if/when it's worth the setup cost, is a GitHub Actions workflow with an environment-protection approval gate that runs `migrate:deploy` only on manual confirmation — no such workflow exists in this repo today (`.github/workflows/` doesn't exist), so this would be new infrastructure, not an extension of something already there. Not built now because a documented manual step already closes the actual risk (unreviewed auto-migration) for near-zero engineering cost, matching the risk-reduction-per-hour goal this task was scoped against.
