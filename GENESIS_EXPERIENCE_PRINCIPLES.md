# The Genesis Experience Principles

**Status: FROZEN.** Adopted with the same weight and permanence as the J4 Constitution — every future UI/UX decision (new page, redesign, or review of an existing screen) gets checked against these before implementation, the same way every J4-related code change gets checked against the Constitution's three tests. Principles 1–6 were adopted 2026-07-31; principles 7–9 were added 2026-08-06/07. This document was overdue — the original six lived only in memory for over a week, with writing them down explicitly flagged and left unresolved until now.

---

## The governing lens

**J4 should always feel like a business partner, not a chatbot.** Added 2026-08-07, sitting above all nine principles below, not alongside them — this is the lens every one of them is an instance of, and the question to return to whenever a new principle is proposed or a new feature is evaluated: does this reinforce the feeling of working *with* a trusted partner, or does it read as chatting with an AI?

The shape this takes, stated directly:

- **Chat is for execution.** Concise, direct, gets work done.
- **Meetings are for collaboration and decision-making.** Where strategy, planning, and preserved decisions live.
- **Background work happens while the owner keeps working.** J4 doesn't block the owner's day to do its own.
- **J4 acknowledges work immediately, communicates progress naturally, and organizes everything** — the concrete mechanics of principles 7–9 below — **in a way that feels like a real working relationship, not a request/response tool.**

Every principle that follows is a specific, checkable instance of this one. When a new situation doesn't map cleanly onto any of the nine, this is the question that decides it.

---

## How the original six were derived

Discovered through a live, evidence-grounded process, not reasoned about in the abstract: a real Playwright-driven visual audit of the actual running product (a seeded disposable store, a real `runCognitiveReview()` pass for authentic AI-authored content, real screenshots across Home, Website, Products, Customers, Analytics, and the public storefront), followed by two rounds of collaborative abstraction.

The audit surfaced a finding no amount of reading component code in isolation would have: Genesis's atmospheric "environment" chrome (the Domicile, the Live Intelligence header, the Genesis Language legend) persists across every page — what breaks is entirely inside each page's own content area, which falls back to generic admin styling. The sharpest single proof: Analytics's own activity feed once read *"Communicated a opportunity finding: 'Your existing customers are remarkably loyal...'"* — the exact same underlying finding Discovery showed as a real, warm sentence, just with the framing stripped off. Same content, two completely different feelings — proof the gap was about *voice*, not color palette.

That led to the **Fundamental Owner Questions** framework — what an owner arrives silently asking (*Is everything okay? What changed? What deserves my attention? What decisions need me? Let me work on something.*) — and the qualities that must be true for those answers to be trusted: **credibility**, **perceived intelligence** (does this feel like it's genuinely thinking about *my* business, not generic SaaS polish), and **calm**. Comprehension is deliberately not a fourth quality on the same spectrum — it's a binary gate, checked per screen.

---

## The nine principles

### Genesis's voice

**1. Spoken, not logged.** Every piece of Genesis-sourced content is a real sentence in Genesis's own voice — never raw system/log language, never bare unexplained data.

**2. Genesis speaks with intent.** Genesis speaks only when it has something that genuinely reduces the owner's uncertainty. An honest "nothing significant right now" is a complete, calm answer — not an empty state filled with filler commentary. (Proven in production: Discovery's own empty state, *"I didn't find anything significant today. Your business appears to be on track."*)

### Genesis's understanding

**3. Understanding travels with the information.** Whether it's a customer, order, product, invoice, campaign, employee, goal, or metric — whatever Genesis genuinely understands about a thing travels with that thing wherever it appears, never siloed in a separate report or simply absent.

### Genesis's relationship to work

**4. Handed, not assembled.** The owner reviews and adjusts something Genesis already prepared. They are never handed a blank form and asked to build it themselves — the same "owner expresses intent, Genesis performs the mechanics" root claim, checked against literal CRUD screens, not just approval flows.

### Genesis's structure

**5. Visual weight matches the question.** A screen's density and prominence match which fundamental owner question it answers and that question's real cognitive cost — glance, skim, read, decide, or do.

**6. One visual system, everywhere.** The same typography, color tokens (the Genesis Language), spacing, and component language apply on every page. Any appearance of plain default browser/framework styling is a signal a page fell *outside* the system, not evidence the system doesn't apply there.

### Genesis's presence during work

Added 2026-08-06/07, discovered the same way as the original six — a real, live dogfooding pass surfaced the gap (a multi-minute onboarding wait with no progress indication; a raw execution-log sentence sitting in the Activity Feed), not an abstract design exercise.

**7. Acknowledge immediately, then work visibly.** The moment the owner does something that starts real work — uploads files, asks for something that takes time, kicks off a generation — J4 confirms receipt immediately, states what it's doing, and reports when it's done, even if the work itself continues in the background. The gap this closes, concretely:

> Instead of nothing for 30 seconds, then a result — *"Got them. I'm organizing 20 files now,"* then, a few seconds later, *"I've identified 12 product photos, 5 brand assets, and 3 documents. I'll start learning from them while you continue working."*

This applies everywhere real work happens — uploads, onboarding generation, image generation, report generation, and Meetings — not just the one surface that first exposed the gap.

**8. Progress is felt, not just present.** Anytime J4 is doing something that could take more than a few seconds, the owner should always know three things: that the request was received, what's currently happening, and when it's finished. An exact percentage isn't required — a real, honest sense of *"something is genuinely happening and here's what"* is. The owner should never be left wondering if Genesis is frozen. **Never fake progress** (already established for the onboarding journey specifically — see `GENESIS_EXPERIENCE.md` principle 2) generalizes here into the positive form: pacing communicates real state, not manufactured suspense, on every surface, not just onboarding.

**9. The Activity Feed speaks business language, not execution language.** A raw internal-system sentence is never acceptable where the owner will read it. The Activity Feed reads like a timeline of what J4 has been accomplishing *for the owner* — outcomes and next steps in plain business terms, never bare technical/execution phrasing. Concretely:

| Don't | Do |
|---|---|
| "This would need more Growth Points than you currently have to invest." | "J4 prepared your SEO update, but publishing it requires 1 additional Growth Point." |
| (a bare execution-log line) | "Your logo draft is ready for review." |

This is the same violation principle 1 (*spoken, not logged*) already named for Genesis's own generated content — this principle extends it explicitly to system/execution-log surfaces like the Activity Feed, which aren't Genesis-authored copy but still reach the owner's eyes and must earn the same voice.

---

## How to apply

Start with the governing lens — does this feel like a business partner, or a chatbot — then check against all nine below. Principles 7–9 apply product-wide, not to whichever feature happened to surface them first — the next time work takes real time anywhere in the product (Meetings' own background work being the next likely case), these three are the bar it's held to from the start, not a retrofit after the fact.
