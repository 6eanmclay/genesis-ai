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

## The five kinds of evidence

**Proven under real concurrency.** Several PostgreSQL backends served the same
race at once — asserted by asking Postgres for its own backend pids before
trusting anything else in the suite. The job claim, the `runOnce` claim and
webhook delivery deduplication. This is the strongest category and the newest:
until 2026-08-30 the database lane ran on PGlite, which serialises concurrent
clients, so none of it could be shown at all.

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

## What the browser lane cannot do

**Measure product correctness on a tired machine, run after run.** On
2026-09-18 four consecutive full browser lanes produced 45/46, 42/46, 44/46 and
41/46 — with a DIFFERENT set of suites failing each time, and every one of
those suites passing standalone immediately afterwards.

The signature is what makes this readable rather than mysterious: **many
timeouts, zero assertion failures.** In the worst run, `grep -c TimeoutError`
found several and `grep -cE "^\s+FAIL "` found none. Not one assertion in
forty-six suites failed. Those are navigation and compile timeouts from
dev-mode Turbopack under sequential load — a statement about the machine, not
about the product.

Two contributors were identified, and both are worth ruling out before
believing a red lane:

- **A corrupt `.next`.** Every suite starts its own server, but they all share
  one build directory, so a single bad chunk cascades through the rest of the
  run. `verify-security-browser` died in 13 seconds with "Cannot find module
  require-in-the-middle-…". `rm -rf .next` changes the failure set entirely.
- **Accumulated load.** The lane gets worse the more lanes have run before it.
  Disk and memory were healthy at rest throughout (52GB free, 10.8 of 16GB), so
  this is not simple exhaustion.

**So read a lane by counting ASSERTION failures, not suite failures.** A suite
that fails on a timeout and then passes standalone is reporting on the machine.
Where a lane is unreadable, the authoritative evidence for a change is its own
suite run standalone, plus targeted sabotage proving those assertions fail when
the behaviour is removed.

Recorded when the Business Map slice (4339b04) was verified: its own suite
passed 152/152 five separate times, including once inside a lane, with three
sabotages each failing correctly, while the surrounding lane was unreadable.
The lane was NOT rewritten or weakened to produce a clean number.

### `verify-office-browser` is KNOWN FLAKY — not a product defect (2026-09-18)

**Do not treat a red `verify-office-browser` as a regression, and do not go
looking for the commit that broke it. There isn't one.** This is written down
because it was already misclassified once, on my own report, and a whole bisect
slice was opened on the strength of it.

Measured over **17 runs**, with the suite byte-identical at every point (git
blob unchanged `5763e96`..`904b915`, on-disk md5
`f070f6e163aae68e1d0a57d1c23b1701`, so no test change is involved):

| point | result |
| --- | --- |
| one run at each of `5763e96`, `4339b04`, `0e91bc6`, `b0f0010`, `92177a8` | 5 of 5 ALL PASS |
| `5763e96` — the commit whose lane read **46/46** — x6 | 5 pass / 1 fail |
| `904b915` x6 | 4 pass / 2 fail |

**14 pass, 3 fail (~18%), and it fails at BOTH ends of the range.** The 46/46
reading that made `5763e96` look like a known-good anchor was simply a run where
it happened to pass. No code boundary exists.

Two abort points, both timeouts, and — matching the signature above — **zero
assertion failures in any of the 17 runs**:

- `verify-office-browser.ts:143` (`signIn`), `Timeout 30000ms`, 0 of 90 PASSes.
- `verify-office-browser.ts:412` (`openOffice`), `Timeout 15000ms`, ~56 of 90.

**The `J4Overlay.tsx:172` hydration mismatch is a separate, standing condition
and has NO established causal link to these timeouts.** It shows up only in lane
output, because the lane runner appends the dev server's log and a standalone
run does not capture that stderr — its absence from a standalone run is not
evidence it stopped happening. `verify-creation-station-browser` logs the same
mismatch and passes 162/0. Every file in that render path — `J4Overlay.tsx`
(untouched since `b3abbf5`), `DashboardShell.tsx`, `BusinessWorkspace.tsx`,
`app/b/[slug]/layout.tsx`, `components/j4/J4Dock.tsx` — is unchanged across the
whole range, so nothing in it could have introduced the mismatch either.

Sean's decision on 2026-09-18: **do not stabilise or rewrite the suite for now.**
It is recorded as known-flaky, not fixed.
