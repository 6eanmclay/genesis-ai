# J4 Capability Audit

**Status: REFRESHED 2026-09-03. This supersedes the 2026-08-08 audit** rather
than sitting beside it — Sean's instruction, and the right one: a second parallel
audit would immediately disagree with the first. The August framing (capability
gap vs routing gap, the real approval vocabulary, priorities) is kept because it
still works. What changed is the answer, and one of the categories.

**Method.** Every number below is read out of the code, not remembered:

| Registry | Where | Count |
|---|---|---|
| Server actions (what the Genesis UI can do) | 32 files with `"use server"` | **149** |
| API routes | `app/api/**/route.ts` | **27** |
| Executables (what can run under approval) | `GENESIS_ACTIONS` | **23** |
| Tools J4 may invoke | `TOOL_POLICY` | **20** (3 read, 17 mutating) |
| Execution-log actions (verification vocabulary) | `EXECUTION_ACTIONS` | **55** |
| Business Map domains | `MAP_DOMAINS` | **9** |

Regenerate with the inventory walk described in *How this was counted* at the
end. `scripts/verify-tool-policy.ts` already asserts `TOOL_POLICY` and the tool
catalog agree in both directions, so the 20 is trustworthy rather than a list
somebody maintained by hand.

---

## The headline finding

**Genesis grew and J4 did not.** 149 owner-reachable server actions against 23
executables and 20 tools. The interesting part is *why* the gap exists, and it
is not what the August audit was built to describe.

That audit split every gap two ways:

- **Capability gap** — the mechanism does not exist at all.
- **Routing gap** — the mechanism exists and works, but the conversational layer
  cannot reach it.

Almost nothing left is a capability gap: the mechanisms exist, as real server
actions the dashboard already calls. But almost nothing is a pure routing gap
either, because J4 does not execute by calling server actions. It executes by
emitting a tool, which maps to a `GENESIS_ACTIONS` entry, which is what carries
approval, category ceilings, execution logging and `verify()`. **A capability
with no `GENESIS_ACTIONS` entry has nowhere for J4 to route to that is safe.**

So this audit uses a third category, and it is where most of the work is:

> **Wrapper gap** — the business logic exists and is proven in the UI, but there
> is no `Executable` for it, so it cannot be approved, logged or verified, and
> therefore should not be conversational yet. Closing one means a thin
> `GENESIS_ACTIONS` entry + `TOOL_POLICY` row + tool definition that *calls the
> existing logic*. **No new business logic, no duplicated architecture.**

That distinction is the audit's main deliverable. It answers questions 6 and 7
directly: **most gaps need a new action/tool declaration, and almost none need
new capability.**

---

## 1. What Genesis can do today (Q1)

149 server actions across 32 files. Grouped by what the owner would call it:

| Area | File | Actions |
|---|---|---|
| Store, products, orders, connections | `app/dashboard/actions.ts` | 28 |
| Conversation, drafts, approvals | `app/dashboard/ai-actions.ts` | 29 |
| Onboarding | `app/onboarding/**` | 26 |
| Studio — creation | `app/b/[slug]/studio/create/actions.ts` | 10 |
| Account security | `app/account/security/actions.ts` | 7 |
| Storefront (customer-facing) | `app/store/[slug]/**` | 11 |
| Connections | `app/dashboard/connectionsActions.ts` | 5 |
| Catalog / sourcing | `app/dashboard/catalog/actions.ts` | 4 |
| Promotions | `app/dashboard/promotions/actions.ts` | 3 |
| Access / members | `app/dashboard/access/actions.ts` | 3 |
| J4 proposals | `app/j4/proposal-actions.ts` | 3 |
| Studio — social | `app/b/[slug]/studio/social/actions.ts` | 3 |
| Understanding | `app/dashboard/understanding/actions.ts` | 2 |
| Billing | `app/dashboard/billing/actions.ts` | 2 |
| Growth Points | `app/dashboard/growth-points/actions.ts` | 2 |
| Everything else | 8 files | 1 each |

Not all 149 are J4's business. Roughly 11 are customer-facing storefront/bag
actions (a shopper's session, not the owner's), 26 are first-run onboarding, and
a handful are auth/telemetry plumbing. **The owner-facing operational surface is
roughly 100 actions.** That is the number to measure J4 against, and it is
stated rather than quietly used, because inflating the denominator would make
the gap look worse than it is.

---

## 2 & 3. What J4 can inspect and explain today (Q2, Q3)

**Inspection is the strongest part of J4 today — with one revenue-affecting
hole, found while scoping the plan below.** One tool,
`look_up_business_data`, reads one canonical assembler,
`getBusinessUnderstanding`, which returns 15 facets:

`profile`, `connectedSummaries`, `upcomingAppointments`, `recentBusiness`,
`recentRecords`, `throughEventSequence`, `blockedGoals`, `beliefs`,
`recentDecisions`, `activeThoughts`, `platformRelationship`, `currentAssets`,
`commitments`, `ownerUnderstanding`, `asOf`.

Viewer scoping is inside the assembler — owner-scoped beliefs and
`ownerUnderstanding` are withheld from non-owners — so the tool's permission
governs whether the question may be asked, not what the answer may contain.
That is the correct split and should not be re-implemented per tool.

**The hole: promotions are invisible to J4 entirely.** The `Promotion` model
exists in Prisma, and `understanding.ts` does not reference it once. Neither
does the Business Map — its "On sale in your storefront" is a *product's*
`active` flag, and `reasoning.ts`'s "sale" means a revenue transaction, not a
discount. So J4 can create a promotion and then never see it again: it cannot
answer "what sales am I running?", and it cannot stop one because it cannot
name one. An inspection gap, not merely an execution gap.

`MAP_DOMAINS` already defines the 9 Business Map domains: `business`,
`commerce`, `customers`, `financials`, `goals`, `social`, `connections`,
`creation`, `learned`. Every map edge names the column or computation backing
it, so **the data contract the approved Business Map walkthrough needs already
exists.** The walkthrough's gap is presentation and choreography, not data.

**The honest limits of explanation:**

- J4 can explain what it *understands*; it cannot yet point at what it is
  explaining. That is the approved direction in `J4_VISUAL_DIRECTION.md` and is
  deliberately unbuilt.
- `take_me_there` returns a destination, which is the nearest thing to
  navigation that exists. A walkthrough needs *focus/highlight within* a
  surface, which has no representation today.
- There is no way for J4 to say "and here is the thing I mean" in a form the UI
  can act on — no scope/selection contract between the conversation and a
  surface. **This is the one genuinely new architectural piece the Business Map
  direction requires**, and it is a contract, not a capability.

---

## 4. What J4 can execute today (Q4)

17 mutating tools, reaching 23 executables.

| Tool | Reaches |
|---|---|
| `edit_store_content` | `update_store_identity`, `update_brand_identity`, `update_design_direction`, `update_store_content`, `update_homepage_content`, `update_seo`, `update_hero`, `update_section_order` |
| `request_product_content_change` | `update_product` |
| `request_product_removal` | `delete_product` |
| `request_image_change` | `update_product_image`, `update_brand_logo` |
| `request_sale` | `create_promotion`, `update_promotion` |
| `create_design` / `approve_design_as_product` | `create_product_from_design`, `create_product` |
| `create_composition` / `approve_composition` | `update_marketing_assets` |
| `generate_brand_logo` | `update_brand_logo` |
| `improve_storefront` / `refine_storefront` | `refine_storefront`, `update_theme` |
| `answer_supplier_economics` | `answer_supplier_economics` |
| `capture_business_fact` | business facts (Understand layer) |
| `plan_campaign` | campaign planning |
| `manage_business_asset` | asset library |
| `approve_pending_changes` | the approval queue itself |

Plus `update_goal_status`, `resolve_challenge`, `communicate_finding` reached
from the intelligence path rather than a chat tool.

**What that covers, fairly stated:** storefront content, brand identity, design
direction, products (create/edit/delete), product and brand imagery,
promotions, designs and compositions, business facts, and the approval queue.
That is the "make and change the storefront" half of the product, and it is
genuinely well covered.

---

## 5. What Genesis can do that J4 cannot invoke (Q5)

Every row names a real server action. Classification per §The headline finding.

### Orders and fulfilment — **the largest and most surprising gap**

| Capability | Server action | Gap | Notes |
|---|---|---|---|
| Mark an order fulfilled | `toggleOrderFulfilled` | wrapper | The single most common daily operation an owner has. |
| Attach a tracking number | `attachTrackingNumber` | wrapper | |
| Correct a tracking number | `correctTrackingNumber` | wrapper | Already has correction semantics to reuse. |
| Buy a shipping label | `purchaseShippingLabel` | wrapper | **money** category — `always_ask`, hard ceiling. |
| Save a return address | `saveReturnAddress` | wrapper | |

J4 can build a store and cannot help run it. An owner asking *"mark order 118
shipped with tracking 1Z…"* is the most natural conversational request in the
product and there is no tool for it.

### Store lifecycle

| Capability | Server action | Gap |
|---|---|---|
| Publish / unpublish the store | `toggleStorePublished` | wrapper — arguably `destructive`-adjacent; unpublishing takes a live store down |
| Activate / deactivate a product | `toggleProductActive` | wrapper |
| Product media: add, reorder, delete, replace | `addProductImages`, `reorderProductImages`, `deleteProductImage`, `replaceProductImage` | wrapper — `request_image_change` covers *changing* one image, not managing a gallery |

### Promotions — partially covered

| Capability | Server action | Gap |
|---|---|---|
| Create a promotion | `createPromotion` | **covered** via `request_sale` |
| Pause / resume a promotion | `setPromotionActive` | **routing only — see Correction 2**: `update_promotion` already exists in full and nothing can produce it |
| Delete a promotion | `deletePromotion` | wrapper — `destructive` |

J4 can start a sale and cannot stop one — and the tool's description promises
it can, which is worse. See **Correction 2** in the plan below.

### Connections

`connectIntegration`, `verifyIntegration`, `disconnectIntegration`,
`syncIntegration`, `submitIntegrationCredentials`, plus the provider-specific
`connectStripe` / `disconnectStripe` / `recheckStripe`, `connectPaypal` /
`submitPaypalCredentials` / `disconnectPaypal` / `recheckPaypal`,
`submitUspsCredentials` / `disconnectUsps` / `recheckUsps`.

**Gap: wrapper for the safe half, and deliberately never for the rest.**
`syncIntegration` and `verifyIntegration` are reads-with-effects and are
reasonable conversational requests. **Credential submission must never be
conversational** — an owner should not paste a secret into a chat transcript
that is stored and may be summarised. That is a boundary, not a gap, and it
belongs in this document as one.

### Access and authority

`addMemberAction`, `changeRoleAction`, `removeMemberAction`, `grantAuthority`,
`revokeAuthority`.

**Gap: wrapper, and the lowest priority here by design.** These change who can
do what. A conversational path to privilege escalation is exactly the shape of
mistake worth avoiding, and the post-migration audit already caught one
authorization hole this milestone. If it is ever built, `destructive` ceiling.

### Money and plan

`purchaseGrowthPoints`, `subscribeToPlan`, `manageBilling`.

**Gap: wrapper, `money` category, `always_ask` hard.** J4 recommending a plan is
already covered by the trusted-advisor principle; J4 *buying* one is a different
act. `addGrowthPointsForTesting` must never be reachable.

### Account security

`beginSetupAction`, `enableAction`, `disableAction`, `regenerateAction`,
`confirmPasswordAction`, `endSessionAction`, `endOtherSessionsAction`.

**Not a gap — out of scope on purpose.** 2FA and session revocation sit behind
re-authentication. Conversational 2FA disablement is an attack, not a feature.
Recorded so nobody later reads its absence as an oversight.

### Catalog and sourcing

`adoptFromCatalog`, `dismissFromCatalog`, `priceFromCatalog`,
`rediscoverForCatalog`.

**Gap: wrapper.** *"Add that supplier's mug to my store at £18"* is a natural
request and the whole sourcing model exists behind it.

### Understanding and beliefs

`contradictBeliefAction`, `restoreBeliefAction`.

**Gap: wrapper — and the most interesting one.** J4 can *capture* a fact
(`capture_business_fact`) but an owner cannot conversationally tell J4 *"that's
wrong"* about a belief J4 itself formed. The Business Fact Lifecycle already
implements owner correction with supersession preserved; only the conversational
route is missing. This one is nearly pure routing.

### Studio and assets

`addDesignToStore`, `saveDesignDraft`, `loadDesignDraft`, `describeDesign`,
`addAssetToLibrary`, `removeAssetFromLibrary`, `restoreAssetToLibrary`,
`saveSocialDraft`.

**Mostly covered** by `create_design`, `approve_design_as_product` and
`manage_business_asset`. `describeDesign` and draft save/load are wrapper gaps of
low value. Social publishing is not authorized regardless.

### Attention, recommendations, drafts

`dismissAttentionCard`, `explainRecommendation`, `reviewBusinessWithGenesis`,
`applyThemePersonality`, `restoreStoreDraftVersion`, `confirmStoreDraft`,
`discardStoreDraft`.

**Gap: routing, genuinely.** These are conversational by nature — *"dismiss
that", "why did you recommend that?", "undo that theme change"* — and every
mechanism exists. `explainRecommendation` in particular is J4 explaining itself,
which is the product's whole thesis.

---

## 6 & 7. New tool vs routing only (Q6, Q7)

| Kind | Count (approx.) | What closing it costs |
|---|---|---|
| **Pure routing** — mechanism + executable exist, conversation cannot reach it | ~7 | Tool definition + `TOOL_POLICY` row + prompt. No new logic. |
| **Wrapper** — mechanism exists, no executable | ~30 | Thin `GENESIS_ACTIONS` entry calling existing logic, + tool + policy. No new logic. |
| **Genuine capability** — nothing exists | **1** | The conversation↔surface scope/selection contract the Business Map walkthrough needs. |
| **Deliberately never** | ~12 | Credentials, 2FA, session revocation, test-only helpers. |

**The single genuinely new architectural piece is the scope contract**, not any
business capability. Everything else is declaration.

---

## 8 & 9. Approval and verification (Q7 of Sean's list, Q8/Q9)

Both systems already exist and **must be reused, not re-implemented**.

**Approval** is `AuthorizationTier` — `always_ask` | `auto_below_limit` | `auto`
— with hard-coded per-category ceilings no owner setting can raise:

| Category | Ceiling |
|---|---|
| `content` | `auto` |
| `operations` | `auto` |
| `communication` | `auto` |
| `integration` | `auto_below_limit` |
| `money` | **`always_ask`, hard** |
| `destructive` | **`always_ask`, hard** |

Only `always_ask` is real today; the other two tiers are declared and not yet
enforced anywhere. **Any new executable must declare a category, and the
category decides the ceiling** — which means the approval question for every gap
above is already answered by which category it falls into. Nothing new is
needed.

**Verification** is `recordExecution` against `EXECUTION_ACTIONS` (55 entries),
plus the `verify()` requirement the compiler enforces — an executable that
cannot be read back does not compile. That is the strongest guarantee in the
codebase and it applies automatically to any new executable. **No new
verification architecture.**

**Practical consequence:** the safe order to close gaps is by category —
`content` and `operations` first (auto, reversible, already the well-trodden
path), `integration` next, and `money`/`destructive` last and always behind
`always_ask`.

---

## 10. What to reuse rather than duplicate (Q10)

| Need | Reuse | Do not build |
|---|---|---|
| Approval, drift refusal, revert | `GENESIS_ACTIONS`, `ApprovalRequest`, `approvalDrift` | a second approval path |
| Execution logging + read-back | `recordExecution`, `EXECUTION_ACTIONS`, `verify()` | a second audit trail |
| Tool authorization | `TOOL_POLICY` + `mayInvokeTool` (fails closed) | per-tool ad-hoc checks |
| Business reading | `getBusinessUnderstanding` | a second assembler — `buildChatDataContext` was already deleted for being one |
| Map data + edges | `MAP_DOMAINS`, the edge registry | a J4-specific map model |
| Recommendations | the existing recommendation/track-record system | a J4-specific suggester |
| Integrations | `lib/integrations` provider layer | per-provider J4 code |
| Order/shipping logic | `lib/carriage`, `lib/pricing/orderPricing.ts` | a conversational pricing path |

`lib/pricing/orderPricing.ts` is the one source of truth both rails must take — a
conversational rail that priced independently would be a third opinion about
money.

---

# The plan (2026-09-03) — approved priorities, scoped against the real code

Sean's sequencing, scoped after reading each mechanism rather than from the
inventory above. **Two things the audit got wrong were found while scoping, and
both make the work smaller — except one, which makes it more urgent.**

## Correction 1: the order wrappers are thinner than stated

All four Priority-1 capabilities **already have Executables**, which means they
already have `verify()`, execution logging and the confirmed-safe
fetch-then-authorize pattern:

| Capability | Executable that already exists |
|---|---|
| `toggleOrderFulfilled` | `toggleOrderFulfilledExecutable` |
| `attachTrackingNumber` | `attachTrackingExecutable` |
| `correctTrackingNumber` | `correctTrackingExecutable` |
| `purchaseShippingLabel` | `purchaseShippingLabelExecutable` |

So the "wrapper gap" is not "write an executable". It is the five-part
declaration every existing action already follows:

1. a `GENESIS_ACTIONS` entry — `executable`, `inputSchema`, `getCurrentValues`,
   `category`, `authorizationTier`, `maxAuthorityTier`
2. an `ACTION_SECTIONS` entry so the approval has somewhere to live
3. a `TOOL_POLICY` row (permission + `mutates`)
4. a tool definition in `buildStoreChatUnifiedTools()`
5. a handler in `toolHandlers.ts`

**No new business logic. No new execution, approval or verification
architecture.** `scripts/verify-tool-policy.ts` and
`scripts/verify-action-sections.ts` already fail closed if any of 2–4 is
missing, which is the safety net for doing this work at all.

## Correction 2: promotions is not a missing capability, it is a WRONG one

This is the finding that changes priority order.

- `update_promotion` **exists in full** — executable, `active: z.boolean()`,
  `money`/`always_ask`, and an `ACTION_SECTIONS` row.
- **Nothing in the product can produce it.** Grepped repo-wide: it appears only
  in its own definition and the sections registry. `requestSale` hardcodes
  `actionType: "create_promotion"`.
- `request_sale`'s tool description advertises **"take the pyramid off sale"**,
  but `RequestSaleInputSchema` has no `promotionId` and no `active` — every
  field describes a NEW promotion.

So a model following the description faithfully will emit a **create**-shaped
proposal for an **end**-shaped request. The owner asks to stop a sale and is
offered a new one. That is a `money`-category action behaving wrongly, not
merely a capability that is absent — **absent is safe, wrong is not.**

`scripts/verify-j4-promotions.ts` asserts `update_promotion.maxAuthorityTier
=== "always_ask"` — a green assertion about a ceiling on a path nothing can
reach. It is correct and it is not evidence of reachability.

**Therefore promotions moves ahead of orders**: it is smaller, and it fixes
behaviour that is actively misleading rather than merely missing.

---

## Priority order, revised

### P0 — Promotions: see them, then stop them (do first)

**You cannot stop what you cannot see**, and J4 cannot see promotions at all
(§2 & 3). So P0 has two halves and the order matters:

**P0a — visibility.** Add promotions to `getBusinessUnderstanding` so J4 can
answer "what sales am I running?" and can name one. This is a read, it reuses
the one canonical assembler, and it is independently valuable even if nothing
else here is built. The Business Map's `commerce` domain should gain them too,
which is also what a Business Map walkthrough would need to explain a discount.

**P0b — stop advertising a capability that does not exist.**

Either the description stops promising it, or the schema can express it. **Do
the second**, because the capability is genuinely wanted and everything below
the tool already exists:

- extend `RequestSaleInputSchema` with an explicit end/stop intent naming an
  existing promotion (by name, resolved server-side — never by asking the owner
  for an id, per the internal-identifiers rule)
- branch `requestSale` to emit `update_promotion` with `active: false`
- P0a is a hard prerequisite: `ToolTurnContext` carries `products` (which is how
  `requestSale` resolves product names) and carries **no promotions at all**, so
  without P0a the handler would have to guess which sale the owner meant

**Sabotage that must go red:** an end-request that produces a `create_promotion`
proposal; an end-request naming a promotion in another store; the ceiling
dropping below `always_ask`.

### P1 — Orders and fulfilment

In value order, all `operations` except the last:

1. `toggleOrderFulfilled` — the most common daily operation in the product
2. `attachTrackingNumber`
3. `correctTrackingNumber` — already has correction semantics to reuse
4. `purchaseShippingLabel` — **`money`, `always_ask` hard**

**One flag on #1 and #2**: marking fulfilled and attaching tracking are what
trigger telling the customer. That is a real-world side effect leaving the
platform, so both stay `always_ask` regardless of what the `operations` ceiling
would permit. (Only `always_ask` is implemented today, so this costs nothing
now and prevents a wrong default later.)

**#4 is externally limited**: buying a label spends real money against a carrier
account. It can be built and approved, but it cannot be *proven* end to end
here — EasyPost live webhooks are already a recorded blocker. Build it last and
say plainly that its verification is partial.

### P2 — The conversation ↔ surface/selection contract

**This is the one genuinely new architecture**, and it is a contract, not a
capability. It has two directions and one durability rule.

**Inbound — what the owner is looking at.** A `SurfaceContext` travelling with
each message: the surface, the business, and a selection of zero or more
entities as `{kind, id, label}`. This is what makes *"change this font"* and
*"compare these three products"* resolvable without the owner restating
anything.

**Outbound — what J4 means.** A `FocusDirective` J4 can return alongside its
reply: the entities to focus or highlight, optionally ordered, so *"TikTok is
getting more views than Facebook"* can light up TikTok and then Facebook. The
expanded character can later point at the same targets — **the directive is what
the pointing is aimed at**, which is why the contract must exist before any of
the visual work.

**Durability.** The selection survives turns, compact ↔ expanded, and navigation
between surfaces. That is the same requirement as *there is one J4* and should
be satisfied by the same state, not a parallel one.

**Five constraints, each from something already decided here:**

1. **Reuse `MAP_DOMAINS` entity kinds.** The map already names its 9 domains and
   every edge names its backing column. A second entity vocabulary would drift
   from it immediately.
2. **A selection is a POINTER, not data.** J4 resolves the entity through
   `getBusinessUnderstanding`; the contract carries identity only. Otherwise it
   becomes a second understanding assembler, which is exactly what
   `buildChatDataContext` was deleted for being.
3. **Authorization is re-checked server-side against the pointer.** A selection
   naming an entity the caller cannot reach is **refused, never substituted** —
   the rule `BUSINESS_CONTEXT.md` already enforces for named businesses, and
   which a chat-supplied pointer makes newly reachable by an attacker.
4. **Ids never surface to the owner.** `label` is for display, `id` is for
   resolution. A cuid has become a SKU here before.
5. **`take_me_there` is not this.** It returns a destination; this focuses
   *within* one. They should stay separate tools with separate meanings.

**Deliverable for P2 is a written contract plus the inbound half**, which is
independently useful (it makes "this" resolvable) and testable without any
visual work. The outbound half is inert until something renders it — build it,
prove it round-trips, and leave it unrendered.

### P3 — Everything else, by value and risk

Ordered by owner value against blast radius, not alphabetically:

| Next | Why | Risk |
|---|---|---|
| `explainRecommendation`, `dismissAttentionCard` | pure routing; J4 explaining itself is the product's thesis | low |
| `contradictBeliefAction` | "owners can correct J4", made conversational | low |
| `setPromotionActive` (covered by P0), `deletePromotion` | completes the lifecycle | `destructive` |
| Product media (`addProductImages`, `reorderProductImages`, `deleteProductImage`, `replaceProductImage`) | common, visual, reversible | low–medium |
| `toggleProductActive`, `toggleStorePublished` | unpublishing takes a live store down | medium |
| Catalog adoption (`adoptFromCatalog`, `priceFromCatalog`) | real sourcing value | medium |
| Connections `syncIntegration` / `verifyIntegration` only | reads-with-effects | medium |
| Billing, Growth Points | `money`, hard ceiling | high |
| Access and authority | conversational privilege escalation | high — last, or never |

**Unchanged: deliberately never.** Credential submission, 2FA disablement,
session revocation, `addGrowthPointsForTesting`. Coverage is not a reason.

---

## Genuinely new architecture required

**One thing: the surface/selection contract (P2).** Everything else in P0, P1
and P3 is declaration against machinery that already exists — executables,
approval tiers, category ceilings, `verify()`, tool policy, action sections.

Two things that look new and are not:
- *Order actions for J4* — the executables exist; only the declarations are
  missing.
- *Stopping a promotion* — the action exists; only the tool cannot say it.

---

## What this audit does NOT claim

- **No implementation happened.** No tool, executable, policy row or prompt was
  added. This is an inventory.
- **Counts are of declarations, not of quality.** That `toggleOrderFulfilled`
  exists says nothing about whether it handles partial fulfilment well.
- **The ~100 owner-facing figure is a judgement**, not a computed number. The
  149 is exact; the split into owner-facing vs storefront vs onboarding vs
  plumbing is mine and worth arguing with.
- **Voice remains unproven.** Anything depending on J4 speaking is downstream of
  a synthesis path that has never produced audio.

## How this was counted

Server actions: every file containing `"use server"`, then `^export async
function` within it. API routes: `app/api/**/route.ts`, exported HTTP verbs.
The registries were read by importing them, not by grepping counts. Repeat
before trusting any number here — the point of deriving them is that they go
stale, and a hand-maintained count in a document is exactly the drift the
mirrored-registry invariant exists to prevent.
