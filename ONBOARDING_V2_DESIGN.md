# Onboarding v2 design: from a generated website to a real, sellable business

**Status:** Design frozen — approved by Sean 2026-08-02 as the implementation blueprint. Not yet implemented; running in parallel with Phase 1 (Business Event Pipeline, see `PHASE1_DESIGN.md`), which continues unaffected. Fulfillment provider decided (section 5) via empirical validation against both candidates' real APIs. Business-model classification (section 4) established as the true first step of onboarding, gating which path — ecommerce or otherwise — Genesis takes next.

## The north star

**Genesis's goal is not to generate a website. Its goal is to launch a real business.** Every onboarding decision — what to ask, what to build, what to skip — is judged against one question: does this get the owner to their **first real transaction** faster, or does it just produce more generated content around one? A finished storefront with no way to transact is not a finished onboarding, no matter how complete it looks.

"First transaction" is not exclusively ecommerce vocabulary, even though ecommerce (section 5) is the only path fully designed so far:

| Business model | The equivalent first transaction |
|---|---|
| Ecommerce (physical products) | First order placed on a real, published, fulfillable product |
| Digital products | First digital product sold and delivered |
| Services | First service booked and paid for |
| Bookings | First confirmed, paid booking |
| Memberships/subscriptions | First paying subscriber |
| Donations/nonprofits | First donation received |
| Other | Defined per case, once that model gets its own design pass |

This table is the lens future onboarding work should be evaluated through, not a commitment to build all seven rows now (see section 8's non-goals) — but it's why section 4's business-model question comes first, and why section 6's ecommerce flow doesn't stop at "a product exists," it goes all the way to "a customer could buy it right now."

## 1. The philosophy shift

Today, onboarding succeeds when a `StoreDraft` becomes a published `Store` with AI-generated copy, theme, and even draft products (see section 2). It can succeed with an empty or placeholder catalog — nothing forces the products to be real or sellable, and nothing asks whether "products" is even the right frame for this business.

The new success criteria for an ecommerce business (Sean's words): a new owner finishes onboarding with a live website, at least one real product, a connected fulfillment method, payments enabled, and that product immediately purchasable. Not a website — a business.

But that's the ecommerce outcome specifically, not the universal one. Sean's broader instruction: **J4's first responsibility is to understand what kind of business the owner wants to build, before assuming what onboarding should even look like.** A services business, a subscription/membership business, or a nonprofit doesn't have "a product with a fulfillment cost" at all — the current design (and today's actual code, see section 3d) quietly assumes ecommerce by always generating draft products regardless of what the business actually is. This document now treats business-model classification as the real first step, with the Printful-backed ecommerce flow as the first (and, for this pass, only) fully-designed path that follows it.

This is a genuine expansion of what Genesis does, not a UI change to the existing flow: it requires Genesis to help source *what* to sell and *how it gets fulfilled* for ecommerce specifically, and to correctly recognize when a business isn't ecommerce at all — neither of which today's product model, connector framework, or generation flow have any concept of (confirmed below, not assumed).

## 2. What already exists and reuses cleanly

- **The AI already generates draft products during store generation.** `productsDraft` on `StoreDraft` (`prisma/schema.prisma`) holds AI-authored `name`/`description`/`price`/`keyFeatures`/`benefits`/`specifications`/`imagePrompt` per product (`ProductBlueprintSchema`, `app/dashboard/ai-actions.ts`), created alongside the real `Product` rows in the same `prisma.store.create` on confirm (`confirmStoreDraftCore`). So "Genesis proposes products" is not new — what's missing is **whether those products are real and fulfillable, and whether this business should have products generated for it at all**, not whether product generation exists.
- **A revenue-stream classification taxonomy already exists** — `REVENUE_STREAM_TYPES` (`lib/businessTaxonomy.ts`): `product_sales`, `service_fees`, `subscriptions`, `bookings_appointments`, `commissions`, `rentals`, `licensing`, `advertising`, `donations`, `other`. This is exactly the axis Sean's business-model question needs (see section 4) — reused, not reinvented.
- **The propose → pending → confirm chat pattern** (`applyGenesisMessage`/`applyGenesisMessageToStore`) already persists full conversation history and supports a multi-turn back-and-forth with a pending-change/confirm step. This is the right substrate for a guided flow — but see the real gap in section 3.
- **The Integration Framework's auth contract reuses directly**: `IntegrationConnector`'s `connect`/`verify`/`disconnect`/`status` shape (OAuth redirect, API-key form, or one-step connect — `lib/integrations/types.ts`) and the `StoreIntegration` model (per-provider credentials, status, sync-scheduling) need no new architecture to add a fulfillment provider as a new `IntegrationProvider` enum value and registry entry. Directly confirmed against a real Printful OAuth flow (section 5): authorize URL → redirect with code → token exchange → refresh token, the same shape already used for Stripe/QuickBooks/Google Calendar.

## 3. What doesn't exist and has to be designed — the real gap

Four things confirmed genuinely absent, not just unbuilt UI:

**(a) `Product` has no cost or fulfillment concept at all.** `priceInCents` is the only money field on the model — no `costInCents`, no supplier/fulfillment link. "Supplier" as a concept exists exactly once in the codebase (`lib/businessModel/profile.ts`, a `Contact` tagged with a `vendor` role for Genesis's own business-understanding narration) and has zero connection to `Product` or to any real catalog or ordering flow.

**(b) Every existing connector's `sync()` pulls the store's *own* business activity out of a system the merchant already owns (QuickBooks invoices, Stripe payments) and writes into the generic `BusinessRecord` table — read-only by explicit design** (`lib/integrations/types.ts`: "never writes back to the provider"). A fulfillment/supplier connector is structurally the opposite on every axis: it pulls a *third party's product catalog* (not the store's own data), writes into the **typed** `Product` table (not `BusinessRecord`'s JSON blob), and — eventually — needs to *write* an order back to the supplier when a customer buys, which no existing connector does or was designed to do. The `connect`/`verify`/`disconnect` contract reuses; `sync()`'s direction and target do not.

**(c) There is no proactive, multi-turn guided-interview mechanism in Genesis's chat today.** The propose/confirm pattern only resolves ambiguity *within* whatever the user just typed (e.g. an ambiguous image-edit request). Nothing today drives a sequence like "what kind of business → who's your customer → do you have a supplier already" independent of user-initiated turns. This needs new orchestration, not just new prompts.

**(d) Revenue-stream classification runs *after* generation today, as a label — never as a gate.** Traced directly in `app/dashboard/ai-actions.ts`: `businessCategories`/`revenueStreams` are classified by a *secondary* AI call that runs **concurrently with**, not before, the primary generation call that already produces `productsDraft` — the comment there is explicit that this classification is "for internal use only... none of this is shown to the customer," used downstream for Recommended Connections, not for deciding what to generate. Concretely: **today, every business gets draft products generated for it, regardless of whether it's actually an ecommerce business** — the classification exists, but nothing gates on it. This is the specific gap section 4 closes.

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

**The architectural change this requires**: this classification has to move from *after* generation (today, section 3d) to *before* it — the literal first question in the guided discovery conversation (section 6), gating everything that follows rather than labeling it afterward. `productsDraft` generation, in particular, should only fire once the business is known to be product-selling (physical or digital), not unconditionally as it does today.

**Scope of this implementation pass, stated plainly**: only the **ecommerce (physical products)** path gets the full new experience designed in section 5 — Genesis finds a product, knows the real fulfillment cost, recommends a price, publishes a live business. Every other business model **falls back to today's existing generation flow** (AI writes copy/theme/positioning from the business description, no forced product generation) for now — which is not a regression, since that's what happens for every business today regardless of type. The branch point is real and gets built; only one branch has a fully designed destination yet. The other six are a real, acknowledged next horizon, not something this pass pretends to solve.

## 5. Fulfillment provider decision: Printful, empirically validated

**Decided, not just recommended** — confirmed by Sean after live validation against both candidates' real APIs (free sandbox accounts, real HTTP calls, nothing inferred from documentation alone). Full evidence:

| Checked | Printful (chosen) | Printify |
|---|---|---|
| OAuth fits our connector architecture | Yes — authorize → redirect+code → token exchange → refresh, same shape as Stripe/QuickBooks/Google Calendar | Yes, same shape, but a real ~1-week manual app-review process (Typeform) blocks going live |
| Cost visible before creating anything | **Yes** — real wholesale cost on the plain catalog/variant browse endpoint | No — cost only appears after a product is actually created in a shop |
| Asset workflow | Direct public image URL, one step | Two steps — must upload to Printify's own Uploads API first, then reference the returned internal id |
| Cost/price/profit data | **Handed back for free** — a live draft order returned `{"customer_pays": "30.98", "printful_price": "21.63", "profit": "9.35"}` with zero computation on our side | Cost (`cost`) and our set `price` both present post-creation, but no profit figure computed for us |
| Order safety / reversibility | Draft order (`status: "draft"`), never billed without a separate explicit confirm call we never made, cleanly deleted (`DELETE /orders/{id}` → 200) | Order landed in `status: "pending"` (also not billed), but the documented cancel endpoint rejected it (`"Order status does not allow cancellation"`) and there's no `DELETE` support — no confirmed API-only undo path |
| Retail pricing under merchant control | Yes | Yes |

**Printful is the launch fulfillment connector for the ecommerce path.** Printify remains documented as the planned second integration, to add once catalog diversity justifies absorbing its OAuth review process — not ruled out, just not first.

**This is an implementation choice, not an architectural commitment.** Genesis's long-term objective is fulfillment-provider abstraction: Printful is the launch implementation, not a dependency baked into the onboarding experience. Concretely:

- The connector code lives behind `lib/integrations/registry.ts`'s existing `getConnector(provider)` pattern, exactly like every other integration — no onboarding-flow code should import Printful's API shape directly. Onboarding calls a small provider-agnostic interface (browse candidates, get cost for a candidate, create a product, create a draft order) that Printful's connector implements today; a future Printify (or any other) connector implements the same interface without the onboarding flow changing.
- The two real differences surfaced above (cost visible pre- vs. post-creation; one-step vs. two-step asset upload) are exactly the kind of provider-specific detail this interface needs to absorb internally rather than leak into onboarding UI or Genesis's conversation logic.

**User-facing mental model: the supplier is an implementation detail, never the experience.** Sean's explicit instruction — Genesis never exposes "Printful" (or any provider name) as something the owner needs to know or think about. The conversation is framed entirely in Genesis's own terms:

- "Genesis found a product."
- "Genesis knows the fulfillment cost."
- "Genesis recommends a selling price."
- "How much profit would you like to make per sale?"

No provider branding, no "connect your Printful account" language, no provider-specific terminology surfaced anywhere in the guided flow. `StoreIntegration.provider` still records which connector is actually in use (needed for the real API calls and future support/debugging), but that's backend bookkeeping — it must never leak into copy the owner reads. This is a hard UX constraint on section 6's discovery conversation, not a suggestion.

## 6. Proposed shape (design only — remaining sequencing questions are in section 9)

**Discovery conversation.** A new guided flow, distinct from the existing free-form chat, driving a state machine attached to `StoreDraft`, reusing its existing `pendingChange` mechanism for each step's proposal instead of inventing a second confirm pattern. This is new orchestration code, not a prompt change — it needs its own explicit state (which question the flow is on, what's been answered) rather than being re-derived from free-form chat history each time. Question order:

1. **What kind of business do you want to build?** — free-form, classified into a `REVENUE_STREAM_TYPES` slug (section 4) before anything else happens. This gate decides everything downstream.
2. *(Ecommerce path only, from here)* Who's your target customer?
3. Do you already have products, or should Genesis help find some?

**Two branches after the product question, ecommerce path only:**
- **"I have products"** — extends the existing manual/AI product-creation path to also collect a real `costInCents` (optional, since not every owner knows or wants to share cost) instead of inventing a new import mechanism from scratch.
- **"Help me find something to sell"** — routes through the fulfillment-provider interface (section 5), backed by Printful today. Zero upfront inventory risk to the owner, and the interface's `getCost(candidate)` call is what feeds the pricing step below — narrated entirely in Genesis's own voice, never the provider's.

**Non-ecommerce answers to question 1** exit this guided flow after classification and fall back to today's existing generation path (section 4) — not designed further in this pass.

**Pricing step.** Once a cost is known (from the fulfillment interface or manually entered), Genesis proposes a **default price built on a healthy, named profit margin** — not a neutral or arbitrary multiplier — computed from the real fulfillment cost, the same way the validated Printful draft order already did for free ($21.63 all-in cost → $24.99 retail → $9.35 profit, roughly a 30% margin, in the real test in section 5). The owner always sees the resulting profit per sale next to the price, and always retains full control to move the markup up or down — fixed amount, percentage, or fully custom — before publishing. Genesis recommends; the owner decides. Where Printful's own draft-order response already computes customer-pays/cost/profit for a Printful-fulfilled product, the UI uses that real figure directly rather than recomputing it, falling back to a local computation only for manually-entered-cost products with no connector behind them.

**Data model (additive only, matching this project's migration discipline):** `costInCents Int?` and two new nullable fields on `Product` — a `fulfillmentProvider` (mirrors `StoreIntegration.provider`) and an `externalProductId` — recording *that* a product is fulfilled externally and by what, without yet building the "route the order to the supplier automatically" execution logic. That's a real, separate capability (see non-goals) but the schema should be able to represent the fact from day one so it isn't a second migration later. Also additive: the new `digital_products` slug on `REVENUE_STREAM_TYPES` (section 4).

## 7. Success-criteria mapping (ecommerce path)

| Sean's criterion | How this design satisfies it |
|---|---|
| Live website | Unchanged — existing `StoreDraft` → `Store` flow |
| At least one real product | Discovery flow's product step, either branch |
| Connected fulfillment method | Printful connector, reusing the Integration Framework's auth contract, never named as such to the owner |
| Payments enabled | Unchanged — existing Stripe/PayPal connect, just sequenced into the same guided flow instead of a separate later step |
| Product immediately purchasable | `active: true` + a real price, same as today, just guaranteed by the flow instead of merely possible |

Non-ecommerce business models don't have an equivalent table yet — that's the honest state of section 4's scope boundary, not an oversight.

## 8. Explicit non-goals for this design pass

- **Designing the onboarding path for services, digital products, subscriptions, bookings, or donations/nonprofits.** Section 4 establishes that these are real, distinct classifications and that the branch point exists — it does not design what happens on any of those six branches. Each is its own future design pass.
- **Automatic order-to-supplier routing** (when a customer buys, actually placing the order with Printful) — a real, separate execution-engine capability. This design only makes the *fact* of a connected fulfillment method representable; wiring a real purchase through to it is next-phase work, sequenced after this if approved.
- **Building the Printify connector now** — planned second integration (section 5), not part of this pass.
- **Multi-supplier catalog browsing/search UX** — the first version can be "Genesis proposes a small number of fitting products from the connected catalog," not a full marketplace browser.
- **Replacing the existing free-form chat** — the guided discovery flow is a new, bounded onboarding-time sequence, not a redesign of ongoing Genesis chat.

## 9. Open decisions that still need Sean, not engineering judgment

1. ~~Which fulfillment/POD provider to integrate first~~ — **resolved, section 5: Printful.**
2. **Whether automatic order-to-supplier routing is in scope for "launch a real business" or a deliberate fast-follow.** Affects how much of this to build before the first real user goes through it.
3. **Whether the guided discovery flow replaces or sits alongside today's "generate immediately" path** — i.e. does every new user go through discovery, or is it offered as an option alongside today's flow during a transition period.
4. **Which non-ecommerce business model gets a real designed path next**, once the ecommerce path has shipped and been validated with real users — services and subscriptions/memberships are the most structurally different from ecommerce (no unit cost/fulfillment concept at all) and are likely candidates, but this is a real product-sequencing decision, not one to make unilaterally here.

## 10. Design frozen — next step is implementation planning

Approved by Sean 2026-08-02 as the implementation blueprint for the ecommerce onboarding path. Items 2-4 in section 9 remain open and should be resolved before or during implementation planning, not treated as blocking this freeze the way item 1 (fulfillment provider) did — they're sequencing/scope questions, not open architecture.

Next step: a real implementation plan (component/file breakdown, migration, connector spec) in the same shape as `PHASE1_DESIGN.md`, then the same freeze → implement → verify cycle as every other design in this codebase. The north star above is the standing lens for that plan and for every onboarding decision after it, not just this document — if a future addition to the ecommerce flow, or the eventual design of any other business model's path, doesn't shorten the road to that model's first real transaction, it needs a better reason to exist than "it seemed useful."

Worth noting for later, not acted on here: this reframing — Genesis as an AI that understands what business someone wants to create and gets them to their first real transaction, not an AI website builder — is a big enough shift that `VISION.md` will likely want a matching update once the ecommerce path has shipped and proven itself, not as part of this design doc.
