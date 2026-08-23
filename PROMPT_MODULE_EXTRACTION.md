# Moving the chat prompts out of the "use server" module

**Status: NAMED, NOT DONE.** 2026-08-23. Written because it was scoped out
deliberately, not forgotten.

## What happened

`app/dashboard/ai-actions.ts` begins with `"use server"`. Next compiles such a
module into a set of server actions, and **a non-function export is a build
error**:

```
A "use server" file can only export async functions, found object.
Failed to collect page data for /api/generate-store-draft
```

On 2026-08-23 I exported four declarations from it — two prompts and two Zod
schemas — so that `scripts/verify-prose-shape-live.ts` could import the real
prompts and measure what the model does with them.

**That broke `next build` for two commits.** It was not caught because:

- `tsc --noEmit` was clean. This is not a type error.
- All 41 shared suites passed, plus the standalone ones.
- The live measurement itself ran and produced correct, useful results.

The build was the only gate that could catch it, and it was the one gate not
being run. It surfaced only when Sean asked for build, lint and typecheck
explicitly.

## What was done instead

The four exports were reverted (`const`, not `export const`), which restores the
build with certainty and no risk. The rule is now written at the top of
`ai-actions.ts`, where somebody about to repeat it will read it.

`scripts/verify-prose-shape-live.ts` was deleted, because a harness that cannot
typecheck is worse than none. **It is preserved in git at `acfdc1a`** and can be
restored verbatim once the extraction below lands.

## What the measurement proved before it was blocked

Recorded so no one thinks the acceptance was hand-waved. UI6 piece 3, measured
live on both reply paths, 8/8:

| live path, sweeping change | sentences | characters | areas named |
|---|---|---|---|
| before | 4 | 718 | 9 |
| after | 2 | 358 | 1 |

That evidence stands. What is blocked is **re-running** it.

## The boundary, measured 2026-08-23

**A correction first.** An earlier version of this document listed thirteen
declarations with line ranges. **Those ranges were wrong** — they came from a
scan that matched the first line ending in `;` or `}`, which lands inside a
nested object rather than at the end of a declaration. Anyone slicing by them
would have cut production prompts in half. They are replaced below with ranges
from a bracket- and template-literal-aware scan, and the lesson is the obvious
one: a number in a document is a claim, and this one was never checked.

### The real closure

Starting from the four declarations the harness needs and following every
reference transitively:

**15 declarations, 190 lines, zero function or runtime references.** All of it is
Zod schemas and template literals. Line numbers as of `14711ff`:

| Declaration | Lines | |
|---|---|---|
| `ThemeSchema` | 122–147 | 26 |
| `BrandIdentitySchema` | 171–184 | 14 |
| `FaqItemSchema` | 186–189 | 4 |
| `HomepageContentSchema` | 196–209 | 14 |
| `StoreCoreFieldsSchema` | 292–297 | 6 |
| `StoreChatPrimarySchema` | 299–308 | 10 |
| `CALIBRATION_GUIDANCE` | 326–330 | 5 |
| `PRESENTATION_GUIDANCE` | 335–340 | 6 |
| `COMPOSITION_GUIDANCE` | 349–357 | 9 |
| `HOMEPAGE_STRUCTURE_GUIDANCE` | 362–373 | 12 |
| `BRAND_PROMISE_GUIDANCE` | 375 | 1 |
| `CONTINUATION_GUIDANCE` | 384–386 | 3 |
| `ChatControlSchema` | 1216–1224 | 9 |
| `CHAT_CONTROL_SYSTEM_PROMPT` | 1226–1262 | 37 |
| `STORE_CHAT_PRIMARY_SYSTEM_PROMPT` | 1313–1346 | 34 |

**Move them byte-exact.** These template literals contain quotes, backticks and
em-dashes; retyping one changes a production prompt. Slice by range, never
re-author.

### Why the closure cannot be smaller

The obvious economy is to move the two prompts and their six guidance constants
(107 lines) and leave the four schemas behind, letting the harness declare a
minimal `{ reply }` output shape.

**That would break the measurement.** The defect piece 3 fixed was J4 narrating
every change it had made — a reply produced while generating a full content
object. A model asked only for a `reply`, with no content to generate, has
nothing to narrate, so the regression would not reproduce and the harness would
pass on a prompt that had regressed. The schemas are part of the condition being
measured, not scaffolding around it.

### Against Sean's six criteria

| Criterion | |
|---|---|
| Preserves the `"use server"` contract | **Yes** — it is the fix for the violation, not a way around it |
| Production action API unchanged | **Yes** — none of the fifteen is a server action, and none is referenced outside `ai-actions.ts` except by two suites that read source text |
| Prompts/schemas testable | **Yes** — a plain module can export them |
| No duplicated production definitions | **Yes** — declarations move; nothing is copied |
| No new abstraction for one test | **Judgement.** `lib/dashboard/storeChatUnified.ts` already holds a prompt imported by both `lib/execution/toolHandlers.ts` and `scripts/verify-brevity-and-streaming.ts`. This applies that existing pattern rather than inventing one |
| Clean build path | **Yes** — `npx next build` is the acceptance test |

### The proposed boundary

`lib/dashboard/storeChatPrompts.ts` — a sibling to `storeChatUnified.ts`, not an
addition to it. That file holds the *unified router* prompt; these are the draft
and live *content* prompts, a different concern that happens to share a
neighbourhood.

`ai-actions.ts` gains one import and loses 190 lines.

### One thing this would also relieve, and is NOT scope

`lib/execution/genesisActions.ts:260` carries a hand-synced copy of
`ThemeSchema`/`CompositionSchema`, with a comment saying so, because those
schemas are currently unreachable from `lib/`. Moving them makes that mirror
resolvable — **but consolidating it is a separate decision** about the two sides
of the approval gate, and is deliberately not bundled here.

## The standing lesson

**Add `npx next build` to what gets run before calling a change done.** Not
`npm run build` — that script runs `prisma migrate deploy` against whatever
`.env` points at, which is production. `npx next build` skips that step.

A green typecheck and 41 green suites did not mean the application could be
built. Three separate gates agreed, and all three were looking somewhere else.
