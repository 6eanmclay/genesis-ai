# Work Studio: Asset → Design → Product → Provider

**Status: the whole chain exists.** Design landed 2026-08-16, verified end to end on the real database and real image pipeline (`lib/design/`). What remains is the Studio surface, Printify as a second connector, and composition intelligence. The audit below is real, taken from the code on 2026-08-16, not from memory. Nothing here authorizes building beyond the step marked as current.

```
Asset  →  Design  →  Product  →  Provider  →  Execution  →  Verification  →  Record
  ✓         ✓          ✓           ✓            ✓              ✓              ✓
```

The worked example this exists to make real, in Sean's words:

> *"Make me a logo."* → **Asset**
> *"Put that logo on a T-shirt."* → **Design** using that Asset → print-ready artwork + mockup
> *"Create the product."* → **Product** → provider → execution → verification → business record

> **The point is not the individual generations. It is that J4 understands the relationship between these objects instead of treating each request as an isolated generation.**

---

## What already exists

**The provider end is built, and built provider-agnostically.** `lib/fulfillment/types.ts` defines `FulfillmentConnector` — `browseCandidates`, `getCost`, `createProduct({ imageUrl, retailPriceInCents })`, `createDraftOrder`. Printful implements it; `registry.ts` and `strategy.ts` select one. The interface's own comment states the rule: **the owner never chooses a provider by name.** Printify is a new file implementing this interface, never an architecture change.

Deliberately separate from `IntegrationConnector` (read-only sync into `BusinessRecord`), and that split is correct: sync pulls your own data out of a system you own; fulfillment pushes into a third party's catalog.

**The execution spine is built.** `ExecutionResult` keeps `verified` explicitly separate from `status` — "independently confirmed, not just the call didn't throw" — with `recordExecution`, `BusinessRecord`, `ProductEvent`, and `Product.externalProductId`.

**The whole chain already runs once, in onboarding.** At store confirmation `ai-actions.ts` creates the Product, calls `connector.createProduct(...)`, writes back `externalProductId`, and records a `FAILED`/retryable execution honestly on failure. So `Product → Provider → Execution → Verification → Record` is proven against a real provider API.

**Assets are real objects as of `830788c`.** `AssetSchema` carries `role` (what it is *for*, as against `category`, what it *is*), `origin`, two-way supersession, and generation provenance. `lib/businessModel/assets.ts` resolves "the current brand logo" to a record rather than a column. Roles are open strings; nothing is logo-specific.

## What is missing

1. **The Design layer.** `createProduct` takes one finished print-ready `imageUrl`. Nothing composes *asset + surface + placement* into artwork, and nothing produces a mockup. This is not cosmetic: a catalog candidate's own image is **not** a valid print file, confirmed live against Printful.
2. **Conversational reach.** Every fulfillment call comes from onboarding. There is no `create_design` or `make_product` action in the registry, so J4 cannot do any of this after launch.
3. **The Studio surface.** No route, no component.
4. **Printify.** Only Printful exists. A connector, not a redesign.
5. **Asset backfill.** Stores created before `830788c` have a `Store.logoUrl` and no asset record, so "the logo" resolves only for new stores.

## Current step

**Finish Assets.** Everything above stays closed until designated assets resolve on a real store. Design comes next, then a conversational entry point, then Printify.

---

# Locked requirement: conversational branching

**Sean, 2026-08-16, mid-build. This is a general creative interaction pattern — logos, website layouts, product designs, hero sections, and eventually all of Work Studio.**

J4 makes its own informed first recommendation from Business Understanding. After the owner sees it, J4 can offer: *"I can show you a couple of other directions based on this if you'd like."* If the owner accepts, **the original is preserved** and the variations are generated as distinct creative directions.

> **They are not unrelated generations.** The owner must be able to say *"keep the symbol from the original but use the typography from option two"* and have J4 understand the relationship between those versions.

The fixed three-choice selector can still exist where it fits. It is one presentation, never the model.

**The owner remains the final creative authority.** J4 provides informed direction, alternatives, and refinement.

## The behavioural rule that governs all of it (locked 2026-08-16)

> **J4 must never pressure the owner into creating or changing a logo, design, or brand asset.**

- **If the owner already has a logo they want to use, accept it and work with that logo.** Never suggest replacing it merely because J4 *could* make something else. Capability is not a reason.
- **If the owner has no logo,** creation is offered as an optional capability.
- **If the owner seems uncertain,** J4 may gently offer alternatives — *"if you're not sure yet, I can show you a couple of other directions based on this."*
- **The offer is always optional, and a decline ends it immediately.** Not softened, not re-offered later in the same conversation.

> **J4's role is to be a creative business partner, not a salesperson. It should help the owner make decisions without creating pressure to make more decisions.**

This directly constrains the branching offer above: *"I can show you a couple of other directions"* is an offer, not a funnel. It is appropriate when the owner is genuinely undecided and inappropriate as a default follow-up to every generation. An offer that always fires is not an offer, it is a step in a flow.

It also constrains the asset layer. An existing designated `brand.logo` — uploaded, backfilled, or generated — is **the answer**, not an opening position. Same family as [[project_j4_trusted_advisor]]: recommend what fits what is actually there, never what produces more activity.

## The design consequence, found while building the logo action

This is why the requirement arriving mid-build mattered rather than being a note for later.

Every existing proposal path in this codebase **replaces**. `app/api/chat/route.ts` deletes the pending `update_product_image` approval before writing a new one; `lib/storefront/proposals.ts` marks the previous proposal `superseded`. Both are correct for "here is my current answer" and both **destroy exactly what branching needs**: after a revision, there is no "option two" left to refer back to.

So a creative generation cannot be modelled as a single pending approval that gets overwritten. It needs:

1. **Siblings that coexist.** Several live candidates at once, not one current answer.
2. **Lineage.** Each candidate knows what it was derived from and what changed — the original, the refinement that produced it, or the two parents it combines.
3. **Named directions.** A candidate carries a label and a reason the owner would recognise, because "option two" has to mean something in conversation.
4. **Composition across siblings.** "The symbol from one, the typography from another" is a real operation on two existing candidates, not a fresh prompt.

Point 4 is the hard one and the reason this is recorded rather than assumed: it means a candidate's *parts* eventually need to be addressable, not just the image as a whole.

**This shares a shape with the Design layer.** `asset(s) + surface + arrangement` already says a design holds several assets; branching says a creative step holds several candidates with lineage between them. Building either one without the other in mind produces two systems that both nearly work.

## Status

**Not built. Implementation paused here deliberately** — see the logo capability below, which was in flight when this arrived and stopped rather than shipping the replace-shaped version this requirement rules out.

---

# J4 generates a brand logo — backend complete, conversation not wired

**Verified 7/7 against the real Neon database** (`scripts/verify-brand-logo-flow.ts`).

Built and working:

- `lib/brand/logoDirection.ts` — prompt from Business Understanding (tagline, description, category, real catalog, stated goals), plus a rationale and what it was grounded in. Says so plainly when it knows nothing. **The owner's own words are weighted LAST so they outrank every inference** — verified by asserting their position in the prompt.
- `lib/brand/proposeBrandLogo.ts` — `proposeBrandLogo` (one informed recommendation, opened as a real proposal), `branchBrandLogo` (named alternatives as siblings via `branchProposal`, original preserved), `hasExistingLogo` (the no-pressure precondition, checking the designated Asset *and* `Store.logoUrl`, so a store predating designation is not treated as logo-less).
- `lib/execution/executables/updateBrandLogo.ts` — approval writes `Store.logoUrl` **and** designates the `brand.logo` Asset. Asset failure is non-fatal: the owner approved a logo and must get it.
- `update_brand_logo` in `GENESIS_ACTIONS`, `always_ask`, with `brand.logoUrl` added to `GenesisActionContext`.

Verified for real: direction grounded in live Understanding; owner direction outranks inference; approval updates `logoUrl` and designates the Asset; **`resolveCurrentAsset("brand.logo")` returns it — the Design layer's actual question**; a second logo supersedes the first with history intact.

## What remains: two sites, and they must land together

**`"Make me a logo"` routes nowhere today.** Missing:

1. A `generate_brand_logo` tool declaration in `lib/execution/genesisTools.ts` (follow `refine_storefront`'s entry).
2. A handler branch in `app/api/chat/route.ts` calling `proposeBrandLogo`, following the `update_product_image` block at ~line 700 — except it must **not** delete a prior pending proposal, because branching depends on siblings coexisting.

**Do not declare the tool without the handler.** The model would call it and nothing would happen — a silent failure, worse than the capability not existing.

The handler must enforce the no-pressure rule, which is why `hasExistingLogo` exists: if the store already has a logo, J4 works with it and does not offer to replace it. The alternatives offer fires only when the owner has no logo or is visibly unsure, and a decline ends it.

## Not covered by verification

The image generation call itself. It needs an OpenAI key, which is not in this environment — `.env.livecheck` carries only `DATABASE_URL` and `STRIPE_SECRET_KEY`. Everything either side of that call is exercised for real; a placeholder URL stands in at exactly the boundary the missing credential draws. **That is a genuine external dependency, not a shortcut.**

# Studio expansion — Sean's spec, 2026-08-17

**Studio is the creative workshop, not a logo page.** The logo is the proof of
concept, not the product. Someone opening Studio should immediately understand:
*"this is where I make things for my business with J4."*

## The two logo paths, both first-class

**No logo:** J4 offers to create one from Business Understanding → owner
approves, refines, or asks for alternatives → approved result becomes the
designated `brand.logo`. **BUILT and verified.**

**Already has a logo:** the owner uploads it and it becomes their designated
brand logo. J4 recognises it and works with it. **BUILT 2026-08-17** —
`manage_business_asset` designates for real and moves `Store.logoUrl` in step.

> **An existing logo is the owner's answer. Capability is not a reason to
> replace it.** Alternatives may still be offered if the owner seems unsure or
> asks — never as pressure.

## What the owner should be able to say

*"Make me a logo." · "Put my logo on a T-shirt." · "Make me a hoodie." ·
"Create a product image for my storefront." · "Make a graphic using my brand." ·
"Create a collage for my storefront." · "Put this design on a shirt." ·
"Make another version that's more minimal."*

These are not separate editor workflows to learn. They are requests.

## The critical missing link: creation must feed the Storefront

```
"Put my logo on a T-shirt" → Design → owner approves
    → becomes a real product available to the Storefront
    → the owner can see it is now part of their store
```

**Studio creates. Storefront presents and sells.** Today a Design is recorded
and stops there — nothing turns an approved Design into a Product. That is the
next real gap, and it runs through the existing chain
(`Product → Provider → Execution → Verification → Record`), never a second one.

## Constraints that do not move

- **Not Photoshop.** The owner describes; J4 does the work. No manual controls.
- **Branching applies here too:** original → alternatives → revisions →
  approval, original always preserved. An offer, never a funnel.
- **Beyond T-shirts:** brand assets → apparel → product imagery → storefront
  graphics → marketing creative. Surfaces are a registry entry, not a rewrite.
- **One foundation.** Asset → Design → Product → Provider → Execution →
  Verification → Record. Never a second creative system.

---

# Recorded future requirement: composition intelligence

**Sean, 2026-08-16. Recorded so we do not design ourselves into a corner. Not scheduled, not authorized, not to be started.**

The website builder needs a far deeper understanding of visual composition than a single product row or a fixed section layout.

J4 should understand composition patterns as a real vocabulary: **single rows, multiple rows, collages, image galleries, slideshows and carousels, hero compositions, split image/text sections, featured products**, and other appropriate arrangements.

**These are not arbitrary UI options.** J4 needs to understand *when* a composition makes sense, given four inputs:

- the **business** — what it is and how it positions itself
- the **content** — what there is to say
- the **available assets** — how many, what kind, how strong
- the **purpose of the section** — what it is there to accomplish

Sean's own examples, which are the specification:

> A business with **five strong brand photographs**: J4 should be capable of deciding that a **slideshow or collage** communicates the brand better than putting all five into a flat row.
>
> A business with **several products**: J4 should create **multiple product sections or rows** rather than treating the entire catalog as one grid.

## Where this belongs

**Part of J4's website design knowledge and the Design layer — never a collection of hardcoded storefront templates.**

That constraint is the reason this is recorded now rather than later. A Design layer built only for print artwork would model a design as *artwork for one surface*, and composition would then arrive as a separate, competing system bolted onto the storefront. The two are the same capability pointed at different surfaces:

```
Design = asset(s) + surface + arrangement
```

A T-shirt is a surface whose arrangement is a placement. A storefront section is a surface whose arrangement is a composition. **If the Design layer is built so that `surface` is a real dimension rather than an assumption, composition intelligence extends it. If it is built around print, composition becomes a second architecture.**

## The two design constraints this places on the Design layer

1. **`surface` must be a first-class input**, not implied by the fact that the caller is a fulfillment connector.
2. **A design must be able to hold more than one asset.** Print placement is one asset on one surface; a collage is five. A single-asset design signature would foreclose composition entirely.

Neither costs anything to honour now. Both are expensive to retrofit.

## Explicitly out of scope today

Do not build composition. Do not expand the current Asset work into it. This section exists to be read *before* the Design layer is designed, and for no other purpose yet.
