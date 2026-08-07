# Business Assets & Interactive Action Cards — Architecture Proposal

**Status: PROPOSAL. Nothing in this document has been built. Written at Sean's explicit request, before any implementation, to establish the long-term foundation for how Genesis stores and reasons over business knowledge, and how dashboard recommendations become conversations.**

Date: 2026-08-06 — v2, revised after Sean's answers on consolidation, trust-tier scope, and Assets placement.

---

## 0. Three requests, one foundation

This proposal unifies:

1. **Uploads shouldn't disappear** — inline thumbnails, a browsable Business Assets home, J4 referencing old uploads without re-upload.
2. **A complete Business Assets system**, not just an Uploads tab — the long-term foundation for how Genesis stores and reasons over business knowledge, built as a **foundational service other parts of Genesis use, not a standalone destination**.
3. **Interactive Action Cards, backed by one unified Task model** — every dashboard recommendation (observation, integration issue, verification failure, insight, future automation) is the same underlying object, always clickable, always opens a real J4 conversation, always follows the same durable trust framework for what J4 may do unsupervised.

---

## 1. The most important finding: most of the trust framework you described already exists

Before designing anything new, I read `lib/execution/genesisActions.ts` and `lib/execution/genesisAutonomy.ts` in full. Genesis already has a real, live, four-part authority system — not a placeholder:

- **`AuthorizationTier`** (`always_ask` / `auto_below_limit` / `auto`) — each action type's current operating tier.
- **`GenesisActionCategory`** (`content`, `operations`, `integration`, `communication`, `money`, `destructive`) with a **hard, code-level ceiling per category** (`CATEGORY_MAX_TIER`), asserted at module load — `money` and `destructive` can *never* be delegated past `always_ask`, no matter what.
- **`maxAuthorityTier`** — per-action, independent of category, must be ≤ its category's ceiling.
- **`DelegatedAuthority`** — a real Prisma model: per-store, per-action-type, owner-granted (`AUTHORITY_MANAGE` permission, owner-only), revocable, re-verified by `execute()` at the moment of every single execution, not just checked once at grant time.

This is essentially your Auto-Execute and Always-Require-Approval tiers, already built and already wired into a real execution engine (`lib/execution/engine.ts`). **The gap isn't the mechanism — it's that only `always_ask` is actually used in practice today**, and nothing conversational reaches this engine yet (only the button-driven `NextRecommendation.tsx` approve/reject flow does).

### Mapping your 5 levels onto what's real

| Your level | Maps to | Status |
|---|---|---|
| **Inform** | `authorityExempt: true` actions (e.g. `communicate_finding`) — no `ApprovalRequest`, nothing to approve, J4 just states something | Real, already used |
| **Recommend** | `authorizationTier: "always_ask"`, no active `DelegatedAuthority` grant | Real, this is what ~every action does today |
| **Prepare** | *Not clearly distinct from Recommend today* — an `ApprovalRequest.input` is already the fully-computed proposed change, not a half-finished draft. Whether "Prepare" means something genuinely different (e.g., J4 assembles a multi-step draft — written copy, a generated image — and holds it ready across several turns before the final confirm) is a real product distinction I don't want to silently resolve. **Flagged as an open question in §5.** |
| **Auto-Execute** | `authorizationTier: "auto"` + an active `DelegatedAuthority` grant (or a category/action where the ceiling already permits `auto` with no per-action grant needed, matching how `operations` was deliberately raised to `auto` for `goal.update_status`/`challenge.resolve`) | Real mechanism, barely used |
| **Always Require Approval** | `CATEGORY_MAX_TIER` locked to `always_ask` for `money`/`destructive` — hard, code-level, no grant can ever override it | Real, already enforced |

### Resolved: trust stays action-based, not category-based

Confirmed — category ceilings (`CATEGORY_MAX_TIER`) don't change. `money`/`destructive` stay hard-locked; `content`/`communication`/`operations`/`integration` keep their existing ceilings. What changes is real, deliberate per-action policy work: going through the actual action catalog and setting genuine `authorizationTier`/`maxAuthorityTier` values per real risk (Sean's own examples: replying with an approved template, routine order updates, publishing owner-already-approved changes, product description/SEO edits → move toward `auto`; new campaigns, mass email, pricing changes, deletions, refunds, financial commitments, business-changing publishes, legal/compliance → stay `always_ask`). This is exactly what the existing `maxAuthorityTier`-per-action mechanism was already built for — no schema or engine change needed, just real values instead of every action defaulting to `always_ask`. Scoped to M3 (§6), not decided item-by-item in this document.

### Resolved: "Prepare" is a workflow shape, not a fifth rung on the trust ladder

Sean's description (J4 does substantial work across multiple turns — drafts a homepage, a product listing, a campaign, a logo — holding it in a reviewable draft state until final sign-off) clarifies something important: **Prepare isn't about who's allowed to commit — it's about *how the work gets built* before a commit decision is even reached.** A Prepare-flow task still has to end by going through one of the other four levels for its actual final commit (usually Recommend, occasionally Auto-Execute for a low-risk finalize like publishing a draft the owner already reviewed).

Concretely: `Task` gains **`draftState: Json?`** — the accumulating work-in-progress (drafted copy, a generated image reference, a partially-filled product spec), updated across multiple conversation turns rather than computed once. `Task.trustLevel = "prepare"` means the conversation stays in a drafting loop (J4 asks follow-ups, refines `draftState`, shows progress) until the owner is ready to finalize — at which point the *real* commit (writing the Product, publishing the homepage section, sending the campaign) goes through the normal `ApprovalRequest`/`execute()` path exactly as any other task would, governed by that specific action's real tier. Prepare is the drafting process; Recommend/Auto-Execute/Always-Approve still govern the actual write.

---

## 2. The unified Task model

A new `Task` model becomes the one real representation of "something for the owner (or J4) to do," replacing the presentation role of `AttentionItem`, `GenesisObservation`, and `NextBestAction` (their existing *detection* logic — the queries that notice a failure, an opportunity, a stale integration — stays; what changes is that they all write into one shared `Task` row instead of three parallel shapes).

```prisma
model Task {
  id                 String    @id @default(cuid())
  storeId            String

  // Source — where this came from, for provenance and debugging, never
  // identity. Mirrors GenesisObservation's existing recordId/entityType
  // pattern (nullable — a store-wide task like "no payment connected" has
  // no single related record).
  source             String    // "observation" | "integration" | "verification" | "insight" | "automation" | "manual" | "chat"
  sourceId           String?   // the originating ExecutionLog/StoreIntegration/etc. id, if any
  relatedRecordId    String?
  relatedEntityType  String?
  relatedAssetId     String?   // BusinessRecord (entityType: "asset") this task references, if any

  // Context — what a card shows and what J4's opening turn is built from.
  title              String
  summary            String
  context            Json      // structured "why this exists" snapshot — the real business data behind it, not a restatement

  // Action — how this connects to the real execution engine, when it does.
  actionType         String?   // a GENESIS_ACTIONS key, when this task is directly automatable
  trustLevel         String    // "inform" | "recommend" | "prepare" | "auto_execute" | "always_approve" — derived from
                                // the action's AuthorizationTier/category/DelegatedAuthority at task-creation time,
                                // never independently set (single source of truth stays genesisActions.ts)
  requiredInput      Json?     // shape of what's needed from the owner, if J4 can't complete this from context alone

  priority           String    // reuses the existing FAILED|WARNING severity scale, extended with "opportunity"
  status             String    @default("OPEN") // OPEN | IN_PROGRESS | AWAITING_INPUT | COMPLETED | DISMISSED

  // Conversation — set once a card is clicked and a real seeded turn exists.
  seedMessageId      String?   // StoreMessage.id of the opening, task-aware turn (see §3)

  completedAt        DateTime?
  dismissedAt        DateTime?
  createdAt          DateTime  @default(now())
  updatedAt          DateTime  @updatedAt

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@index([storeId, status])
}
```

This is additive — no existing table is dropped. `AttentionItem`'s and `GenesisObservation`'s real detection queries (real `ExecutionLog`/`StoreIntegration` reads, real dedup-by-key logic) keep running exactly as they do today; the change is that their *output* becomes a `Task` upsert instead of a page-local array. `NextBestAction`'s ranking-by-confidence logic becomes how competing open `Task` rows get ordered for the top-of-page single recommendation slot, not a separate parallel list.

---

## 3. Action cards → a real, persisted, task-aware conversation

Replaces `GenesisAssistant.tsx`'s current `focusedContext` prop, whose own code comment already admits it's "ephemeral... never persisted as a StoreMessage" — cosmetic, invisible to the model. Real mechanism:

1. Add `StoreMessage.taskId String?` (references `Task.id`) and `StoreMessage.assetRecordId String?` (references `BusinessRecord.id`, for §4's inline uploads). Both nullable, additive.
2. Clicking a Task card calls a new server action that writes a real assistant-authored opening `StoreMessage` (`taskId` set), stating what needs doing and why, built from the Task's own `title`/`summary`/`context` — same "never claim something false" discipline already enforced for the fixed upload-intent-classifier reply strings. Sets `Task.status = "IN_PROGRESS"` and `Task.seedMessageId`.
3. Opens the chat directly into that message. Because `taskId` is real and persisted (not a client prop), **every subsequent turn in that conversation can see it** when `applyGenesisMessageToStore` builds model context — this is what makes "J4 already understands why the task exists" true for the whole conversation, not just its first render.
4. When J4 determines it can act: dispatches through the *existing* `ApprovalRequest`/`GENESIS_ACTIONS`/`execute()` path exactly as it works today, governed by the Task's `trustLevel` (§1) — `auto_execute` with an active grant executes directly and says so; anything else surfaces the real inline Approve/Reject UI (`ApprovalsSummary`'s existing rendering) inside the conversation rather than a fabricated new confirmation pattern.
5. On completion, `execute()` already writes real state changes — the only new step is setting `Task.status = "COMPLETED"`/`completedAt` and the same `revalidatePath` call every other mutating action in `ai-actions.ts` already makes, so the dashboard reflects it on next load.

---

## 4. Business Assets — a foundational service, not a destination

Per your direction: assets power the experience everywhere rather than becoming a primary nav item. Concretely:

**Design principle, stated explicitly per Sean's direction: two views of one asset, never two copies.** The `BusinessRecord` (`entityType: "asset"`) row is the single underlying object. The conversation view and the Assets library view are both just different lenses over that same row — nothing about an asset is ever duplicated between them.

- **The upload IS the message, not an addition to it.** `StoreMessage.assetRecordId` (§3) means the user-role message *is* the thumbnail/file chip — the same bubble a typed message would occupy, not a separate system notification floating near one. This is what makes the upload feel received rather than backgrounded: the owner sees their own file sitting in the conversation exactly where their words would sit, and J4's reply appears directly beneath it — already true structurally today (`uploadBusinessAssetFromChat` writes both messages back to back in one turn), this only changes the message from plain text to a real rendered thumbnail/chip.
- **Referenced by tasks**: `Task.relatedAssetId` (§2) lets a task ("Review this invoice," "New product photo needs pricing") carry its asset directly into the seeded conversation (§3) — J4 opens already holding the relevant file, not asking the owner to re-describe or re-find it.
- **Pulled into conversation automatically, without re-upload, including multiple assets at once**: `getBusinessProfile()`'s existing `recentAssets` already covers "recently uploaded." For an older, specifically-referenced asset — including plural references like "use these three previous images" — a lightweight lookup step, mirroring the existing upload-intent classifier pattern, detects the reference and pulls the matching `BusinessRecord` row(s) (one or several) into that turn's context. A targeted classifier plus a lookup query, not a general search index.
- **Reverse-reference tracking — "where has this asset been used."** A new small join, `AssetReference` (`assetRecordId`, `context`: `"task" | "message" | "generation"`, `referencedId`, `createdAt`), written every time an asset is pulled into a task, a later conversation turn, or a generation (e.g. "build a banner using these three images"). This is what makes "see where an asset has been referenced" real rather than only showing the single original upload message — additive, small, queried only when the Assets library view renders an asset's detail.
- **Surfaced by the dashboard when relevant**: a Task card whose `relatedAssetId` is set can show a small preview inline on the card itself, using the same asset data.
- **A real "browse everything" view still exists**, per your direction, tucked into an existing management area rather than elevated to primary nav — the natural fit is a new section within **Understanding** (where J4's knowledge is already surfaced today), not a new top-level destination. Real requirements confirmed: browse, search/filter (`fileType`/`category`/date/`originalFilename`/`summary`), preview, which conversation an asset came from (`StoreMessage.assetRecordId` reverse lookup) and jump-to-it, where else it's been referenced (`AssetReference` above), and one-click reuse (attaches the existing asset to a new task/message context instead of re-uploading). All over the existing `BusinessRecord` (`entityType: "asset"`) rows — no duplication of the underlying file or its data.

---

## 5. All open design questions resolved

1. **Prepare** is a multi-turn drafting workflow (`Task.draftState`), not a fifth commit-authority level — resolved in §1.
2. **Trust stays action-based, not category-based** — category ceilings are untouched; real per-action tier-setting is scoped to M3 — resolved in §1.
3. **V1 includes at least one net-new Task detector**, not just a migration of the three existing sources — this proves the model is a real foundation, not only a refactor. Natural first candidates already exist as *plain, non-clickable links* in `BusinessJourney.tsx` today (unpublished store, no active products, no payment connected) — converting one or more of these into real Task-backed, clickable, J4-conversation-opening cards is the concrete M1 proof point, alongside genuinely new detectors Sean listed (missing business name, no logo, no hero image, incomplete product descriptions) where no detection logic exists yet at all.

---

## 6. Proposed milestone breakdown (not started — for review)

- **M1 — Task model + migration + one real net-new detector.** New `Task` table; `AttentionItem`/`GenesisObservation`/`NextBestAction` write into it instead of their own page-local shapes; existing dashboard cards render from `Task` with no visible regression. Plus at least one genuinely new Task source with no prior detection logic (e.g. missing business name, no logo) *and* at least one of `BusinessJourney.tsx`'s existing plain-link checklist items upgraded to a real Task card — proving both "new capability" and "existing capability, now real" in one milestone. Verification: today's dashboard behavior is preserved for existing items, and the new/upgraded items are real, clickable, backed by real detection queries.
- **M2 — Real card → seeded conversation.** `StoreMessage.taskId`, the seed-message mechanism (§3), cards become clickable and open a real task-aware conversation. No auto-execution yet — every task still ends in a normal conversation, same approve/reject as today.
- **M3 — Per-action trust tiering + conversational auto-execute + Prepare workflow.** Real `authorizationTier`/`maxAuthorityTier` values set per Sean's risk examples (§1) for the first real candidate actions; chat-driven completion wired into the existing `ApprovalRequest`/`execute()` path per Task's resolved trust level; `Task.draftState` and the multi-turn Prepare loop for substantial work products (homepage drafts, product listings, campaigns); dashboard auto-updates on completion.
- **M4 — Business Assets as foundational service.** `StoreMessage.assetRecordId`, the upload-as-message rendering, `Task.relatedAssetId`, `AssetReference` (reverse-reference tracking), the multi-asset lookup classifier, the Understanding-page browse/search/filter/preview/reuse surface.

Each milestone independently verifiable end-to-end on real data before the next starts, matching how every other multi-milestone initiative on this project has shipped.

---

## 7. Bulk uploads

Core requirement, not an enhancement: selecting/dropping multiple files in one action, each becoming its own real asset, understood as a batch — not N independent turns that happen to arrive close together.

**Selection & transport.** `<input type="file" multiple>` (mechanical change) driving N parallel calls to the same client-direct-to-Blob `upload()` mechanism already shipped for the single-file case (Beta 1 fix) — each file gets its own token from `/api/blob/business-asset-upload` and PUTs directly to Blob, so N files transfer in parallel rather than serially, and one file's failure doesn't block or fail the others (`Promise.allSettled`, not `Promise.all`).

**Conversation shape.** One grouped message per batch (`📦 Uploaded 27 files`), expandable to the individual items, each item showing real per-file status (uploading → succeeded/failed) as it resolves — not a single message that waits for the slowest file. Requires `StoreMessage` to reference multiple assets: either a `batchId` shared across N individual `assetRecordId` messages (grouped visually, real independent rows — consistent with "every message is a real row," no new join needed), or a single message with an `assetRecordIds: string[]` in a structured field. Leaning toward the shared-`batchId` approach — keeps each asset's own message independently reference-able (§4's `AssetReference`/reverse-lookup still works per-asset) rather than needing to unpack an array everywhere that logic runs.

**Batch understanding, not N isolated classifications.** `classifyAndExtractAsset` today runs once per asset with no awareness of siblings uploaded in the same action. A real batch call should classify the group together — a real product-catalog dump (18 photos) should organize as one coherent set with shared context ("these are likely the same product line"), not 18 independent "I can see a photo, not sure what it is" replies. Concretely: a new batch-level classification pass that receives the whole batch's file list + types, produces the group breakdown (Product Photos / Brand Assets / Business Documents / etc.) J4 states in its one reply, then per-asset classification still runs (§8 covers making that fast), but the *reply* synthesizes the batch, not N separate paragraphs.

**"Business Memory," not isolated events.** This is the real point of §4's persistent Assets library plus this batch framing together — a photo uploaded today and nineteen more uploaded next week should accumulate into the same growing, organized library and inform later reasoning (`recentAssets` in `getBusinessProfile`), not reset context each time. No new mechanism beyond what §4 already proposes — bulk upload is the same pipeline run N times with a shared batch identity, not a parallel system.

**Long-term "onboard by dragging in everything"** — named as the real destination, not scoped here. Once single and bulk upload are both real and fast (§8), this becomes primarily a UX/entry-point question (a dedicated first-run "teach J4 your business" drop zone) rather than a new ingestion architecture — the ingest/classify/organize pipeline this document already proposes is the same one that destination would use.

---

## 8. Performance — profiled, not guessed

Per your explicit instruction, real numbers first. Measured against live production (`genesis-ai-rho.vercel.app`), real network timing captured per request, one real 5.52MB iPhone photo (the same file used for Beta 1 verification):

| Stage | Measured | Notes |
|---|---|---|
| Blob upload token issuance (`/api/blob/business-asset-upload`) | 458ms | Auth + permission check + token generation. Small, not a priority. |
| **Direct-to-Blob file PUT (the actual bytes, 5.52MB)** | **5,044ms** | Real network transfer time, scales with file size. |
| **Server Action round trip (`ingestBusinessAsset` + `classifyAndExtractAsset` + message writes + redirect)** | **10,264ms** | The single largest controllable cost. |
| Post-redirect page render | 102ms | Not a concern. |

**The Server Action leg is the real target, and `classifyAndExtractAsset` is almost certainly why.** Reading it directly: it calls `getBusinessProfile(storeId)` (a real multi-entity database read) *and* a synchronous Claude vision + structured-extraction API call, both awaited before the turn can write its reply message and redirect — for every single upload, no matter how simple. A real vision + JSON-schema-output call in the few-second range is the expected, believable source of most of that 10.3s, not a mystery to re-profile further before acting.

**Confirmed via direct code check: nothing today delivers a message to an already-open chat without a full page action.** No polling, no SSE, no WebSocket, no `router.refresh()` interval — `GenesisAssistant.tsx`/`DashboardShell.tsx` have zero live-update mechanism. This matters directly for what "start processing immediately, stream progress instead of waiting" can mean in practice: if classification moves to background work (the obvious fix for the blocking cost above), **its result needs a new delivery path to actually reach the user without a manual refresh** — this is real, necessary new infrastructure, not a detail to skip.

### Proposed priority order (biggest perceived-speed win first)

1. **Make the upload message itself appear instantly, before either network call resolves.** Client-side optimistic rendering — the moment a file is selected, render its thumbnail/chip in the conversation immediately (from the local `File` object via `URL.createObjectURL`, no network round trip needed to show it), with a real uploading-progress state, before the Blob PUT even starts. This alone addresses "the files should instantly appear" directly, independent of every other fix below.
2. **Stop blocking the turn on classification.** Use the exact `after()` (`scheduleAfterResponse`) pattern already established elsewhere in `ai-actions.ts` — write the upload message and a fast, honest "Got it — taking a look now" reply immediately (no fabricated analysis), redirect immediately, then run `classifyAndExtractAsset` in the background and update that same message in place once it resolves. This turns the perceived latency from "the whole 10s+5s" into "however long the Blob PUT itself takes" for everything except the final analysis.
3. **Build the missing delivery mechanism** so step 2's background result actually reaches the user live — the real new infrastructure named above. Simplest real version: lightweight polling (a short interval, only while the chat panel is open and a message is known to be pending) rather than a full WebSocket layer, matching the size of the actual problem.
4. **Parallelize `getBusinessProfile` inside `classifyAndExtractAsset`** with whatever else can run concurrently, and for batches (§7), classify the group with shared context in one pass rather than N sequential/redundant profile reads.
5. **File transfer time (the 5s leg)** is real network physics for a 5.5MB file and the least controllable — worth a follow-up profile across a few real file sizes/types to confirm it scales linearly before spending effort here; likely not the priority once 1-3 land, since it's already parallelized across a batch (§7) and already bypasses this app's own server entirely (Beta 1 fix).

Not proposing to build any of this yet — flagged here as the concrete, evidence-based priority order for when implementation starts, per the same "profile first, then prioritize" instruction this section followed.

### Frozen principle: acknowledgment is never gated on analysis

Confirmed by Sean, standing across every future upload/analysis flow, not just this one: the UI never waits on J4's thinking to acknowledge what the user just did. Files appear instantly, the upload begins immediately, J4 acknowledges receipt immediately ("I received your 18 photos and I'm analyzing them now"), analysis continues in the background, and results stream into the conversation without a refresh as they complete. A 10-20s real analysis time is fully acceptable as long as the interface stays visibly responsive and continuously updating throughout — the failure mode being protected against is the app *feeling* frozen, not the analysis taking a specific amount of time. This is exactly what the priority order above (1→3) is designed to produce; stated here explicitly as the frozen product principle it implements.

**Since generalized into a product-wide principle** (2026-08-07, after a real dogfooding pass found the same gap in onboarding's own creative-direction generation) — see `GENESIS_EXPERIENCE_PRINCIPLES.md` principles 7 and 8. This section's own wording stays as the original, upload-specific case study; the canonical, standing rule now lives there.

---

## Approval

**Approved by Sean, 2026-08-06.** Architecture, Task model, trust framework, Business Assets service design, bulk uploads, and the performance plan (including the acknowledgment-before-analysis principle above) are all frozen. Implementation begins with M1.
