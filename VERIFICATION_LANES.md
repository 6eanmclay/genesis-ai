# How this platform is verified, and what each lane proves

**Written 2026-08-30.** Four kinds of evidence, deliberately kept distinct.
Conflating them is how a codebase comes to believe it has tested something it
has only inspected.

| Lane | Command | What it proves |
|---|---|---|
| **Database** | `npx tsx scripts/run-db-suites.ts` | Real Postgres, real functions, no HTTP. Every rule that lives in a library. 75 suites. |
| **HTTP** | `npx tsx scripts/run-http-suites.ts` | A real `next dev` server on a real port, real routing, real request scope, real sessions. What a caller actually receives. |
| **Browser** | `npx tsx scripts/run-http-suites.ts --browser` | The same server, driven by Playwright. What a person actually sees. |
| **Source** | assertions inside suites | Only where execution is genuinely impossible, and always labelled as such. |

Both runners must go through `scripts/run-unelevated.ps1` on Windows —
PostgreSQL refuses to start under an administrator account, and that refusal is
correct.

## The four kinds of evidence

**Proven by real HTTP execution.** A request crossed a socket to a running
server and the answer was asserted. The per-store authorization boundary, the
platform-admin boundary, the public-API validation and rate limits, the
upload-token routes, the cron triggers, the PayPal return validation, Stripe
webhook signature verification, and the whole bag-to-order chain.

**Proven at the function/database layer.** The rule was exercised against a real
database by calling the real function. Everything in `lib/`, including the
retention policy, the dispute state machine, the scheduler's cadence, the
idempotency claims and the redaction rules.

**Source-asserted.** The code was read rather than run. Used only where running
it is impossible — a server action's id is build-specific, `auth()` throws
outside a request scope — and every instance says so in the suite.

**Blocked by external infrastructure.** Recorded in `EXTERNAL_BLOCKERS.md` and
never simulated. No real provider has ever signed a request here.

## Which lane a suite belongs to

Derived from its source, never from a list — `scripts/lib/suiteLanes.ts`. That
file already learned this lesson: a hand-maintained exclusion list was missing
an entry for a day, and a suite ran in the wrong lane and failed for a reason
that had nothing to do with what it tested.

- Imports `startTestServer` → the HTTP lane.
- Also imports Playwright → the browser lane.
- Calls `db.reset()`, or sets `process.env` **before** importing the server →
  its own server, because it cannot share one.
- Everything else that starts a server → the shared server.

Sharing matters: `next dev` takes most of a minute to become ready, and a runner
that started one per suite would spend longer compiling than asserting.

## What the HTTP lane cannot do

**Invoke a server action.** An action is addressed by a build-specific id in a
`Next-Action` header. Reconstructing that would couple the suite to a private
detail that changes between versions. The actions' guards are proven at the
function layer and their pages are proven over HTTP — the same guard, reached
the way a person reaches it.

**Speak to a real provider.** Every signature in every suite is generated
locally. `verify-order-webhook-live` uses Stripe's own SDK to sign, which is
stronger than a hand-rolled HMAC and still says nothing about Stripe's live
behaviour. PayPal's verification is a live API call and has never run.
