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

## What has not been validated

Classification and the employee-handbook loop. `verify-classification-live.ts`
exists and its deterministic half passes, but the live half needs a second thing
that is genuinely absent: **`CLASSIFY_FIXTURE_URL`**. `classify.ts` sends the
document to the model as a URL for the model to fetch, so a local file is not
enough — it needs a publicly reachable handbook PDF.

That harness has **never run its live half**, and says so at the top of the file
rather than implying otherwise.
