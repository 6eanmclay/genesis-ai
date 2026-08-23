# Proactive J4 — milestone contract

**Status: AWAITING APPROVAL. Nothing here is implemented.**
Written 2026-08-23, after UI6 shipped. Eight-section standard, same as the
Unified Intelligence and Business Understanding contracts.

VISION.md Chapter 1 names the shift: from *"What would you like to do today?"*
to *"Here's what I noticed."* This contract is an audit of how far that already
is, and what the remaining distance actually consists of.

---

## 1. What already exists — audited, not assumed

More than the framing suggests. The engine is built and running:

| Piece | Where | State |
|---|---|---|
| Scheduled cycle per business | `lib/intelligence/cycle.ts` — `runIntelligenceCycle`, `getStoresDueForIntelligence`, `runDueIntelligenceCycles` | Live, cron-driven |
| Detectors | `lib/intelligence/insights.ts`, `changeDetection.ts`, `storefrontReadiness.ts` | Live, M1–M9 closed |
| Findings raised and resolved | `notifyFromInsights` → `GenesisObservation` | Live, lifecycle asserted |
| Beliefs about the business | `lib/intelligence/learn.ts` | Live, owner-correctable |
| One prioritised thing to do | `lib/intelligence/nextBestAction.ts` — `getNextBestAction` | Live |
| Confidence / track record | Growth Engine, Chapter 1 | Closed |
| Attention cards on Home | `AttentionCard`, nav badges | Live |

**BI_ENGINE.md M1–M9 are closed** and its open list says explicitly that it is
"recorded, not scheduled" and does not authorise new scope. This contract does
not reopen any of it.

## 2. The gap, stated precisely

**Nothing in this codebase ever writes an unprompted assistant message.**

Verified by search, not assumption: every `role: "assistant"` write is inside a
turn the owner started — `runToolTurn.ts`, `ai-actions.ts`, `proposal-actions.ts`,
the chat route. There is no path by which J4 speaks first.

So J4's proactivity today is **cards**, and cards are software. A finding
surfaces as a panel with a title and a Review link; the same finding said in the
conversation would be J4 telling its partner what it noticed. VISION's sentence
is not about computing more — the computing is done — it is about **voice and
place**. That distinction is the whole milestone.

Second, smaller gap: a finding and the conversation are unrelated records. An
owner who asks "what did you notice this week?" gets an answer assembled from
the same data, but the finding itself was never *said*, so there is nothing to
refer back to.

## 3. What this milestone would build

**P1 — J4 can speak first, into the one conversation.** A finding worth saying
becomes a real assistant `StoreMessage`, written by the cycle, carrying its
execution row like every other message (UI6's join). It appears in the
conversation the owner already has, in the business it belongs to.

**P2 — Not every finding earns a sentence.** A rule for what is worth
interrupting for, and a ceiling on how often. Without this, P1 turns a partner
into a notification feed — the exact failure `J4_APP_ROADMAP.md` §"J4 is
proactive" names ("the failure mode to guard against is presenting it like
software instead of like a partner").

**P3 — Said once, not re-said.** `notifyFromInsights` deliberately **keeps**
producing a standing finding for as long as it is true, because suppressing it
would silently retract it (BI_ENGINE.md, M4 lifecycle). A card can be re-raised
harmlessly; a sentence cannot be re-said every cycle. P1 needs its own record of
what has been spoken, distinct from what is currently true.

**P4 — The owner can answer it.** A proactive message that cannot be replied to
is a notification with better copy. Replying must continue the same conversation
with the finding as context — which the existing turn machinery already
supports, since context is assembled per turn.

## 4. Explicitly out of scope

- **Push notifications / mobile.** `J4_APP_ROADMAP.md` M4, frozen separately.
- **New detectors.** BI M1–M9 are closed; this changes where findings are said,
  not what is found.
- **Benchmark or cross-business comparison.** Deliberately out of scope in
  ARCHITECTURE.md and unchanged here.
- **Email.** Blocked on `RESEND_API_KEY` and a different surface anyway.
- **The §7 conversation-workspace pieces** — business context beside the
  conversation, navigable history. Undesigned, and named in §7 as needing their
  own decision.

## 5. Decisions I need from you

**PD1 — Where does J4 speak first?** Into the existing single conversation
(J4's own model: "there must only be ONE J4 conversation"), or a distinguishable
thread? I recommend the single conversation; a second thread is a notification
feed with extra steps.

**PD2 — What earns a sentence?** Options: (a) only `getNextBestAction`'s single
highest-confidence item; (b) any finding above a confidence threshold; (c) only
findings whose kind is on an allow-list. **I recommend (a)** — it already exists,
is already prioritised, and gives a natural ceiling of one. But this is a
product judgement about interruption, not an engineering one.

**PD3 — How often, at most?** A hard ceiling per business per period. I have no
basis to pick the number; it is a judgement about how present a partner should
be.

**PD4 — Does a proactive message ever act?** Strictly speak-only, or may it
carry a proposal the owner can approve inline? Speak-only is safer and smaller.
Carrying a proposal is more useful and inherits every guarantee UI6 just built.
I lean speak-only for the first pass, with proposals as a follow-on once the
cadence is proven tolerable.

**PD5 — Is silence acceptable?** If nothing clears the bar, J4 says nothing at
all. I believe that is correct and worth stating explicitly, because the
alternative — always finding something to say — is how this becomes noise.

## 6. How it would be verified

Deterministically, without a model, in the pattern used throughout:

- A cycle with nothing worth saying writes no message at all (PD5, asserted).
- A finding said once is not said again while it remains true (P3) — and the
  underlying observation is still *resolved* correctly when it stops being true,
  so P3 does not silently retract the M4 lifecycle behaviour.
- The ceiling holds across repeated cycles (PD3).
- A proactive message carries its execution row and renders through UI6's
  existing state vocabulary — it must never read as a completed change.
- Tenant isolation: a cycle for business A writes into A's conversation only,
  asserted against a second business, as `verify-proposals-live.ts` does.
- Capability authorization: a proactive message must not surface work the
  viewer could not have asked for.
- Negative controls on each of the above, per standing practice.

**What cannot be verified without `ANTHROPIC_API_KEY`:** whether the sentence J4
writes is *good*. The mechanism, cadence, isolation and honesty are all testable;
the copy is not. I would keep the message deterministic (assembled from the
finding, not model-generated) precisely so this milestone does not depend on a
credential — and note that as a deliberate constraint rather than a limitation.

## 7. Risks

- **Turning a partner into a feed.** The whole reason P2/P3 and PD2/PD3 exist.
- **Re-saying a standing finding.** BI's own lifecycle makes this the default
  behaviour, so P3 is not optional.
- **Writing into the wrong business.** Every proactive write is unattended, with
  no session and no active pointer — which is *safer* than the request path, but
  only if the storeId comes from the cycle. This is the exact class of defect
  found four times in the last two days.
- **Interaction with partial-turn semantics.** A proactive message is a write
  with no owner watching; `PARTIAL_TURN_SEMANTICS.md` D1/D2 do not govern it,
  and I would not want them decided implicitly here.

## 8. Sequencing

1. PD1–PD5 answered.
2. P3's spoken-record first — it is the constraint everything else must respect,
   and building it after P1 would mean shipping a feed and then throttling it.
3. P1 behind the ceiling.
4. P2's rule, tuned against real findings in the test database.
5. P4 last: replying works the moment the message is real, and confirming that
   is cheaper than designing it.

**Estimated shape:** one schema addition (a spoken record), one module, changes
to `cycle.ts`, one new verification suite. No changes to the tool architecture,
the handler registry, or the understanding layer — this consumes them.
