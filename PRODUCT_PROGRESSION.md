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
  /// What the owner has said they can invest, in cents. NEVER inferred (I1).
  investableCapitalCents Int?
  /// When they said it. NULL here means UNSTATED, which is different from
  /// stating zero: unstated may be asked about, zero must not be asked again.
  capitalStatedAt        DateTime?
  /// Capabilities the owner has confirmed. Absent = unknown = treated as false
  /// for feasibility, and worth asking about.
  ownerCapabilities      String[]  @default([])
}
```

**Resolution rule.** `availableCapitalCents = investableCapitalCents ?? 0`. An
owner who has said nothing gets recommendations that need nothing. This is the
zero-capital path, and it is the default rather than a fallback.

### C. Supplier economics — database, on `SourcedProduct`

Facts the supplier stated. Nullable throughout, and null means unknown (I2).

```prisma
model SourcedProduct {
  // ...existing...
  /// Units required to buy at bulk price. NULL = the supplier did not say.
  minimumOrderUnits   Int?
  /// Per-unit cost AT that minimum. NULL = unknown. Never derived from a
  /// percentage of unitCostInCents.
  bulkUnitCostInCents Int?
  leadTimeDays        Int?
}
```

### D. Product readiness — derived, never stored (I4, I5)

Computed on demand from that business's real orders.

```ts
export interface ProductReadiness {
  productId: string;
  unitsSold: number;          // paid, non-refunded orders
  refundedUnits: number;
  windowDays: number;         // first sale to now, min 1
  unitsPerWeek: number;       // unitsSold / (windowDays / 7)
  netRevenueCents: number;    // excludes refunded (matches §40)
  netMarginCents: number;     // netRevenue - (unitCost * units) - shippingCost
  returnRate: number;         // refundedUnits / (unitsSold + refundedUnits)
  /** Methods this product's evidence would justify. Never a promise it is affordable. */
  earnedRungs: number[];
}
```

**Derivation** — every input is an existing column:

- `unitsSold` = `Order` rows for this `productId` with `status = "paid"`.
  One order is one unit; there is no quantity column, and inventing one is out
  of scope.
- `refundedUnits` = same, `status = "refunded"`.
- `netMarginCents` = `sum(amountInCents)` over paid orders, minus
  `Product.costInCents * unitsSold` where cost is known, minus
  `sum(shippingCostInCents)`. **Where `costInCents` is null, margin is `null`,
  not zero** (I2).

**Earned-rung thresholds** — deterministic, and stated so they can be argued
with rather than discovered:

| Rung | Earned when |
|---|---|
| 1 — stocked | `unitsSold >= 20` AND `windowDays >= 28` AND `returnRate <= 0.10` AND `netMarginCents` is known and positive |
| 2 — private label | rung 1 AND `unitsSold >= 100` AND `windowDays >= 84` |
| 3 — own production | rung 2 AND `unitsSold >= 500` AND `windowDays >= 168` |

Time floors matter as much as volume: 20 units in three days is a spike, not a
pattern, and buying a case on it is exactly the mistake this system exists to
prevent.

### E. Business stage — derived, never stored (I5)

```ts
export type BusinessStage = "exploring" | "selling" | "proven" | "committing";
```

| Stage | Derived when |
|---|---|
| `exploring` | no paid orders in this business |
| `selling` | at least one paid order, no product has earned rung 1 |
| `proven` | at least one product has earned rung 1 |
| `committing` | at least one product is *sourced at* rung ≥ 1 |

Stage describes what is on the table. It never gates a specific product on its
own — that is readiness (I4).

### F. `ProgressionDecision` — database, new

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
  /// The evidence as it stood, so "has it materially changed" is answerable
  /// without re-deriving history. Json for the same reason recommendation is.
  evidence   Json
  decidedAt  DateTime @default(now())

  store   Store   @relation(fields: [storeId], references: [id], onDelete: Cascade)
  product Product @relation(fields: [productId], references: [id], onDelete: Cascade)

  @@index([storeId, productId])
}

enum ProgressionDecisionKind { ACCEPTED  DECLINED }
```

**Re-offer rule.** A `DECLINED` graduation is not offered again until
`unitsSold` has grown by **at least 50%** over the units recorded in `evidence`.
Anything less is the same suggestion in a new hat.

---

## Decision boundaries

Each of these is a separate function with a single job. The split is the
architecture; collapsing any two of them is how this becomes a catalog again.

```ts
// pure — the economics of a method
methodProfile(kind: ProductSourceKind): SourcingMethodProfile

// database read — what the owner has stated. Never inferred (I1).
capitalPosture(storeId: string): Promise<CapitalPosture>

// derived from real orders (I6)
productReadiness(storeId: string, productId: string): Promise<ProductReadiness>

// derived from readiness + orders (I5)
businessStage(storeId: string): Promise<BusinessStage>

// pure — CAN this business do this, today?
assessFeasibility(input: {
  profile: SourcingMethodProfile;
  posture: CapitalPosture;
  supplier: { minimumOrderUnits: number | null; bulkUnitCostInCents: number | null };
  readiness: ProductReadiness | null;   // null for a candidate never sold
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
      upfrontCents: number;
      shortfallCents: number;          // upfront - availableCapital
      missingCapabilities: OwnerCapability[];
      /** Only when readiness exists and margin is known. */
      paybackWeeks: number | null;
      unitsToGo: number | null;
    };
```

`paybackWeeks` = `upfrontCents / (marginPerUnitAtBulk * unitsPerWeek)`, and is
`null` whenever any input is unknown (I2). **A payback figure is never an
estimate**: it is the number an owner would spend money on.

### `Outcome`

```ts
export type Outcome =
  | { kind: "recommended_now"; reasons: string[] }
  | { kind: "not_yet"; reasons: string[]; blockers: string[]; plan: string }
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

Step 4 is the invariant I8 made concrete: a product that fits and is not
affordable is **shown**, with what would change it, not hidden.

---

## Graduations

```ts
findGraduationOpportunities(storeId: string): Promise<GraduationOpportunity[]>
```

For every product the business sells:

1. Compute `productReadiness`.
2. For each rung above the product's current `sourceKind`, in order, take the
   highest rung it has earned.
3. Skip if a `ProgressionDecision` declined it and the re-offer rule is not met.
4. Assess feasibility for that rung.
5. Emit the outcome. A graduation that is `not_yet` is **still emitted** — it is
   the most motivating thing in the system, and hiding it would be the mistake.

A graduation is an `Outcome` about a product the business already sells. It is
deliberately the *same* type as a discovery outcome: an owner should not have to
learn two vocabularies for "here is something worth doing".

---

## Schema changes

Additive only. No existing row changes meaning; no backfill.

1. `ProductSourceKind` gains `PRIVATE_LABEL` (rung 2) and `CONTRACT_MANUFACTURED`
   (rung 3). Postgres enums only append, so this is safe.
2. `Store` gains `investableCapitalCents`, `capitalStatedAt`, `ownerCapabilities`.
3. `SourcedProduct` gains `minimumOrderUnits`, `bulkUnitCostInCents`,
   `leadTimeDays`.
4. New `ProgressionDecision` + `ProgressionDecisionKind`.

**No column stores business stage or product readiness** (I5).

---

## Architecture vs interface

The test applied throughout: *if J4 said this out loud on a phone call, would it
still have to be true?*

| Architecture | Interface |
|---|---|
| Method profiles, capital posture, readiness, stage | How groups are labelled and ordered |
| Feasibility and the four outcomes | Which reasons are shown, and how many |
| Graduation evidence and thresholds | Whether a graduation is a card, a message, or a moment |
| The re-offer rule | Whether declined items are collapsed or hidden |

---

## Minimum P0.5 implementation boundary

**In:**

1. `methodProfile()` with the fixed table above, and the two new enum values.
2. Capital posture columns + `capitalPosture()`, defaulting to zero.
3. Supplier economics columns on `SourcedProduct`, populated where a source
   states them and left null where it does not.
4. `productReadiness()` and `businessStage()`, derived from real orders.
5. `assessFeasibility()` and `decide()` — the four outcomes.
6. `findGraduationOpportunities()` + `ProgressionDecision` and the re-offer rule.
7. Verification: pure suites for every derivation and threshold; a real-Postgres
   suite for readiness, stage, graduations and per-business isolation, including
   **two businesses on one account at different stages**.

**Out, deliberately:**

- **Any private-label or manufacturing connector.** The rung exists in the model
  before a supplier for it does — the reverse is how a supplier's shape dictates
  the architecture.
- **Inventory tracking and reordering.** A stocked product's remaining units are
  not modelled. `WHOLESALE_STOCKED` is honest about the shape without pretending
  to track quantity, exactly as it does today.
- **Order quantity.** One order is one unit. Real quantity is its own change and
  affects far more than this.
- **The customer-facing catalog screen.** Waiting on approval of the discovery
  UX proposal.
- **Asking the owner for capital.** The columns exist and are read; the
  conversation that fills them is interface work.

---

## Open questions for Sean

1. **Thresholds.** 20 units / 28 days for rung 1 is a judgement, not a
   derivation. It is deliberately conservative — the cost of being early is an
   owner spending money they should not have.
2. **The 50% re-offer rule** is the same kind of judgement.
3. **Currency.** Every figure is in one currency per business today. Multi-
   currency sourcing is not modelled and would touch margin arithmetic
   everywhere.
