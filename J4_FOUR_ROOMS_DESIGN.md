# The Four Rooms — design proposal

**Status: PROPOSAL. Not approved, not built.** Sean, 2026-08-22: *"draft the four-room design as a proposal only — canvas, ledger, catalogue, and workbench — explaining the purpose of each room, what information belongs there, how they differ, how J4 moves between them, and what business actions each room enables. No interface code or implementation yet."*

`GENESIS_SURFACES.md` reserves this question deliberately: *"How the rooms actually feel different from one another while remaining one Genesis. Not decided here, and not to be settled by implementation."* This document exists to be argued with and then either locked or thrown away. Nothing here is authorization to build.

---

## 0. The premise changed after the question was asked

The locked architecture (2026-08-15) names four rooms and assigns them four metaphors:

> *"Storefront is a canvas, Orders is a ledger, Studio is a workbench, Products is a catalogue — those are genuinely different kinds of work and can look it."*

**The code says something different now, and the difference is two of Sean's own later decisions.** From `lib/dashboard/navConfig.ts`:

- **2026-08-17 — Products and Orders became one room, Commerce.** *"Selling and fulfilling are one job to an owner; they were two tabs because they are two tables."*
- **2026-08-17 — Account became a real primary room**, not overflow. It is a sentinel href: it opens a sheet in place rather than navigating, because everything inside it is configured, not visited.

The bar today, with `PRIMARY_TAB_COUNT = 4`:

```
Storefront   Studio   ( J4 )   Commerce   Account
                      Office
```

**So the ledger and the catalogue are now the same room.** Four metaphors, three rooms with visual character, and one sheet.

This matters before any pixel is chosen: a design that gave the ledger and the catalogue different characters would visually re-split a room Sean deliberately merged, and it would do it in the name of a document that predates the merge. Every proposal below is written against the rooms that exist.

*(Minor, non-blocking: the comment block above `NAV_SECTIONS` still describes the pre-merge order `Storefront | Orders | (J4) | Products | Account`. The list beneath it is correct and current. Worth a one-line correction whenever that file is next touched.)*

---

## 1. Purpose — the question each room answers

| Room | The owner's question | What they actually do here |
|---|---|---|
| **Storefront** | What does my business look like? | Look at the real site. Change how it looks. |
| **Studio** | What am I making? | Make one thing. See alternatives. Iterate. |
| **Commerce** | What's happening, and what am I selling? | Read what changed. Tend the shelf. |
| **Office** | What have we been working on? | Read the accumulated stream. Decide. |
| **Account** | *(not a question)* | Configure once. Leave. |

Account is on this list for completeness and is deliberately **not** a design subject. A surface you visit twice a year does not need character; it needs to be findable and boring. Giving it a personality would be inventing work.

---

## 2. What information belongs in each room

Taken from the real registries, not proposed:

| Room | Sections (`navConfig.ts`) |
|---|---|
| **Storefront** | Storefront · Identity |
| **Studio** | *(none — a one-section room shows no section row, which is correct)* |
| **Commerce** | Orders · Products · What you could sell · Customers · Revenue |
| **Office** | Conversation · Tasks · Ideas · Decisions · Information · Understanding |
| **Account** | Settings · Billing · Connections · Payments · Growth Points |

Two of these are worth stating as deliberate, because both look like omissions:

- **Fulfillment has no section.** It is not a page — it is what you do *to* an order, and it lives on the order itself. A section for it would be a destination invented to make a list look symmetrical.
- **"What you could sell" is its own section rather than a tab inside Products.** One is the shelf as it stands; the other is what Genesis thinks should be on it. Folding the second into the first would make a recommendation look like inventory.

---

## 3. How the rooms differ — the actual proposal

### The thesis

**A room's character comes from what it is made of, not from what colour it is.**

Three variables, all of which change what the room *is* rather than how you reach it:

1. **The lead** — what the eye lands on first, before scrolling.
2. **The density** — how much is on screen at once.
3. **The ground** — what the content sits on.

| Room | The lead | Density | The ground |
|---|---|---|---|
| **Storefront** | The real rendered site | One thing, edge to edge | A neutral mat. The room recedes so the site is the brightest thing on screen. |
| **Studio** | The piece being made, beside its alternatives | One thing, large, comparable | The darkest room. Work in progress is the light source. |
| **Commerce** | One line: what changed since you were last here | Many rows, tight, tabular figures | A flat sheet. Ruled, not carded. |
| **Office** | The conversation | A single continuous stream | Its own atmosphere — already built, already distinct. |

### Why this satisfies the locked constraints

- **Blue stays J4's alone.** No room's identity depends on hue. The doc is explicit: *"a room that glows blue steals the one signal the owner has learned to read. Rooms get light without colour."*
- **Nothing new to learn.** Same four labels, same place, same tap. The difference is entirely inside.
- **The difference comes from the work.** A canvas, a workbench and a sheet of paper are different because the work is different — which is the constraint the architecture sets, restated as three concrete variables.
- **Legibility, not theatre.** No motion system, no depth metaphor, no spatial navigation. The active room keeps the same ordinary emphasis in every room: *the room changes; the way you know which room you're in does not.*
- **Polish, never add.** Studio showing no section row stays. Commerce does not gain a sixth section. Nothing here introduces a surface.

### The Office is the harder half, and my proposal is that it gets no character at all

`GENESIS_SURFACES.md` flags this: the Office *"has to feel like J4's own space without becoming a fifth visual style, and it is the only surface that appears on top of a room rather than beside it."*

**Proposal: the Office keeps exactly the atmosphere it already has, and is deliberately the one surface that looks identical over every room.** That constancy is what makes it J4's space rather than a room's. A fourth peer style would make it a fifth room — the precise failure the architecture spent a day removing.

This has already been verified as working end to end (`scripts/verify-office-browser.ts`, 2026-08-22): six views, both doors, closing returns to the exact room.

### How far to take it — the decision

Three coherent levels. They differ in how much they change, not in direction.

| | What changes | Risk |
|---|---|---|
| **A — Restraint** | Lead and density only. Every room keeps the same ground. | Rooms may still read as tabs with better names. |
| **B — Material** *(recommended)* | Lead, density and ground. | The one that has to be got right; a wrong ground reads as a different product. |
| **C — Full character** | B, plus a per-room type scale. | Real risk of four products. Not recommended without seeing B first. |

**I recommend B**, and recommend seeing it in one room — Commerce, because it is the densest and the least like a canvas — before committing the other two.

---

## 4. How J4 moves between the rooms

### What is already true and must not change

- **J4 never navigates as a side effect.** The owner's page and scroll position are the primary state, and nothing J4 does may destroy them.
- **The Office overlays rather than routes.** Closing it returns the owner to the exact room and scroll position. Structural, not incidental — the room underneath is never unmounted.
- **J4 routes on intent to act, never on a question.** *"If I ask 'what makes a good hoodie design?' J4 should answer me. If I say 'okay, make me a hoodie', then J4 should take me to Studio."* Covered by `scripts/verify-j4-routing.ts`.
- **Voice works in every room. No exceptions.**

### The gap — verified today, not inferred

`lib/j4/workspaceContext.ts` is a closed registry of 14 routes, matched **exactly**, that tells J4 *"the owner is looking at Storefront right now"* so that *"make this bolder"* is a complete sentence. Every key in it begins `/dashboard/`.

Business-in-the-URL shipped 2026-08-20. Owners are now at `/b/<slug>/...`.

```
KNOWS   /dashboard/website
BLIND   /b/copper-and-coil/website
KNOWS   /dashboard/orders
BLIND   /b/copper-and-coil/orders
BLIND   /dashboard/studio
BLIND   /dashboard/catalog
```

**J4 currently cannot tell which room the owner is standing in on any of the routes owners actually use.** Studio and "What you could sell" are unknown on both old and new paths — neither was ever added.

This is a precondition rather than part of the room design, and it is worth saying plainly: **rooms that feel different mean nothing to a partner who cannot tell which one you are in.** I recommend fixing it as its own small change, before or alongside the room work — never folded into it.

A second, smaller instance of the same drift: `ACTION_SECTIONS` in `lib/execution/genesisActions.ts` still routes approved changes to `Website`, `Identity`, `Marketing` and `Settings` at `/dashboard/*`. When J4 tells an owner where a change landed, it names rooms that no longer exist. Also its own change, not this one.

---

## 5. What business actions each room enables

Every action below is a real registered executable in `GENESIS_ACTIONS`. Nothing here is aspirational.

| Room | Actions |
|---|---|
| **Storefront** | `update_hero` · `update_theme` · `refine_storefront` · `update_homepage_content` · `update_section_order` · `update_seo` · `update_brand_logo` · `update_brand_identity` · `update_store_identity` |
| **Studio** | `create_product_from_design` · `update_product_image` · `update_marketing_assets` · `update_design_direction` |
| **Commerce** | `create_product` · `update_product` · `delete_product` · `update_product_image` · `answer_supplier_economics` |
| **Office** | `update_goal_status` · `resolve_challenge` · `communicate_finding` |
| **Account** | `update_store_content` |

**This mapping is mine, and it is a proposal.** It is derived from what each action actually touches. The shipped `ACTION_SECTIONS` map is still keyed to the pre-rooms sections, so this table does not describe current behaviour — it describes what the table should become if the rooms are to be real. Two consequences worth deciding on:

- `update_seo` currently lands in **Marketing**. Under the rooms it belongs in Storefront: the search listing is how the business looks to someone who has not arrived yet.
- `update_goal_status` and `resolve_challenge` land on **Home** today, honestly, because no dedicated page exists. Under the rooms their natural home is the Office, which now genuinely has one — the Understanding view.

---

## What this proposal does not do

- No new navigation, no spatial metaphor, no motion system, no new surface.
- No change to the orb, Talk Mode, the voice architecture, `useJ4Talk.ts`, or 88px.
- No re-splitting of Commerce.
- No fifth room. The Office stays behind J4.
- No per-room colour identity.
- No interface code. Nothing in this document has been built.

---

## The decision register

Five decisions. Each carries its recommendation and what it commits us to. Nothing is built until these are resolved.

> **The navigation reality is the baseline.** Sean, 2026-08-22: *"preserve the current navigation reality — Storefront, Studio, Commerce, Account, with J4/Office separate — rather than forcing the old Storefront/Orders/Studio/Products model back onto the product."* Every proposal in this document is written against that bar. Decision 2 is therefore recorded as confirmed pending sign-off rather than genuinely open.

### 1. How far the rooms differ — Level A, B or C

**Recommended: B (Material).** The lead, the density and the ground change per room. Prove it in Commerce first.

- **Architectural consequence.** The ground becoming per-room is the structural part. `DashboardShell` paints one surface for every room today; B means the shell derives its surface from the active room, in **one place**. Locking B commits us to a room-keyed token set defined centrally, and forbids per-page styling — which is exactly how rooms drift into separate products.
- **Product consequence.** A leaves the rooms as tabs with better names, the failure this document exists to avoid. C risks four products and cannot be judged before B exists. B is the only level that changes what a room is *made of* without changing anything the owner has to learn.

### 2. Commerce holds both the ledger and the catalogue

**Recommended: Confirm.** This supersedes the four-metaphor line in `GENESIS_SURFACES.md`, written 2026-08-15 — two days before the merge.

- **Architectural consequence.** The locked doc gets corrected so it stops describing a bar that does not exist. One room means **one ground and one density**, set by its densest content: the ledger. Products and "What you could sell" therefore have to work on a ruled sheet rather than in a gallery.
- **Product consequence.** One place for selling, which is how the owner thinks — *"they were two tabs because they are two tables."* The cost worth watching: Products is the most image-heavy thing in the room and will be the first place a ledger ground looks wrong. A sub-question for the Commerce prototype, not a reason to re-split.

### 3. The Office gains no character

**Recommended: Agree.** It keeps the atmosphere it already has and looks identical over every room.

- **Architectural consequence.** This makes the Office an explicit **exemption** from the per-room ground system, and that is worth recording as an invariant: *the Office's appearance is independent of the room it is over.* `GENESIS_ATMOSPHERE` stays its single source; any change letting a room's ground leak into the overlay is the bug.
- **Product consequence.** Constancy is the signal. An Office that took on each room's character would read as a feature *of the room* rather than as the partner's own space — the fifth-room failure the architecture spent a day removing.

### 4. Fix J4's sense of place first, as its own change

**Recommended: Yes, first and separately.**

- **Architectural consequence.** The important part is *how*. `resolveWorkspaceContext` must learn `/b/<slug>/…` and gain Studio and catalog entries, while staying a **closed registry with exact matching**. Normalise-then-match — strip the business prefix, then match exactly — never loosen to prefix-matching, which would make `/b/x/products/abc` resolve to "the product catalog": the confident wrong answer the file exists to prevent.
- **Product consequence.** Until this lands, "make this bolder" is not a complete sentence anywhere owners actually are, and room character is invisible to J4. Doing it first lets the room work assume J4 knows where the owner is standing. Small: one resolver, two entries.

### 5. Re-key `ACTION_SECTIONS` to the rooms

**Recommended: Yes — after 4, and independent of the visual work.**

- **Architectural consequence.** `ACTION_SECTIONS` is one of the three hand-maintained mirrored registries already covered by the invariant in `ARCHITECTURE.md`. Re-keying means extending its guard from "every action has a section" to "every action's section is a **real room**". Assert it, do not merely rename it.
- **Product consequence.** J4 currently tells owners a change landed in Website, Identity, Marketing or Settings — rooms no longer on their screen. Two moves are substantive rather than cosmetic: `update_seo` belongs in Storefront (the search listing is how the business looks to someone who has not arrived yet), and `update_goal_status` / `resolve_challenge` belong in the Office, which now has a home for them in Understanding.

---

**Once these five are resolved, the room architecture can be locked and implementation can begin — in this order: 4, then 5, then 1 proven in Commerce.** Not before.
