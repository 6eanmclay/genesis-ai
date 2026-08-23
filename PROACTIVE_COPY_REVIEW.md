# What J4 actually says — read end to end

**2026-08-23. A review, not a change.** Zero cost, no key, no database — the
proactive sentences are pure functions, so they can simply be rendered and read.
`LIVE_VALIDATION_PLAN.md` predicted this was where the most would be wrong. It
was.

## The output, verbatim

```
[insights: revenue]
  Something needs your attention. Revenue down 40% this week (£1,240 vs £2,070 last week)

[insights: revenue]
  I noticed something worth a look. Revenue up 32% this week (£2,730 vs £2,070 last week)

[insights: email]
  I noticed something worth a look. Email open rate up 18% this week (44% vs a 26% recent average)

[insights: invoices]
  Something needs your attention. 3 invoices are now overdue, totaling £4,180

[insights: appointments]
  Something needs your attention. Appointment cancellations doubled this week (8 vs 3 the week before)

[connection gap]
  I noticed something worth a look. £2,400 in real revenue on record with no
  accounting system connected yet — connecting QuickBooks would let me help you
  understand your real numbers.

[staff policy ask]
  You've got 3 people on your team and I don't have anything about how you
  actually run things — would you like to upload your employee handbook so I can
  understand your policies?
```

## The finding, in one sentence

**The detector summaries are card labels, and J4 is speaking them as sentences.**

*"Revenue down 40% this week (£1,240 vs £2,070 last week)"* is a perfectly good
label under a heading. As something a partner says out loud it has no verb —
"Revenue **is** down" — and it ends in a data readout in brackets. A dashboard
wrote that. J4 would say *"Revenue is down 40% this week — £1,240, against
£2,070 last week."*

This is structural, not a typo. The summaries predate proactive J4 by months and
were written for a surface that does not speak.

## Graded honestly

| Line | Reads as a sentence? |
|---|---|
| `3 invoices are now overdue, totaling £4,180` | **Yes.** Already a sentence |
| `Appointment cancellations doubled this week (…)` | Nearly — the bracket is clunky |
| `Revenue down 40% this week (…)` | **No.** No verb, ends in a readout |
| `Email open rate up 18% this week (…)` | **No.** Same shape |
| Connection gaps | **Yes** — but the opener in front of them is wrong (below) |
| Staff policy ask | **Yes** — written for this, and it shows |

## Three specific problems

**1. Missing verbs in the trend summaries.** "Revenue down", "Email open rate
up". Two of the five insight detectors.

**2. The generic opener earns nothing in front of an already-complete sentence.**
*"I noticed something worth a look. £2,400 in real revenue on record…"* — the
opener says nothing, and then the sentence starts with a number. The ask-shaped
findings already skip the opener (a question introduces itself); these are
statement-shaped and complete, and would read better without it too.

**3. Every opportunity opens identically.** An owner seeing *"I noticed something
worth a look"* on Monday, Wednesday and Friday learns to skip the first six
words. Urgent has the same problem with *"Something needs your attention."*

Also minor: *"on record"* is system vocabulary. An owner has customers, not
customers on record.

## Why I have not fixed it

**The summary is deliberately shared** between the card and the sentence, so one
finding cannot be described two ways. Rewriting it for J4's voice **changes the
cards too** — every "Genesis noticed" panel, every attention card, the nav
badges' source text.

That is a product decision about what the card language becomes, not a copy
tidy-up, and it touches a surface `GENESIS_LANGUAGE.md` and the Experience
Principles both govern. Making it unilaterally is exactly what I would be wrong
to do.

## The decision, small and specific

**Do the detector summaries become sentence-shaped everywhere — cards included —
or do the two surfaces get separate text?**

- **(a) Sentence-shaped everywhere.** One summary, now a real sentence. Cards
  read slightly longer; nothing can drift. My preference.
- **(b) Two fields — a label and a spoken form.** Cards keep their density, J4
  gets prose. Costs a second field on every detector and a mirrored-registry
  invariant to keep them saying the same thing.
- **(c) Leave it.** The three sentences that already read well carry it, and the
  two that do not are trend lines the owner sees often.

Separately and independently: **drop the generic opener** for statement-shaped
findings as it was already dropped for questions. That one needs no decision
about card text and is a two-line change — I have left it alone only because it
is copy, and copy is yours.

## What this cost

Nothing. No key, no database, no model. The most useful half-hour of validation
available today was reading our own output.
