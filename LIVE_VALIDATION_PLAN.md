# What a real model can tell us, and what it cannot

**2026-08-23. Scoping only — nothing built, no features.**
Sean: *"identify exactly what we can now validate with the real model: routing,
classification/handbook behavior, and whether J4's proactive responses actually
read and behave the way we intend."*

Audited against the repository. One of those three turns out not to be a model
question at all, which is worth settling before any key is spent.

## The state of live coverage

177 verification scripts. The `-live` suffix on 45 of them means **live
database**, not live model — they bring real Postgres. Exactly **13** are gated
on `ANTHROPIC_API_KEY`, and only a few bear on what Sean asked.

| Area | Harness | State |
|---|---|---|
| **Routing** | `verify-j4-routing.ts` | **Wired and waiting.** Skips loudly today |
| **Classification** | — | **None. The only real gap** |
| **Proactive reading well** | — | **Not a model question** — see below |
| Reply brevity / real streaming | `verify-brevity-and-streaming.ts` | Wired |
| Tool-calling round trip | `smoke-tool-calling.ts` | Wired |
| Prompt-cache behaviour | `smoke-unified-call-caching.ts` | Wired |
| Provider failure copy | `verify-genesis-model.ts` | Wired |
| Grounding / provenance in answers | `verify-grounded-reasoning.ts` | Deterministic half runs; live half skips |

---

## 1. Routing — ready, and it answers the question the design doc declined to

`verify-j4-routing.ts` holds **19 cases** and, for the context-sensitive ones,
classifies each **twice — with and without the business digest**. That second
run is the valuable one: it measures whether the digest actually changes what J4
reaches for, which is the central bet of the Unified Intelligence milestone and
has never been tested against a model.

**It answers:** does a model choosing among nineteen tools make more real
mistakes than the narrow classifier it replaced? `J4_UNIFIED_INTELLIGENCE.md`
raised that and explicitly declined to settle it.

**Specific things it would settle:**
- Advice stays advice — *"What makes a good hoodie design?"* must call nothing.
  Over-triggering is the failure Sean named ("don't make every question trigger
  an action").
- *"Make me a logo"* reaches `generate_brand_logo` — and, for a business that
  **already has one**, does not. That case exists because a prompt workaround
  was removed on the argument that the digest makes it unnecessary. This is the
  test of that argument.
- Whether the 19-tool surface causes confusion between neighbours
  (`create_design` vs `create_composition` vs `improve_storefront`).

**Cost:** roughly 25–30 calls. **Run first** — highest learning per call in the
repository, and it needs no new code.

---

## 2. Classification — the only genuine gap, and it gates the handbook loop

`lib/businessAssets/classify.ts` makes a real model call per uploaded asset and
has **no live coverage at all**. Nothing anywhere exercises it against a model.

That matters more than it looks, because of what shipped today. The employee
handbook ask closes when an uploaded document's `category` matches a staff-policy
label — and an upload lands as `"unclassified"` until classification fills it in.
**So classification is the step that closes the loop, and it is the one step
never tested.**

**It would answer:**
- Does a real handbook PDF classify as something the matcher recognises
  (`employee_handbook`, `employee_document`, `sop`, or a label the model
  invents)? The matcher was deliberately made broad *toward stopping*; whether
  it is broad enough is unknown.
- Does an unrelated document (an invoice, a licence) avoid matching? A false
  match silently retires an ask that should stand.
- Is `category` stable across runs for the same document? An unstable label
  means a gap that closes and reopens.

**This is the one harness worth writing**, and it can be written now: a
deterministic half (the matcher's behaviour over known labels — already covered)
plus a live half that classifies a small fixture set and reports what came back,
skipping loudly without a key, exactly like the routing suite.

**Cost when run:** one call per fixture document, single digits.

---

## 3. Proactive responses — this is not a model question

**J4's proactive messages contain no model output.** `lib/intelligence/proactive.ts`
makes no model call; the sentence is assembled from the finding's own summary,
which the detector wrote. That was a deliberate constraint so proactive J4 keeps
working when a credential does not.

So *"do they read the way we intend"* cannot be answered by an API key. It is a
**human review** question, and it is answerable **today, at zero cost**:

- The sentences are pure functions — `proactiveMessageFor`, `staffPolicyAsk`,
  and the detector summaries they wrap. They can be rendered for every finding
  type and read on a page without a database or a model.
- What is genuinely unreviewed is the **detector summaries**, which predate this
  work and were written for a card, not for J4's voice. A card says *"Revenue
  down 40%"*; J4 says it in a sentence. Whether every existing summary survives
  that change of register has never been looked at.

**What a model WOULD add here, and only here:** whether a *reply* to a proactive
message is handled well — the owner answering "why?" and J4 continuing with the
finding in context. That is routing plus conversation, and the routing suite
already covers the mechanism.

**Recommendation:** review the proactive copy now, without waiting. It costs
nothing and it is the part most likely to be wrong, because it is the part
nobody has read end to end.

---

## The order I would run them in

1. **Routing** — wired, highest value, settles a documented open question.
2. **Proactive copy review** — free, needs no key, and probably finds the most.
3. **Classification** — after the harness exists; closes the handbook loop.
4. `smoke-tool-calling`, `smoke-unified-call-caching` — confirm the round trip
   and cache behaviour still hold on the current model.
5. `verify-brevity-and-streaming` — whether the data answer stays short.

## What a key will not tell us

- Whether the deterministic surface is correct. 40 suites already answer that.
- Whether proactive delivery, D3, D4 or partial turns behave — all model-free by
  construction, and that was the point.
- Whether provider integrations work — Printful and Stripe are separate
  credentials and separate blockers.

## The honest summary

Only **one** of the three areas Sean named needs a key and lacks a harness:
classification. Routing needs the key but is already written. Proactive reading
well needs neither — it needs somebody to read it, which we can do now.
