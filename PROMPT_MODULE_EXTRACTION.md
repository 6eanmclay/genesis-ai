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

## The extraction, when it is done deliberately

Move these thirteen declarations from `app/dashboard/ai-actions.ts` into a plain
module — `lib/dashboard/storeChatPrompts.ts`. The precedent already exists:
`lib/dashboard/storeChatUnified.ts` holds `STORE_CHAT_UNIFIED_SYSTEM_PROMPT` and
is imported by both the route and the routing suite.

All thirteen are pure data — Zod schemas and template literals, no functions, no
imports from `ai-actions` itself. Line numbers as of `c221352`:

| Declaration | Lines |
|---|---|
| `BrandIdentitySchema` | 155–168 |
| `HomepageContentSchema` | 180–193 |
| `StoreCoreFieldsSchema` | 276–281 |
| `StoreChatPrimarySchema` | 283–292 |
| `CALIBRATION_GUIDANCE` | 310–314 |
| `PRESENTATION_GUIDANCE` | 319–324 |
| `COMPOSITION_GUIDANCE` | 333–341 |
| `HOMEPAGE_STRUCTURE_GUIDANCE` | 346–357 |
| `BRAND_PROMISE_GUIDANCE` | 359 |
| `CONTINUATION_GUIDANCE` | 368–370 |
| `ChatControlSchema` | 1200–1208 |
| `CHAT_CONTROL_SYSTEM_PROMPT` | 1210–1246 |
| `STORE_CHAT_PRIMARY_SYSTEM_PROMPT` | 1297–1330 |

**Move them byte-exact.** These are template literals containing quotes,
backticks and em-dashes; retyping any of them changes a production prompt. Slice
by line range, do not re-author.

Each is used 2–7 times elsewhere in `ai-actions.ts`, so the move is followed by
one import and no other edit.

### Why it was not done in the same pass

It is a thirteen-block refactor of the application's largest and most critical
server-action file, arriving at the end of a long session, in service of a test
convenience rather than a product behaviour. The build defect needed a fix that
was certain; this is a change that needs care.

### Verifying it

- `npx next build` — the gate that would have caught the original defect.
- `npx tsx scripts/verify-reply-shape.ts` — asserts `LEAD WITH ONE SENTENCE.`
  appears in **both** reply prompts by count, wherever they live.
- Restore `scripts/verify-prose-shape-live.ts` from `acfdc1a`, repoint its
  imports, and re-run the 4-call measurement.

## The standing lesson

**Add `npx next build` to what gets run before calling a change done.** Not
`npm run build` — that script runs `prisma migrate deploy` against whatever
`.env` points at, which is production. `npx next build` skips that step.

A green typecheck and 41 green suites did not mean the application could be
built. Three separate gates agreed, and all three were looking somewhere else.
