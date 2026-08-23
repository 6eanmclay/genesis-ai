# Checkpoint — where Genesis actually stands

**2026-08-23.** Replaces the earlier version, which was written when live
validation was believed blocked. It was not.

## The roadmap, corrected against the repository

Sean's sequence, with what the repo actually says:

| # | Milestone | State |
|---|---|---|
| 1 | Live-model validation + fixes | **Partly done.** Routing validated; classification blocked |
| 2 | J4's Understanding of Your Business | **SHIPPED** — U1–U6, `d19254f..f80f4dd` |
| 3 | Business Intelligence Engine | **CLOSED** — M1–M9, `BI_ENGINE.md` §15 |
| 4 | UI6 | **Partly shipped.** Three parked pieces need a contract |
| 5 | Teaching / Challenge | Needs a design pass |
| 6 | Belief Constitution + channel | Constitution decision, not engineering |
| 7 | Integrations / operating layer / Growth Points | Not started |
| 8 | Final hardening and launch readiness | Not started |

**2 and 3 are done.** They are recorded here so they stop being rediscovered as
future work.

## Live validation — what happened

**The key was never missing.** It has been in `.env` throughout;
`verify-j4-routing.ts` never imported `dotenv/config`, printed "is not set", and
I relayed that as an external blocker for days. One import fixed it. Accepting a
script's own skip message as fact about the environment is the same class of
error as a green test that never entered its window.

**Routing: 48/50, and the central bet is confirmed.** Ten cases where the
business digest changed the decision, correct every time. The decisive one:
*"Make me a logo"* goes to `generate_brand_logo` blind and, with the digest, J4
answers instead — because the business already has one. That is precisely the
job the removed prompt workaround used to do. `LIVE_ROUTING_RESULTS.md`.

**One defect, fixed with a rule after prose failed.** *"Remove the old products
and let's upload the first ring"* was answered rather than proposing the removal.
A description change was tried, measured, did not work, and was reverted. The
invariant now lives in `planToolRun`.

**Not covered, and not pretended otherwise:** the variant where the model calls
nothing at all. Forcing a tool there means inventing the arguments it needs.

## Blocked, and by what exactly

| Blocker | Blocks |
|---|---|
| **Anthropic credit balance** (new) | Any further live run. Exhausted across three runs — one baseline, two testing a hypothesis that failed |
| **`CLASSIFY_FIXTURE_URL`** | Live classification and the employee-handbook loop. `classify.ts` sends the document as a URL for the model to fetch, so a local file cannot substitute |
| `RESEND_API_KEY` | Owner notifications |
| M2 | Sean's, untouched |

`verify-classification-live.ts` is written, its deterministic half passes, and
its live half **has never run** — stated at the top of the file.

## Deterministic state

**41/41 database suites.** No known defect. Everything shipped this session is
model-free by construction, so none of it is waiting on credit.

## Next

1. Credit, then re-run routing to exercise the policy-refusal display.
2. `CLASSIFY_FIXTURE_URL`, then classification and the handbook loop.
3. **UI6 contract** for the three parked pieces — business context beside the
   conversation, navigable history, concise-summary replies. Contract first, no
   implementation until approved.

Nothing else starts. The empty backlog is the signal to establish the next real
milestone, not to invent one.
