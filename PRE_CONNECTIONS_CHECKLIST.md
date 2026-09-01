# Pre-Connections completion checklist

**One authoritative inventory, 2026-08-25.** Built by reading the repository,
the milestone records, `COMPLIANCE.md`'s external-blocker list, and the recorded
follow-ups — not from the roadmap. Every item names its evidence.

Connections does not start until section 1 is empty.

**Section 1 is now empty — all four closed 2026-08-25. See §6.**

---

## 1. Must finish now

Work that is entirely mine — no credential, no decision, no external party.

| # | Item | Evidence | State |
|---|---|---|---|
| **M1** | **Identity promotion.** 12 of 16 production stores hold all four identity fields in `blueprint.brandIdentity`; 0 hold the facts. Nothing reads the blueprint since D1-A, so J4 does not know who those businesses are for. | measured read-only 2026-08-24 | **authorised 2026-08-25** |
| **M2** | **`BusinessContext.connectedSystems.stale` is always false.** `stale: Boolean(s.syncedAgoLabel && s.lastSyncedAt === null)` — `describeSyncAge` returns a label only when `lastSyncedAt` is non-null, so the two conditions are mutually exclusive. A real `isStale` already sits on the same object and `digest.ts` uses it correctly. | `lib/businessModel/businessContext.ts:155` vs `lib/businessModel/profile.ts:189-201` | **defect, mine, undeployed** |
| **M3** | **A dead connector never asks for attention.** `getIntegrationIssues` filters on `status: { in: ["NEEDS_ATTENTION", "FAILED"] }`. QuickBooks reads `CONNECTED` with **14 consecutive sync failures, last synced 2026-08-01**; Google Calendar reads `CONNECTED` with **11 failures, last synced 2026-08-06**. Neither raises anything. The owner is never told. | `lib/dashboard/needsAttention.ts:105-116`; production rows | **defect, closable without credentials** |
| **M4** | **Two documents contradict production.** `DEPLOYMENT.md:70` says the build "no longer runs `prisma migrate deploy`"; yesterday's build log shows `node scripts/migrate-deploy.mjs && next build`. And `BI_PRODUCTION_READINESS.md` frames `FAILED` + `syncFailureCount: 0` as suspicious when the two fields measure different things by design. | Vercel build log 2026-08-25T01:32Z; `package.json` | **CLOSED 2026-09-01.** `DEPLOYMENT.md` already carried a correction banner with the build log; `ARCHITECTURE.md` did not, and contradicted *itself* — line 195 said the build runs migrations, line 784 said it does not. The false half is corrected. |

---

## 2. Requires Sean's action or a credential

Marked **USER ACTION REQUIRED**. None of it blocks anything in section 1, and no
amount of engineering closes any of it.

| # | Item | Consequence today | What unblocks it |
|---|---|---|---|
| **U1** | **`RESEND_API_KEY` absent** | customers are never told an order shipped; password reset cannot send; the Marketing send milestone stays paused | a Resend account + verified sending domain |
| **U2** | **QuickBooks re-consent** | dead since 2026-08-01; a retired refresh token can only be replaced by fresh consent | only the account holder can re-authorize |
| **U3** | **Google Calendar OAuth app unpublished** | Google expires every refresh token after 7 days while the consent screen is in *Testing* | publish the app, then reconnect |
| **U4** | **Six Stripe connections carry live/test key mismatches** | those stores' Stripe verification fails; `lastError` names the specific account each time | reconnect each store with the correct-mode key, or remove the stale connection |
| **U5** | **Mailchimp / Facebook / Instagram / TikTok client credentials absent** | nobody can newly connect them (existing key-based Mailchimp connections are unaffected and syncing) | register the apps |
| **U6** | **EasyPost account verification** | live shipping labels blocked; per-store architecture finished behind it | EasyPost support ticket |
| **U7** | **Migration gate — a decision, not a task** | every push to `master` migrates production with no review step | Sean decides whether to reinstate it |
| **U8** | **Live end-to-end payment test** | deliberately not run | Sean's call |

---

## 3. Intentionally deferred

Recorded so nobody treats them as gaps to close. **This list does not authorise
work.**

| # | Item | Why deferred |
|---|---|---|
| **D1** | **`learn` produces 1 belief across 16 stores** | `BI_ENGINE.md` Defect 2 — all three detectors filter on `topicKey: { not: null }` and chat-originated proposals leave it null. Deferred to M2. Not a prerequisite for Connections. |
| **D2** | **No production shipping-cost data** | 0 of 5 orders carry `shippingCostInCents`, so `planNetOfPostage` returns `null` platform-wide. **Blocked by the absence of real orders carrying a shipping cost.** Cannot be resolved from existing data and must not be manufactured. |
| **D3** | **`document_gap:staff_policy` has never fired** | the stage runs; no store has met the evidence bar. Correct silence, not a defect. |
| **D4** | **Printful live-API check** | externally blocked; `check-printful-economics-live.ts` is the legitimate read-only path. Not to be worked around. |
| **D5** | **UI6 Piece 1 (context pane)** | contracted, not authorised to build. Depends on Piece 2, which shipped. |
| **D6** | **Social connections (FB/IG/TikTok)** | built then paused 2026-08-09, deferred to P2. |
| **D7** | **AD2 / AD3 document asks** | AD1 shipped; AD2 deferred until an uploaded document becomes structured memory; AD3 moot with one ask. |
| **D8** | **Business-in-the-URL route migration** | 28 screens; blocks the business switcher, not correctness. |
| **D9** | **Deployed-route check via `CRON_SECRET`** | **closed by events** — the cron has now actually executed and was verified from the database. No remaining requirement. |

---

## 4. Already complete

| Item | Evidence |
|---|---|
| BI Engine M1–M9 | `BI_ENGINE.md` §15, closed at `66078f1` |
| BI production-readiness + deployment | `BI_PRODUCTION_READINESS.md` §§9–12; deployed `892f67b`; first cron run 2026-08-25 06:03 UTC verified |
| One Canonical Understanding | `7c4ae04` |
| Business Fact Lifecycle | `2b4f631` |
| Verification Hardening | `e1c5dc0` |
| J4 Business Understanding (D1-A, D2–D5) | committed `02503e4`, **not yet deployed** — M1 is its remaining step |
| Unified Intelligence — 19 tools across both chat paths | `8619431..fff2dc7` |
| UI6 Pieces 2 and 3 | `UI6_REMAINING_CONTRACT.md` |
| Proactive J4 | `e5fda18`, verified in production 2026-08-25 (8 deliveries/day) |
| Partial-turn D1–D4, PD4 | `NEXT_MILESTONES_AUDIT.md` — approved backlog empty |

---

## 5. Production risk register

| Risk | Severity | Status |
|---|---|---|
| 12 stores have no identity facts and nothing reads the blueprint | **high** — J4 does not know who they are for | M1 closes it |
| A connector dead for 3+ weeks presents as healthy | **medium** — the owner is never prompted to reconnect | M3 closes the *noticing*; U2/U3 close the reconnection |
| Every push migrates production unreviewed | **medium** | U7, Sean's decision |
| No transactional email | **medium** — reaches real customers | U1 |
| Margin arithmetic has never had production input | **low** — returns `null` honestly | D2, blocked |


---

## 6. Section 1, closed — 2026-08-25

### M1 — identity promotion: APPLIED to production

Dry run first, against production, writing nothing. It matched the established
expectation exactly: **12 stores × 4 facts = 48**, `skipped, a current fact
already exists: 0`, `skipped, blank in the blueprint: 0`.

The twelve: Fernbrook Botanicals, Socks galore, Beta Test Bags, PayPal Test
Books, Loam & Ember, Adventure Threads, Wildwood Candles, Meridian Cold Brew,
Be Free, Cubit & Coil, Lumen Aquatics, Cofoundr.

The four safeguards were confirmed by their own gates *before* applying
(`verify-business-understanding-model.ts`): dry-run unless told otherwise;
writes INFERENCE never OWNER; never overwrites a current fact; does not touch
the blueprint.

**Applied: 48 written.** Read-back afterwards:

| | |
|---|---|
| fact rows of the four types | **48** |
| provenance / detail | **`INFERENCE / promoted_from_blueprint`, all 48** |
| rows claiming OWNER provenance | **0** |
| rows attributed to a person (`statedById`) | **0** |
| stores with facts | **12** |
| store×type combinations without exactly one current fact | **0** |
| stores still holding `targetAudience` in the blueprint | **12** (unchanged) |
| `readOwnerFacts` on a sample store | returns all four real values |

No OWNER provenance was fabricated. The blueprint was not modified, so the
promotion stays reversible by deleting rows carrying
`provenanceDetail: "promoted_from_blueprint"`.

**One change was required to run it safely.** `promote-brand-claims.ts` took no
env-file argument and silently used the ambient `.env` — the *dev* database —
while appearing to have run. It now takes an env file, the same way
`check-stripe-live-readiness.ts` does and for the same reason.

### M2 — `BusinessContext.connectedSystems.stale` was always false: FIXED

`Boolean(s.syncedAgoLabel && s.lastSyncedAt === null)` — `describeSyncAge`
returns a label only when `lastSyncedAt` is non-null, so the two halves are
mutually exclusive and no connector could ever be reported stale through this
seam. J4 would have described a connection dead for three weeks as though its
data were current. Now reads `s.isStale`, the signal the profile already
computes against the scheduler's own cadence and which `digest.ts` had been
using correctly all along.

Mine, introduced when the D2 seam was built, and caught here rather than in
production because nothing had ever asserted it.

### M3 — a dead connector never asked for attention: FIXED

`getIntegrationIssues` filtered on `status` alone. `status` is the last
*verification* result and nothing re-runs it on a schedule; `syncFailureCount`
is the scheduler's own counter and is the signal that keeps moving. Reading only
the first is how QuickBooks (14 consecutive failures, no sync since 2026-08-01)
and Google Calendar (11 failures, none since 2026-08-06) both presented as
healthy and never told their owner — when re-authorizing is the only thing that
fixes either.

Now: three consecutive failures raises an attention item saying what stopped,
when it last worked, and that it needs reconnecting. **Three, not one** — a
single failed sync is ordinary, the scheduler backs off and retries, and raising
it would be noise on something that fixes itself.

`scripts/verify-connection-health.ts` — 16 assertions, 5 negative controls, in
the shared runner.

### M4 — two documents contradicting production: CORRECTED

`DEPLOYMENT.md` claimed the build no longer runs `prisma migrate deploy`. The
2026-08-25 build log shows `node scripts/migrate-deploy.mjs && next build`. The
section is now marked stale with the log quoted; the procedure it describes is
kept because it is still right, only its opening claim was false.

`BI_PRODUCTION_READINESS.md` framed `FAILED` + `syncFailureCount: 0` as
suspicious. It is not — the two fields answer different questions, as above.
Corrected in place rather than deleted.

### Gates

`tsc` clean · `next build` compiled · eslint **70 problems (2 errors, 68
warnings) — identical to baseline** · shared runner **42/42** (the new suite
joined it) · deterministic standalone **66/68**, the two known baseline
failures · `verify-business-understanding-model` and
`verify-bi-production-readiness` both ALL PASS.


---

## 7. Deployed and closed — 2026-08-25

**Deployed commit: `6650011`**, from the build log rather than inferred:

    Cloning github.com/6eanmclay/genesis-ai (Branch: master, Commit: 6650011)
    91 migrations found in prisma/migrations
    No pending migrations to apply.
    ✓ Compiled successfully in 30.6s
    Build Completed in /vercel/output [1m]

Four commits went out together: the identity milestone, the connector-health
fix, and two documentation records. **28 files, no `prisma/` changes, no
storefront files.**

### The order mattered, and it was the right way round

The promotion ran **before** the deploy. That is what made this safe: yesterday
deploying `02503e4` would have left twelve stores with no identity at all,
because the code stops reading the blueprint and there was nothing else to read.
With the facts already written, the new code had something to find the moment it
went live — and during the window in between, production's old code kept reading
the blueprint, which was never touched. No gap in either direction.

### Post-deployment verification

**Identity read-back**, through `readOwnerFacts` — the path J4 itself uses:

| | |
|---|---|
| stores with all four identity facts readable | **12** |
| partial | **0** |
| stores that never had blueprint values | 4 |
| provenance after deploy | **`INFERENCE` × 48** — unchanged, nothing rewritten |

**Connector health**, against real production rows — the two connections that
had been silently dead now say so, in the owner's terms:

    RAISED  Cofoundr           [WARNING] GOOGLE_CALENDAR has not synced since 8/6/2026 — 11 attempts have failed. It needs reconnecting.
    RAISED  Cofoundr           [WARNING] QUICKBOOKS has not synced since 8/1/2026 — 14 attempts have failed. It needs reconnecting.
    RAISED  ×6                 [FAILED]  Stripe account retrieval failed: … (the provider's own message, preserved)

**8 raised, 9 healthy connections correctly silent** — Mailchimp, Printful ×4,
PayPal ×2, and the working Stripe connection all say nothing, which is the half
that would have been easy to get wrong.

### Pre-Connections milestone: CLOSED

Section 1 is empty and deployed. Everything remaining is section 2 (Sean's
credential or decision) or section 3 (deliberately deferred). Neither blocks
Connections.

**Production baseline for Connections: `6650011`.**
