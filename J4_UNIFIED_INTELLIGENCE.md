# J4 Unified Intelligence — one mind, real tools, one understanding

**Status: v3, 2026-08-22 — LARGELY IMPLEMENTED. This document was wrong for two weeks and is corrected below.**

Read the correction first, because everything under it was written against a system that no longer exists. v2 described a chain of five classifiers ahead of a generation call and said "design only, not yet implemented". Phases 1 and most of 2 shipped in the interim, and the audit that opened the Unified Intelligence milestone (2026-08-22) found the document describing an architecture two migrations old.

A design document that describes a system two migrations ago is worse than none: it is the thing somebody reads before changing the code.

## What actually runs today (2026-08-22)

Measured from the code, per message type, on the live streaming route
(`app/api/chat/route.ts`). The "six sequential calls before a reply" below was
true when it was written and is now true of no path.

| A message that… | Model calls | What each contributes |
|---|---|---|
| is ordinary conversation | 1 | The unified call, which streams the reply itself |
| states a goal or challenge | 1 | Unified; the capture is deterministic after it |
| asks a data question | 2 | Unified picks `look_up_business_data`, then the answer is generated |
| asks for a campaign, image change or product rewrite | 2 | Unified, then that capability's own generation |
| asks for a logo or a design | 2–3 | Unified, then direction and image generation |
| **edits store content** | 2–4 | Unified → the legacy Server Action, which runs primary and optionally secondary and composition. **The one real surviving chain.** |

One tool-enabled call with **nineteen** registered tools does the deciding.
`callGenesisModel` passes `tools`/`tool_choice` through untouched, exactly as
this document predicted it would.

### What the Unified Intelligence milestone changed (2026-08-22)

The audit found that the six-call problem was largely solved and a different,
more consequential one was not: **the call that decides what J4 does was the
only one that never learned anything about the business.**

`getBusinessUnderstanding` was fetched INSIDE the `look_up_business_data`
branch — after the tool had already been chosen — so the deciding call saw the
message, the active product NAMES, and nothing else. J4 picked blind and
discovered the business afterwards.

The prompts showed the strain, which is how it was found rather than guessed at.
`generate_brand_logo`'s description had to say "this tool reads their real
business understanding itself, so do NOT call `look_up_business_data` first" — a
workaround for having nothing at decision time — and "if the merchant already
has a logo, do NOT call this", an instruction the model had **no data to obey**.

Six things changed:

1. **Authorization moved onto the capability.** `store:manage` was checked ahead
   of the unified call, so it refused the CONVERSATION rather than the
   capability: a member with `genesis:chat` and without `store:manage` was
   declined for everything, including "what was my revenue last week", with copy
   saying "only the store owner can change". Each tool now declares what it
   takes (`lib/execution/toolPolicy.ts`), checked after selection and before any
   handler runs. Three read-only tools moved to `genesis:chat`; every mutating
   tool still requires exactly `store:manage`.

2. **The last pre-call became a tool.** Upload-intent ran on every single
   message as a full round trip, and existed there for a permission-ordering
   reason rather than a reasoning one. With the gate moved it is
   `show_upload_options`. Deliberately not a regex: the prompt it replaced had
   to tell "I have a PDF for you" from "the photo on my homepage looks bad" from
   "remove the old products and let's upload the first ring", where uploading is
   real but is not the whole message.

3. **The deciding call now knows the business.** A compact digest
   (`lib/businessModel/digest.ts`) — identity, what is sold, WHICH ASSET ROLES
   ARE HELD, goals and challenges, what is recorded as standing in the way of
   what, connected systems, current beliefs with maturity, dated commitments,
   and how many facts record where they came from. A pure projection of the
   canonical `BusinessUnderstanding`, capped in every dimension, with its
   rendered size asserted by a suite. Both prompt workarounds above are gone.

4. **One turn assembler.** The streaming route and the Server Action each built
   the context themselves and had already diverged — the route told J4 about a
   proposal on the table and the Server Action did not, so the same push-back
   refined an existing idea on one path and started a fresh one on the other.
   `lib/dashboard/chatTurnContext.ts` is now the only place a context line is
   written, and the suite asserts neither path adds one itself.

5. **Nothing the model asks for vanishes.** `firstToolUse` returned the first
   `tool_use` block and discarded the rest, silently. Both paths now read every
   tool and plan what runs under two rules — a cap, and at most one mutation per
   turn. A two-action message still executes one action, deliberately, but J4
   says so instead of leaving the owner believing both happened.

6. **The routing suite became a gate.** `scripts/verify-j4-routing.ts` runs a
   deterministic half on every ordinary run — every case names a real tool, the
   prompt describes the input it is given, every fixture renders — and skips the
   live half loudly when there is no `ANTHROPIC_API_KEY`. It now sends what the
   product sends, including the digest, and for context-sensitive cases it
   classifies twice, with and without, so the question below can finally be
   answered with evidence.

### What the audit found afterwards (2026-08-23)

Three defects, none of them present before this milestone, all three made by
two changes that were each correct on their own.

**An authorization hole, and the most serious thing found here.** UI2 moved the
permission check off the conversation and onto the capability, asked after the
model picks a tool. UI5 stopped a turn discarding everything the model asked for
after the first tool. Together, the check ran on the head of the planned list
and the whole list ran. "What sold worst last month? Get rid of it" plans a read
and then a mutation; the read is allowed for an employee with `genesis:chat`,
that was the only thing asked, and `request_product_removal` proposed a deletion
behind it. `firstRefusedTool` now asks about every planned tool — and returns
the first REFUSED one, not the first requested one, because naming the read
would tell an employee their question was declined. The whole turn is refused
rather than the offending tool skipped: running half of what somebody asked for
is a decision nobody has made. The check is repeated inside `runPlannedTools`,
where every tool actually executes, so a third caller written later cannot
execute anything.

**The Server Action planned every tool and ran one.** Its own comment claimed it
applied "the same plan the streaming route applies". It read every tool, planned
every tool, took `plan.run[0]` and discarded the rest — which are absent from
`plan.dropped` precisely because policy ALLOWED them, so nothing said they had
gone. The silence UI5 exists to end, surviving on one path while the other
reported it.

**J4 declined something the merchant had not said yet.** The route says what it
is not doing before it does the work — correctly — but does not write the
merchant's own message until it knows the turn resolved locally, so persisting
the notice when it was spoken filed it first. Scrolling back showed the refusal
above the message it answers. It travels with the turn now.

**Three more, found by continuing to look after the first three were fixed.**

*The answer arrived before the thing asked for first.* Every handler runs before
any reply is emitted, so a handler that streams puts its words on the wire during
execution while earlier tools' replies still wait for the loop that emits them.
"Take me to orders, and what sold worst last month" is a plan policy allows, and
it put the answer first — while the stored conversation had them the other way
round. Only the first tool is given the delta sink now.

*J4 said it was taking you somewhere you never arrived.* Two `take_me_there`
calls are two reads, so neither the cap nor the one-mutation rule stopped them:
the route emitted two navigations, the client pushed both, the last won, and the
first reply had already named the other place. A turn ends in one place now, and
the second is dropped with its own reason — the pacing copy would have read as
an excuse for something that was never about pacing.

*The reply was honest and the log said SUCCESS.* `approve_pending_changes`
executes approved changes against a live store, and every return omitted
`outcome`, so a run where nothing applied was recorded as a success that could
not be retried while telling the owner it had failed. Then the same sweep found
fourteen more turns declaring failure and logging SUCCESS, because `outcome` and
`executionStatus` were defaulted independently. Both fixed; the sweep is now
section 9 of the suite rather than a script that ran once.

The pattern in all six is worth naming: **each was two correct features
meeting.** None would have been caught by reviewing either change alone, and the
ones that mattered were found by asking what a rule ASSUMES rather than whether
it runs — every one of them was a rule that held for one of something and
quietly stopped holding when that something acquired a plural.

### What is still open

- **The legacy content chain** (`STORE_CHAT_PRIMARY` → `CHAT_SECONDARY` →
  `CHAT_COMPOSITION`) still runs for `edit_store_content`. It retires only when
  the tool path is shown to cover the same ground as well or better, which needs
  a real model and real conversations. Not deleted prematurely.
- **The dispatch is extracted — all nineteen, and shared (2026-08-23).** It was
  a long `if` ladder in a 2,215-line route file, duplicated in a second 5,968-line
  one. Every tool is now a handler in `lib/execution/toolHandlers.ts` that
  RETURNS what it did instead of writing messages, emitting and closing the
  stream itself, and both chat paths run them through one runner
  (`lib/dashboard/runToolTurn.ts`). The route is 651 lines with zero inline
  branches; ten duplicated branches left the Server Action.

  The reason to migrate them one at a time was not caution for its own sake:
  **the only way to reach a branch was through a model, so nineteen capabilities
  had no test of any kind** — including `approve_pending_changes`, which
  executes approved changes to a live store, and `request_product_removal`,
  which proposes irreversible deletions. Each branch that moved gained real
  coverage on the way, and that is what the migration was actually buying:
  `scripts/verify-tool-handlers.ts` is 243 assertions where there were none.

  What the tests pinned, none of it hypothetical: an approval that throws must
  say the changes are still pending rather than claiming success; a proposed
  deletion is logged PENDING, deletes nothing, and supersedes its own stale
  proposal; an unresolved product name proposes nothing and asks, naming what
  exists rather than guessing; J4 must never say one place and navigate to
  another; an answer about supplier economics uses the outcome's words, never
  the model's; and the merchant's own message is written exactly once however
  many tools ran — which was fine while only one could and silently wrong the
  moment two did.

  **The sharing is the point, not the tidying.** The Server Action had branches
  for eleven of the nineteen; the other eight matched nothing there and fell
  through to the legacy content pipeline, so asking for a logo on that path ran
  a full store-content regeneration and reported it as the answer. That gap was
  declared first (`SERVER_ACTION_TOOLS`, so it was named rather than silent) and
  is now gone along with the list itself — see ARCHITECTURE.md on deleting a
  mirror rather than guarding it forever. Two live drifts closed with it: the
  route told J4 about a proposal on the table where the Server Action did not,
  and a clarifying question that had already failed once escalated to a numbered
  list on one path and repeated itself forever on the other.

  What is deliberately NOT shared is how a turn RESPONDS — one streams tokens
  and closes a controller, the other revalidates and redirects. Collapsing those
  would be a worse abstraction than the duplication it replaced.

  **The last fall-through is closed too.** A handler that resolves to no work
  used to continue into the content pipeline below it, which is the original
  defect with a different trigger: the owner shown another capability's result
  as though it were the answer. `edit_store_content` is the single exception,
  because that pipeline IS its implementation.

- **Tool results do not return to the model.** A `tool_use` is a routing signal
  today, not a call whose result feeds the next turn of reasoning. That is the
  architecture that would let a read genuinely inform an action in one pass; the
  digest removes most of the need for it, and it remains the honest end state.
- **The interface work in §7 is a separate milestone** (Sean, 2026-08-22). The
  argument for bundling it was written when this was one large migration; most
  of that migration shipped without it, which is the evidence they are separable.

---

## UI6 — what shipped (2026-08-23)

The conversation view existed before this milestone: `/j4` is a real route,
`J4Surface` resolves its business from the slug, and the floating panel was
already deprecated. So UI6 was not the rebuild §7 anticipated — most of that had
happened. What was left was the part §7 could not have named, because it only
became true once the tool architecture landed:

- **The conversation is the business boundary.** The proposal card renders
  inside a conversation that knows its business; the decisions inside it went on
  resolving one for themselves. All three now take it from the conversation, and
  no action in that file reads the account's active pointer.
- **The conversation shows what happened, not what J4 said happened.**
  `StoreMessage.executionLogId` joins a message to the execution row written in
  the same breath, and `lib/j4/messageState.ts` derives six states from that row
  alone — never from the prose. A reply reading "Done. I applied all 3 changes
  and verified them." over a row saying WARNING renders as didn't-go-through.
  The rule needing most care: a tool that PROPOSES and reports SUCCESS proposed
  successfully; the change has not happened, and reading that as "done" is the
  precise claim the whole preceding milestone existed to make impossible.

**Still open from §7, and each needs a decision rather than an implementation:**

- **Business context alongside the conversation** — §7 itself calls this
  undesigned ("a real decision for whenever this phase actually starts").
- **Conversation history as navigable** — there is no threading model;
  `StoreMessage` has no conversation id. A design question, not a build.
- **Concise-summary replies** — contracted concretely, and blocked as a unit.
  The render half (making the checklist primary) is buildable; the prompt half
  (shortening `content` to one lead sentence) needs a model to verify. Doing the
  render half alone produces a worse interface than today: a primary checklist
  under paragraphs of prose. They are one design and should ship together.

## The interface work — SPLIT OUT into its own milestone (2026-08-22)

Sean's decision, taken with the Unified Intelligence contract: **this does not ride along with
the architecture work.** The argument for bundling it was written when this was one large
migration; most of that migration has since shipped without it, which is itself the evidence
they are separable. None of what follows depends on the tool-calling architecture, and none of
it was needed to finish it. It is a real design milestone and deserves its own contract.

Kept here in full because the reasoning is good and the north star at the end of it is still
the north star.

## 7. The interface should change with the architecture, not separately from it

Sean's explicit call: the dedicated full-screen conversation view (replacing the floating chat panel) is **part of this migration, not a separate later UI redesign.** The reasoning is architectural, not cosmetic — a floating Q&A widget was the right shape when J4 only answered questions; it stops being the right shape once J4 is one continuous intelligence collaborating on branding, strategy, content, products, and marketing in the same conversation. The interface should reflect what the system actually is, not lag behind it.

Three concrete pieces of this, all scoped as real near-term work once performance is fixed:

- **A dedicated conversation view, replacing what tapping J4 opens — not the launcher itself.** The small button stays exactly as it is: ambient, available everywhere, what makes J4 feel accessible rather than tucked away. What changes is only what happens on tap — instead of an overlay unfurling in place on top of the dashboard, it's a real transition into a dedicated workspace (compact header, the conversation taking nearly the full screen, input docked at the bottom), closed to return to the dashboard exactly where it was left. Real cost, not just layout: today's panel is a global overlay (`GenesisAssistant.tsx`, mounted once in `DashboardShell.tsx`) with open/closed state kept locally. A dedicated view means a real route, back-navigation, and retargeting every place that currently opens the panel via `?openChat=1` (see `redirectKeepingChatOpen`, added 2026-08-07 for the chat-panel-collapse fix) to navigate there instead. Sean's own reasoning for the timing, sharpened by a real bug the same day: the floating panel isn't just visually cramped, it structurally competes with the dashboard for scroll and touch on mobile — the safe-area overlap bug found and fixed 2026-08-07 (`GenesisAssistant.tsx`'s `bottom-20` not accounting for `env(safe-area-inset-bottom)`) is a real, concrete instance of the overlay model's own ceiling, not just an argument for preferring the new one. Sean's framing for the moment itself: tapping J4 should read as entering a meeting with a business partner, not opening a panel.
- **Business context alongside the conversation**, collapsible — the workspace, not just a bigger chat window. What's on screen (a homepage draft, a chart, a product) should be able to sit next to the conversation, not require leaving it. Undesigned here: whether this is context J4 proactively surfaces per the topic (closer to the "pull the business into the room" mechanic from `MEETINGS_ARCHITECTURE.md` §7) or something the owner opens deliberately — a real decision for whenever this phase actually starts.
- **Conversation history as a first-class, navigable thing** — the first real move toward the "working memory of the business" north star below, not the whole of it. At minimum: past conversations are findable and resumable, not just today's thread. The fuller mechanism (linking a past conversation to the real changes it produced) stays real future work, per that north star's own note.
- **Concise-summary replies**: lead with one sentence and a grouped checklist, expandable per item — not several paragraphs of prose. This is *not* new infrastructure: `GenesisAssistant.tsx` already renders a `<details>`/`<summary>` "See what changed" list from a real `changes: string[]` field the model already returns (line ~535-556). Today it's a secondary afterthought below the full prose reply; the change is making it the primary structure and shortening `content` to a single lead sentence. Deliberately sequenced alongside the tool-calling migration rather than before or after it — both are decisions about what shape J4's reply actually takes, and should be designed once, not twice.

**Why this belongs in the Unified Intelligence migration specifically, not general UX polish**: a dedicated conversation view is also the natural home for what today lives only as deferred, out-of-scope ideas — voice, true Meetings, document review, other collaborative workflows (see `MEETINGS_ARCHITECTURE.md` §7-8). Building the floating-panel-replacement now, shaped correctly, means those capabilities have a real place to land later without a second interface rebuild. This isn't scope creep into building those things now — it's building the one thing (the conversation surface) so it doesn't have to be redesigned twice.

**North star, not yet designed (Sean, 2026-08-07):** a conversation shouldn't just be a transcript that disappears into chat logs — over time it becomes the working memory of the business. The owner should be able to return to a past conversation, continue it, review what was decided, and see how it actually turned into real changes. Recorded here deliberately without a design attached — it reinforces why the conversation surface is worth building carefully now (§7 above), but the actual mechanism (how a past conversation is found, resumed, and linked to the real changes it produced) is real future work, not something to design ahead of need.


# Historical — the v2 design, kept for its reasoning

Everything below describes the system **before** the migration and is preserved because the
reasoning is still the reasoning. Read it as why the current architecture looks the way it
does, never as a description of what runs.

## Why this happened (worth naming honestly, not just fixing)

Each classifier was added at a real moment when a real new capability needed a safe, narrow trigger condition — upload detection, then data questions (Phase 3 M1), then business-fact capture (Phase 3 M5), then campaigns, then image requests. Each one is well-built in isolation: a tight schema, an honest fallback if the call fails, "own small call, own schema, doesn't touch the main pipeline" by explicit design (see that phrase in the code's own comments). That's a *safe* way to bolt one more capability onto a single-shot generation call. It just doesn't scale — every new capability adds one more sequential gate, and the tax is paid by every message, not just the ones that need that capability.

## The target: one reasoning pass, real tools

Sean's framing is the right one: J4 should decide *within* one reasoning pass whether it needs to read data, edit the site, call an integration, analyze a document, or just answer — the same way a person doesn't consciously run five checklist items before deciding how to respond to a question. The mechanism for that already exists and doesn't need to be invented: Claude's native tool use. One call, given the full set of things J4 can currently do as real `tools`, decides for itself which (if any) to invoke, in `tool_use` blocks, potentially several in the same turn.

This is not "one bigger prompt." A single unstructured prompt trying to do classification *and* generation *without* tool use is genuinely worse — it risks the model guessing at an answer instead of actually fetching real data, exactly the failure mode Sean and I already agreed to avoid. The fix is real tool-calling, not prompt consolidation.

## What already maps cleanly — this is buildable, not a rewrite

Three real pieces of existing architecture turn out to already be shaped almost exactly like the pieces a tool-calling migration needs. This is the strongest evidence this is a real, scoped migration rather than a ground-up redesign:

- **`callGenesisModel`** (`lib/genesisModel.ts`) is a fully generic wrapper: `Params extends Parameters<typeof anthropic.messages.stream>[0]`. It already passes through *any* valid Anthropic SDK params untouched — `tools`, `tool_choice`, none of it is blocked or unsupported. Cost governance (the daily token ceiling), error classification, and `AiUsageEvent` recording all operate on the response, not the request shape — **zero changes needed here** for tool-calling to work.
- **`GENESIS_ACTIONS`** (`lib/execution/genesisActions.ts`) already has almost exactly the shape of a tool registry: `inputSchema` (a real Zod schema — trivially convertible to a JSON Schema for a tool definition), `executable` (the handler), `authorizationTier`/`maxAuthorityTier` (whether this executes immediately or waits for the owner's approval), `category` (content/operations/integration/communication/money/destructive, each with its own hard trust ceiling). This entire trust framework is orthogonal to *how* the model decided to invoke the action — it governs what happens *after* a tool call resolves, and needs no redesign.
- **`Executable.run(input, ctx)`** (`lib/execution/executable.ts`) is already precisely "the function a tool handler calls": typed input, typed context, returns a result or throws. Every one of the 14 registered executables today (`updateSeo`, `updateHero`, `createProduct`, ...) can become a real tool's handler with no change to the executable itself.

The read-only side has the same shape waiting to be used: `buildChatDataContext(storeId)` and `getBusinessUnderstanding(storeId)` are already the right inputs for a `look_up_business_data` tool — they just need to be reachable *as a tool call* instead of gated behind the data-question classifier's own separate branch.

## What has to change

- The nine-plus separate system prompts collapse into one system prompt describing J4 once, with a `tools` array covering every registered `GENESIS_ACTIONS` entry, a data-lookup tool, an upload/asset-classification handoff, a campaign-planning tool, an image-request tool, and a "capture a new business fact" tool.
- The approval-vs-auto-execute decision currently happens *after* a structured-output call returns a proposed action. In a tool-calling model it happens when handling each `tool_use` block instead — same decision (`authorizationTier`), different trigger point. This must stay a hard, code-enforced gate, never something the model narrates its way past — matching the standing rule that Genesis never reports a change that didn't actually happen.
- Multiple tool calls in one turn become possible and, per Sean's own description, *desirable* — "read data AND propose an edit" in one pass is closer to what a real business partner does than today's mutually-exclusive branches. This needs a real policy for how many tool round-trips one turn is allowed before it must resolve, so a trigger-happy model can't turn "one reasoning pass" into a *worse* latency chain than today's bounded, predictable one.

## A phased migration, not a rewrite (phases 1 and 2 are done — see the correction at the top)

Sean was explicit: fix today's performance problem first, don't derail it into rebuilding everything at once. This scopes into independently shippable phases:

1. **Prove it on the read-only path first.** Collapse the data-question, business-fact, campaign-request, and image-request classifiers into one tool-enabled call with `look_up_business_data`, `capture_business_fact`, `plan_campaign`, and `request_image_change` tools. This alone turns the common case — a question, or a simple factual statement — from 2-4 calls into 1, with no change yet to the higher-stakes content-editing path.
2. **Migrate `GENESIS_ACTIONS` into real tools**, one action at a time, reusing `inputSchema`/`executable`/`authorizationTier` completely unchanged. `update_seo` (already the one action trusted to `auto`) is the natural first candidate.
3. **Retire the old multi-call content pipeline** (`CHAT_CONTROL`/`CHAT_CONTENT`/`CHAT_SECONDARY`/`CHAT_COMPOSITION`) once the tool-based path covers the same ground with equal or better quality, verified against real conversations, not assumed.

## Extensibility — why "just another tool" is already true today, not aspirational

Sean's requirement is that every future capability — integrations, analytics, documents, email, accounting, CRM, social media, business intelligence, recommendations — becomes another tool J4 reaches for, never a new pipeline invented per capability. Checking this against the real code, rather than assuming it: **this is already the architecture's actual design principle for one whole category of capability, integrations, not a new idea being proposed here.**

`lib/execution/adapters/integrationExecutable.ts` composes any `IntegrationConnector` (Stripe, QuickBooks, Mailchimp, Google Calendar today) into the exact same `Executable` interface a content edit like `update_hero` implements — `connectExecutable`/`verifyExecutable`/`syncExecutable`, three thin adapters, zero special-casing per provider beyond a display name and an action-id lookup. The registry's own comment states the intent explicitly: *"any Executable becomes approvable by Genesis just by being registered here, with zero changes to the Executable itself... one more entry here plus one new Executable — no changes to this shape, the approval UI, or the execution engine."* That sentence was written before this document existed, for a different reason (Phase 6's autonomy ladder) — but it's the same promise Sean is asking for now, already kept once.

What this means for each capability on Sean's list, checked against what's real today rather than assumed:

- **Integrations (CRM, social media, accounting, future providers)** — already solved. A new provider is a new `IntegrationConnector` implementation; it inherits a real tool for free the moment `GENESIS_ACTIONS`-style registration is extended to wrap it, with no new pipeline.
- **Documents / assets** — `lib/businessAssets/` already treats a photo or PDF as a first-class entity (`asset` in `ENTITY_REGISTRY`, per `J4_FOUNDATION.md` §3), classified via its own `classifyAndExtractAsset`. This becomes a tool the same way: "process an uploaded file" is already one well-defined operation, not a chain.
- **Analytics, business intelligence, recommendations** — these are not separate capabilities needing their own access path; they already read from the same `getBusinessUnderstanding()` object that chat's data-answer path uses (`J4_FOUNDATION.md`'s whole point: "one J4, not a shallower one for conversation"). A `look_up_business_data` tool serves all three today, and should keep serving all three rather than growing a parallel BI-specific lookup.
- **Email / communication** — `lib/email/sendEmail.ts` (built 2026-08-07 for password reset) is a real, generic send capability with no `Executable` wrapper yet. This is the one item on Sean's list without an existing adapter — a real, small piece of future work (a `communicate` category action, almost certainly `always_ask` given it's customer-facing), not evidence against the pattern.

The design principle to hold onto: **one path in — `Executable` — regardless of whether the capability behind it is a database read, a Prisma write, an external API call, or a file classification.** A future capability should never need to ask "how does J4 learn to do this new thing"; it should only ever need to ask "what does this one new `Executable` do," with the tool-calling layer, the approval framework, and the trust-tier system all inherited automatically, unchanged. That's what keeps Genesis's internal complexity able to grow without the owner-facing experience getting any more complicated — Sean's own framing: the experience gets simpler as the system gets more capable, not the reverse.

## Open questions — with what is now known (2026-08-22)

Three of the four below are still open and one is answerable today. **Worst-case latency**: a
turn that reads then acts is at minimum two model turns and always will be; what changed is
that the digest usually removes the need for the read, because the deciding call no longer has
to look the business up before acting. **Context size**: the fixed cost is the system prompt
plus the tool catalog, both under `cache_control`; the digest adds a capped amount on top and
removing the upload pre-call took a whole round trip off every message. **Tool-selection
reliability** and **where exactly the authorization gate sits** are answered in part —
the gate is now on the individual tool, checked after selection and before any handler — and
the reliability question needs `ANTHROPIC_API_KEY` and the routing suite above.

The original wording follows.


- **Tool-selection reliability at scale.** A narrow classifier with one job rarely picks the wrong branch. Does a model choosing among 15+ tools in one pass make more real mistakes? This needs actual evaluation against real conversation transcripts, not an assumption in either direction.
- **Worst-case latency.** "One call" doesn't mean "one round trip" the moment a tool is actually invoked — a call that reads data then edits the site is still at minimum two model turns. The honest comparison is against today's *actual* chain length per real message type, not against an idealized single-shot number.
- **Context size vs. speed.** Today's classifiers are deliberately narrow and fast (low effort, small prompts) specifically to stay cheap on the common case. A unified call carries the full tool catalog and more context on every turn, including the simplest ones — this needs to be measured, not assumed to be net faster by default just because it's fewer round trips.
- **Where exactly the authorization gate sits in a multi-tool-call turn**, and how a turn that calls both a read-only tool and a content-editing tool is reported back to the owner — needs a concrete design once phase 1 is real and observable.
