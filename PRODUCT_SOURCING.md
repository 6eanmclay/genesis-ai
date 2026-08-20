# Product sourcing and discovery

*P0.5, built 2026-08-20. The catalog as the foundation of a discovery system —
not a static product list.*

**The rule this document is written under, same as `COMPLIANCE.md`: nothing here
is described as working unless something proves it. Where a supplier cannot be
reached, that is stated, and no catalogue is invented in its place.**

---

## What the problem actually was

Genesis could already put products into a store two ways: the owner typed one
in, or the onboarding flow pulled a Printful blank and put the owner's artwork
on it. Both work. Neither is a catalog *model*, and three things were missing
before anything like recommendation could sit on top.

**Nothing recorded where a product came from.** `Product.fulfillmentProvider`
records which *connector* a product arrived through, which is a narrower
question and is null for everything Cubit & Coil sells — Sean makes tensor rings
himself. So the platform could not tell an owner-made product from a dropshipped
one, and those differ in ways the code already cares about: who buys the
shipping label, whether there is stock to run out of, whether "customise this"
means anything, what the cost basis is.

**The supplier abstraction only fitted one shape.** `FulfillmentConnector` is
built around `createProduct(candidate, imageUrl, retailPrice)` — every method
assumes artwork being applied to something that does not exist yet. A wholesale
supplier is the structural opposite: nothing is created, nothing is customised,
the item already exists with a price and a photograph, and the owner is deciding
whether to resell it. Passing that through the existing interface would mean
either lying about the image or bolting optional-everything onto a contract that
is currently honest.

**Discovery did not survive the request.** Candidates existed inside one page
load. J4 could not come back to one, could not say why it had raised it, and —
the one that decides whether this reads as a partner or a nag — could not tell a
suggestion the owner had already rejected from one it had never seen.

---

## The model

### `ProductSourceKind` — a taxonomy of behaviour, not of suppliers

An enum rather than a string, because every value changes what other code must
do, and a value nobody handles should fail to compile rather than fall through.

| | |
|---|---|
| `OWNER_MADE` | The owner makes or holds it, and ships it. Cubit & Coil's rings. |
| `PRINT_ON_DEMAND` | Printed or customised per order by a partner, who ships it. The only kind for which "customise this" is real. |
| `WHOLESALE_DROPSHIP` | Bought from a wholesaler who ships direct. The owner never touches it and never buys a label for it. |
| `WHOLESALE_STOCKED` | Bought wholesale, held and shipped by the owner. Has stock. |
| `DIGITAL` | Nothing ships. No parcel, no label, no address. |

`Product.sourceKind` defaults to `OWNER_MADE` because that is the truth about
every product that exists today: each was entered by hand by the person who
makes or holds it. Nothing is backfilled or inferred.

`Product.sourceKey` records *which* source, as a plain string. Adding a supplier
should be a registry entry, not a migration — the same reasoning the business
taxonomy is not an enum.

### `ProductSource` — a source declares what it can do

```ts
interface ProductSource {
  key: string;                     // what Product.sourceKey holds
  kind: ProductSourceKind;         // a source sells one shape
  capabilities: { customization, createsListings, shipsDirect, quotesCost };
  fulfillmentProvider: IntegrationProvider | null;
  blockedOn: string[];             // empty when genuinely ready
  search(intent): Promise<SourceSearchResult>;
}
```

**No capability is inferred from a provider's name, anywhere.** That is how
"Printful means customisable" quietly becomes "every source means customisable"
the moment a second one is added — and offering *add your own artwork* on a
wholesale listing is a promise to a customer that the supplier has no idea was
made.

`blockedOn` is declared rather than discovered, so "why did discovery only
search one supplier" has an answer that does not require making a request to
find out.

A source that cannot be used returns a **reason**, never an empty success. "The
catalogue had nothing for you" and "I was never able to look" lead to completely
different next actions, and only one of them is the owner's.

### `SourcedProduct` — what Genesis found, as opposed to what the store sells

Store-scoped, because the same Printful blank is a different proposition for a
streetwear brand than a wellness one, and the reasoning attached to it is about
*this* business.

Unique on `(storeId, sourceKey, externalProductId, externalVariantId)`, which is
what makes re-running discovery an update in place rather than a pile of
duplicates. `externalVariantId` is **NOT NULL with `""` meaning "this source has
no variants"** — nullable was the natural modelling and is wrong twice over:
Postgres treats NULLs in a unique index as distinct, so every re-run would have
inserted another copy of every variant-less candidate; and Prisma cannot target
a compound unique containing a null, so the upsert could not have been written
at all. The sentinel is converted back at exactly one place, `adopt.ts`.

`recommendation` is `Json` for the same reason `Store.blueprint` is: the shape of
an explanation will change as J4's understanding deepens, and that should not be
a migration each time. `score` is denormalised out of it so the database can sort
without parsing.

`status` is `SUGGESTED | DISMISSED | ADOPTED`. **A dismissal is remembered
rather than deleted**, because the next run finds the same supplier listing
again.

---

## Recommendation

`scoreCandidate()` is pure, deterministic and explainable, and deliberately not
an LLM call — three reasons in order: a discovery run scores dozens of candidates
and every one would be billed; the same business and candidate must score the
same way twice or "why is this still at the top" has no answer; and a model asked
to justify a product it has already been shown will always find something to say.
A grounded score first and a model to narrate it is the right order. The reverse
is how a recommender starts telling owners what they want to hear.

**Relevance is a gate, not a term.** Signals that connect the candidate to the
business — the owner's own words, what already earns, the rest of the catalogue,
the business's classification — are summed first. If that total is zero, scoring
stops and nothing is said. Everything else (customisation fit, margin) is a
*modifier* and can never be the reason something is suggested.

That distinction was not in the first version, and its own suite caught it: an
unrelated phone case scored positive on customisation fit alone and would have
been recommended with *"your own artwork can go on it"* as its entire
justification — a sentence about the supplier wearing the costume of a
recommendation.

**Recommending something the owner already sells is disqualifying, not
penalised.** The first version scored it −20 against a relevance total that
reached +24, so an exact duplicate of the store's best seller came out positive.
A duplicate cannot be outweighed by how relevant it is; being relevant is
precisely why it is already in the catalogue.

**A store Genesis knows nothing about gets no suggestions.** *"I don't
understand your business well enough to suggest anything yet"* is the useful
answer and the true one. A list padded with confident nothings is how an owner
learns to ignore the list.

`buildSourcingContext()` is the join to the Foundation: a deliberately narrow
projection of `getBusinessUnderstanding()`, so what a recommendation was grounded
in is a matter of record rather than whatever the scorer could reach. Widening it
is a deliberate edit to one function, which is the point. Recommendation quality
improves as understanding deepens, with no change to the scorer.

---

## Status

### VERIFIED — behavioural proof exists

`scripts/verify-sourcing-live.ts` (real Postgres, real pipeline) and
`scripts/verify-product-sourcing.ts` (pure):

- discovery holds both shapes at once, with customisation and variants kept apart
- every suggestion carries readable reasoning naming the business's own words
- re-running discovery corrects rows in place and never duplicates
- a dismissal is respected on the next run and blocks adoption
- adoption carries `sourceKind`, `sourceKey` and the supplier's ids onto the
  Product, and does not claim a fulfilment partner where there is none
- concurrent adoptions produce one product
- one store's suggestions are never another's, through adoption or dismissal
- a blocked or failing source is named, and contributes nothing
- a candidate claiming another source's key is dropped
- deleting an adopted product does not erase the record of finding it
- products that predate all of this are `OWNER_MADE` with no source

### UNVERIFIED

- **Printful's real catalogue through this adapter.** The underlying connector
  was validated live against Printful's API when it was written; the *adapter*
  over it has not been run against a connected store.
- **`buildSourcingContext` against a real store's understanding.** The scorer is
  proven against contexts; the projection that builds them is not.

### EXTERNALLY BLOCKED

- **AliExpress** — needs `ALIEXPRESS_APP_KEY` and `ALIEXPRESS_APP_SECRET` (an
  AliExpress Open Platform app). The source is registered and refuses; it does
  not return an invented catalogue.
- **Printful** — needs a store with Printful connected to search anything.
- **The migration** `20260820060000_product_sourcing` is written and applies
  cleanly against real Postgres, but production migrations are a deliberate
  separate step (`DEPLOYMENT.md`) and it has **not** been applied to production.

### NOT MODELLED — deliberately, and named

- **Variants.** One representative variant per candidate, inherited from the
  existing fulfilment layer. No variant-selection UI and no variant model on
  `Product`.
- **Inventory.** `WHOLESALE_STOCKED` exists as a kind and nothing tracks stock
  against it. The enum value is honest about the shape; there is no quantity.
- **Automatic order routing.** Adopting a dropship product does not make an
  order flow to the supplier. That remains the explicit non-goal it has been
  since `ONBOARDING_V2_DESIGN.md`.
- **Any owner-facing surface.** There is no screen. This is the model and the
  pipeline; per the standing rule that interface work needs a confirmed design
  first, no discovery UI was built alongside it.
