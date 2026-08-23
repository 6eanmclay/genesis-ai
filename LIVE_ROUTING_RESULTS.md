# Live routing validation — the first real-model evidence

**2026-08-23. Run against the real model. 48/50 routed correctly.**

## First: the key was never missing

`ANTHROPIC_API_KEY` has been in `.env` throughout. `verify-j4-routing.ts` never
imported `dotenv/config`, so it read an empty `process.env`, printed *"is not
set"*, and skipped — and I relayed that as an external blocker across several
days of work.

**I accepted a script's own skip message as fact about the environment instead of
checking the environment.** That is the same class of error as a green test that
never entered its window: the output said something true about itself and false
about the world. One line — `import "dotenv/config"` — and the whole live half
runs.

Worth noting what it cost: a real validation was described as blocked, and
several decisions were argued partly on the grounds that it was unavailable.
None of those decisions turn out to be wrong, but they were made with a false
constraint in play.

## The central bet: confirmed

`J4_UNIFIED_INTELLIGENCE.md`'s architectural claim was that giving the model the
business digest *before* it picks a tool makes prompt workarounds unnecessary.
That was argued, not tested. It is now tested.

**Ten cases where the digest changed the decision — and it was right every time.**

```
"Make me a logo."              blind → generate_brand_logo
                          with digest → answers instead   (business already has one)

"What's holding up the         blind → look_up_business_data
 second workshop?"        with digest → answers directly  (it already knows)
```

The logo case is the decisive one. A prompt workaround used to say *"if the
merchant already has a logo, do NOT call this"* — an instruction the model had no
data to obey. It was removed on the argument that the digest makes it
unnecessary. **The digest does exactly that job**, across all five screens.

The second case is a bonus nobody claimed: the digest removes a whole model call
when the answer is already in context.

## The one real defect, and a fix that did not work

```
"Remove the old products and let's upload the first ring."
  expected: request_product_removal
  got:      (a conversational answer)
```

The comment on that case states the stakes exactly: *"uploading is mentioned but
the real instruction is a removal — answering this as an upload message silently
drops it."* A destructive instruction the owner gave, silently dropped.

`show_upload_options`'s description already warns against this exact phrase from
its own side, and the model correctly does **not** call it. The failure is
under-triggering removal, not over-triggering upload.

**Attempted fix, and its honest result.** I added the mirror warning to
`request_product_removal` — that a compound message still counts. Re-ran live:
**still 48/50**, and the Studio variant moved from an answer to
`show_upload_options`, which that tool's description explicitly forbids. The
change did not fix it and may have made one variant worse.

**Reverted.** A prompt change that does not do what it claims is not worth
keeping because it sounded right.

## What that failure actually tells us

The model is not confused about which tool. It is deciding that a compound
instruction is conversational. Two descriptions both discussing the same phrase
did not resolve it, which suggests description text is the wrong lever.

Options, none taken, each a real decision:

- **Policy, not prompt.** A compound message containing a destructive verb could
  be required to produce the destructive tool, enforced in `planToolRun` rather
  than asked for in prose.
- **Split the turn.** The multi-tool machinery already exists — this could be a
  removal plus an upload prompt, which is arguably what the owner asked for.
- **Accept it.** J4 answers, the owner repeats themselves, nothing is destroyed.
  The current behaviour is safe, just not good.

The first is closest to how everything else in this codebase resolved: when prose
could not be relied on, a rule was.

## The turn level, measured 2026-08-23

The runs above measure MODEL CHOICE. What an owner experiences is the turn, and
those are different measurements. Two calls, `verify-refusal-turn-live.ts`, real
model choice fed straight into the real `planToolRun` call.

| phrase | model chose | policy ran | owner hears |
|---|---|---|---|
| "Remove the old products and let's upload the first ring." | `request_product_removal` | `request_product_removal` | — nothing dropped |
| "I want to upload photos of the first ring — and get rid of the old products." | `request_product_removal` | `request_product_removal` | — nothing dropped |

**The `removal_not_upload` rule is unexercised.** It is correct, it is
deterministically tested, and no real model choice measured here reaches it —
the model picks the removal tool on its own, both orderings, so policy has
nothing to refuse. It is a guard against a mistake J4 is not currently making.
That is a fine thing for a guard to be, but it should not be described as
working behaviour: nothing here is evidence an owner has ever seen its sentence.

**A caveat on the first row, which is the fixture case recorded above as the one
remaining routing defect.** It routed correctly here. Do not read that as fixed.
This harness sends a one-line business description where `verify-j4-routing.ts`
sends a full `UnderstandingDigest`, so the two are not comparable inputs and the
difference may be the input rather than the model. Re-running the routing suite
is what would settle it, and that costs ~55 calls.

### What the turn level did expose

The measurement was worth its two calls for a reason unrelated to routing: it
sent me to read the display path, and the display path was broken. A refusal
that dropped the ONLY requested tool was suppressed in both callers, and on the
Server Action path it fell through to regenerating store content. Fixed in
`1e52963`; the reasoning is in that commit.

Worth stating plainly, because it is the pattern of the whole day: the rule was
right, the copy was right, the unit test was green, and the owner would have
heard nothing.

## What has not been validated

Classification and the employee-handbook loop. `verify-classification-live.ts`
exists and its deterministic half passes, but the live half needs a second thing
that is genuinely absent: **`CLASSIFY_FIXTURE_URL`**. `classify.ts` sends the
document to the model as a URL for the model to fetch, so a local file is not
enough — it needs a publicly reachable handbook PDF.

That harness has **never run its live half**, and says so at the top of the file
rather than implying otherwise.
