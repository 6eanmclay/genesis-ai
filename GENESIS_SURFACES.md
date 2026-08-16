# The four surfaces: Business, J4, Office, Creation

> ## J4 is not a place I go. J4 is who comes with me.
>
> Sean, 2026-08-14, naming this **the governing principle for the entire interface** — not one principle among several. Every decision below is an instance of it, and any future proposal that cannot be squared with it is the wrong proposal regardless of how well it is built.

**Status: ARCHITECTURE LOCKED, 2026-08-14.** Drafted for review the same day; all five open questions answered by Sean and folded in below. The four surfaces, the transitions between them, the confirmation ladder and the build order are now settled and are not to be relitigated by implementation convenience. What remains open is *how* each piece is built, never *what* the model is.

**This is not blanket authorization to build.** The build order at the end is deliberate and sequential. **Office and Creation are explicitly not to be started yet.**

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

### The presence is the composer (locked 2026-08-14, second pass)

Sean's refinement, replacing "a button that opens J4": **the composer lives with the orb, permanently, just above the bottom navigation, with the orb overlapping the boundary so J4 reads as present in the current surface rather than waiting behind a door.**

- The owner can **type straight into it** without opening anything first. Someone who does not want to talk never has to.
- **Voice activates from the same presence.** Speaking and typing are input modes, not different conversations.
- Sending from it opens the conversation **in place**, showing J4's reply over the current page. Nothing navigates.

The rule this encodes: *J4 doesn't take me somewhere to talk to J4. J4 comes to wherever I already am.*

**One composer, not two.** The inline field is an entry point to the single conversation's composer, never a second send path. A second place to type is a second conversation, which is the thing this whole architecture rules out.

**Two states, one conversation.** The presence is the lightweight default and does not show history — most exchanges do not need it. Expanding reveals the history, and it is the *same* conversation expanded, never a second surface opening. Collapsing hides the reading of it, not the having of it.

**The orb sits half in, half out of the interaction bar.** Not a standalone element parked above a field: it breaks the bar's own edge so J4 reads as physically attached to the page rather than floating on it. That overlap is the whole visual argument for "J4 is here", and it is why the orb is not simply another control in a row.

**Tapping the orb activates J4 here, and does only that.** It expands nothing, focuses nothing, and records nothing. The orb visibly wakes — a pulse and a steady glow — leaving the owner on the same screen with the composer still compact: *"tapping it should activate J4 HERE, not navigate or immediately turn into the pull-out/expanded conversation. The user should see and feel that J4 has been activated."*

**The orb is not the microphone, and must not quietly become it.** The orb is the persistent presence; the mic is the voice control, and it lives with the conversation. Merging them would let a tap start a recording nobody asked for. Equally, the orb is not a shortcut to the text field — an orb that pops a keyboard has announced the field rather than J4. Someone who wants to type taps the field, which is right there.

**Activation must be visible.** An orb that responds to a tap with nothing has not communicated anything. Subtle, but it has to actually do something.

**Expansion is its own affordance.** The grab handle pulls the conversation up, and sending expands too, because a reply needs somewhere to be read. Nothing else expands. Compact is the default and expansion is secondary, which is the whole difference between a presence and a panel. Collapsing returns to compact; the conversation underneath is untouched either way.

**The shape of the surface:** presence strip → orb on the seam → compact composer, about one to two lines. The orb bridges the two areas rather than sitting on top of one, and is backed in the panel's own colour so the overlap leaves no visible crack.

**Never two J4 presences on one screen.** If the persistent presence is on a page, that page does not also carry a large J4 of its own. This mistake has now been made three times — a business-area icon grid, permanent observation cards, and a home hero duplicating the presence — and each time the fix was deleting the duplicate, never arranging it better.

**What belongs in the layer:** the conversation and the composer. That is all.

**What must never be in the layer:** queues, lists, records, history, tabs. Those are Office. The test for any future addition is whether it is part of *this* conversation. If it is a collection of things, it belongs in Office, and putting it here rebuilds the trip the layer exists to remove.

**The morning briefing belongs to J4, not Office.** It is J4's proactive daily briefing, not a document filed somewhere. J4 says what matters today, offers the owner a chance to respond or add something, and then gets out of the way. It must support **Listen** as well as reading — the owner should be able to hear their briefing while looking at their dashboard rather than parsing a wall of prose. Brief → respond if necessary → go run the business.

**A recommendation appears where the conversation is, wherever that is.** If J4 proposes something visual, the `Current ↔ J4's proposal` comparison renders inline in the conversation with **Apply this / Not this / Tell J4 what to change**. The owner never navigates to approve something J4 proposed. This holds on every surface the conversation appears on, which was got wrong once by making proposals layer-only while the room showed the same conversation.

## 3. Office — "I'm reviewing what J4 and I have been doing"

Where the owner intentionally goes to review, organise and understand accumulated work: conversations, goals, decisions, tasks, ideas, documents, business knowledge, history and briefings.

**`/j4` becomes Office.** What was called "Full workspace" is renamed Office. `/j4` may remain temporarily as a compatibility route that resolves to Office, but it is no longer the primary way to talk to J4 and must not be presented as one.

**No permanent sub-navigation. Decided, not open.** Today's `Conversation | Tasks | Ideas | Decisions | Information` rail is J4's internal filing cabinet exposed as navigation, and it does not survive. Those five do not remain as equal destinations.

Office is **one coherent workspace**. Its material may be filtered, grouped, searched, or surfaced contextually — but never in a way that makes the owner feel they are navigating J4's internal database. The test is which sentence the owner thinks:

> ✅ *"I'm going to J4's Office to see what we've been working on."*
> ❌ *"Which J4 filing tab contains this?"*

And J4 retrieves against it conversationally:

- *"Show me what we've decided about the website."*
- *"What are the three things we're working on right now?"*
- *"Show me everything we've discussed about the new brand."*

Those are retrievals, not tabs.

## 4. Creation — "J4 and I are making something"

The full-screen studio: logos, brand identity, website redesigns, product design, apparel, marketing, images, campaigns. Large canvas, zooming, side-by-side comparison, iteration, and real creative tooling.

**Creation is one surface with tools inside it, never a growing list of tabs.** A permanent "Logo" destination guarantees that in six months there is also Website Design, Product Design, Images, Merch and Video sitting beside it, and we are back to the icon grid this whole design keeps deleting.

Creation may use the same J4 conversation and context as everywhere else. It is an intentional transition only because the owner needs a larger canvas, never because the conversation changes.

---

## What is retired

**`/j4/room` is obsolete.** The separate immersive voice room is replaced conceptually by Office and Creation, and should ultimately redirect to Office.

**"Just Talk" is not a separate destination.** Ordinary conversation with J4 happens through the persistent layer while the owner is inside Business. Wanting a larger historical or organisational view of that conversation means Office. Wanting to make something means Creation.

There is no reason to make the owner choose between "Just Talk," "Room," and "Full workspace." One model replaces all three:

```
Business → persistent J4 → Office or Creation, when intentionally needed
```

---

## Transitions

| From | To | When |
|---|---|---|
| Business | J4 | Any time. The summon. **Never navigates.** Opens the layer in place on the current page. |
| J4 | Office | Intentional. *"Show me what we've decided about the website."* J4 **offers**; the owner accepts. |
| J4 | Creation | Intentional. *"Redesign this."* J4 **offers**; the owner accepts. |
| Office / Creation | Business | Returns to the exact page and scroll position they came from. |

Stated as the distinction to hold onto: **J4 summon = talk to J4 here. Office = go look at the accumulated work with J4.**

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

**A proposal belongs to J4 first, not to a disconnected page.** This was the real architectural fork, and it is decided: the proposal is part of the conversation. When the owner is looking at the thing being discussed, J4 says *"here's what I'm proposing"* and **shows it without taking the owner away from what they are looking at.**

**Proposals come to the owner; the owner does not go hunting for them.** A proposal buried at the bottom of the Website tab fails this. If the owner is elsewhere, J4 brings the relevant visual into view rather than throwing them into another room.

### Localized variant previews (locked 2026-08-15)

A second, narrower shape alongside `Current ↔ Proposed`. That one answers *"do I prefer this version of my storefront?"*; this one answers *"which of these should it be?"*

Sean's shape, exactly: *"If I ask, 'What would this heading look like in three different fonts?', J4 should stay on the actual webpage, scroll to that heading, and show the three font variations there... I don't want three separate storefronts. I want to see the actual element in its actual context with the different possibilities."*

- **The real storefront stays the canvas.** Not a settings panel, not a mock, not three rendered pages side by side.
- **The preview scrolls to the target element** rather than showing the page from the top, so the owner is looking at the thing they asked about.
- **The variants are compact and in place** — stacked or side by side at the element, in its real surroundings.
- **Choosing applies it** to the real storefront through the existing execution path.

**This is not a design editor.** Sean: *"Don't build a separate generic design editor. The storefront itself should become J4's visual canvas."* Every variant is a real value from the existing closed vocabularies, rendered by the real storefront renderer.

**It generalises beyond fonts.** Colours, buttons, product grid layouts, image treatments, section layouts, spacing, hero treatments, product cards. The mechanism is the same in every case: one element, several real possibilities, shown where the change will actually live.

**The principle underneath both shapes:** J4 shows what a proposed change will actually look like before it changes the owner's website.

### The confirmation ladder

Confirmation is context-dependent. Not every action needs two confirmations, and demanding one because the architecture is uniform is itself the bug:

| The change | What confirmation looks like |
|---|---|
| Conversation | None. Talking is not a change. |
| Small text or content change | Show it and confirm appropriately |
| Meaningful visual or design change | Visual comparison |
| Major redesign | Substantial before and after preview |
| Execution | The owner approves the actual proposed change |

**If the owner is already looking directly at the target and J4 can modify that same visible target, do not make them perform a redundant confirmation.** The conversational approval they just gave is the approval. Making them review the same thing twice is not safety, it is friction wearing safety's clothes.

The principle underneath the whole ladder:

> **The owner should always be able to see what they are agreeing to when the change is visual or substantial.**

If the request concerns something outside the current viewport (*"let's redo the website"* said from Identity), J4 must bring that target into view and show a proposal, because the owner cannot approve what they cannot see. And if J4 proposes a completely new homepage, showing the first few inches of it is useless — the preview must be proportional to the scope of the change.

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

**Present and now retired by decision, still to be removed in code:** `/j4/room`, the separate immersive voice room, and the `Just Talk` toggle inside the current workspace. Both predate this model and neither has a place in it. `/j4` itself survives only as a compatibility route to Office.

---

## Decisions — answered by Sean 2026-08-14, closed

1. **`/j4` becomes Office.** "Full workspace" is renamed Office. `/j4` may stay temporarily as a compatibility route resolving to Office, but is no longer the primary way to talk to J4. The summon never navigates to it. `/j4/room` is retired and ultimately redirects to Office.
2. **Office has no permanent sub-navigation.** The five tabs do not survive as equal destinations. One coherent workspace, with material filtered, grouped, searched or surfaced contextually.
3. **`/j4/room` and "Just Talk" are both obsolete.** Replaced by the single model: Business → persistent J4 → Office or Creation when intentionally needed.
4. **A proposal belongs to J4, shown in place.** Not a disconnected page. Scope-matched preview, with the confirmation ladder above.
5. **Build order is fixed.** See below. Office and Creation are explicitly not to be started yet.

---

## Build order

Sequential and deliberate. Each step is the foundation the next depends on. **Do not skip ahead, and do not start Office or Creation.**

### 1. Persistent J4 layer — *largely built*

Always accessible; never navigates when summoned; never steals or locks the owner's scroll; remains available across every Business page; understands current page context; the conversation continues naturally across pages.

Shipped: the layer itself (`5be9221`), the summon as a topmost layer (`83f78af`), turns finishing in place (`09ffb55`), page-level context (`lib/j4/workspaceContext.ts`). What remains is verification on a real device and removing the retired surfaces named above.

### 2. Visual proposal and comparison — *next*

Current versus proposed. Element, section, page and full-page scope with an appropriately sized preview. Approve, reject or discuss. **J4 can revise the same proposal based on the owner's rebuttal** — this is the `IDEA → DISCUSSION → REBUTTAL → REFINEMENT` loop made real, and it is what separates this from a diff viewer.

### 3. Context model

Page-level first, architected to grow into the actual entity or element being discussed: *"I don't like this headline," "change this product," "show me another version of this logo."* J4 needs to eventually know exactly what "this" means.

### 4. Office

Consolidate the accumulated conversation and work into one coherent workspace.

### 5. Creation

The large-format creative workspace. May use the same J4 conversation and context; intentional only because the owner needs a larger canvas.

### 6. Design intelligence

Its own research and knowledge problem. Not solvable with arbitrary UI rules.

---

## How to apply

The architecture in one line each:

```
BUSINESS  = where I operate my business.
J4        = the partner who's always with me while I operate it.
OFFICE    = where I review and organize everything we've worked on.
CREATION  = where we make things together at full scale.
```

Check any proposed J4 work against four things before writing code:

1. Does it pass the non-negotiable test — does the owner keep their page and their place?
2. Does it put a collection of things into the conversational layer? Collections are Office.
3. Does it let the owner accept a visual or substantial change they cannot actually see?
4. Does it demand a confirmation the owner already gave conversationally while looking straight at the target?

A change that fails any of those is the wrong change regardless of how well it is implemented. And above all four, the governing principle at the top of this document: **J4 is not a place I go. J4 is who comes with me.**

See also `GENESIS_EXPERIENCE_PRINCIPLES.md` (the governing lens: business partner, never chatbot), `J4_IDENTITY.md`, and `lib/j4CopyRules.ts` for the permanent no-dashes copy rule that applies to everything J4 says on every surface here.
