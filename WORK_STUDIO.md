# Work Studio: Asset → Design → Product → Provider

**Status: chain defined, first link built.** The audit below is real, taken from the code on 2026-08-16, not from memory. Nothing here authorizes building beyond the step marked as current.

```
Asset  →  Design  →  Product  →  Provider  →  Execution  →  Verification  →  Record
  ✓         ✗          ✓           ✓            ✓              ✓              ✓
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
