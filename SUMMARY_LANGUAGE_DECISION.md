# The detector summaries — a compliance defect, not an open decision

**Status: READY TO IMPLEMENT ON ONE WORD. Nothing changed yet.** 2026-08-23.

Sean approved sentence-shaped summaries everywhere and asked that the decision be
made explicitly first, because it touches the product language contract. Checking
that contract changed what the decision is.

## Correction first

I told him this sat on "a surface `GENESIS_LANGUAGE.md` and the Experience
Principles both govern." **`GENESIS_LANGUAGE.md` does not exist** — the only file
in the repository that mentioned it was my own review. The Genesis Language is a
five-state model in `lib/dashboard/genesisState.ts` and governs states, not
summary text. That citation was wrong and it mattered, because it framed this as
touching a contract nobody had read.

## What actually governs it

`GENESIS_EXPERIENCE_PRINCIPLES.md` — frozen, Constitution-level, and the first
principle listed under *Genesis's voice*:

> **1. Spoken, not logged.** Every piece of Genesis-sourced content is a real
> sentence in Genesis's own voice — never raw system/log language, never bare
> unexplained data.

Measured against that:

| Summary | Compliant? |
|---|---|
| `3 invoices are now overdue, totaling £4,180` | Yes |
| `Appointment cancellations doubled this week (8 vs 3 the week before)` | Borderline — sentence, trailing bare data |
| `Revenue down 40% this week (£1,240 vs £2,070 last week)` | **No.** Not a sentence; ends in bare data |
| `Email open rate up 18% this week (44% vs a 26% recent average)` | **No.** Same |
| Connection gaps, staff-policy ask | Yes |

**Two detectors have been violating a frozen principle since they were written.**
Nobody noticed because the summaries only ever appeared on cards, where a label
reads as a label. Proactive J4 made them speak, and speaking is what exposed it.

## What this does to the three options

- **(a) Sentence-shaped everywhere** — the only compliant option, and the one
  Sean chose independently.
- **(b) Two fields, a label and a spoken form** — **not available.** The
  principle says *every piece* of Genesis-sourced content, which includes the
  card. A label field would be sanctioned non-compliance.
- **(c) Leave it** — **not available.** It is the current state and the current
  state is the defect.

So there is no product decision left to make. There is a frozen principle, two
lines that breach it, and a fix.

## Exactly what would change

Two `summary:` strings in `lib/intelligence/insights.ts`:

```
Revenue down 40% this week (£1,240 vs £2,070 last week)
→ Revenue is down 40% this week — £1,240, against £2,070 last week.

Email open rate up 18% this week (44% vs a 26% recent average)
→ Your email open rate is up 18% this week — 44%, against a 26% average.
```

The appointment line is a real sentence already; its bracket would follow the
same em-dash shape for consistency, which is polish rather than compliance.

**Blast radius:** every surface reading these summaries — the attention cards,
the "Genesis noticed" panels, the nav badge source text, the Discovery feed, and
now J4's own sentences. All of them get a real sentence instead of a label, which
is what principle 1 asks for on every one of them.

**Not touched:** the five-state vocabulary, any card's structure or density, and
every summary already compliant.

## The separable change, unchanged

Dropping the generic opener for statement-shaped findings — as it is already
dropped for questions — remains independent of all of the above, needs no
decision about card text, and is two lines in `proactiveMessageFor`. Sean has
already approved it.

## Verification

- The two rewritten summaries render as sentences: an assertion that each
  detector's summary starts with a capital, ends with a full stop, and contains
  a finite verb, applied to every insight the detectors can produce.
- That assertion generalises: it is principle 1 made checkable, so a future
  detector written as a label fails at the suite instead of on a card.
- Negative control: reverting either string fails it.
- The existing insight suites cover what the detectors *detect*; none of this
  changes detection.

**Size:** small. **Credentials:** none. **Depends on:** nothing.
