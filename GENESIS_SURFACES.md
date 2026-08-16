# Four rooms, the partner who is in all of them, and the Office he keeps

> ## J4 is not a place I go. J4 is who comes with me.
>
> Sean, 2026-08-14, naming this **the governing principle for the entire interface** — not one principle among several. Every decision below is an instance of it, and any future proposal that cannot be squared with it is the wrong proposal regardless of how well it is built.

**The rooms model is locked, 2026-08-15.** It does not replace the surface model below; it resolves it. What was called *Business* was never one surface — it was four rooms wearing a single name. See **The rooms** immediately after the non-negotiable test. The rest of this document, written the day before, is unchanged and still governs: only the naming of Creation → Studio has moved.

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

# The rooms

**Locked by Sean, 2026-08-15.** Design only — nothing here is authorization to build.

Genesis is not a dashboard full of tabs. It is a set of **places the owner goes to do things**, and the interface itself is what communicates that.

**Four business rooms carry the navigation. The Office is entered through J4.**

```
┌────────────────────────────────────────────────┐
│  Storefront   Products  ( J4 )  Orders  Studio  │
│                         Office                  │
└────────────────────────────────────────────────┘
```

Two rooms, the partner, two rooms. **The navigation holds the business. J4 holds the work done on it.**

| Room | The question it answers | Entered by |
|---|---|---|
| **Storefront** | What does my business look like? | Navigation |
| **Products** | What am I selling? | Navigation |
| **Orders** | What's happening right now? | Navigation |
| **Studio** | What am I making? | Navigation |
| **Office** | What have we been working on? | **J4's presence** |

## Why the Office leaves the navigation (locked 2026-08-15)

Two doors into one room is not a problem. **An "Office" tab sitting in the room bar is** — because it is the tab every owner would read as *the J4 tab*, which is the one thing this architecture forbids, reintroduced through the back door.

Removing it makes the division honest: the bar is the business, and the partner keeps the work. It also gives the bar its physical symmetry, two rooms either side of the orb, which is what a control deck should look like and what a five-item bar could never be.

**Office is still a room.** It has a stable name, a place, and a door. It is simply not a tab.

## J4 is not a room

**The hard rule.** J4 must never appear in the room navigation and must never be presented as a destination. J4 is the persistent partner who accompanies the owner into every room. This is the governing principle at the top of this document, applied to the one place most likely to break it — because a bottom bar is exactly where a "J4" tab would look natural and be wrong.

That is also why the room is **Office**, not "J4 Office." The Office holds the accumulated *work*; J4 himself is the orb, present in every room. The owner goes to the Office to look at what they and J4 have done. They never go to *J4*.

**Voice is available in every room. No exceptions.** The owner must never have to leave a space in order to talk to their business partner. Any room that cannot be talked to from where the owner is standing is not finished.

## What belongs in each room

**Storefront** — the live site as the canvas. **Website and Identity both live here**, because brand identity *is* how the storefront looks; separating them was an administrative distinction, never an owner's. Localized variant previews happen here.

**Products** — the catalog and individual products: photos, pricing, descriptions, inventory.

**Orders** — orders, fulfillment, revenue and analytics, and **Customers as a first-class section within the room**, alongside Orders, Fulfillment and Revenue. Analytics belongs here because revenue and trends are what orders *mean*.

> **Customers stays inside Orders for now.** Not a separate room. If Genesis later builds true CRM — segmentation, lifetime value, outreach, relationship management — Customers can earn its own room then. That is a real future possibility, not a placation, and the decision to promote it should be made on that capability existing rather than on the room list feeling unbalanced.

**Studio** — the visual creation space: logos, product imagery, merchandise, layouts, brand exploration, marketing creative. Where *"put this logo on the shirt"* and *"show me three versions"* live.

**Office** — conversations, decisions, tasks, ideas, documents, business knowledge, briefings and history, as **one continuous stream** rather than eight collections. Entered through J4's presence. See *The Office doorway* under section 3.

## Naming

**The room is Studio.** "Creative Studio" is retired as a user-facing name, and so is **Creation** — section 4 below describes the right surface under the wrong name, and Studio is that name now. Internal identifiers may lag; the owner-facing word is Studio.

## What every current destination becomes

| Today | Becomes | Why |
|---|---|---|
| Your Business (Overview) | **Removed** | A lobby. Its content is J4's briefing, which belongs to J4 and can appear anywhere. |
| Website | Storefront | |
| Identity | Storefront | Brand *is* the storefront's appearance |
| Products | Products | |
| Customers | Orders | A section within the room, not its own room |
| Orders | Orders | |
| Analytics | Orders | Revenue and trends are what orders mean |
| Understanding | Office | J4's accumulated knowledge |
| Marketing | Studio + Office | Making a campaign is Studio; deciding to run one is a conversation |
| Payments | Settings | Configured once, not visited |
| Connections | Settings | Same |
| Billing | Settings | Your account, not your business |
| Growth Points | Settings | Same |
| Settings | **Outside the room navigation** | Reached from the account, never a room |
| More | **Removed** | It exists only because there are too many tabs |

**Fifteen destinations become four rooms, the Office behind J4, and a settings area.** The two removals are the substance of the change, not tidying: *Overview* and *More* both exist only because the current navigation is a list of features rather than a set of places. Keeping either one would mean the rethink did not happen.

## The visual principle

### The navigation stays simple. The rooms carry the character. (locked 2026-08-15)

**This corrects the earlier framing in this same section.** "Spatial control deck" and "portal system" were the right instinct about *ambition* and the wrong instruction for *navigation*. Sean, closing it:

> *"Don't introduce a complicated spatial navigation system just because we call them rooms. The user should never have to learn a new navigation system just to understand where they are."*

The current bar already has a quality worth protecting: **everything is visible, understandable, and one tap away.** Genesis is meant to be simpler than conventional business software, and a navigation system that has to be learned is the opposite of that no matter how good it looks.

So the rule is a division of labour:

| | |
|---|---|
| **Navigation** | Familiar, legible, boring on purpose. Four labels, always visible, always in the same place. |
| **Rooms** | Distinct character, specialised experience, real difference once you are inside. |

**Distinctiveness lives inside the rooms, never in the mechanism for reaching them.** A room may look and behave like nothing else in Genesis. Getting there is always four labels and a tap.

The active room still needs to be unmistakable — an owner must never wonder which room they are in — but it earns that with ordinary, readable emphasis rather than with motion, depth or spatial metaphor. **Legibility is the requirement; theatre is not.**

This is the standing "preserve simplicity" rule applied to navigation: polish it, never add to it.

**Blue illumination remains exclusive to J4.** This is a constraint on the whole treatment, not a preference. J4 is the only blue thing on screen, and a room that glows blue steals the one signal the owner has learned to read. Rooms get light without colour: a lit surface, a raised edge, depth, material — never J4's blue.

The orb stays centred between the four rooms, present in all of them, and is never one of them.

## Still open — the next design discussion

**How the rooms actually feel different from one another while remaining one Genesis.** Not decided here, and not to be settled by implementation. Rooms that look identical are tabs with better names, and rooms that look unrelated are separate products.

The constraint that shapes this discussion: **the difference has to come from what each room is for, not from how the owner gets there.** Storefront is a canvas, Orders is a ledger, Studio is a workbench, Products is a catalogue — those are genuinely different kinds of work and can look it. The bar above them stays the same four labels in the same place, every time.

The Office is included, and is the harder half: it has to feel like J4's own space without becoming a fifth visual style, and it is the only surface that appears *on top of* a room rather than beside it.

---

## 1. Business — "I'm looking at my business"

> **Superseded in structure by the rooms above, 2026-08-15.** *Business* turned out to be four rooms — Storefront, Products, Orders, Studio — sharing one name. Everything below about the owner's page and scroll position being the primary state is unchanged and applies to every room.

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

### The Office doorway (locked 2026-08-15)

**The control beneath J4's presence is the door to the Office.** It reads **Office**. It does not read "Conversation" — that word named one artifact and made the other seven feel like they lived somewhere else.

```
        ╭─────────╮
        │   ORB   │   tap → Talk Mode
        ╰─────────╯
          Office       tap → J4's Office
```

It does not need to say "J4's Office." The orb directly above it supplies that, and the owner reads the pair as one thing: *J4, and the place J4 keeps our work.*

**The name is stable and never changes dynamically.** A small contextual badge is fine where it earns its place — *3 waiting*, *2 new* — but the destination is always Office. A door that renames itself is a door the owner has to re-learn every time they look at it.

**Sean's test for the whole design:** *"A user who wants to remember something they told J4 should not have to understand our navigation architecture. They see J4, tap J4, and naturally find the conversation and history there."*

### It opens over the room, it does not navigate

The Office opens as a full-height surface **above** the current room, the way the conversation already does. This is structural, not a rendering preference:

- A mis-tap on a small label sitting directly beneath an 88px orb would otherwise cost the owner their page and their scroll position. The previous worst case for a mis-tap was starting Talk Mode in place, which is recoverable by tapping again.
- As an overlay, the room underneath is never unmounted, so *return to exactly where you were* costs nothing and needs no restoration logic. Free is the only version of that guarantee that cannot regress.
- It keeps the non-negotiable test literally true: **nothing ever navigates from J4's presence.**

### The four interactions, unchanged

| Where | Does |
|---|---|
| **Orb** | Talk Mode, continuous voice |
| **Office**, beneath the orb | Opens the Office |
| **Mic**, inside | One voice message |
| **Text**, inside | One typed message |

The same four that were locked on 2026-08-14. The fourth simply grew from *the conversation* into *everything we have made together*, which is what it should have been.

### One stream, not eight collections

The eight things the Office holds are **typed objects inside one continuous stream**, never parallel archives and never destinations.

This matters because those eight are very nearly the five-tab rail this document already retired as *J4's filing cabinet exposed as navigation*. The reason they are not the same mistake: every decision, task and idea **happened in a conversation**. They are things that surfaced while the owner and J4 were talking, and they keep their place in that history. A decision renders as a decision, inline, where it was made. A document renders where it was uploaded.

So the Office opens on **what is being worked on now** — open threads, live decisions, recent work — with history running continuously beneath it. Not an index. Not eight cards.

**The owner must never need to know what type an object was in order to find it.** Three ways in, all equal:

1. **Ask J4.** *"What did I tell you about the shirt sizing?"* Retrieval is J4's job, not the navigation's.
2. **A lens**, where one genuinely helps. A filter over the single stream.
3. **Scroll.** The history is there, in order.

The line between a lens and a rail is which sentence the owner thinks:

> ✅ *"Show me just the decisions."* — a lens over one stream
> ❌ *"Which tab is that in?"* — a rail, forbidden

### One conversation, always

**The compact presence and the full Office show the same conversation and the same history. There is never a second thread.** This is the load-bearing rule of the whole design: the Office is a larger view of the relationship the owner already has with J4, not a separate place where a different J4 keeps different notes.

Three continuities make it read as one system rather than a section of an app:

1. **One conversation**, compact and full.
2. **The same J4.** Talking inside the Office is talking to the partner who was just in Storefront.
3. **Dismissing returns the owner exactly where they stood** — same room, same scroll, mid-sentence if that is where they were.

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

## 4. Studio — "J4 and I are making something"

> **Renamed 2026-08-15.** This surface was called *Creation*. The owner-facing name is now **Studio**, and "Creative Studio" was considered and rejected as the longer form. Read every "Creation" below as "Studio."

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
| Any room | J4 | Any time. The summon. **Never navigates.** Opens the layer in place on the current page. |
| Any room | Office | The permanent door beneath J4's presence. Opens **over** the room; the room is never unmounted. |
| J4 | Office | Also offered conversationally. *"Show me what we've decided about the website."* J4 **offers**; the owner accepts. |
| J4 | Studio | Intentional. *"Redesign this."* J4 **offers**; the owner accepts. |
| Office / Studio | The room they came from | Returns to the exact page and scroll position. |

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
- **All variants are shown at once, anchored to that element** — a comparison overlay or card pinned to it, or the labelled options laid out immediately around it. Simultaneous, not one at a time: *"I want to be able to look at the actual webpage and immediately understand the difference between the options."* A toggle makes the owner hold two things in memory; showing them together does not.
- **Nothing is applied until a variant is chosen.** The preview is temporary and changes nothing. Only selection reaches the real storefront, through the existing execution path.

**This is not a design editor.** Sean: *"Don't build a separate generic design editor. The storefront itself should become J4's visual canvas."* Every variant is a real value from the existing closed vocabularies, rendered by the real storefront renderer.

**An extension, not a replacement.** `Current ↔ Proposed` stays exactly as it is for whole-storefront judgements. This is the localized case: one element, several possibilities, compared at a glance.

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

**Current priorities, locked 2026-08-15.** These supersede the ordering below for what happens next.

**0. Done and locked. Do not change.**
- The **voice loop**: tap the orb, Whisper listens, J4's own brain answers, ElevenLabs speaks, listening resumes. Working end to end on a real phone. `useJ4Talk.ts` and the speak path are not to be modified.
- **J4 at 88px**, permanent and unmistakable on every workspace, rendered globally through `DashboardShell`. Not Overview only, and correct as it stands.
- The four interactions stay distinct and must never be merged: **orb = continuous Talk mode · mic = voice message · text = typed message · expand = conversation and history**.

**Design work in flight, ahead of all of it: the rooms.** The information architecture is locked (see *The rooms*), including the Office doorway beneath J4's presence. **The next step is a design discussion, not code** — how the rooms feel distinct while remaining one Genesis. Nothing about the bottom navigation or the Office is authorized to be built until that is settled and written down here.

**1. Contextual J4 surface on every workspace.** The same compact presence everywhere, with the controls around it changing by location:

| Workspace | Controls |
|---|---|
| Office | Photos · Documents · Files · Ideas |
| Products | Products · Photos · Edit · Ideas |
| Website | Design · Photos · Content · Preview |
| Identity | Brand · Photos · Copy · Ideas |

**These are ways of giving J4 context or asking J4 to work on something. They are not navigation tabs**, and they must not become the old generic chat UI rebuilt per page.

**2. Test the existing proposal controls, on the deployed build, before extending them.** Apply this, Not this, and Tell J4 what to change have never been exercised by hand. Two real bugs already hid in that path — nested forms that silently swallowed every click, and a page-scoped revalidation that refreshed a route the owner was not on. Sean's rule, and it is the right one: *do not consider that feature complete based on code inspection alone.*

**3. Three-option visual proposals.** `Current + J4's Pick + Alternative`, shown simultaneously against the real storefront element. Selecting one lets the owner ask for **two more variations based on that choice**, so the comparison narrows rather than restarting. See the localized variant preview section above for the shape.

---

## Build order (original, superseded above for sequencing)

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
STOREFRONT = what my business looks like.  ┐
PRODUCTS   = what I'm selling.             │ the navigation
ORDERS     = what's happening right now.   │ four rooms
STUDIO     = what we're making.            ┘

J4         = the partner who is in all four, and is never one of them.
OFFICE     = what we've been working on. Behind J4, not in the bar.
```

Check any proposed J4 work against five things before writing code:

1. Does it present J4 as somewhere to go? J4 is in every room and is never a room.
2. Does it pass the non-negotiable test — does the owner keep their page and their place?
3. Does it put a collection of things into the conversational layer? Collections are Office.
4. Does it let the owner accept a visual or substantial change they cannot actually see?
5. Does it demand a confirmation the owner already gave conversationally while looking straight at the target?

A change that fails any of those is the wrong change regardless of how well it is implemented. And above all five, the governing principle at the top of this document: **J4 is not a place I go. J4 is who comes with me.**

See also `GENESIS_EXPERIENCE_PRINCIPLES.md` (the governing lens: business partner, never chatbot), `J4_IDENTITY.md`, and `lib/j4CopyRules.ts` for the permanent no-dashes copy rule that applies to everything J4 says on every surface here.
