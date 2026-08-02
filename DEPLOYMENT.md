# Deployment & production migrations

How code and schema changes actually reach production, and the one step that is deliberately **not** automatic. Edited in place, like `ARCHITECTURE.md` — should describe today's process, not a past one. This is also the living operational reference for deployment safety and infrastructure verification generally — the product/feature roadmap lives elsewhere (see `reference_engineering_roadmap` memory) and stays focused on product and platform evolution, not operational hardening.

**Last updated:** 2026-08-02, after AI cost governance (code-complete and functionally verified end-to-end — see below).

## Track 0 checklist — Operational Foundations

Cheap, high-blast-radius operational risks, tracked separately from feature work. Check an item off once it's been verified against the real environment, not just implemented.

- [x] **Remove automatic production schema migrations** — done 2026-08-01, see below.
  - [ ] **Verify Preview deployment database branching** — open. Need to confirm in the Vercel dashboard (Project → Storage → the Neon integration → connection settings) whether Preview deployments get an isolated Neon branch or share the production database. See *Two things worth knowing but not yet resolved* below for why this couldn't be confirmed via CLI. Not blocking anything today (migrations no longer auto-run in either environment), but worth closing out and documenting the answer here.
- [~] **Production error monitoring (Sentry)** — code-complete 2026-08-01, **not yet live**. See *Sentry — code-complete, one manual step remains* below for exactly what's left and why I couldn't finish it myself.
- [x] **Per-store AI usage ceilings / proactive cost governance** — done 2026-08-02. A real circuit breaker (Sean's framing, not a billing system): daily per-store/per-user token ceiling, computed from an append-only `AiUsageEvent` log (real usage from the provider's own response, never estimated). Background/autonomous AI work (the one real call site — `cognitiveLayer.ts`'s scheduled/opportunistic business review) stops immediately with no confirmation possible; owner-initiated chat gets a real "Continue anyway" button in `GenesisAssistant.tsx` that re-issues the exact same request with the ceiling bypassed for that one turn. Every breach reports through Sentry. Verified functionally end-to-end against a real account with a real Claude call: real usage recorded correctly, a temporarily-lowered ceiling produced the real block + confirm button, and clicking it produced a real, successful, grounded Genesis response.
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
   run locally against the real production `DATABASE_URL`. **Correction, found while actually doing this for the first time:** `vercel env pull` redacts sensitive values (shows `[SENSITIVE]`) whenever it detects a non-interactive/agent context — confirmed via the CLI's own `--non-interactive` flag description ("default when agent detected"), not assumed — and `vercel exec` (previously listed here as an alternative) doesn't exist as a real subcommand in this CLI version. So this step is agent-blocked by design, not just by convention: **only a real, interactive human session can pull the real value.** Run `vercel env pull .env.production.local --environment=production` yourself, in your own terminal, or copy `DATABASE_URL` directly from the Vercel dashboard's environment variables page.
4. Only then push/merge the code that depends on the new schema.

Running migration-then-code (not the reverse) matters because they're no longer coupled to the same build — code that assumes a column exists should never deploy ahead of the column itself.

**A real consequence of this discovery**: this means an agent (me) can never fully complete step 3 unassisted — the production migration step now has two sub-parts: I can write, review, and stage the migration, but *applying* it to production genuinely requires you to run one command yourself. Not a gap to work around; this is Track 0's own migration-gate goal working as intended, one layer deeper than originally designed.

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
