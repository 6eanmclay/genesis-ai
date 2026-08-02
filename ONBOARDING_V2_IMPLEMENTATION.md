# Onboarding v2 implementation plan: the ecommerce path

**Status:** Frozen — approved by Sean 2026-08-02. Implementation begins now. Scope is exactly `ONBOARDING_V2_DESIGN.md`'s ecommerce path (section 4's scope boundary): business-model classification as a gate, brand positioning as a second classification axis, fulfillment as a provider-agnostic strategy Genesis evaluates internally (Printful is the first implementation, not the architecture), the north star (section: *The north star*) as the standing evaluation lens. Every design decision below was checked against the real, current code — file:line references throughout are real, not illustrative.

**Standing principle, Sean's own words, frozen alongside this plan**: *fulfillment is one execution strategy, not something the platform is permanently centered around.* `lib/fulfillment/` (section 2) is the ecommerce path's own strategy module — the generic discovery-flow orchestrator (`lib/onboarding/discoveryFlow.ts`) invokes it only when business-model classification resolves to `product_sales`/`digital_products`, and never imports its internals otherwise. A future services/bookings/subscriptions strategy gets its own module, invoked the same way, never forced to resemble or route through fulfillment-shaped code. See `ONBOARDING_V2_DESIGN.md` section 11 for the full statement of this principle.

## 1. Existing components reused, unchanged

- **`StoreDraft` / `confirmStoreDraftCore`** (`app/dashboard/ai-actions.ts`) — the draft → real `Store` materialization point. `productsDraft` → real `Product` rows happens here today; the ecommerce path's real, fulfillment-backed product(s) get materialized the same way, at the same point, just sourced differently (section 5).
- **`REVENUE_STREAM_TYPES`** (`lib/businessTaxonomy.ts`) — reused as-is for business-model classification, plus one additive slug (section 3). A new, sibling `BRAND_POSITIONING_TYPES` taxonomy in the same file follows its exact shape (section 3).
- **`IntegrationConnector` / `getConnector(provider)`** (`lib/integrations/types.ts`, `lib/integrations/registry.ts`) — Printful's OAuth auth backbone (connect/verify/disconnect/status) is a new connector implementing this exact contract, registered exactly like Stripe/QuickBooks/Mailchimp/Google Calendar. **Not modified** — see section 4 for why the draft-phase entry point deliberately doesn't reuse this interface's `connect()` call site or the shared OAuth callback route.
- **`encryptCredentials`/`decryptCredentials`** (`lib/integrations/credentials.ts`) and the `refreshAccessToken`-on-expiry pattern (reference implementation: `lib/integrations/quickbooks.ts:40-65`) — reused verbatim for Printful's token lifecycle (1hr access token, 90-day refresh token, confirmed via real OAuth docs in `ONBOARDING_V2_DESIGN.md` section 6).
- **`recordExecution()`** (`lib/execution/log.ts`) — the low-level, `ExecutionContext`-free primitive already used by the PayPal capture handler and the OAuth callback route's own failure path, both of which write `ExecutionLog` rows with a real `storeId` OR a real `storeDraftId` (`ExecutionResult.storeId`/`storeDraftId`, `lib/execution/types.ts:34-35`, both nullable by design). This is what draft-phase fulfillment actions use — see section 6 for why the higher-level `execute()`/`Executable` engine does not apply here.
- **`lib/tenantIsolation.ts`'s guard** — no change needed. The new `Product`/`Store` columns (section 3) are plain nullable additions to already-guarded models; `StoreDraft` is (correctly) outside the guard's scope today, since it's `userId`-owned, not `storeId`-scoped, and stays that way.
- **`lib/integrations/registry.ts`'s "map of N, only a handful implemented" shape** — directly reused as the pattern for `lib/fulfillment/registry.ts` (section 2), not reinvented. The same shape that already lets 5 real integrations share one lookup function is what lets fulfillment partners scale past Printful without new architecture per partner.

## 2. New components

| File | Purpose |
|---|---|
| `lib/fulfillment/types.ts` | The provider-agnostic `FulfillmentConnector` interface, `FulfillmentPartnerProfile` (quality tier, cost tier, brand fit), and candidate/cost/order shapes — deliberately separate from `IntegrationConnector` (section 4). |
| `lib/fulfillment/registry.ts` | `getFulfillmentConnectors()` — returns every registered `FulfillmentConnector` (just Printful today), same lookup shape as `lib/integrations/registry.ts`. |
| `lib/fulfillment/strategy.ts` | `selectFulfillmentStrategy(brandPositioning, connectors)` — the provider-agnostic evaluation Genesis runs internally; the owner never sees this layer or its inputs directly (section 6). |
| `lib/fulfillment/printful.ts` | Implements `FulfillmentConnector` + its `FulfillmentPartnerProfile` against the real, validated Printful endpoints. |
| `lib/integrations/printful.ts` | Implements `IntegrationConnector` (OAuth connect/verify/disconnect/status) — the auth backbone, registered in `lib/integrations/registry.ts`. Also exports `buildPrintfulAuthorizeUrl(state)`, the shared URL-builder both the standard connect flow and the draft-phase flow call (section 4). |
| `app/api/onboarding/fulfillment/callback/route.ts` | New, dedicated OAuth callback for the draft-phase Printful connect — `state` carries a `storeDraftId`, not a `storeId` (section 4). Provider-agnostic by construction (reads which connector from the route param, same as the existing shared callback), so a second connector doesn't need a second route. |
| `lib/onboarding/discoveryFlow.ts` | Pure state-machine functions: given current `StoreDraft.onboardingState` + the owner's latest answer, compute the next question and the updated state. No I/O — mirrors the existing `genesisArrivalCopy.ts` pattern (pure function, given inputs, returns a plan) already proven elsewhere in this codebase. |
| `lib/onboarding/pricing.ts` | `recommendPrice(costInCents, shippingInCents, brandPositioning): { retailPriceInCents, profitInCents, marginPct }` — brand-aware, not a flat default (section 5). Pure, testable, no network calls. |
| `app/onboarding/actions.ts` | Server actions driving the guided flow: submit an answer → advance `discoveryFlow` state → call `lib/fulfillment` when the state machine needs real data → persist → return the next question. |
| UI: a new guided-discovery flow, entry point TBD at implementation time (likely alongside or replacing the existing `CreateBusinessArrival.tsx` first-run entry point) | Not fully specified here — this is a real product-surface design task, not something to pre-architect in a backend-focused plan. |

## 3. Database changes

Additive only, same discipline as `PHASE1_DESIGN.md`'s migration.

```prisma
enum IntegrationProvider {
  // ...existing values unchanged...
  PRINTFUL
}

model Product {
  // ...existing fields unchanged...
  costInCents         Int?
  fulfillmentProvider IntegrationProvider?
  externalProductId   String?
  externalVariantId   String?
}

model Store {
  // ...existing fields unchanged...
  // The owner's stated brand positioning (luxury/streetwear/minimalist/
  // budget/family/professional/other — see BRAND_POSITIONING_TYPES) —
  // same draft-stage-copy pattern as businessCategories/revenueStreams.
  // Used by selectFulfillmentStrategy and recommendPrice, not just stored
  // for narration.
  brandPositioning String?
}

model StoreDraft {
  // ...existing fields unchanged...
  brandPositioning String?
  // The guided discovery flow's own state — current step, business-model
  // classification, chosen product candidate, and (encrypted, see section 4)
  // fulfillment credentials while no real Store/StoreIntegration exists yet
  // to hold them. Deliberately separate from `pendingChange` (that's one
  // AI-authored diff awaiting confirm; this is "where the guided
  // conversation currently is," a different kind of state).
  onboardingState Json?
}
```

Plus two non-migration, additive changes in `lib/businessTaxonomy.ts`: `digital_products` added to `REVENUE_STREAM_TYPES`, and a new sibling `BRAND_POSITIONING_TYPES` array (`luxury`, `streetwear`, `minimalist`, `budget`, `family`, `professional`, `other`) — no schema change beyond the plain `String?` columns above, following that file's own established "small, open, purely additive" shape exactly.

**No variant model.** `Product` has never had a variant concept, and this plan doesn't add one — Genesis selects one representative catalog variant per product (e.g. one size/color) and `externalVariantId` records exactly that one. Real multi-variant selection is future scope, not this pass (matches `ONBOARDING_V2_DESIGN.md` section 9's non-goals discipline: don't build more than the design asked for).

## 4. Two connector layers, deliberately kept separate

**Finding from `ONBOARDING_V2_DESIGN.md` section 3(b), now made concrete**: `IntegrationConnector.sync()` pulls a store's *own* data out of a system it already owns and writes read-only into `BusinessRecord`. A fulfillment connector does the structural opposite — pulls a third party's catalog and writes into typed `Product` rows, plus needs to create draft orders. Rather than stretch `IntegrationConnector` to cover both shapes, Printful gets **two** small, separate pieces:

- **`lib/integrations/printful.ts`** implements the standard `IntegrationConnector` (connect/verify/disconnect/status) — this is purely the OAuth auth backbone, registered in `lib/integrations/registry.ts` exactly like every other provider. Once a real `Store` exists, reconnecting/disconnecting Printful from the Connections page works identically to Stripe/QuickBooks today, no special-casing.
- **`lib/fulfillment/printful.ts`** implements the new `FulfillmentConnector` interface (section 2) — `browseCandidates`, `getCost`, `createProduct`, `createDraftOrder`, plus a static `profile: FulfillmentPartnerProfile` (quality tier, cost tier, which brand positionings it suits), using the same stored/decrypted credentials. `lib/fulfillment/strategy.ts` (section 6) is what actually calls this — the onboarding flow itself never picks a fulfillment connector directly.

**Why the draft-phase OAuth flow doesn't reuse `IntegrationConnector.connect()`'s call site or the shared `/api/integrations/[provider]/callback` route**: read directly, `app/api/integrations/[provider]/callback/route.ts:28,114-118` hard-requires a real `storeId` (`state` param) and calls `execute(executable, {...}, {storeId, executionId})`, which internally re-verifies `requireStorePermission` against that `storeId` — the route's own comment calls this path "real-money-tested." During onboarding there is no `Store` yet, only a `StoreDraft`, so there is nothing for `requireStorePermission` to check against. Bending that shared, proven, real-money-adjacent route to also handle a draft-phase case is a real risk for a small convenience; a **separate, small, dedicated route** (`app/api/onboarding/fulfillment/callback/route.ts`) is safer and keeps the existing route's proven behavior completely untouched — the same "don't touch what's already proven" instinct behind `prismaSystem` being an *additional* export rather than a modification to `prisma` (see `lib/prisma.ts`).

Both the standard flow and the draft-phase flow build the exact same authorize URL for whichever connector is involved, just with a different `state` payload (`storeId` vs. `storeDraftId`) — factored into one shared `buildPrintfulAuthorizeUrl(state)` in `lib/integrations/printful.ts` (and the equivalent for any future connector) so URL-building logic is never duplicated, only the two thin call sites around it.

**Where draft-phase credentials live until publish**: `StoreIntegration.storeId` is a required, non-nullable field (`prisma/schema.prisma:177`) with no `storeDraftId` alternative — unlike `StoreGeneration`/`ExecutionLog`, it was never built as a dual-phase model, and this plan doesn't add that dual-phase pattern to a credentials-holding table (a materially different risk profile than adding one to `BusinessEvent` or `AiUsageEvent`). Instead, the draft-phase callback route writes the encrypted credentials into `StoreDraft.onboardingState` (section 3) — exactly the same "draft holds provisional state, `confirmStoreDraftCore` materializes the real row" pattern `productsDraft` → `Product` already uses. `confirmStoreDraftCore` gets one addition: if `onboardingState` carries fulfillment credentials, create the real `StoreIntegration` row (`provider`, `status: CONNECTED`) inside the same transaction that creates the `Store` and its `Product` rows — one atomic materialization, matching the existing all-or-nothing confirm.

## 5. The discovery flow, end to end

**Ordering change from today, stated plainly**: today, `generateStoreDraftForApi` (`app/dashboard/ai-actions.ts`) fires immediately from the initial business description and produces everything in one shot, including AI-imagined `productsDraft`. In this design, the business-model question (section 4 of `ONBOARDING_V2_DESIGN.md`) is asked **before** that call, not after:

1. **"What kind of business do you want to build?"** — classified into a `REVENUE_STREAM_TYPES` slug via the existing small classification call pattern (`app/dashboard/ai-actions.ts:212-215`'s `BusinessCategorySchema`, reused, just moved earlier in sequence and now gating instead of merely labeling). Written to `StoreDraft.onboardingState.businessModelSlug`.
2. **If not `product_sales`**: exit the guided flow, fall back to today's existing generation path unchanged (`ONBOARDING_V2_DESIGN.md` section 4's explicit scope boundary — the other six business models are not designed here).
3. **If `product_sales`**: the primary generation call (`generateStoreDraftForApi`) still runs — store name, tagline, theme, `blueprint.homepageContent` are valuable regardless of *how* the product gets sourced, and rewriting that call is out of scope. Its own `productsDraft` output is simply **not used** for this path; it's superseded by whatever the guided flow produces next. (Cheap to leave unused rather than adding a flag to suppress it — this is not the place to touch a large, already-proven generation prompt for a small optimization.)
4. **"Who's your customer, and what kind of brand do you want this to be?"** — free-form, classified into a `BRAND_POSITIONING_TYPES` slug the same way step 1 classifies business model. Written to `StoreDraft.onboardingState.brandPositioning` (and to `StoreDraft.brandPositioning` directly, section 3). This is the input `selectFulfillmentStrategy` and `recommendPrice` both need — asked before either runs, not derived after the fact.
5. **"Do you already have products, or should Genesis help find some?"**
   - **"I have products"**: existing manual/AI product-creation path, extended to also collect `costInCents` (optional).
   - **"Help me find something to sell"**: `selectFulfillmentStrategy(brandPositioning, getFulfillmentConnectors())` (section 6) picks the right partner internally — today always Printful, architecturally not hardcoded as such — then that partner's `browseCandidates({ brandPositioning })` proposes a small number of real, fulfillable, brand-appropriate candidates. Never named by provider, per the north star's mental-model rule. Owner picks one.
6. **Connect fulfillment** (if not already connected for this draft): the draft-phase OAuth flow from section 4, against whichever connector `selectFulfillmentStrategy` chose. Framed to the owner as "connecting how this gets made and shipped," never a provider name.
7. **Cost known** → the chosen connector's `getCost(candidate, variant)` returns real product + shipping cost. `lib/onboarding/pricing.ts`'s `recommendPrice(costInCents, shippingInCents, brandPositioning)` computes a default retail price whose margin reflects the stated brand (a luxury/professional positioning supports a different margin than a budget/family one against the same underlying cost) — the exact margin bands per positioning are pricing content to set at build time (section 9), not invented in this plan. Owner sees cost → recommended price → profit, and can move markup up/down (fixed, percentage, or fully custom) before confirming — exactly `ONBOARDING_V2_DESIGN.md`'s pricing-step instruction.
8. **Confirm** → `confirmStoreDraftCore` materializes `Store` (including `brandPositioning`), the real `Product` row (`costInCents`, `fulfillmentProvider`, `externalProductId`, `externalVariantId`, the owner's chosen `priceInCents`), and the real `StoreIntegration` row, atomically (section 4). Payments (Stripe/PayPal) connect in the same guided sequence, unchanged mechanically from today.
9. **Published, purchasable** — same `active: true` + real price + published `Store` as today; the difference is everything upstream of this point was real, brand-appropriate, and never asked the owner to pick a fulfillment vendor by name.

## 6. Fulfillment strategy selection, in practice

`lib/fulfillment/strategy.ts`'s `selectFulfillmentStrategy(brandPositioning, connectors)` is the layer that makes "the owner never chooses a provider" literally true (`ONBOARDING_V2_DESIGN.md` section 6). With one connector registered:

```ts
function selectFulfillmentStrategy(brandPositioning: BrandPositioningSlug, connectors: FulfillmentConnector[]) {
  // Real scoring logic (profile.brandFit.includes(brandPositioning), costTier
  // vs. positioning, etc.) is genuinely trivial with one candidate — but the
  // function signature and call site don't change when a second connector
  // is registered. That's the point: the *architecture* is built for N now,
  // even though the real behavior is "return Printful" until a second
  // FulfillmentConnector exists.
  const scored = connectors.map((c) => ({ connector: c, fit: scoreFit(c.profile, brandPositioning) }));
  const best = scored.sort((a, b) => b.fit - a.fit)[0];
  return { connector: best.connector, rationale: explainFit(best.connector.profile, brandPositioning) };
}
```

`rationale` is what Genesis's discovery-flow copy actually narrates to the owner ("a premium, quality-focused option that fits a professional brand" — business terms, never "Printful"), sourced from `FulfillmentPartnerProfile`, not invented per-call by an LLM guessing at qualities the connector doesn't actually have.

## 7. Draft-phase execution and logging

Every real action in steps 5-8 above (browsing candidates, connecting, computing cost, creating the eventual `Product`) happens **before a `Store` exists**, so it cannot go through the `execute()`/`Executable` engine as-is: `ExecutionContext.storeId` (`lib/execution/executable.ts:5`) is a required `string`, and every existing `Executable` (e.g. `lib/execution/executables/products.ts`) assumes one. Rather than widen that core, already-proven interface to accept a nullable/draft-phase context — a change that would touch every existing `Executable` implementation's assumptions — draft-phase fulfillment actions call `recordExecution()` directly with `storeDraftId` set and `storeId: null` (`lib/execution/types.ts:34-35` already supports exactly this shape; `recordExecution()` already writes it verbatim, `lib/execution/log.ts:14-15`). This mirrors the PayPal capture handler and the OAuth callback route's own failure path, both of which already call `recordExecution()` directly for reasons in the same family (real actions with no `execute()`-shaped authorization context to check against). Once a real `Store` exists, any *future* automatic order-to-supplier routing (explicit non-goal, `ONBOARDING_V2_DESIGN.md` section 9) would be a normal `Executable` with `ctx.storeId`, same as everything else.

## 8. Rollout strategy

Ties to `ONBOARDING_V2_DESIGN.md` section 10's still-open item 3 (replace vs. alongside) — the *feature-gating mechanism* itself is a small, low-stakes engineering choice and this plan decides it directly rather than leaving it open: a single `ONBOARDING_V2_ENABLED` env var, checked once at the guided flow's entry point, same pattern as every other environment-gated toggle already in this codebase (`.env`, never a database row — there's nothing per-store about "is this feature live yet"). Cheap to flip, cheap to remove once the guided flow is simply *the* onboarding path. What that entry point actually is (replace vs. alongside `CreateBusinessArrival.tsx`) is still a real product decision — this env var makes either answer equally cheap to ship, it doesn't presuppose one.

- The guided discovery flow is new, additive code reachable from a new entry point — it does not require deleting or branching inside today's existing "generate immediately" path.
- Recommended sequencing: dogfood against a small number of real accounts with the flag on, before flipping it to every new user by default — consistent with this project's standing "verify against reality before committing" discipline, not a new process being invented for this feature specifically.
- Proposed entry-point resolution (from the previous version of this plan, still standing): the guided flow **replaces** the product-related step of today's flow rather than living alongside it as a second, competing path — it slots in right where `productsDraft` would otherwise get used (section 5, step 3), so a new owner experiences one continuous flow, not a fork they have to choose between. `CreateBusinessArrival.tsx` itself (the surrounding first-run shell) is untouched; only what happens at the product step changes.

## 9. Verification plan

Matches the rigor already applied to Track 0 and Phase 1, adapted to what's actually new here:

1. **`tsc`/`eslint`/`next build` clean**, as always.
2. **Migration reviewed** (generated SQL read before applying), same discipline as every migration this session.
3. **`lib/fulfillment/printful.ts` validated against the real Printful API** using the same disposable-script pattern already proven in this session's own validation work (catalog browse, cost retrieval, product creation, draft-order creation — all four already confirmed working live; this step re-validates them behind the new typed interface, not from scratch).
4. **`selectFulfillmentStrategy` validated with a real assertion, even with one connector**: given each `BRAND_POSITIONING_TYPES` slug, confirm it returns Printful with a real, non-empty `rationale` string, not that it silently no-ops or throws on an unrecognized positioning.
5. **A real functional walkthrough of the full guided flow** against a disposable test account: business-model question branches correctly (both the `product_sales` path and at least one non-ecommerce fallback), brand-positioning question is asked and classified, Printful connect round-trips through the new draft-phase callback route, a real candidate is browsed/costed/priced with a brand-aware recommendation, and `confirmStoreDraftCore` produces a `Store` (with `brandPositioning` set) + `Product` + `StoreIntegration` atomically with the right fields populated. Clean up disposable test data afterward, per this session's established data-safety discipline.
6. **Confirm the mental-model rule holds**: grep the actual UI copy shipped for this flow for "Printful" — should find zero user-facing occurrences (the only legitimate occurrence is `StoreIntegration.provider`'s stored value and code comments, never rendered copy).
7. **A real draft order is created and safely torn down** against the live Printful sandbox as part of this verification, confirmed still `status: "draft"`/un-billed, same safety posture already established.

## 10. Open items for Sean before/at freeze

Rollout gating (section 8) and the entry-point proposal are resolved directly above. One real item remains:

1. **The actual margin bands per brand-positioning slug** (`ONBOARDING_V2_DESIGN.md` section 10, item 5) — e.g. what `recommendPrice` should target for `luxury` vs. `budget` vs. `professional`, etc. This is real pricing-strategy content, deliberately not invented in this plan with false precision (see `ONBOARDING_V2_DESIGN.md` section 9's non-goals) — needs Sean's input once implementation reaches this specific function, not before.

Once this is set (or Sean is comfortable with a reasonable placeholder per band that gets tuned after real data comes in), this plan is ready for the same freeze → implement → verify cycle as `PHASE1_DESIGN.md`.
