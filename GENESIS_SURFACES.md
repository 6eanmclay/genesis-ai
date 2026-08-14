# The four surfaces: Business, J4, Office, Creation

**Status: DRAFT, 2026-08-14 — written for Sean's review, and explicitly NOT authorization to build.** Sean's instruction, verbatim: *"stop implementation and lock the architecture first... no more UI implementation until we review and approve that architecture."* Everything below describes a target. The inventory near the end states honestly what exists today, which is much less. Do not implement against this document without an explicit go-ahead, and do not treat any single section of it as approval for the section next to it.

**What this supersedes.** The "J4 Room" and "Full workspace" concepts, including the ones shipped earlier today (`7e30c7e`, `6c7ea05`). There is no Room anymore. Office and Creation replace it. `J4_WORKSPACE_ARCHITECTURE.md` (2026-08-07, never implemented as written) is also superseded: it proposed J4 as a full-window workspace you enter, which is the model this document exists to reject.

---

## The governing distinction

**J4's persistent layer and J4's full workspace are different things.** Almost every wrong turn in this design has come from collapsing them into one.

- The **persistent layer** is the primary way the owner works with J4. It comes to them. It never navigates.
- **Office** and **Creation** are places the owner goes *on purpose*, for review or for making something.

Conflating them produces the failure we keep landing on: tapping J4 becomes a trip, the owner loses their place, and a business partner turns back into a chatbot behind a door.

### The non-negotiable test

> **If tapping the J4 summon causes the owner to leave the page they are currently working on, the implementation is wrong.**

Sean made this the period at the end of the argument. It is a structural test, not a stylistic one, and it applies to *everything* in the turn — not only the tap. A turn that ends by redirecting the owner back to the page they were already on fails this test just as surely as one that opens a new route, because the App Router scrolls to top and their place is gone either way. That specific bug was real and is fixed (`09ffb55`); the test is written here so it stays fixed.

---

## 1. Business — "I'm looking at my business"

The business itself: Overview, Identity, Website, Products, Understanding, Customers, Orders, and whatever comes later. This is where the owner spends their time. It is the primary workspace, and it is the thing every other surface is in service of.

**The owner's current page and scroll position are the primary state.** Nothing J4 does may destroy them.

## 2. J4 — "I'm talking to my business partner"

**Not a destination.** The persistent centre control, always available, always on top. Summoning means *bring J4 here* — never *take me to J4*.

The interaction it exists to make possible, in Sean's own shape:

```
Browse business → summon J4 → talk → J4 responds
    → keep browsing → summon again → same conversation continues
```

No page transition anywhere in that loop. The owner can be 2% down Identity, 80% down Products, or halfway through Website, say *"J4, change this,"* and carry on scrolling.

**The conversational loop this enables is the actual product:**

```
IDEA → DISCUSSION → REBUTTAL → REFINEMENT → CONCLUSION → IMPLEMENTATION
```

Not `QUESTION → CHAT ROOM → ANSWER → EXIT`. The first is a business partner. The second is a chatbot. The worked example Sean gave — *"I don't like this mission statement"* → J4 proposes → *"too corporate"* → J4 refines → *"yeah, that's better"* → J4 applies it — never leaves Identity, and never requires the owner to remember where they were.

**What belongs in the layer:** the conversation and the composer. That is all.

**What must never be in the layer:** queues, lists, records, history, tabs. Those are Office. The test for any future addition is whether it is part of *this* conversation. If it is a collection of things, it belongs in Office, and putting it here rebuilds the trip the layer exists to remove.

**The morning briefing belongs to J4, not Office.** It is J4's proactive daily briefing, not a document filed somewhere. J4 says what matters today, offers the owner a chance to respond or add something, and then gets out of the way. It must support **Listen** as well as reading — the owner should be able to hear their briefing while looking at their dashboard rather than parsing a wall of prose. Brief → respond if necessary → go run the business.

## 3. Office — "I'm reviewing what J4 and I have been doing"

Where the owner intentionally goes to review, organise and understand accumulated work: conversations, goals, decisions, tasks, ideas, documents, business knowledge, history and briefings.

**One coherent Office, not five destinations.** Today's `Conversation | Tasks | Ideas | Decisions | Information` tab rail is J4's internal filing cabinet exposed as navigation. It asks the owner *"which J4 room do I need to enter?"*, which is the wrong question. Office should answer *"here's everything we've been working on"* — and let J4 retrieve against it conversationally:

- *"Show me what we've decided about the website."*
- *"What are the three things we're working on right now?"*
- *"Show me everything we've discussed about the new brand."*

Those are retrievals, not tabs. Whether any permanent sub-navigation survives is an open question below.

## 4. Creation — "J4 and I are making something"

The full-screen studio: logos, brand identity, website redesigns, product design, apparel, marketing, images, campaigns. Large canvas, zooming, side-by-side comparison, iteration, and real creative tooling.

**Creation is one surface with tools inside it, never a growing list of tabs.** A permanent "Logo" destination guarantees that in six months there is also Website Design, Product Design, Images, Merch and Video sitting beside it, and we are back to the icon grid this whole design keeps deleting.

---

## Transitions

| From | To | When |
|---|---|---|
| Business | J4 | Any time. The summon. Never navigates. |
| J4 | Office | Intentional. *"Show me what we've decided about the website."* J4 **offers**; the owner accepts. |
| J4 | Creation | Intentional. *"Redesign this."* J4 **offers**; the owner accepts. |
| Office / Creation | Business | Returns to the exact page and scroll position they came from. |

**J4 offering to open Office or Creation is a suggestion, not a redirect.** These are what the owner does deliberately, not what happens every time they tap the J4 button.

---

## The visual inspection principle

> **Every meaningful visual change J4 proposes must be visually inspectable before the owner accepts it.**

Sean's framing, and it may be one of Genesis's signature experiences: most website builders make the owner mentally translate a description into an imagined result. J4 should eliminate that gap. The owner is not asking an AI to describe a website to them — **they are looking at the website together.**

**Proposal size must match change scope.** This is the rule, and today's implementation violates it:

| Scope | Presentation |
|---|---|
| Single element | Targeted before/after of that element |
| Section | Section-level comparison |
| Page or full redesign | Large or full-page comparison, with a `CURRENT ↔ PROPOSED` toggle |

**A whole-site redesign must never be represented by a small cropped hero preview.** When J4 changes six things and shows a thumbnail, the owner cannot judge the proposal, and "I changed six things" is not the same as showing them what their business now looks like.

**Proposals come to the owner; the owner does not go hunting for them.** A proposal buried at the bottom of the Website tab fails this. If the owner is already looking at the target, the comparison appears in context. If they are elsewhere, J4 brings the relevant visual into view without throwing them into another room.

**Context determines confirmation.** If J4 and the owner are already looking at the thing, J4 should not make them review the same thing twice — the conversational approval already given is the approval. If the request concerns something outside the current viewport (*"let's redo the website"* said from Identity), J4 must bring that target into view and show a proposal, because the owner cannot approve what they cannot see.

---

## The context model

**Page-level context is the foundation. Entity and element level is the target architecture. Do not fake the gap with hardcoded rules.**

What exists (`lib/j4/workspaceContext.ts`): a closed registry of 14 dashboard routes, matched exactly. It can tell J4 *"the owner is looking at Website."* A deeper path like `/dashboard/products/abc` deliberately resolves to **nothing** rather than answering "the product catalog," because a confident wrong answer to *"what is this product?"* is worse than no answer — J4 asking is already the agreed behaviour.

What the product requires:

- *"J4, I don't like this headline."* → **which** headline
- *"What do you think about this product?"* → **which** product
- *"Change this image."* → **which** image

That is the difference between an overwatching business partner and a chatbot sitting on top of a website. It is not in this pass, and it is not a hardcoded lookup table bolted onto the current registry. **The requirement now is that the context model be designed to grow into entity and element resolution** rather than needing to be replaced to get there.

Two properties must survive that growth, because they are security and honesty properties, not conveniences:

1. **Closed resolution.** The path arrives from the browser and whatever comes out is concatenated into a model prompt. An unrecognised target resolves to nothing; the client's own string is never interpolated into a prompt. Entity-level context must inherit this — resolve IDs against real records, never echo them.
2. **Silence over confidence.** Unknown context yields no claim, not a plausible guess.

---

## Design intelligence — named, and explicitly out of scope

J4 can now execute precise storefront changes. **Execution is not design intelligence.** A proposal can be technically correct and still bad, because J4's concept of "improve the website" is currently too shallow.

The real target: visual hierarchy, composition, contrast, whitespace, movement, imagery, storytelling, product emphasis, calls to action, section rhythm, visual variety, brand personality, above-the-fold impact, mobile composition — recognising when a page feels static, when a redesign warrants changing multiple sections, and **when not to change something at all.**

And the one that matters most: **does this website feel alive?** A handmade copper brand should not feel like a database with a header on it. It should feel like there is a person making these things, a story, craftsmanship, something worth exploring.

**This must not be solved by adding arbitrary rules** like "always add animation" or "always use bigger images." That is exactly how Genesis becomes another rigid website builder. It belongs in J4's *understanding* — evaluating the business, its audience, its products, its brand personality and its current composition before deciding what kind of improvement is warranted, or whether one is warranted.

**This is a separate research and knowledge problem.** It is not scoped here, should not be estimated here, and must not be started as a side effect of building anything above. It is the difference between *"J4 can edit a website"* and *"J4 is actually good at building websites"* — and we are now at the point where that distinction matters.

---

## Honest inventory: what exists today

**Built and live:**

- The persistent layer. J4 renders over the workspace, mounted for the life of the dashboard, and nothing navigates (`5be9221`).
- The summon as a topmost interaction layer, portalled to `document.body`, above the tab bar and the More menu, below only J4 himself (`83f78af`).
- Turns finish in place. The Server Action path no longer redirects the owner when the turn came from the layer (`09ffb55`).
- Page-level workspace context, both chat paths (`lib/j4/workspaceContext.ts`).
- A generic `Current → Proposed` diff component (`lib/execution/ActionDiff.tsx`) used by attention cards, products and the meeting screen. Element-scale only.
- `refine_storefront`, with a closed target registry and a 4-mutation ceiling.
- An owner briefing (`ownerBriefingSummary`) and a `J4SpeakButton`; real speech synthesis is unverified for want of an ElevenLabs key.

**Not built:**

- Office. Today there is a `/j4` route with a five-tab rail — the thing this document says to replace.
- Creation. Does not exist in any form.
- Scope-matched visual comparison. `ActionDiff` has no section or full-page mode.
- Proposals that come to the owner rather than waiting at the bottom of a page.
- Entity and element level context.
- Listen on the morning briefing as a first-class control.
- Design intelligence, in any form.

**Also present and unresolved:** `/j4/room`, a separate immersive voice room, and a `Just Talk` toggle inside the current workspace. Both predate this model and neither has a place in it as written.

---

## Open questions — these need Sean's decision before anything is built

1. **What happens to `/j4` and the "Full workspace" control shipped today?** Does the room become Office, with Creation added beside it? Does the layer's header control become two? Does `/j4` survive as a route at all, or do Office and Creation get their own?
2. **Does Office keep any permanent sub-navigation,** or is it purely conversational retrieval with a single landing view? "One coherent Office" rules out five tabs but does not by itself say what replaces them.
3. **What happens to `/j4/room` and `Just Talk`?** Both are conversation surfaces that this model has no slot for. Fold into Creation, fold into J4, or delete.
4. **Where does a proposal actually appear** when the owner is looking at the target — inside the layer, or in the page beneath it? This decides whether the comparison UI belongs to J4 or to the Business surface, which is a real architectural fork.
5. **Build order.** Office, Creation, and scope-matched comparison are three substantial pieces. Comparison is the one with a live complaint behind it and the smallest blast radius.

---

## How to apply

Check any proposed J4 work against three things before writing code: does it pass the non-negotiable test above; does it put a collection of things into the conversational layer; and does it let the owner accept a visual change they cannot actually see. If a change fails any of those, it is the wrong change regardless of how well it is implemented.

See also `GENESIS_EXPERIENCE_PRINCIPLES.md` (the governing lens: business partner, never chatbot), `J4_IDENTITY.md`, and `lib/j4CopyRules.ts` for the permanent no-dashes copy rule that applies to everything J4 says on every surface here.
