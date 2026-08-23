# Asking for a missing document — decisions only

**Status: DECIDED AND BUILT (2026-08-23).** `858ab7a`, `d72350c`.

- **AD1 — employee handbook.** Built. Evidence is active employees on record; the ask carries its own justification, speaks once, and withdraws when satisfied or when the team goes.
- **AD2 — deferred.** No further document asks until an uploaded document becomes structured, actionable memory. Nothing generalises: there is no document registry and no per-document configuration, so a second document is a decision rather than a config entry.
- **AD3 — moot for now.** With one ask there is nothing to queue behind anything.

**The honest boundary, found by tracing rather than assuming:** an upload lands `category: "unclassified"` and is categorised later, so classification — which needs a model — is what closes the gap. Without one the ask stays open, and is never repeated. An ask left standing is a much smaller failure than an ask repeated.

---

*Original decision request follows.*

Deliberately short. J4_IDENTITY.md already freezes the principle, the governing
test, and the example sentences; the machinery to ask and to be heard now exists
in two working instances. The only thing missing is a product judgement I should
not make alone.

## What already works, so you can see what "one more" costs

| Ask | Evidence that triggers it | Where it reaches the owner |
|---|---|---|
| Connect an integration | Real revenue with no accounting system; real customers with no email platform; an appointment business with no calendar | Connections page **and** the conversation (2026-08-23) |
| What a supplier charges | A product blocked on unknown unit economics, with a real supplier to ask | Attention card and the turn context |

Both are deterministic, evidence-gated, and speak once. A document ask would use
the same path: evidence → `GenesisObservation` → Proactive J4 says it once →
closes when the gap closes.

## The governing test, already frozen

> "A real, specific reason already in evidence, never a category of information
> that's generically nice to have."

Every decision below is an application of that test. If a candidate cannot pass
it, it should not be built.

## The decisions

**AD1 — Which documents, if any?** Each needs evidence the system actually holds
today. My reading of what is available:

| Document | Evidence that could justify asking | Available now? |
|---|---|---|
| Employee handbook | The business has recorded employees | **Yes** — `employee` is a real entity type |
| Lease / premises | ? | **No** — nothing records whether the business has premises |
| Inventory count | Products with no stock tracking | Partly — needs checking against real fields |

Only the first clearly passes the test with evidence that exists. Picking any of
them is yours.

**AD2 — What happens to the answer?** An uploaded document becomes a
`BusinessRecord` asset with a summary. J4_FOUNDATION.md §4 already names the
real limit: *"If an uploaded lease says it expires in December, that's understood
as a sentence in `Asset.summary` — not a date J4 holds anywhere it could act on
weeks later."* So an ask can be answered and still not make J4 more useful later.

- **(a)** Ask anyway — the summary is genuinely useful in conversation now.
- **(b)** Do not ask until the answer becomes structured, actionable memory.

I lean (a) and think (b) is the better long-term milestone, but asking for
something J4 then half-forgets is a real cost and the judgement is yours.

**AD3 — How many document asks may stand at once?** Proactive J4 already speaks
one finding per cycle, and an unanswered ask stays open until it is satisfied.
Several standing document asks would queue behind each other indefinitely, which
is the questionnaire the principle exists to prevent — arriving slowly instead of
all at once.

- **(a)** One document ask outstanding per business, ever.
- **(b)** No special limit; the existing one-per-cycle cadence is enough.

## What I am not asking

Nothing about mechanism, wording, cadence, storage or verification — all of that
is settled by existing frozen documents and shipped code. If AD1 names one
document and AD2/AD3 are answered, this is a small build with no further
decisions in it.
