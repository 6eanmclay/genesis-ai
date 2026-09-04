# J4 personalization, ownership, and crypto — a future concept

**Status: CAPTURED 2026-09-04, NOT AUTHORISED TO BUILD.** Recorded at Sean's
instruction so it stops being something we might remember to discuss, and starts
being something architectural decisions are checked against. Nothing here is a
current implementation task, and no part of it is designed yet.

> **The architectural rule, first, because it is the only part that binds today:**
> do not build blockchain into the current J4, and do not architect the current
> J4 so that customization or ownership becomes impossible later.

---

## Why this document exists now rather than later

Because a decision taken this week already turned out to be load-bearing for it.

J4's base render used to have a smile baked into the visor, and the component
could only show another state by painting an opaque shape over the glass. On
2026-09-04 the expression was removed from the asset instead, leaving a **blank
visor** that the component owns entirely.

That change was made for a visual reason — the drawn shape was destroying the
photograph at dock size. It happens to be the exact separation this concept
needs: **one stable physical character, one controlled surface, unlimited
states.** Everything below is possible because the character and what appears on
his visor are no longer the same artefact. If a future change re-bakes anything
into the base asset, it closes this door, and that is the concrete reason to
refuse it.

---

## The five layers, kept separable

The whole concept reduces to not letting these five collapse into each other.
Any design that merges two of them should be treated as a mistake, and today's
code should keep the seams visible even while only the first two exist.

| Layer | What it owns | Today |
|---|---|---|
| **J4 Core** | identity, conversation, intelligence, capabilities | built |
| **J4 Presentation** | character, visor, expressions, illumination, animation | built (`J4Character`, `useJ4State`) |
| **J4 Configuration** | the owner's chosen appearance, voice, preferences | **not built** |
| **Commerce** | payments and purchases | partly built (Stripe, PayPal, Growth Points) |
| **Optional Ownership** | wallet, chain, digital ownership | **not built, not designed** |

`J4Core` must never read from `J4Configuration`. What J4 *knows and does* cannot
depend on which skin an owner bought, or the product becomes two products.

---

## 1. "My J4" — appearance as a configurable layer

Each owner should eventually be able to have a distinct J4 without there being a
second J4 implementation. Candidate dimensions, none designed:

helmet and armour appearance · armour finishes · J4 colour and energy colour ·
visor styles · eye designs · visor illumination effects · aura and background
effects · ear-module designs · voices · animation and reaction packs · special
skins · limited or exclusive appearances · future poses and gestures

**The invariant:** one interaction and state system; appearance is configuration
over it. Six states must not become six times N assets. The current
implementation already obeys this — states are lightings of one base, and
`useJ4State` is one derivation shared by every J4 on screen.

## 2. Personalization as a product layer

A possible progression — **J4 Basic → J4 Custom → Premium J4 → Exclusive** —
with some customization free and some paid. Premium skins, visor effects,
voices, animation packs, exclusive configurations, limited editions, and
potentially a creator ecosystem or marketplace.

**Not designed, deliberately.** Capture the shape; preserve the flexibility.
Note only that Genesis already has a metered-value system (Growth Points) and
real payment rails, so this would not start from nothing.

## 3. Optional digital ownership

The concept is **not** "sell people a picture of J4". It is *"this is my J4"* —
a digital asset that **references a configuration**: base J4, appearance, skin,
visor, colours, effects, voice and animation configuration, and edition or
rarity where that genuinely applies.

**Genesis must remain fully useful with no wallet and no crypto.** Ownership is
an optional collectibility layer over configuration, never the foundation J4
stands on. A J4 with no wallet attached must be a complete J4.

## 4. Crypto payments, as one capability rather than two systems

Crypto payments are already expected to arrive independently. Treat that and the
ownership layer as **one future Crypto / Blockchain capability**, so we do not
design two unrelated systems that later have to be reconciled:

accepting cryptocurrency as a payment method · wallet connections · payment
verification · refunds and the payment lifecycle · purchasing customization ·
purchasing digital J4 assets · optional on-chain ownership · transferring or
collecting configurations · security, custody and compliance

**No chain, token standard, wallet provider or marketplace model is assumed.**
Those are research for when this becomes an active milestone, not now.

## 5. J4 Optimization

Beyond appearance: J4's voice, interaction style, state communication, level of
detail, reaction preferences, workflow preferences and environment should
eventually adapt to the individual owner.

**Subordinate to his identity.** Personalization should make "my J4" feel
distinct without fragmenting what J4 *is* — the boundary being that
[J4_IDENTITY.md](J4_IDENTITY.md) governs who he is, and configuration only
governs how he looks and sounds while being that.

---

## How to use this document

When a J4 architectural decision comes up, check it against two questions:

1. **Does this bake anything into the base character** that would have to be
   re-generated per state, per skin, or per owner? If yes, it closes §1.
2. **Does this make Core depend on Configuration**, or Presentation depend on
   Commerce? If yes, it collapses two layers that must stay separable.

Neither question authorises building any of this. They are the checks that keep
it buildable.

**Related:** [J4_VISUAL_DIRECTION.md](J4_VISUAL_DIRECTION.md) (approved
direction), [J4_ASSET_SPECIFICATION.md](J4_ASSET_SPECIFICATION.md) (the blank
visor and locked regions), [VISION.md](VISION.md) (the six-chapter roadmap this
sits beyond).
