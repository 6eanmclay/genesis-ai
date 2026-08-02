# Onboarding v2 design: from a generated website to a real, sellable business

**Status:** Design frozen — approved by Sean 2026-08-02 as the implementation blueprint. Not yet implemented; running in parallel with Phase 1 (Business Event Pipeline, see `PHASE1_DESIGN.md`), which continues unaffected. Business-model classification (section 4) established as the true first step of onboarding, gating which path — ecommerce or otherwise — Genesis takes next. Fulfillment is a provider-agnostic **strategy** Genesis evaluates internally (section 6), not a choice the owner makes — Printful is the first implementation behind that strategy, not the architecture itself.

## The north star

**Genesis's goal is not to generate a website. Its goal is to launch a real business.** Every onboarding decision — what to ask, what to build, what to skip — is judged against one question: does this get the owner to their **first real transaction** faster, or does it just produce more generated content around one? A finished storefront with no way to transact is not a finished onboarding, no matter how complete it looks.

"First transaction" is not exclusively ecommerce vocabulary, even though ecommerce (section 6) is the only path fully designed so far:

| Business model | The equivalent first transaction |
|---|---|
| Ecommerce (physical products) | First order placed on a real, published, fulfillable product |
| Digital products | First digital product sold and delivered |
| Services | First service booked and paid for |
| Bookings | First confirmed, paid booking |
| Memberships/subscriptions | First paying subscriber |
| Donations/nonprofits | First donation received |
| Other | Defined per case, once that model gets its own design pass |

This table is the lens future onboarding work should be evaluated through, not a commitment to build all seven rows now (see section 9's non-goals) — but it's why section 4's business-model question comes first, and why section 7's ecommerce flow doesn't stop at "a product exists," it goes all the way to "a customer could buy it right now."

**A note on plainer language Sean has used for the same idea** — "creators," "local businesses," and similar audience-facing framings aren't additional rows this taxonomy needs. They're business *archetypes*, not revenue mechanisms: a creator's real first transaction is still one of the rows above depending on what they actually sell (a paid newsletter is `subscriptions`; a course is `digital_products`; a commission is `service_fees`) — same for a local business (a shop is `product_sales`; a salon is `bookings_appointments`). The seven-row taxonomy already generalizes to these without new slots; what changes per archetype is which row(s) apply and how Genesis's discovery question is phrased in the owner's own words, not the underlying classification. Worth stating explicitly so a future contributor doesn't add parallel "creator" or "local business" taxonomy entries that would just fragment classification the existing rows already handle.

## 1. The philosophy shift

Today, onboarding succeeds when a `StoreDraft` becomes a published `Store` with AI-generated copy, theme, and even draft products (see section 2). It can succeed with an empty or placeholder catalog — nothing forces the products to be real or sellable, and nothing asks whether "products" is even the right frame for this business.

The new success criteria for an ecommerce business (Sean's words): a new owner finishes onboarding with a live website, at least one real product, a connected fulfillment method, payments enabled, and that product immediately purchasable. Not a website — a business.

But that's the ecommerce outcome specifically, not the universal one. Sean's broader instruction: **J4's first responsibility is to understand what kind of business the owner wants to build, before assuming what onboarding should even look like.** A services business, a subscription/membership business, or a nonprofit doesn't have "a product with a fulfillment cost" at all — the current design (and today's actual code, see section 3d) quietly assumes ecommerce by always generating draft products regardless of what the business actually is. This document now treats business-model classification as the real first step, with the Printful-backed ecommerce flow as the first (and, for this pass, only) fully-designed path that follows it.

This is a genuine expansion of what Genesis does, not a UI change to the existing flow: it requires Genesis to help source *what* to sell and *how it gets fulfilled* for ecommerce specifically, and to correctly recognize when a business isn't ecommerce at all — neither of which today's product model, connector framework, or generation flow have any concept of (confirmed below, not assumed).

## 2. What already exists and reuses cleanly

- **The AI already generates draft products during store generation.** `productsDraft` on `StoreDraft` (`prisma/schema.prisma`) holds AI-authored `name`/`description`/`price`/`keyFeatures`/`benefits`/`specifications`/`imagePrompt` per product (`ProductBlueprintSchema`, `app/dashboard/ai-actions.ts`), created alongside the real `Product` rows in the same `prisma.store.create` on confirm (`confirmStoreDraftCore`). So "Genesis proposes products" is not new — what's missing is **whether those products are real and fulfillable, and whether this business should have products generated for it at all**, not whether product generation exists.
- **A revenue-stream classification taxonomy already exists** — `REVENUE_STREAM_TYPES` (`lib/businessTaxonomy.ts`): `product_sales`, `service_fees`, `subscriptions`, `bookings_appointments`, `commissions`, `rentals`, `licensing`, `advertising`, `donations`, `other`. This is exactly the axis Sean's business-model question needs (see section 4) — reused, not reinvented.
- **The propose → pending → confirm chat pattern** (`applyGenesisMessage`/`applyGenesisMessageToStore`) already persists full conversation history and supports a multi-turn back-and-forth with a pending-change/confirm step. This is the right substrate for a guided flow — but see the real gap in section 3.
- **The Integration Framework's auth contract reuses directly**: `IntegrationConnector`'s `connect`/`verify`/`disconnect`/`status` shape (OAuth redirect, API-key form, or one-step connect — `lib/integrations/types.ts`) and the `StoreIntegration` model (per-provider credentials, status, sync-scheduling) need no new architecture to add a fulfillment provider as a new `IntegrationProvider` enum value and registry entry. Directly confirmed against a real Printful OAuth flow (section 6): authorize URL → redirect with code → token exchange → refresh token, the same shape already used for Stripe/QuickBooks/Google Calendar.

## 3. What doesn't exist and has to be designed — the real gap

Five things confirmed genuinely absent, not just unbuilt UI:

**(a) `Product` has no cost or fulfillment concept at all.** `priceInCents` is the only money field on the model — no `costInCents`, no supplier/fulfillment link. "Supplier" as a concept exists exactly once in the codebase (`lib/businessModel/profile.ts`, a `Contact` tagged with a `vendor` role for Genesis's own business-understanding narration) and has zero connection to `Product` or to any real catalog or ordering flow.

**(b) Every existing connector's `sync()` pulls the store's *own* business activity out of a system the merchant already owns (QuickBooks invoices, Stripe payments) and writes into the generic `BusinessRecord` table — read-only by explicit design** (`lib/integrations/types.ts`: "never writes back to the provider"). A fulfillment/supplier connector is structurally the opposite on every axis: it pulls a *third party's product catalog* (not the store's own data), writes into the **typed** `Product` table (not `BusinessRecord`'s JSON blob), and — eventually — needs to *write* an order back to the supplier when a customer buys, which no existing connector does or was designed to do. The `connect`/`verify`/`disconnect` contract reuses; `sync()`'s direction and target do not.

**(c) There is no proactive, multi-turn guided-interview mechanism in Genesis's chat today.** The propose/confirm pattern only resolves ambiguity *within* whatever the user just typed (e.g. an ambiguous image-edit request). Nothing today drives a sequence like "what kind of business → who's your customer → do you have a supplier already" independent of user-initiated turns. This needs new orchestration, not just new prompts.

**(d) Revenue-stream classification runs *after* generation today, as a label — never as a gate.** Traced directly in `app/dashboard/ai-actions.ts`: `businessCategories`/`revenueStreams` are classified by a *secondary* AI call that runs **concurrently with**, not before, the primary generation call that already produces `productsDraft` — the comment there is explicit that this classification is "for internal use only... none of this is shown to the customer," used downstream for Recommended Connections, not for deciding what to generate. Concretely: **today, every business gets draft products generated for it, regardless of whether it's actually an ecommerce business** — the classification exists, but nothing gates on it. This is the specific gap section 4 closes.

**(e) There is no closed, upfront brand-positioning classification — only free-text prose, generated after the fact.** Checked directly: `blueprint.brandIdentity.brandPersonality` (`lib/execution/genesisActions.ts:348`, `lib/execution/executables/updateBrandIdentity.ts:12`) is a free-text `z.string()` — AI-authored descriptive prose (e.g. "warm, playful, approachable"), not a small closed slug an owner explicitly picks or a downstream system can branch on. This is the exact same shape of gap as (d) was for revenue streams before this document closed it: real content exists, but nothing upfront and classifiable. Section 5 closes this one the same way section 4 closed (d).

## 4. Business-model classification: the real first step of onboarding

**Genesis must know what kind of business it's building before it decides how to build it.** Reusing the existing `REVENUE_STREAM_TYPES` taxonomy (section 2) rather than inventing a parallel one, mapped to Sean's seven categories:

| Sean's category | Taxonomy slug | Status |
|---|---|---|
| Ecommerce (physical products) | `product_sales` | Existing slug — but see the real gap below |
| Digital products | *(none — new)* | **Gap found**: the existing taxonomy has no distinct slug for digital goods; `product_sales` today conflates physical and digital, but they need different onboarding paths (one has a fulfillment/shipping cost, one doesn't). Proposed additive fix: add `digital_products` to `REVENUE_STREAM_TYPES` — matches that file's own "small, open, purely additive" design already used for prior additions. |
| Services | `service_fees` | Existing slug |
| Memberships/subscriptions | `subscriptions` | Existing slug |
| Bookings | `bookings_appointments` | Existing slug |
| Donations/nonprofits | `donations` | Existing slug |
| Other future business models | `other` (plus `commissions`/`rentals`/`licensing`/`advertising`, already real slugs not on Sean's list but not in conflict with it) | Existing slugs |

**The architectural change this requires**: this classification has to move from *after* generation (today, section 3d) to *before* it — the literal first question in the guided discovery conversation (section 7), gating everything that follows rather than labeling it afterward. `productsDraft` generation, in particular, should only fire once the business is known to be product-selling (physical or digital), not unconditionally as it does today.

**Scope of this implementation pass, stated plainly**: only the **ecommerce (physical products)** path gets the full new experience designed in sections 5-7 — Genesis finds a product, knows the real fulfillment cost, understands the brand the owner wants to build, recommends a price, publishes a live business. Every other business model **falls back to today's existing generation flow** (AI writes copy/theme/positioning from the business description, no forced product generation) for now — which is not a regression, since that's what happens for every business today regardless of type. The branch point is real and gets built; only one branch has a fully designed destination yet. The other six are a real, acknowledged next horizon, not something this pass pretends to solve.

## 5. Brand positioning: the second classification axis

Sean's refinement: onboarding shouldn't reason about fulfillment and pricing from cost alone — it should first understand **what kind of brand the owner wants to build** (his examples: luxury, streetwear, minimalist, budget, family, professional), then let that shape everything downstream — which products get proposed, which fulfillment approach fits, and what margin makes sense. Section 3(e) confirmed this doesn't exist as classifiable data today, only as generated prose after the fact.

**Proposed additive fix, mirroring section 4's own pattern exactly**: a new `BRAND_POSITIONING_TYPES` taxonomy in `lib/businessTaxonomy.ts`, same shape as `REVENUE_STREAM_TYPES` (small, open, `other` fallback) — `luxury`, `streetwear`, `minimalist`, `budget`, `family`, `professional`, `other`. Collected as an explicit discovery-flow question (section 7), classified the same way revenue streams are (a small AI classification call against the owner's free-form answer), and — unlike `brandPersonality`'s free prose — usable as a real branching input, not just narrative flavor.

**Why this matters beyond pricing**: brand positioning isn't only a markup input. It should also shape *which product candidates Genesis proposes* in the first place (section 6) — a streetwear-positioned business and a minimalist-positioned one browsing the same underlying catalog should see different suggestions, not the same list with a different price sticker on it.

## 6. Fulfillment strategy: provider-agnostic evaluation, Printful is the first implementation

**The owner never chooses between fulfillment providers by name.** Sean's explicit correction to the previous version of this document: the owner picks the kind of brand they want to build (section 5); Genesis internally evaluates the available fulfillment partners against that brand, on quality, product selection, production cost, and brand fit, and recommends a strategy — explained to the owner in business terms (quality, price, expected margin), never as "Printful vs. Printify vs. Tapstitch." This is a stronger, more literal reading of the north star's "Genesis does as much of the discovery and setup work as possible" than the earlier version of this section had — evaluating and choosing is Genesis's job, not a menu handed to the owner.

**What this requires architecturally**: a small evaluation layer sitting above individual fulfillment connectors, not inside any one of them —

```ts
// lib/fulfillment/types.ts
interface FulfillmentPartnerProfile {
  provider: IntegrationProvider;   // never shown to the owner
  qualityTier: "standard" | "premium";
  costTier: "budget" | "mid" | "premium";
  brandFit: BrandPositioningSlug[]; // which brand positionings this partner suits well
}

interface FulfillmentConnector {
  provider: IntegrationProvider;
  profile: FulfillmentPartnerProfile;
  browseCandidates(query: { brandPositioning: BrandPositioningSlug; keywords?: string }): Promise<FulfillmentCandidate[]>;
  getCost(candidate, variant): Promise<FulfillmentCostEstimate>;
  createProduct(...): Promise<{ externalProductId: string }>;
  createDraftOrder(...): Promise<{ externalOrderId: string; costBreakdown: {...} }>;
}
```

```ts
// lib/fulfillment/strategy.ts
function selectFulfillmentStrategy(
  brandPositioning: BrandPositioningSlug,
  connectors: FulfillmentConnector[]
): { connector: FulfillmentConnector; rationale: string }
```

**The honest state of this today**: with exactly one fulfillment connector implemented (Printful), `selectFulfillmentStrategy` has exactly one real candidate to evaluate — the function's *output* is trivially Printful every time. What this section commits to is the *shape*: `selectFulfillmentStrategy` takes a brand positioning and a list of connectors, not a hardcoded provider, so adding a second specialized partner later (Sean named Tapstitch as one plausible example among others — not researched or validated in this document, cited only as evidence that "future providers" is a real, near-term expectation, not a hypothetical) is a new `FulfillmentConnector` + `FulfillmentPartnerProfile` registered alongside Printful's, not a rewrite of the onboarding flow or a new UI for the owner to navigate. This is the same "registry of N, only 1 implemented today" shape already proven by `lib/integrations/registry.ts` (5 real connectors) and reused deliberately, not invented fresh for fulfillment.

**Why Printful specifically is the first one built** — the evidence from the earlier version of this document still stands, unchanged, as the reason Printful was worth building *first*, not as a claim that it's the only one that will ever exist:

| Checked | Printful (built first) | Printify |
|---|---|---|
| OAuth fits our connector architecture | Yes — authorize → redirect+code → token exchange → refresh, same shape as Stripe/QuickBooks/Google Calendar | Yes, same shape, but a real ~1-week manual app-review process (Typeform) blocks going live |
| Cost visible before creating anything | **Yes** — real wholesale cost on the plain catalog/variant browse endpoint | No — cost only appears after a product is actually created in a shop |
| Asset workflow | Direct public image URL, one step | Two steps — must upload to Printify's own Uploads API first, then reference the returned internal id |
| Cost/price/profit data | **Handed back for free** — a live draft order returned `{"customer_pays": "30.98", "printful_price": "21.63", "profit": "9.35"}` with zero computation on our side | Cost (`cost`) and our set `price` both present post-creation, but no profit figure computed for us |
| Order safety / reversibility | Draft order (`status: "draft"`), never billed without a separate explicit confirm call we never made, cleanly deleted (`DELETE /orders/{id}` → 200) | Order landed in `status: "pending"` (also not billed), but the documented cancel endpoint rejected it (`"Order status does not allow cancellation"`) and there's no `DELETE` support — no confirmed API-only undo path |
| Retail pricing under merchant control | Yes | Yes |

Printify remains the natural second connector to add, once catalog diversity or a specific brand-fit gap justifies absorbing its OAuth review process — evaluated by `selectFulfillmentStrategy` alongside Printful at that point, not swapped in to replace it.

**User-facing mental model: the supplier is an implementation detail, never the experience.** The conversation is framed entirely in Genesis's own terms:

- "Genesis found a product."
- "Genesis knows the fulfillment cost."
- "Genesis recommends a selling price."
- "How much profit would you like to make per sale?"

No provider branding, no "connect your Printful account" language, no provider-specific terminology surfaced anywhere in the guided flow. `StoreIntegration.provider` still records which connector is actually in use (needed for the real API calls and future support/debugging), but that's backend bookkeeping — it must never leak into copy the owner reads. This is a hard UX constraint on section 7's discovery conversation, not a suggestion.

## 7. Proposed shape (design only — remaining sequencing questions are in section 10)

**Discovery conversation.** A new guided flow, distinct from the existing free-form chat, driving a state machine attached to `StoreDraft`, reusing its existing `pendingChange` mechanism for each step's proposal instead of inventing a second confirm pattern. This is new orchestration code, not a prompt change — it needs its own explicit state (which question the flow is on, what's been answered) rather than being re-derived from free-form chat history each time. Question order:

1. **What kind of business do you want to build?** — free-form, classified into a `REVENUE_STREAM_TYPES` slug (section 4) before anything else happens. This gate decides everything downstream.
2. *(Ecommerce path only, from here)* Who's your target customer, and **what kind of brand do you want this to be** — free-form, classified into a `BRAND_POSITIONING_TYPES` slug (section 5).
3. Do you already have products, or should Genesis help find some?

**Two branches after the product question, ecommerce path only:**
- **"I have products"** — extends the existing manual/AI product-creation path to also collect a real `costInCents` (optional, since not every owner knows or wants to share cost) instead of inventing a new import mechanism from scratch.
- **"Help me find something to sell"** — Genesis calls `selectFulfillmentStrategy(brandPositioning, connectors)` (section 6) to pick the right partner internally, then that partner's `browseCandidates({ brandPositioning, ... })` to propose a small number of real, fulfillable, brand-appropriate candidates — never named by provider. Owner picks one. Zero upfront inventory risk to the owner.

**Non-ecommerce answers to question 1** exit this guided flow after classification and fall back to today's existing generation path (section 4) — not designed further in this pass.

**Pricing step — brand-aware, not a flat default.** Once a cost is known (from the fulfillment interface or manually entered), Genesis proposes a default retail price grounded in **both** the real fulfillment cost **and** the brand positioning from step 2 — a luxury or professional positioning supports a materially different margin than a budget or family one, even against the identical underlying cost. The exact margin *bands* per positioning are product/pricing content, not architecture, and are deliberately not hardcoded with false precision in this document (see section 9's non-goals) — what's decided here is that the recommendation function takes brand positioning as a real input (`recommendPrice(costInCents, shippingInCents, brandPositioning)`), not that it ignores it in favor of one universal number. The owner always sees the resulting profit per sale next to the price, and always retains full control to move the markup up or down — fixed amount, percentage, or fully custom — before publishing. Genesis recommends; the owner decides. Where a connector's own draft-order response already computes cost/profit for a connector-fulfilled product (confirmed for Printful), the UI uses that real figure directly rather than recomputing it, falling back to a local computation only for manually-entered-cost products with no connector behind them.

**Data model (additive only, matching this project's migration discipline):** `costInCents Int?`, `fulfillmentProvider IntegrationProvider?`, `externalProductId String?`, and `externalVariantId String?` on `Product` — recording *that* a product is fulfilled externally, by what, and which specific catalog variant, without yet building the "route the order to the supplier automatically" execution logic (see non-goals). Also additive: `brandPositioning String?` on both `Store` and `StoreDraft` (same draft-stage-copy pattern already used for `businessCategories`/`revenueStreams`), the new `digital_products` slug on `REVENUE_STREAM_TYPES` (section 4), and the new `BRAND_POSITIONING_TYPES` taxonomy (section 5).

## 8. Success-criteria mapping (ecommerce path)

| Sean's criterion | How this design satisfies it |
|---|---|
| Live website | Unchanged — existing `StoreDraft` → `Store` flow |
| At least one real product | Discovery flow's product step, either branch, chosen to fit the owner's stated brand |
| Connected fulfillment method | Internally selected by `selectFulfillmentStrategy` (Printful today), reusing the Integration Framework's auth contract, never named as such to the owner |
| Payments enabled | Unchanged — existing Stripe/PayPal connect, just sequenced into the same guided flow instead of a separate later step |
| Product immediately purchasable | `active: true` + a real, brand-aware price, same as today, just guaranteed by the flow instead of merely possible |

Non-ecommerce business models don't have an equivalent table yet — that's the honest state of section 4's scope boundary, not an oversight.

## 9. Explicit non-goals for this design pass

- **Designing the onboarding path for services, digital products, subscriptions, bookings, or donations/nonprofits.** Section 4 establishes that these are real, distinct classifications and that the branch point exists — it does not design what happens on any of those six branches. Each is its own future design pass.
- **Automatic order-to-supplier routing** (when a customer buys, actually placing the order with the fulfillment partner) — a real, separate execution-engine capability. This design only makes the *fact* of a connected fulfillment method representable; wiring a real purchase through to it is next-phase work, sequenced after this if approved.
- **Building a second fulfillment connector now** (Printify, Tapstitch, or otherwise) — `selectFulfillmentStrategy` is architected for N connectors (section 6), but only Printful is actually built this pass.
- **Hardcoding specific margin percentages per brand-positioning band.** Section 7 decides that pricing recommendations take brand positioning as a real input; it deliberately does not decide the exact numbers per band — that's tunable pricing content, to be set (and iterated on with real data) at implementation time, not invented here with false precision.
- **Multi-partner catalog browsing/search UX** — the first version can be "Genesis proposes a small number of fitting products from the internally-selected partner's catalog," not a full marketplace browser.
- **Replacing the existing free-form chat** — the guided discovery flow is a new, bounded onboarding-time sequence, not a redesign of ongoing Genesis chat.

## 10. Open decisions that still need Sean, not engineering judgment

1. ~~Which fulfillment/POD provider to build first~~ — **resolved, section 6: Printful, behind a provider-agnostic evaluation layer.**
2. **Whether automatic order-to-supplier routing is in scope for "launch a real business" or a deliberate fast-follow.** Affects how much of this to build before the first real user goes through it.
3. **Whether the guided discovery flow replaces or sits alongside today's "generate immediately" path** — i.e. does every new user go through discovery, or is it offered as an option alongside today's flow during a transition period.
4. **Which non-ecommerce business model gets a real designed path next**, once the ecommerce path has shipped and been validated with real users — services and subscriptions/memberships are the most structurally different from ecommerce (no unit cost/fulfillment concept at all) and are likely candidates, but this is a real product-sequencing decision, not one to make unilaterally here.
5. **The actual margin bands per brand positioning** (section 9's non-goal) — real pricing-strategy content, to be defined once implementation planning reaches that level of detail.

## 11. Design frozen — implementation begins

Approved by Sean 2026-08-02 as the implementation blueprint for the ecommerce onboarding path, refined the same day to make fulfillment a provider-agnostic, brand-fit-driven strategy rather than a fixed provider choice or a flat default margin. Items 2-5 in section 10 remain open and should be resolved during implementation, not treated as blocking this freeze the way item 1 (fulfillment architecture) did — they're sequencing/scope/content questions, not open architecture.

**Final architectural principle, Sean's words**: *fulfillment is one execution strategy, not something the platform is permanently centered around.* Stated precisely so it doesn't erode as code gets written: `lib/fulfillment/` (section 6, `ONBOARDING_V2_IMPLEMENTATION.md` section 2) is the **ecommerce path's own** strategy module, invoked by the generic discovery-flow orchestrator (`lib/onboarding/discoveryFlow.ts`) only when business-model classification (section 4) resolves to `product_sales`/`digital_products` — the orchestrator itself never imports from or knows the internal shape of `lib/fulfillment/`. A future services path gets its own strategy module (e.g. a `lib/booking/` implementing whatever *its* first-transaction mechanics are) invoked the identical way, sitting completely outside `lib/fulfillment/`, never forced through fulfillment-shaped types or naming. The north star's per-business-model "first transaction" table (top of this document) is the reason this separation exists: onboarding is fundamentally "classify, then run the right strategy toward that model's first transaction," and ecommerce/fulfillment happens to be the first strategy built, not a template the others must resemble.

Next step: implementation, per `ONBOARDING_V2_IMPLEMENTATION.md` (also frozen 2026-08-02). The north star above is the standing lens for every onboarding decision after this, not just this document — if a future addition to the ecommerce flow, or the eventual design of any other business model's path, doesn't shorten the road to that model's first real transaction, it needs a better reason to exist than "it seemed useful."

Worth noting for later, not acted on here: this reframing — Genesis as an AI that understands what business someone wants to create and gets them to their first real transaction, not an AI website builder — is a big enough shift that `VISION.md` will likely want a matching update once the ecommerce path has shipped and proven itself, not as part of this design doc.
