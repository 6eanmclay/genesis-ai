# Product progression

*P0.5 architecture and specification. Approved in principle 2026-08-20; this is
the concrete form. **Nothing here is built yet.***

This document is written to be implementable without invention. Where a value is
derived, the derivation is stated. Where a boundary exists, what sits on each
side is stated. Where something is deliberately absent, it says so and why.

Builds on `PRODUCT_SOURCING.md` (the source contract and fit reasoning, built and
verified) and `BUSINESS_CONTEXT.md` (per-business isolation, built and verified).

---

## What this is for

> A person should be able to start with little or no money, sell products they
> never had to buy, generate real sales, reinvest them, and progressively move
> toward better margins and more independent production.

That is not a sourcing feature. It is Genesis's business-development model, and
the product catalog is where it becomes tangible.

The system therefore has to answer three different questions about one product,
and keep them apart:

1. **Does this belong in this business?** — fit
2. **Can this business do this today?** — feasibility
3. **What would make it possible?** — the plan

---

## Invariants

These are the rules the implementation must not break. Each is written so it can
be asserted.

| # | Invariant |
|---|---|
| I1 | **Available capital is never inferred from revenue.** The only capital inputs are what the owner has explicitly stated. Revenue is evidence about a *product*, never about a bank balance. |
| I2 | **Unknown stays unknown.** A missing supplier minimum, bulk price or lead time is never defaulted to zero, a guess, or an average. An unknown that blocks a decision produces `cannot_assess`, not a recommendation. |
| I3 | **`not_a_fit`, `not_yet` and `recommended_now` are distinct outcomes** with distinct explanations, and none collapses into another. |
| I4 | **Product readiness and business stage are distinct.** Readiness is per product. Stage is per business. Neither is computed from the other alone. |
| I5 | **Business stage is derived, never stored** as a mutable field. There is no column an admin or a bug can set. |
| I6 | **A graduation requires evidence from real orders** of the specific product. No graduation is offered on the strength of time, revenue totals, or business age. |
| I7 | **Every recommendation, decision and progression fact is scoped to one business** and reachable only through that business's context. |
| I8 | **A product may fit a business eventually without fitting it today.** The model must be able to express that, and must not hide such a product. |
| I9 | **Every outcome carries its reasoning** — why recommended, why rejected, why deferred — in the owner's own terms. |
| I10 | **Fit is evaluated before feasibility.** A product that does not belong is `not_a_fit` however affordable it is. Telling an owner they can afford the wrong thing is worse than saying nothing. |
| I11 | **Unknown is never converted into zero, even when zero is the safe way to behave.** The system may *act* as though capital is zero while the owner has said nothing, but it must never *record* that as a stated zero. Three states stay distinguishable forever: unstated, explicitly zero, explicitly greater than zero. Collapsing the first two destroys the only signal that says "worth asking about". |
| I12 | **Evidence and policy are separate.** Evidence is what happened. Policy is how Genesis reads it. A threshold change must never require touching the code that gathers evidence, and must never rewrite what was recorded. |
| I13 | **Currency belongs to the business.** Every money value is in `Store.currency`. No progression function assumes a currency, and none compares or sums across two. One currency per business in P0.5; the assumption is named and local rather than global and buried. |
| I14 | **Units are units, not orders.** Progression evidence counts real quantity. An order for 100 units and an order for one are not the same evidence. |

---

## Entities

### A. `SourcingMethodProfile` — code, not database

The economics of a *method*, not of a business or a supplier. Lives in
`lib/sourcing/methodProfile.ts` beside `framing.ts`, for the same reason: it is a
property of the sourcing model itself, identical for every business, and a
database row would be a copy that drifts.

```ts
export type CapitalModel =
  | "none"            // nothing is paid until a customer pays
  | "bulk_upfront"    // a minimum order is bought before anything sells
  | "tooling";        // setup cost independent of units

export type UnsoldRisk =
  | "none"            // nothing was bought
  | "held_stock"      // money sits in stock
  | "branded_stock"   // stock that cannot be resold generically
  | "tooling";        // sunk setup

export type OwnerCapability =
  | "hold_stock"      // physical space and willingness
  | "provide_artwork" // a design to print
  | "manage_supplier";// direct manufacturer relationship

export interface SourcingMethodProfile {
  kind: ProductSourceKind;
  capitalModel: CapitalModel;
  unsoldRisk: UnsoldRisk;
  requiresCapabilities: OwnerCapability[];
  /** True only where the owner's own branding can go on it. */
  carriesOwnBranding: boolean;
  /** Ordering on the ladder. Higher = more commitment, better margin. */
  rung: 0 | 1 | 2 | 3;
}
```

Fixed values, and these are the specification, not examples:

| kind | capitalModel | unsoldRisk | requires | branding | rung |
|---|---|---|---|---|---|
| `PRINT_ON_DEMAND` | `none` | `none` | `provide_artwork` | yes | 0 |
| `WHOLESALE_DROPSHIP` | `none` | `none` | — | no | 0 |
| `WHOLESALE_STOCKED` | `bulk_upfront` | `held_stock` | `hold_stock` | no | 1 |
| `OWNER_MADE` | `tooling` | `tooling` | `manage_supplier` | yes | 3 |
| `DIGITAL` | `none` | `none` | — | yes | 0 |

**Two kinds are missing on purpose.** Private label and contract manufacturing
are rungs 2 and 3, and adding them to `ProductSourceKind` is part of this work —
see *Schema changes*. `OWNER_MADE` stays what it already means: the owner makes
it themselves.

### B. Capital posture — database, on `Store`

```prisma
model Store {
  // ...
  /// The business's own currency. Every money value on this business — costs,
  /// margins, capital, supplier minimums — is in it. One per business (I13).
  currency               String    @default("USD")
  /// What the owner has said they can invest, in the business's currency.
  /// NEVER inferred (I1). NULL means UNSTATED, not zero (I11).
  investableCapitalCents Int?
  /// When they said it. Together with the column above this is what keeps
  /// three states apart — see the resolution rule below.
  capitalStatedAt        DateTime?
  /// Capabilities the owner has confirmed. Absent = unknown, not false.
  ownerCapabilities      String[]  @default([])
}
```

**Three states, and they must never collapse (I11).**

| State | Columns | Genesis acts as if | Worth asking? |
|---|---|---|---|
| **Unstated** | both `NULL` | capital is zero | **Yes** |
| **Explicitly zero** | `0`, with a `statedAt` | capital is zero | No — they said so |
| **Explicitly positive** | `> 0`, with a `statedAt` | that amount | No |

The first two behave identically and are **not** the same fact. Collapsing them
destroys the only signal that says *worth asking about*, and asking someone who
already told you nothing is how a partner starts sounding like a form.

So the resolution is a discriminated value, not a number:

```ts
export type CapitalPosture =
  | { state: "unstated"; actAsIfCents: 0 }
  | { state: "stated"; investableCents: number; statedAt: Date };

/** What feasibility may spend. Identical for the first two states, by design. */
export function spendableCents(posture: CapitalPosture): number {
  return posture.state === "stated" ? posture.investableCents : 0;
}
```

Every outcome that was limited by capital records **which state it came from**,
so J4 can say *"I'm assuming you don't want to put money in — tell me if that's
wrong"* to one owner and not to the other.

### C. Supplier economics — database, its own table (added 2026-08-20)

Facts about what a supplier's product costs this business. Nullable throughout,
and null means unknown (I2).

Originally columns on `SourcedProduct`. Given its own table once the progression
engine started reading it, for two reasons. A supplier's terms are a fact about
*a product from a supplier*, not about *a suggestion Genesis once made* — the
economics outlive the candidacy, and a product that was adopted or dismissed
still costs what it costs. And the terms have to be identifiable independently of
whether Genesis ever suggested the thing.

```prisma
model SupplierEconomics {
  storeId              String
  sourceKey            String
  externalProductId    String
  externalVariantId    String   // "" for none, never NULL — see below
  provenance           EconomicsProvenance
  unitCostInCents      Int?
  minimumOrderUnits    Int?
  tiers                Json?    // [{ minUnits, unitCostInCents }]
  shippingPerUnitInCents Int?
  leadTimeDays         Int?
  requiresCapabilities String[]
  statedByUserId       String?
  statedAt             DateTime
  note                 String?

  @@unique([storeId, sourceKey, externalProductId, externalVariantId])
}
```

**Identity is all four parts, always.** An external id alone is not an identity.
Two suppliers can use the same one, and a variant is a different product with
different terms. The unique key is what makes a minimum of 5000 landing on a
product whose real minimum is 50 impossible rather than merely unlikely — and a
wrong number about money is the kind nobody catches by reading the screen.
`externalVariantId` is `""` rather than NULL for no-variant, because Postgres
does not treat NULLs as equal in a unique index and the collision the key exists
to prevent would slip straight through.

**Three states, and none of them is zero** (I2, I11):

| `provenance` | What it means | Where it comes from |
|---|---|---|
| `SUPPLIER` | A catalogue published these terms | A connector sync |
| `OWNER` | Somebody rang the supplier and asked | `ownerStatesEconomics` — no API involved |
| `UNAVAILABLE` | Somebody looked and there is no answer | `markEconomicsUnavailable` |

`OWNER` is as real as `SUPPLIER` and is not the same fact: one can be refreshed,
the other has to be re-asked. `stateEconomics` therefore takes provenance as a
required argument rather than inferring it from the caller — code that guessed
would eventually refresh away something a person went and found out.

`UNAVAILABLE` resolves to nulls, but the *record* is not null. That is what makes
it distinguishable from never having asked, and it is why J4 asks a different
question in that case: asking the same thing again is asking somebody to repeat
work they already did.

**A partial answer stays partial.** `bulkTerms()` returns nulls rather than
guesses. A supplier that published a unit price but no minimum has told us one
thing and not the other, and calling the minimum 1 would turn *"I don't know"*
into *"you can buy one"* — the exact lie I2 exists to prevent. Tiers win over
flat figures when both exist, because a price break is what a bulk purchase would
actually cost.

**The unblock names the gap and why it matters.** `missingEconomics()` returns
which halves are missing; `ECONOMICS_GAP_EXPLANATION` supplies the second
sentence. *"I don't know the minimum order"* is a fact about Genesis. *"It
decides what buying in bulk would actually cost you up front"* is a reason for
the owner to go and find out.

`SourcedProduct.minimumOrderUnits` / `bulkUnitCostInCents` remain as the
discovery-time fallback, read only when no `SupplierEconomics` row exists.

### C1. The write contract — `economicsIngest.ts`

Three things will eventually write here: a supplier connector, an owner-entry
flow, and a bulk import. They are not one caller with different arguments — they
differ in **what they are allowed to say** — so there is one entry point each,
and each decides its own provenance.

| Writer | Provenance | May overwrite |
|---|---|---|
| `ingestFromSupplier` | `SUPPLIER` | another `SUPPLIER` row, or an `UNAVAILABLE` one |
| `recordOwnerQuote` | `OWNER` | anything, including the owner's own earlier answer |
| `recordUnavailable` | `UNAVAILABLE` | a `SUPPLIER` row, never an `OWNER` one |

Two protections are **structural rather than checked**:

1. **A connector cannot write under another source's key.** `ingestFromSupplier`
   takes one `sourceKey` for the whole batch and stamps it onto every record.
   The records have no `sourceKey` field to get wrong, so there is no code path
   by which one supplier's sync reaches another supplier's row.
2. **A sync cannot erase what a person found out.** An `OWNER` row is what
   somebody got by ringing the supplier up; a catalogue sync that would overwrite
   it is refused and reported as `preserved`. This rule was written down the day
   the table was created and enforced by nothing — which is the state in which
   rules stop being true.

A bad record is **rejected as data, not thrown**: a sync of four hundred products
must not lose three hundred and ninety-nine because one had a negative price, and
must not be able to pretend the bad one was fine. A rejected record writes
**nothing at all**, never the half that parsed — a row that is half-believable is
the most dangerous shape this table can hold, because it looks answered.

Absence survives a re-sync. Prisma reads `undefined` as *leave this column
alone*, so a later sync that says nothing about price breaks writes an explicit
null; otherwise the engine would go on quoting a break the supplier had withdrawn.

### C2. Broken price breaks block, they do not fall back

`readTiers` returns `{ tiers, integrity }`. When the stored JSON cannot be
believed — not a list, an entry with no quantity, a non-numeric price, or **two
different prices for the same quantity** — `integrity` carries the problem and
`bulkTerms` quotes **nothing at all**, including the flat `unitCostInCents` and
`minimumOrderUnits` sitting in the same row.

That refusal is the point. The earlier version fell through to the flat figures,
so a corrupt price-break table produced a confident-looking unit cost with
nothing indicating anything was wrong. **A plausible figure derived from data we
have just established is broken is worse than no figure at all.** The same
applies to the discovery-row fallback: a record whose tiers are unusable is not
quietly replaced by an older number from `SourcedProduct`.

The owner gets `unusable_tiers` — *"what's recorded doesn't add up, so I've
stopped using it rather than quote you a figure I can't stand behind"*. Whoever
maintains the connector gets `integrityDiagnostic`: the store, the source, the
product, the variant, the provenance and the specific problem, via `reportIssue`.

**Not validated:** whether a bigger order costs less per unit. A supplier quoting
500 at a higher unit price than 100 is odd but not contradictory — nobody would
buy at that tier, and picking the cheapest is still right. Rejecting it would be
Genesis deciding it knows the supplier's business better than the supplier does.

### C5. Asking, and being answered — the loop

`nextMoves` could produce the right question from the day the economics layer
landed. Nothing carried it anywhere an owner could answer it, so in production it
was a sentence with no destination.

```
nextMoves -> unblock
  -> raiseEconomicsQuestions()      Task (source: supplier_economics)
     -> owner replies
        -> answer_supplier_economics  (GENESIS_ACTIONS, always_ask, locked)
           -> answerEconomicsQuestion()
              -> recordOwnerQuote / recordUnavailable / nothing at all
                 -> economicChanges(before, after)
                    -> re-evaluate ONLY if something material moved
                       -> settleEconomicsQuestion()  close, or leave standing
```

**No second mechanism at any step.** The question is a `Task`, which is where
everything else Genesis needs from an owner already lives — `requiredInput` and
the `AWAITING_INPUT` status had been declared in the schema for exactly this and
written by nothing. The answer is a registered action, so it gets a permission
check, an `ExecutionLog` row and an actor rather than a direct table write. The
fact is stored by `recordOwnerQuote`, unchanged.

**One question per blocked product, and only the half that is missing.** The
gaps come from `missingEconomics`, the same function the unblock move uses, so
the card and the conversation can never disagree about what is outstanding. An
owner who has already given the minimum is asked about the price.

**Three answers, and one writes nothing.**

| Answer | What is recorded |
|---|---|
| `quoted` | `recordOwnerQuote` — provenance `OWNER`, attributed, in the business's currency |
| `supplier_would_not_say` | `recordUnavailable` — provenance `UNAVAILABLE` |
| `dont_know_yet` | **Nothing.** The question stays open |

The third is the one a system like this usually gets wrong. *"I don't know"* is
not an answer about the supplier, it is the absence of one, and there is nowhere
honest to put it — recording `UNAVAILABLE` would be Genesis claiming somebody
asked and was refused, which is a different fact and a false one. It is a real
branch rather than the absence of a call, so there is somewhere to test that
nothing was written.

**Half an answer is kept.** `recordOwnerQuote` now accepts either figure alone
and rejects only a call with **neither** — "a call with neither answer is not a
quote" is unchanged. An owner who rang their supplier and came back knowing the
minimum but not the price has found out something real; demanding both would
throw it away and ask them the same two questions again.

**Re-evaluation is earned.** `economicChanges` compares the terms before and
after and re-runs the progression only when something moved, using the same
"becoming known counts as much as improving" rule `materialChange` already
applies. An owner confirming figures Genesis already had has told us something
useful about our data and nothing new about their business, and rerunning to
reach the same three moves is work nobody can tell apart from no work at all.
A **worse** quote is recorded but is not material — it unblocks nothing, and the
owner is not owed another interruption for it.

**The card is settled from the result, never from the reply.** A question closes
only when the thing it asked for is actually known.

### C3. Freshness — `economicsPolicy.ts`

`statedAt` existed from the first version of this table and **nothing read it**.
That is the quiet failure mode of a timestamp: a quote obtained in February and
one obtained this morning were the same fact to the engine, and a recommendation
to spend $410 rested equally on both.

Versioned like the progression thresholds, because it is judgement:

| Provenance | Stale after | Why that window |
|---|---|---|
| `SUPPLIER` | 30 days | A connector syncs on a schedule. Month-old catalogue data does not mean the price is a month old — it means **the sync has not run**, which is a fact about Genesis worth surfacing |
| `OWNER` | 120 days | Roughly how long a trade quote tends to be honoured, and long enough that nobody is re-interrogating their supplier monthly for no reason |
| `UNAVAILABLE` | 60 days | "They wouldn't say" is worth leaving alone for a couple of months, and then worth asking again |

**THE DECISION: stale data does not block. It qualifies.**

Blocking was the tempting rule and it is wrong. A business that recorded its
economics five months ago would lose its recommendation entirely and be told *"I
don't know"* — replacing a slightly old truth with a total absence, which is
strictly less true. What an owner needs is the recommendation **and** its age.

So staleness produces a **caveat**, not a blocker, and the distinction is
load-bearing: a blocker is a reason this cannot happen yet; a caveat is a reason
to check something before acting on a number that is otherwise sound. Caveats
survive `recommended_now` deliberately — the outcome that actually causes
somebody to spend money must not be the one that says least about where its
figures came from.

The one place staleness changes **behaviour** rather than wording is
`UNAVAILABLE`. Inside the window J4 asks *"can you find another supplier?"*; past
it, *"it's been three months since they wouldn't quote you — worth asking
again?"* Suppliers change their minds, and by then the owner may be a customer
worth quoting.

### C4. What the stored figures actually do

Three columns were stored, read out of the database, and then discarded one line
before the only function that could use them. What each does now:

| Field | Effect on `assessFeasibility` |
|---|---|
| `shippingPerUnitInCents` | Money that leaves the owner's hands to get the order, so it is added to the unit cost: `upfront = minimum x (bulk + shipping)`, and the bulk margin is computed against the landed cost. A **stated 0 is an answer** — "delivery included" — and is not the same as null |
| `leadTimeDays` | Part of payback. The clock starts when the money leaves, not when the boxes arrive; a supplier who takes six weeks to ship is six weeks of an owner's money sitting in transit earning nothing |
| `requiresCapabilities` | Unioned with the method's own. Stocked wholesale needs somewhere to keep stock whatever the product is; **this** product may need more — an item that ships on a pallet needs real storage. Applies at rung 0 too, where nothing is bought but artwork may still be required |

**Unknown shipping and lead time qualify rather than block**, and this is the
judgement call in `feasibility.ts`. Requiring them would send every stocked
recommendation back to `cannot_assess` — the exact paralysis this layer was built
to end — over a delivery charge that is usually a fraction of the order. Instead
the figure carries a `costBasis`: when shipping is unknown the total is a floor
and the owner reads **"at least $410"**, never a bare total that claims a
completeness it does not have.


### D. Product evidence — derived, never stored (I4, I5, I12)

**Evidence is what happened. It contains no judgement and no thresholds.**
Renamed from "readiness" deliberately: readiness is a conclusion, and this type
holds none.

```ts
export interface ProductEvidence {
  productId: string;
  currency: string;           // the business's, carried so no caller assumes
  unitsSold: number;          // SUM of quantity over paid orders (see G)
  refundedUnits: number;
  orderCount: number;         // distinct orders — kept, and not the same number
  firstSoldAt: Date | null;
  windowDays: number;         // first sale to now, min 1
  unitsPerWeek: number;
  netRevenueCents: number;    // excludes refunded (matches §40)
  /** NULL where product cost is unknown. Never zero (I2). */
  netMarginCents: number | null;
  returnRate: number;
}
```

`orderCount` and `unitsSold` are both kept and are genuinely different questions:
*how many people bought this* and *how many did they take*. A progression
decision needs the second; a demand signal often wants the first.

**Derivation** — every input is a column, and `Order.quantity` is new (see G):

- `unitsSold` = `SUM(quantity)` over `Order` rows for this `productId` with
  `status = "paid"`.
- `orderCount` = `COUNT(*)` over the same rows.
- `refundedUnits` = `SUM(quantity)` where `status = "refunded"`.
- `netMarginCents` = `SUM(amountInCents)` over paid orders, minus
  `Product.costInCents * unitsSold` where cost is known, minus
  `SUM(shippingCostInCents)`. **Where `costInCents` is null, margin is `null`,
  not zero** (I2).

Every figure is in `Store.currency`, and the type carries it so no downstream
caller has to assume (I13).

### E. Progression policy — versioned, separate from evidence (I12)

**Evidence is what happened. Policy is how Genesis reads it.** They are separate
because they change for entirely different reasons: evidence changes when a
customer buys something, policy changes when we learn our thresholds were wrong.

Policy lives in `lib/sourcing/progressionPolicy.ts` as a versioned constant.
Not a database table — it is platform judgement, identical for every business,
and a per-business row would be a per-business fork nobody asked for.

```ts
export interface RungPolicy {
  rung: 1 | 2 | 3;
  minUnitsSold: number;
  minWindowDays: number;
  maxReturnRate: number;
  /** Margin must be KNOWN and above this. Never satisfied by an unknown (I2). */
  minNetMarginCents: number;
}

export interface ProgressionPolicy {
  /** Bumped whenever any threshold changes. Recorded on every decision. */
  version: string;             // e.g. "2026-08-20.1"
  rungs: RungPolicy[];
}
```

The initial policy — **approved as the starting point, not as domain truth**:

| Rung | minUnits | minDays | maxReturnRate | minMargin |
|---|---|---|---|---|
| 1 — stocked | 20 | 28 | 0.10 | > 0 |
| 2 — private label | 100 | 84 | 0.10 | > 0 |
| 3 — own production | 500 | 168 | 0.10 | > 0 |

Time floors matter as much as volume: 20 units in three days is a spike, not a
pattern, and buying a case on it is exactly the mistake this system exists to
prevent.

**The rules that make this a real separation, not a naming convention:**

1. `productEvidence()` **never imports the policy.** It cannot; nothing in it
   takes a threshold.
2. Applying policy is its own pure function:
   ```ts
   earnedRungs(evidence: ProductEvidence, policy: ProgressionPolicy): number[]
   ```
3. **Every stored decision records `policyVersion`.** A threshold change does not
   rewrite history — it means later decisions were made under a different policy,
   and the record says which.
4. Changing a threshold is a one-line edit to the constant plus a version bump.
   Nothing that gathers evidence is touched, and no stored row changes.

### F. Business stage — derived, never stored (I5)

```ts
export type BusinessStage = "exploring" | "selling" | "proven" | "committing";
```

| Stage | Derived when |
|---|---|
| `exploring` | no paid orders in this business |
| `selling` | at least one paid order, no product has earned rung 1 under current policy |
| `proven` | at least one product has earned rung 1 |
| `committing` | at least one product is *sourced at* rung ≥ 1 |

Stage describes what is on the table. It never gates a specific product on its
own — that is evidence (I4). Stage is a *reading of evidence under policy*, so it
moves when either changes, which is correct and is why it is never stored.

### G. `ProgressionDecision` — database, new

A graduation is derived, but the owner's answer to one must persist, or it is
offered again next week.

```prisma
model ProgressionDecision {
  id         String   @id @default(cuid())
  storeId    String
  productId  String
  /// The rung that was offered.
  toKind     ProductSourceKind
  decision   ProgressionDecisionKind  // ACCEPTED | DECLINED
  /// Which policy version produced the offer (I12). A later threshold change
  /// does not rewrite this; it means the next offer was judged differently.
  policyVersion String
  /// The CONDITIONS as they stood — not just the evidence. This is what
  /// "has anything material changed" is answered against. Json for the same
  /// reason recommendation is: the set of conditions will grow.
  conditions Json                     // ProgressionConditions
  decidedAt  DateTime @default(now())

  store   Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([storeId, productId])
}

enum ProgressionDecisionKind { ACCEPTED  DECLINED }
```

### H. Reconsideration — material change, never a percentage

**A declined product becomes eligible again when a material condition changes,
not when an arbitrary counter is crossed.** An owner who said no to a £1,400
commitment has not changed their mind because units went from 40 to 60. They may
well have changed it because the supplier dropped the minimum to 50.

The snapshot is therefore of *conditions*, and each has a rule for what counts as
material:

```ts
export interface ProgressionConditions {
  capitalState: "unstated" | "stated";
  spendableCents: number;
  ownerCapabilities: OwnerCapability[];
  minimumOrderUnits: number | null;
  bulkUnitCostInCents: number | null;
  unitsSold: number;
  unitsPerWeek: number;
  netMarginCents: number | null;
  sourceAvailable: boolean;      // the supplier is still connectable
  currency: string;
}

export type ReconsiderationReason =
  | "capital_increased"
  | "capital_first_stated"
  | "capability_gained"
  | "minimum_order_lowered"
  | "supplier_price_dropped"
  | "margin_improved"
  | "demand_grew"
  | "source_became_available"
  | "policy_changed";
```

| Condition | Material when |
|---|---|
| `spendableCents` | rises **at or above** the upfront cost that blocked it — the change that turns *no* into *yes*, not any increase |
| `capitalState` | moves `unstated` → `stated`, in either direction of amount. The owner has now told us something |
| `ownerCapabilities` | a capability the offer required is gained |
| `minimumOrderUnits` | falls, or becomes known having been unknown |
| `bulkUnitCostInCents` | falls, or becomes known having been unknown |
| `netMarginCents` | becomes known having been unknown, or rises enough to change payback by a week or more |
| `unitsPerWeek` | rises enough to change payback by a week or more |
| `sourceAvailable` | `false` → `true` |
| `policyVersion` | differs from the current policy (I12) |

**Demand is deliberately expressed as payback, not as units.** "You've sold 50%
more" is a fact about a number; "this now pays for itself in four weeks instead
of nine" is a fact about the decision the owner declined. Only the second is a
reason to ask again.

**The reason is recorded and shown** (I9). J4 does not re-raise a product; it
says *why* it is raising it again:

> *"You said no to the case of foam rollers in June. The supplier has dropped
> its minimum from 200 to 50, so it's £340 now rather than £1,400."*

An offer with no material change is **not** re-raised, however much time passes.

## Decision boundaries

Each of these is a separate function with a single job. The split is the
architecture; collapsing any two of them is how this becomes a catalog again.

```ts
// pure — the economics of a method
methodProfile(kind: ProductSourceKind): SourcingMethodProfile

// pure — platform judgement, versioned (I12)
currentPolicy(): ProgressionPolicy

// database read — three states, never collapsed (I1, I11)
capitalPosture(storeId: string): Promise<CapitalPosture>

// derived from real orders. Contains NO thresholds (I6, I12, I14)
productEvidence(storeId: string, productId: string): Promise<ProductEvidence>

// pure — policy applied to evidence, and the only place thresholds appear
earnedRungs(evidence: ProductEvidence, policy: ProgressionPolicy): number[]

// derived from evidence + policy + what is already sourced (I5)
businessStage(storeId: string): Promise<BusinessStage>

// pure — CAN this business do this, today?
assessFeasibility(input: {
  profile: SourcingMethodProfile;
  posture: CapitalPosture;
  supplier: { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null };
  evidence: ProductEvidence | null;   // null for a candidate never sold
  currency: string;
}): Feasibility

// pure — DOES this belong here? Already built, unchanged.
scoreCandidate(candidate, context): Recommendation

// pure — the two combined, in the required order (I10)
decide(fit: Recommendation, feasibility: Feasibility): Outcome
```

### `Feasibility`

```ts
export type Feasibility =
  | { kind: "affordable" }
  | { kind: "cannot_assess"; missing: ("minimum_order" | "bulk_price" | "product_cost")[] }
  | {
      kind: "not_yet";
      currency: string;
      upfrontCents: number;
      shortfallCents: number;
      /** WHICH capital state produced the shortfall (I11). Decides whether J4
       *  should ask, and it must never be lost between here and the owner. */
      capitalBasis: "stated" | "assumed_because_unstated";
      missingCapabilities: OwnerCapability[];
      /** Null whenever any input is unknown (I2). Never an estimate. */
      paybackWeeks: number | null;
      unitsToGo: number | null;
    };
```

`paybackWeeks` = `upfrontCents / (marginPerUnitAtBulk × unitsPerWeek)`, and is
`null` whenever any input is unknown (I2). **A payback figure is never an
estimate**: it is the number an owner would spend money on.

`capitalBasis` is the difference between two sentences J4 must not confuse:

- `stated` → *"That's £1,400 and you told me you have £300 to put in."*
- `assumed_because_unstated` → *"That's £1,400. I'm working on the assumption you
  don't want to put money in — tell me if that's wrong."*

### `Outcome`

```ts
export type Outcome =
  | { kind: "recommended_now"; reasons: string[] }
  | { kind: "not_yet"; reasons: string[]; blockers: string[]; plan: string;
      capitalBasis: "stated" | "assumed_because_unstated" }
  | { kind: "not_a_fit"; concerns: string[] }
  | { kind: "cannot_assess"; missing: string[] };
```

**The order in `decide()` is normative** (I10, I3):

1. fit verdict `does_not_fit` → `not_a_fit`. Feasibility is never consulted.
2. fit verdict `unknown` → `cannot_assess` with *"I don't know your business well
   enough yet"*.
3. feasibility `cannot_assess` → `cannot_assess` with the missing supplier facts.
4. feasibility `not_yet` → `not_yet`, carrying the fit reasons **and** the plan.
5. otherwise → `recommended_now`.

Step 4 is invariant I8 made concrete: a product that fits and is not affordable is
**shown**, with what would change it, not hidden.

## Graduations

```ts
findGraduationOpportunities(storeId: string): Promise<GraduationOpportunity[]>
```

For every product the business sells:

1. Compute `productEvidence` — facts only, no thresholds.
2. Apply `earnedRungs(evidence, currentPolicy())` and take the highest rung above
   the product's current `sourceKind`.
3. If a `ProgressionDecision` declined it, compare today's conditions against the
   recorded snapshot. **Skip unless a material condition has changed**; where one
   has, carry its `ReconsiderationReason` through to the outcome (I9).
4. Assess feasibility for that rung, in the business's currency.
5. Emit the outcome. A graduation that is `not_yet` is **still emitted** — it is
   the most motivating thing in the system, and hiding it would be the mistake.

A graduation is an `Outcome` about a product the business already sells. It is
deliberately the *same* type as a discovery outcome: an owner should not have to
learn two vocabularies for "here is something worth doing".

---

## Schema changes

Additive only. No existing row changes meaning; no backfill that alters a fact.

1. `ProductSourceKind` gains `PRIVATE_LABEL` (rung 2) and `CONTRACT_MANUFACTURED`
   (rung 3). Postgres enums only append, so this is safe.
2. `Store` gains `currency` (default `"USD"`), `investableCapitalCents`,
   `capitalStatedAt`, `ownerCapabilities`.
3. `SourcedProduct` gains `minimumOrderUnits`, `bulkUnitCostInCents`,
   `leadTimeDays`.
4. `Order` gains **`quantity Int @default(1)`** — see below.
5. New `ProgressionDecision` + `ProgressionDecisionKind`.

**No column stores business stage, product evidence, or earned rungs** (I5, I12).

### Order quantity — the minimum that keeps evidence truthful (I14)

`unitsSold` must not permanently mean *number of orders*. A single order for 100
units is not the same evidence as 100 orders for one, and a progression decision
built on the wrong one would tell an owner to buy a case on the strength of one
bulk sale.

**What is added:** one column, `Order.quantity Int @default(1)`.

- **The default is truthful for every existing row.** Every order Genesis has
  ever written came from a checkout that sells one product with no quantity
  control, so each is genuinely one unit. This is a backfill that records what
  was already true, not one that invents a value (I2).
- `amountInCents` remains the **order total**. Per-unit revenue is
  `amountInCents / quantity`, computed where needed and never stored twice.
- The Stripe and PayPal capture paths write `quantity` from the line item where
  the provider states one, and `1` where it does not — which is the current
  behaviour of both, made explicit.

**What is deliberately NOT added:** a line-item model, cart support, inventory
counts, or per-unit price history. One order still concerns one product. This is
the smallest change that stops the evidence lying, and nothing more.

## Architecture vs interface

The test applied throughout: *if J4 said this out loud on a phone call, would it
still have to be true?*

| Architecture | Interface |
|---|---|
| Method profiles, capital posture, readiness, stage | How groups are labelled and ordered |
| Feasibility and the four outcomes | Which reasons are shown, and how many |
| Graduation evidence and thresholds | Whether a graduation is a card, a message, or a moment |
| Material-change reconsideration, and its reasons | Whether declined items are collapsed or hidden |

---

## Minimum P0.5 implementation boundary

Eight units of work, each independently verifiable. Nothing here renders a screen.

| # | What | Verified by |
|---|---|---|
| 1 | `methodProfile()` + the two new enum values (`PRIVATE_LABEL`, `CONTRACT_MANUFACTURED`) | pure: every kind has a profile; rung ordering; `carriesOwnBranding` true only for kinds that genuinely customise |
| 2 | `Store.currency`; every money type carries it | pure + real Postgres: no function assumes a currency; two businesses on one account may differ |
| 3 | Capital posture columns + `capitalPosture()` returning the **three-state** value | pure: unstated and explicit-zero behave identically and remain distinguishable (I11); real Postgres for the round trip |
| 4 | `Order.quantity` + backfill to 1; capture paths write real quantity | real Postgres: one order of 100 units is not 100 orders of one (I14); existing rows unchanged in meaning |
| 5 | `productEvidence()` — no thresholds anywhere in it | real Postgres: units, refunds, window, margin; **margin `null` where cost is unknown**, never zero |
| 6 | `progressionPolicy` constant + `earnedRungs()` + `businessStage()` | pure: thresholds are read from policy only; changing the constant changes outcomes and touches nothing else (I12) |
| 7 | `assessFeasibility()` + `decide()` — the four outcomes, in the normative order | pure: fit-before-feasibility (I10); `not_yet` carries a real plan; `capitalBasis` survives to the outcome |
| 8 | `findGraduationOpportunities()`, `ProgressionDecision`, and reconsideration by **material change** | real Postgres: a decline is remembered; an unchanged condition never re-raises; each material change re-raises **with its reason** (I9) |

Plus one adversarial suite over the whole thing: **two businesses on one account
at different stages**, proving evidence, policy application, stage, capital
posture, decisions and graduations are all per-business (I7).

**Out, deliberately:**

- **Any private-label or manufacturing connector.** The rung exists in the model
  before a supplier for it does — the reverse is how a supplier's shape ends up
  dictating the architecture.
- **Inventory tracking and reordering.** A stocked product's remaining units are
  not modelled. `WHOLESALE_STOCKED` stays honest about the shape without
  pretending to count.
- **Line items and carts.** `Order.quantity` is the smallest change that stops
  the evidence lying. One order still concerns one product.
- **Multi-currency within one business.** `Store.currency` makes the assumption
  explicit and local, so lifting it later is a contained change rather than an
  excavation.
- **The customer-facing catalog screen.** Waiting on approval of the discovery
  UX proposal.
- **Asking the owner for capital.** The columns exist and are read; the
  conversation that fills them is interface work — though the three-state posture
  is precisely what makes that conversation possible to write later.

---

## Decisions taken, and what is still open

**Decided 2026-08-20, and folded in above:**

| | |
|---|---|
| Thresholds | Kept as the **initial policy**, versioned and configurable, never hardcoded as domain truth. Evidence and policy are now separate types with separate functions (I12) |
| Re-offering | The fixed 50% rule is **gone**. Reconsideration is triggered by a **material change** in a named condition, and the reason is recorded so J4 can explain it (I9) |
| Currency | Modelled on the business, AND on every supplier statement (added 2026-08-20). `SupplierEconomics.currency` is NOT NULL, written from the owning Store at ingest. `assessFeasibility` returns `cannot_assess` with `matching_currency` when they differ — nothing in this codebase converts, and applying a rate nobody supplied would turn a real quote into a fabricated figure that looks just as trustworthy (I13) |
| Order quantity | `Order.quantity` added. Evidence counts units, not orders (I14). No line items, no carts, no inventory |
| Unknown vs zero | New invariant I11. The system may *act* as though capital is zero; it must never *record* an unstated posture as a stated one |

**Still open, and genuinely judgement rather than derivation:**

1. **The initial threshold values.** 20/28 for rung 1 is deliberately
   conservative — the cost of being early is an owner spending money they should
   not have. Now cheap to change: one constant, one version bump.
2. **What counts as "enough to change payback by a week"** in the material-change
   table. A week is a guess at the granularity an owner would notice.
3. **Does unknown shipping block affordability?** Today it does not: if the
   owner has $450 and the known cost is $410, the answer is `affordable` with the
   figure marked as a floor. If delivery then turns out to be $60 they are $20
   short. Blocking instead would mean nobody gets a stocked recommendation until
   somebody records a delivery charge, which is the paralysis this whole layer
   exists to end. **This is the one rule in the economics layer I decided rather
   than derived**, and it is the first thing to revisit if it bites.
4. **The three freshness windows** (30 / 120 / 60 days). Judgement, in the same
   category as the 20/28 rung-1 thresholds and cheap to change for the same
   reason: one constant, one version bump.
5. **`qualifiedConfidenceMultiplier` at 0.9.** Deliberately close to 1 — a
   tiebreaker, not a penalty. Anything harsher would let a missing shipping
   figure bury a move worth thousands.
6. **Where `Order.quantity` comes from for PayPal.** Stripe line items state a
   quantity; PayPal's capture response is per purchase unit and this codebase
   creates one order per product. Writing `1` is correct for what the checkout
   actually sells today, and the moment a cart exists this needs revisiting.
