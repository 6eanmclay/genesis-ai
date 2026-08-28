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

---

# One design system, two ways in

**Recorded 2026-08-28, from Sean. A core Creation Station principle, not a shortcut feature.**

> **The goal is not to teach users how to design. The goal is to let them choose how much designing they want to do.**

Creation Station supports **J4-directed creation** and **hands-on creation** over the *same* underlying creation system.

An owner must be able to stay in the ordinary Genesis conversation and say:

> *"Put my logo on a T-shirt and make it available in my store."*

and have it happen. If J4 already holds the owner's logo in their assets, he uses it. If the owner uploads a logo or photo in the conversation, he uses that. He then applies his product and supplier knowledge to choose the best available placement, product, colour and size, and **shows the owner the resulting design before completing the action**.

> *"Put this logo on a hoodie"* must not require entering Creation Station. J4 makes the reasonable design decisions himself.

And when the owner wants control — exact placement, size, rotation, product colour, front or back, different artwork — they open Creation Station and take over.

```
"J4, do it for me."            ->  instant creation
"Let me make it exactly how    ->  Creation Station
 I want."
```

## The architectural principle

**These are not two creation systems.** The conversational path must produce the *same* design and placement representation Creation Station uses. Creation Station is the visual and manual control layer over that one representation — not a parallel implementation that happens to produce similar output.

Both paths therefore end at the same saved design, and eventually at the same supplier-ready product once the supplier contract supports the requested placements.

This is the same constraint the composition section above places on `surface`, arriving from the other direction: a representation that only Creation Station can write is a representation J4 cannot use, and the conversational path would then grow its own. Design must be a value both callers construct, with no privileged writer.

## "Make it available in my shop" has to stay true

**An actual active, manufacturable product only when the supplier integration can genuinely fulfil the complete design.** Otherwise J4 saves the completed design and says plainly what the limitation is.

He does not report a product as live because the design is finished. This is the same rule already enforced in `addDesignToStore`, which writes `active: false` and `supplierProductCreated: false` rather than claiming a product exists — see *Designed is not the same as ready to sell* (`3361c08`). The conversational path inherits that rule; it does not get a friendlier version of it.

## Explicitly out of scope today

Not authorized to build. Recorded so that the design representation is settled **before** either path is implemented against it, because the cost of getting this wrong is exactly the second architecture this section exists to prevent.

---

# Product presentation is not the product

**Recorded 2026-08-28, from Sean. A Creation Station / product-publishing requirement.**

## The separation

Two objects, kept apart:

```
Product               ->  hoodie + design + colour + size + supplier information
Product Presentation  ->  the image used to represent that product in the storefront
```

**Do not make the model image the product itself.** The same black hoodie can carry a clean product image, a model front, a model side, a lifestyle shot, a close-up and a seasonal campaign image **without becoming six products**. Collapsing presentation into the product forecloses all of that, and it is the kind of collapse that cannot be undone later without a migration of live catalogues.

Design is settled before presentation is considered. Once the product itself is final, J4 decides how it should appear.

## The three presentations

1. **Product-only** — clean product or mockup image, no person. The straightforward catalogue presentation.
2. **Lifestyle / model** — the product worn or used by a person. J4 selects or generates something appropriate to the product and the brand.
3. **Varied** — across a catalogue. When a store has several products of the same type, they must not all arrive with the same model, pose, framing and composition. J4 varies people, poses, angles, crops, environments and body positions deliberately, while keeping the brand coherent.

Variety is the requirement that makes this a storefront capability rather than a per-product one: it cannot be decided by looking at the product in hand. J4 has to consider **the products already in the store**.

> *"You already have two hoodies displayed on models. For this one, I'd recommend a clean product-only image so your storefront doesn't look repetitive."*
>
> *"You have several T-shirts using the same presentation style. I'll use a different model and pose for this one."*

So when J4 sees

```
Hoodie #1  male model, front-facing
Hoodie #2  female model, side angle
Hoodie #3  product-only
Hoodie #4  male model, hands in pockets
```

it can make Hoodie #5 deliberately different. **That is the capability. A "generate mockup" button is not.**

## The owner decides

The control the owner sees:

```
Product presentation
  ( ) Product only
  ( ) Model / lifestyle
  ( ) Let J4 decide
```

**Let J4 decide** is the path that consults the rest of the storefront.

**J4 recommends; the owner always has final control.** He may argue from storefront consistency, variety, brand style and the existing products — once. If the owner overrides him, he honours it and **does not challenge it again**. Repeated presentation choices become part of the owner's learned preferences, so the recommendations improve rather than the objections repeating.

This is the standing rule in [J4_IDENTITY.md](J4_IDENTITY.md) applied to a specific decision: J4 makes better entrepreneurs, he does not overrule them. An owner who has chosen product-only three times has told him something, and the correct response is a better default, not a fourth argument.

## Supplier-agnostic, and that is the point

**The supplier determines what product and print areas exist. Genesis determines how the finished product is presented to the customer.** These are different questions and must not share a code path.

Printful's mockups are used **where they exist** — they are one source of presentation, not the definition of it. A future supplier, or Genesis's own generation, must be able to provide richer presentations without the storefront noticing. Presentation is a layer with sources behind it.

Tying presentation to Printful's mockup API would architect us into a Printful-only storefront, which is the same mistake as the `FulfillmentConnector` interface exists to prevent on the other side of the chain: *the owner never chooses a provider by name.*

## Explicitly out of scope today

Not authorized to build. Recorded now because the separation above is cheap to honour before products carry images and expensive afterwards.

---

# What presentation costs

**Recorded 2026-08-28, from Sean. Creation Station + Growth Points.**

> **Genesis makes the business easy to build. Growth Points let the owner level it up.**

Product creation and product presentation are **two separate Growth Point actions**, because they are two separate objects — the separation recorded above is what makes this pricing possible at all.

| Action | Cost | When |
|---|---|---|
| **Product creation** | **2 GP** | *"Put my logo on a black hoodie and add it to my store."* The product is created and saved as normal. |
| **Image differentiation** | **1 GP** | Only when the owner accepts J4's offer to differentiate the presentation. |
| **Manual editing of an existing design** | **free** | Placement, size, rotation, colour, view — every adjustment the owner makes themselves. |

## Declining is free

After the product exists, J4 may proactively offer:

> *"You already have a few products using a similar presentation. Want me to create a different angle, pose, model, or a product-only image?"*

**No costs nothing** and he leaves the product alone. **Yes costs 1 GP** and he creates the differentiated presentation — a different model, angle, pose, environment, or a product-only image.

The owner has final control, and an owner who wants the same presentation anyway gets it without an argument — the standing rule from the presentation section above, which is also what stops a paid offer from becoming a nag.

## The line the price is drawn on

**The Growth Point buys substantive creative generation by J4, never the owner's own adjustments.** Dragging artwork half a centimetre is not a creative act by J4 and must never be metered. Charging for manual editing would price the owner out of the control layer Creation Station exists to be, which is the opposite of what it is for.

## Running out must not break the business

**A store that runs out of Growth Points keeps working.** Its products still exist, still show, still sell. Growth Points buy optimization, differentiation and additional creative work — they are not a licence to have a catalogue.

This is why the metering has to be settled now rather than retrofitted: a differentiation feature built as unlimited and free would either stay free forever or become a removal of something owners already had, and both are worse than pricing it correctly on the first day.

## Supplier-agnostic, again

The presentation system stays a layer with sources behind it. Printful's mockups are today's source; another supplier or Genesis's own creative system is tomorrow's. **The price is attached to the act of differentiating a presentation, not to whichever provider happens to render it** — otherwise the cost model would have to be renegotiated every time a source changes.

## Explicitly out of scope today

Not authorized to build. Recorded so the Design and presentation layers are shaped for it from the start.

---

## Social posts are the next Creation Station surface

Requirements are recorded in [SOCIAL_CREATION.md](SOCIAL_CREATION.md) and are not authorized to build. They belong to the same creation system as everything above: the owner brings content and context, J4 does as much or as little of the writing as they want, and the representation is one thing with two ways in.

**That scope is LOCKED as of 2026-08-28.** Section 0 of that file is the whole of v1, and section 0.1 names what is excluded — comment management, automated replies, and engagement agents. The exclusions matter here because this is the file someone reads when deciding what Creation Station becomes next: the answer is the ten steps in section 0, and nothing adjacent to them.
