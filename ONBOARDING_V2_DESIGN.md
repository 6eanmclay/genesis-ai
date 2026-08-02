# Onboarding v2 design: from a generated website to a real, sellable business

**Status:** Draft — a design pass only, per Sean's explicit instruction to design this before writing any more onboarding code. Not implemented. Running in parallel with Phase 1 (Business Event Pipeline, see `PHASE1_DESIGN.md`), which continues unaffected.

## 1. The philosophy shift

Today, onboarding succeeds when a `StoreDraft` becomes a published `Store` with AI-generated copy, theme, and even draft products (see section 2). It can succeed with an empty or placeholder catalog — nothing forces the products to be real or sellable.

The new success criteria (Sean's words): a new owner finishes onboarding with a live website, at least one real product, a connected fulfillment method, payments enabled, and that product immediately purchasable. Not a website — a business.

This is a genuine expansion of what Genesis does, not a UI change to the existing flow: it requires Genesis to help source *what* to sell and *how it gets fulfilled*, which today's product model and connector framework have no concept of at all (confirmed below, not assumed).

## 2. What already exists and reuses cleanly

- **The AI already generates draft products during store generation.** `productsDraft` on `StoreDraft` (`prisma/schema.prisma`) holds AI-authored `name`/`description`/`price`/`keyFeatures`/`benefits`/`specifications`/`imagePrompt` per product (`ProductBlueprintSchema`, `app/dashboard/ai-actions.ts`), created alongside the real `Product` rows in the same `prisma.store.create` on confirm (`confirmStoreDraftCore`). So "Genesis proposes products" is not new — what's missing is **whether those products are real and fulfillable**, not whether they exist.
- **The propose → pending → confirm chat pattern** (`applyGenesisMessage`/`applyGenesisMessageToStore`) already persists full conversation history and supports a multi-turn back-and-forth with a pending-change/confirm step. This is the right substrate for a guided flow — but see the real gap in section 4.
- **The Integration Framework's auth contract reuses directly**: `IntegrationConnector`'s `connect`/`verify`/`disconnect`/`status` shape (OAuth redirect, API-key form, or one-step connect — `lib/integrations/types.ts`) and the `StoreIntegration` model (per-provider credentials, status, sync-scheduling) need no new architecture to add a fulfillment provider as a new `IntegrationProvider` enum value and registry entry.

## 3. What doesn't exist and has to be designed — the real gap

Two things confirmed genuinely absent, not just unbuilt UI:

**(a) `Product` has no cost or fulfillment concept at all.** `priceInCents` is the only money field on the model — no `costInCents`, no supplier/fulfillment link. "Supplier" as a concept exists exactly once in the codebase (`lib/businessModel/profile.ts`, a `Contact` tagged with a `vendor` role for Genesis's own business-understanding narration) and has zero connection to `Product` or to any real catalog or ordering flow.

**(b) Every existing connector's `sync()` pulls the store's *own* business activity out of a system the merchant already owns (QuickBooks invoices, Stripe payments) and writes into the generic `BusinessRecord` table — read-only by explicit design** (`lib/integrations/types.ts`: "never writes back to the provider"). A fulfillment/supplier connector is structurally the opposite on every axis: it pulls a *third party's product catalog* (not the store's own data), writes into the **typed** `Product` table (not `BusinessRecord`'s JSON blob), and — eventually — needs to *write* an order back to the supplier when a customer buys, which no existing connector does or was designed to do. The `connect`/`verify`/`disconnect` contract reuses; `sync()`'s direction and target do not.

**(c) There is no proactive, multi-turn guided-interview mechanism in Genesis's chat today.** The propose/confirm pattern only resolves ambiguity *within* whatever the user just typed (e.g. an ambiguous image-edit request). Nothing today drives a sequence like "what kind of business → who's your customer → do you have a supplier already" independent of user-initiated turns. This needs new orchestration, not just new prompts.

## 4. Proposed shape (design only — sequencing and vendor choice are open, see section 7)

**Discovery conversation.** A new guided flow, distinct from the existing free-form chat: a small fixed sequence of questions (business idea / target customer / "do you already have products, or should I help find some") driving a state machine attached to `StoreDraft`, reusing its existing `pendingChange` mechanism for each step's proposal instead of inventing a second confirm pattern. This is new orchestration code, not a prompt change — it needs its own explicit state (which question the flow is on, what's been answered) rather than being re-derived from free-form chat history each time.

**Two branches after discovery:**
- **"I have products"** — extends the existing manual/AI product-creation path to also collect a real `costInCents` (optional, since not every owner knows or wants to share cost) instead of inventing a new import mechanism from scratch.
- **"Help me find something to sell"** — needs a real fulfillment/supplier connector. Print-on-demand (POD) platforms (the category, not naming a specific vendor here) are the most concretely buildable first target: they expose real product catalogs and real per-unit cost via a documented API, require no upfront inventory purchase, and their unit economics match Sean's own example almost exactly (supplier cost → markup → margin). Wholesale/dropship marketplaces are a plausible later addition but are more fragmented (many lack a clean public API) and would be a second connector, not a variant of the first.

**Pricing UI.** Once a cost is known (from a connector or manually entered), a small pricing step offers: accept a recommended price (a simple, transparent multiplier — not an AI guess), fixed markup, percentage markup, or fully custom, always showing the resulting profit per sale before the owner confirms. This is UI/computation, not a new data concept beyond `costInCents` below.

**Data model (additive only, matching this project's migration discipline):** `costInCents Int?` and two new nullable fields on `Product` — a `fulfillmentProvider` (mirrors `StoreIntegration.provider`) and an `externalProductId` — recording *that* a product is fulfilled externally and by what, without yet building the "route the order to the supplier automatically" execution logic. That's a real, separate capability (see non-goals) but the schema should be able to represent the fact from day one so it isn't a second migration later.

## 5. Success-criteria mapping

| Sean's criterion | How this design satisfies it |
|---|---|
| Live website | Unchanged — existing `StoreDraft` → `Store` flow |
| At least one real product | Discovery flow's product step, either branch |
| Connected fulfillment method | New POD connector, reusing the Integration Framework's auth contract |
| Payments enabled | Unchanged — existing Stripe/PayPal connect, just sequenced into the same guided flow instead of a separate later step |
| Product immediately purchasable | `active: true` + a real price, same as today, just guaranteed by the flow instead of merely possible |

## 6. Explicit non-goals for this design pass

- **Automatic order-to-supplier routing** (when a customer buys, actually placing the order with the POD/fulfillment provider) — a real, separate execution-engine capability. This design only makes the *fact* of a connected fulfillment method representable; wiring a real purchase through to it is next-phase work, sequenced after this if approved.
- **Naming a specific POD/dropship vendor to integrate first** — a real vendor/API/pricing/contract decision, not an engineering one; flagged for Sean in section 7, not decided here.
- **Multi-supplier catalog browsing/search UX** — the first version can be "Genesis proposes a small number of fitting products from the connected catalog," not a full marketplace browser.
- **Replacing the existing free-form chat** — the guided discovery flow is a new, bounded onboarding-time sequence, not a redesign of ongoing Genesis chat.

## 7. Open decisions that need Sean, not engineering judgment

1. **Which fulfillment/POD provider to integrate first.** This determines API shape, cost-data availability, and account/contract setup — a real business decision, not something to pick unilaterally.
2. **Whether automatic order-to-supplier routing is in scope for "launch a real business" or a deliberate fast-follow.** Affects how much of this to build before the first real user goes through it.
3. **Whether the guided discovery flow replaces or sits alongside today's "generate immediately" path** — i.e. does every new user go through discovery, or is it offered as an option alongside today's flow during a transition period.

## 8. Next step

Once Sean has weighed in on section 7, this doc gets a real implementation plan (component/file breakdown, migration, connector spec) in the same shape as `PHASE1_DESIGN.md`, then goes through the same freeze → implement → verify cycle as every other design in this codebase.
