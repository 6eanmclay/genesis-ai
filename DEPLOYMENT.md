# Deployment & production migrations

How code and schema changes actually reach production, and the one step that is deliberately **not** automatic. Edited in place, like `ARCHITECTURE.md` — should describe today's process, not a past one. This is also the living operational reference for deployment safety and infrastructure verification generally — the product/feature roadmap lives elsewhere (see `reference_engineering_roadmap` memory) and stays focused on product and platform evolution, not operational hardening.

**Last updated:** 2026-08-02, after structural tenant-isolation enforcement (code-complete and functionally verified end-to-end — see below). All Track 0 items are now implemented; the two remaining unchecked boxes are human-only steps (Sentry's Vercel account link, Preview-branch database verification), not engineering work.

## Track 0 checklist — Operational Foundations

Cheap, high-blast-radius operational risks, tracked separately from feature work. Check an item off once it's been verified against the real environment, not just implemented.

- [ ] **Remove automatic production schema migrations** — done 2026-08-01
  (`5002093`), **and reversed on 2026-08-13** (`a2a05bf`), which this document
  did not say for a week. See *Correction* immediately below.
  - [ ] **Verify Preview deployment database branching** — open. Need to confirm in the Vercel dashboard (Project → Storage → the Neon integration → connection settings) whether Preview deployments get an isolated Neon branch or share the production database. See *Two things worth knowing but not yet resolved* below for why this couldn't be confirmed via CLI. Not blocking anything today (migrations no longer auto-run in either environment), but worth closing out and documenting the answer here.
- [~] **Production error monitoring (Sentry)** — code-complete 2026-08-01, **not yet live**. See *Sentry — code-complete, one manual step remains* below for exactly what's left and why I couldn't finish it myself.
- [x] **Per-store AI usage ceilings / proactive cost governance** — done 2026-08-02, **live in production**. A real circuit breaker (Sean's framing, not a billing system): daily per-store/per-user token ceiling, computed from an append-only `AiUsageEvent` log (real usage from the provider's own response, never estimated). Background/autonomous AI work (the one real call site — `cognitiveLayer.ts`'s scheduled/opportunistic business review) stops immediately with no confirmation possible; owner-initiated chat gets a real "Continue anyway" button in `GenesisAssistant.tsx` that re-issues the exact same request with the ceiling bypassed for that one turn. Every breach reports through Sentry. Verified functionally end-to-end against a real account with a real Claude call: real usage recorded correctly, a temporarily-lowered ceiling produced the real block + confirm button, and clicking it produced a real, successful, grounded Genesis response. Production migration (`20260802010559_add_ai_usage_event`) applied by Sean 2026-08-02, confirmed via real Prisma CLI output against the real Neon production host.
- [x] **Structural tenant-isolation enforcement** — done 2026-08-02. `lib/tenantIsolation.ts`, a Prisma Client Extension wired in once at `lib/prisma.ts`, now requires a store-scoping filter on every `update`/`delete`/`updateMany`/`deleteMany` and `findMany`/`count`/`aggregate` across the ~19 tenant-scoped models — defense-in-depth alongside (not a replacement for) `requireStorePermission`, which remains the real authorization gate. Deliberately does not touch the confirmed-safe fetch-then-authorize single-record-lookup pattern (`findFirst`/`findUnique`) — see `ARCHITECTURE.md`'s *Permissions & Roles* section for the full reasoning. Fixed 24 genuine mutation/read call sites across 12 files that had authorization but no store-scoped `where`; added a second `prismaSystem` export for the handful of legitimate cross-tenant CRON_SECRET-gated queries (scheduler due-syncs, cron status endpoint). Verified via a real functional smoke test against a running dev server (seeded account, blocked-without-scope + allowed-with-scope both confirmed, storefront pages re-verified end-to-end), plus a clean `tsc`/`eslint`/`next build` pass. Test accounts and scripts cleaned up afterward.

## Code deploys — unchanged, still automatic

Pushing to `master` triggers a normal Vercel build (`next build`) and deploy. Nothing about this changed. Most schema evolution in this codebase happens through `Json` columns (`Store.blueprint`, `Product.richContent`, etc.) rather than new tables/columns — see `ARCHITECTURE.md`'s *Database model* section — so the large majority of deploys have no pending migration at all and this section is all that applies to them.

## Correction — the gate is not there (2026-08-20)

**Everything in the section below describing migrations as a deliberate, manual
step was true when written and has been wrong since 2026-08-13.**

`package.json`'s build script reads:

```
"build": "node scripts/migrate-deploy.mjs && next build"
```

`a2a05bf` ("Run migrations as part of the production build") put automatic
migration back, and `db27a05` later moved it onto the unpooled connection to fix
a real advisory-lock problem. Both were reasonable changes. Neither updated this
file, so for a week the only document describing how migrations reach production
described a gate that had been removed.

**What that means in practice.** Pushing to `master` applies every pending
migration to the production database before the app builds. There is no review
step and no human in the loop. Code and migration deploy together again, so the
ordering advice below ("migration first, then the code that depends on it") is
now automatic rather than something anybody chooses.

**How this was found.** `20260820060000_product_sourcing` was written and
deliberately *not* applied, and recorded in `COMPLIANCE.md` as waiting for a
manual step. Reading the production database to apply it showed it already
applied — by the Vercel build triggered by the push that added it. The schema
was verified correct against production directly: both enums with the right
labels, `Product.sourceKind` NOT NULL defaulting to `OWNER_MADE`, all 21
`SourcedProduct` columns, both indexes, all 55 existing products reading
`OWNER_MADE` and nothing rewritten.

**The claim in the section below that an agent cannot apply a production
migration is also no longer meaningful.** It is still true that the production
`DATABASE_URL` is a Vercel Sensitive variable and unreadable there — verified
again today, it reads `[SENSITIVE]` in `.env.production.local`. But nothing has
to read it: a push applies the migration.

**Whether to reinstate the gate is a decision for Sean, not a cleanup task.**
The reasons it was introduced (no staging, no review, real customer and order
data) have not changed; the reason it was reversed is not recorded anywhere. It
is on `COMPLIANCE.md`'s decision list rather than being quietly changed back.

---

## Schema migrations — the section below describes a gate that is not there

> **STALE, AND CONFIRMED STALE BY A PRODUCTION BUILD LOG (2026-08-25).**
>
> Everything from here to the end of this section describes the state after the
> gate was added on 2026-08-01. The gate was reversed on 2026-08-13 and this
> section was never updated, which is exactly the drift §"Correction — the gate
> is not there" above already records.
>
> The deploy of `892f67b` on 2026-08-25 settles it with direct evidence rather
> than inference. From the Vercel build log:
>
> ```
> > node scripts/migrate-deploy.mjs && next build
> migrate: using DATABASE_URL_UNPOOLED (direct connection)
> 91 migrations found in prisma/migrations
> No pending migrations to apply.
> ```
>
> **`package.json`'s build script DOES run migrations, on every push to
> `master`.** That deploy happened to carry none, which is why it was safe; a
> deploy that carries one will apply it to production with no review step.
>
> The text below is kept rather than deleted because the *safe order* it
> describes is still the right procedure — it is the opening claim that is
> false. Whether to reinstate the gate remains Sean's decision and is on
> `COMPLIANCE.md`'s list.

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
   run locally against the real production `DATABASE_URL`. **`DATABASE_URL` is a Vercel "Sensitive" environment variable** — confirmed against Vercel's own docs, and empirically: it shows `[SENSITIVE]` in `vercel env pull` even in a real, interactive human session (first assumed this was about agent/automation detection specifically; that guess was wrong and got corrected once tested). Per Vercel's docs, a Sensitive variable's value is genuinely non-readable once set, for anyone, through any Vercel surface — there's no interactive workaround. The real value still exists at the source: **Neon's own console** (`console.neon.tech`, or via the "open in Neon" link from the storage integration's page in the Vercel dashboard) has the real connection string under the branch's Connection Details, independent of Vercel's copy being locked. Copy it from there and set it for one command: `$env:DATABASE_URL = "<paste>"` (PowerShell) before running `migrate:deploy` — never commit it, and it only persists for that terminal session.
4. Only then push/merge the code that depends on the new schema.

Running migration-then-code (not the reverse) matters because they're no longer coupled to the same build — code that assumes a column exists should never deploy ahead of the column itself.

**A real consequence of this discovery**: applying a production migration now genuinely requires a real human with Neon console access — not something I (or any agent) can complete unassisted, even in principle, since the value is cryptographically locked on Vercel's side. I can write, review, and stage every migration; only a human can apply it. First real exercise of this was `20260802010559_add_ai_usage_event`, applied 2026-08-02.

## Sentry — code-complete, one manual step remains

`@sentry/nextjs` is installed and wired into every real error boundary (`app/error.tsx`, `app/global-error.tsx`, `app/dashboard/error.tsx`, `app/store/[slug]/error.tsx` — all four now call `Sentry.captureException(error)` alongside their existing `console.error`), plus `instrumentation.ts`/`instrumentation-client.ts`/`sentry.server.config.ts`/`sentry.edge.config.ts` and a `withSentryConfig`-wrapped `next.config.ts`. Verified: `tsc`/`eslint`/`npm run build` all clean, and a real browser check against the running dev server confirmed the SDK initializes (`window.__SENTRY__` present) with zero console errors and zero network calls — the documented no-op behavior for a missing DSN, confirmed live, not assumed.

**What's not done, and why I can't finish it:** there's no Sentry project to send errors to yet. Sentry is available as a Vercel marketplace integration (confirmed via `vercel integration discover sentry`), but installing it requires accepting Sentry's terms in a browser — a legal agreement tied to your account, not something I can or should do on your behalf. Running `vercel integration add sentry` returned:

```
"reason": "integration_terms_acceptance_required"
"verification_uri": "https://vercel.com/genesis-a1/~/integrations/accept-terms/sentry?source=cli"
```

**To finish activating it:**
1. Open that URL, accept the terms.
2. The same flow will ask you to link (or create) a Sentry project — the integration doesn't auto-create one.
3. Once linked, Vercel auto-injects `NEXT_PUBLIC_SENTRY_DSN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` (exact names confirmed against Sentry's own docs) — the code above already reads exactly those names, so nothing else needs to change.
4. Redeploy (or just push anything) to pick up the new env vars.
5. I can then trigger a real test error and confirm it lands in Sentry, and check this item off.

## Two things worth knowing but not yet resolved

- **Preview deployments may share the production database.** Neon's native Vercel integration *can* give every Preview deployment its own isolated database branch, but only if that's explicitly toggled on when the integration was connected — confirmed via Neon's own docs, not assumed. I could not determine the current toggle state through the Vercel CLI (branch-specific credentials for preview branching, if enabled, are injected only at deploy time, not stored as an inspectable env var). **This needs a direct check in the Vercel dashboard** (Project → the Neon integration card → connection settings) — until confirmed, treat preview deployments as if they might be talking to the same database as production. This is now moot for the migration-gate risk specifically, since `prisma migrate deploy` no longer runs automatically in *either* environment's build — but it's still relevant for anyone testing against a preview URL and wondering why their test data shows up (or doesn't) in production.
- **7-day PITR window.** Fine for catching a bad migration quickly, but if a subtle data issue went unnoticed for longer than a week, Neon's `Scale` plan extends this to 30 days. That's a cost/plan decision, not an engineering one — flagging it, not acting on it.

## If this manual step becomes a real friction point

The natural next step, if/when it's worth the setup cost, is a GitHub Actions workflow with an environment-protection approval gate that runs `migrate:deploy` only on manual confirmation — no such workflow exists in this repo today (`.github/workflows/` doesn't exist), so this would be new infrastructure, not an extension of something already there. Not built now because a documented manual step already closes the actual risk (unreviewed auto-migration) for near-zero engineering cost, matching the risk-reduction-per-hour goal this task was scoped against.
