# J4 Visual & Interaction Direction — APPROVED

**Status: APPROVED PRODUCT DIRECTION, 2026-09-03 (Sean). NOT YET IMPLEMENTED.**

This is a real product decision, not concept art under consideration. It
supersedes the older Genesis-orb interaction model as the primary J4 experience.
**Implementation is deliberately deferred** — do not build the avatar, animation
system, mouth/voice synchronization, skins, expanded character, or Business Map
choreography yet. The architecture should be designed with this J4 in mind; the
next work item is the capability audit in `J4_CAPABILITY_AUDIT.md`.

**References** (`design/j4-visual-direction/`, copied into the repo because the
originals were in session-scoped upload folders that do not survive):

| File | Role |
|---|---|
| `j4-compact-primary.png` | **Primary visual reference** — the approved character. |
| `j4-primary-reference.png` | Earlier full-scene reference for the same character. |
| `j4-concept-sheet.png` | Supporting: sizes, expressions, alternate presentation. |

The shell-geometry reference is the diagram in **Shell geometry** below, from
Sean's own description. No annotated layout image exists — the attachments were
all the same character screenshot, and naming one of them "annotated layout"
would have been a filename that lied about its contents.

### What this supersedes

`GENESIS_AVATAR.md` and the 2026-08-01 frozen avatar identity describe the blue
orb/sonar treatment with transparent **"Listening"** and **"Thinking"** text
labels. **That is an older interaction model and is no longer the desired
primary J4 interaction.** It is not deleted — the history is worth keeping — but
where the two disagree, this document is current.

`GENESIS_SURFACES.md` (locked) and `J4_IDENTITY.md` (frozen) are not edited by
this document. Those describe *who J4 is* and *where J4 lives*, which this does
not contradict. Any change to their frozen contents remains Sean's to make
explicitly, in those files.

---

## The one rule that governs all of it

> **There is one J4. We are only changing how much of him the owner sees.**

Compact and expanded are **presentation state, not two systems**. This exists to
prevent "chat J4", "expanded J4", "Business Map J4" and eventually "mobile J4"
being built as separate implementations. Across every compact ↔ expanded
transition and every navigation between Genesis surfaces, all of the following
must survive unchanged:

- conversation and context
- current task
- voice state
- intelligence
- permissions
- pending approvals
- execution state

A second J4 state machine for mobile is the specific outcome to avoid. Web and
mobile are **presentation surfaces for the same J4**.

---

## Genesis and J4 are different things

**Genesis is the platform/interface. J4 is the persistent business-partner
character inside Genesis.** J4 is a character and a visual communication system,
not merely an animated avatar or an icon.

**Colour**: green is J4's identity/interaction colour. **Genesis remains blue.**
Both are true at once; this is not a rebrand of Genesis.

---

## Shell geometry — J4 owns the bottom-left corner

**J4 is not a floating circle above the bottom navigation, and Studio / Website
/ Products / Business must not sit underneath him.** He has a **dedicated
permanent bottom-left home zone in the main Genesis shell**, and the existing
navigation shifts right to begin after that zone.

```
┌─────────────────────────────────────────────────┐
│                                                 │
│                   WORKSPACE                     │
│                                                 │
├────────────────┬────────────────────────────────┤
│                │                                │
│       J4       │ Studio | Website | Products |  │
│                │ Business | ...                 │
└────────────────┴────────────────────────────────┘
```

The bottom shell is `[ J4 HOME ] [ Studio ] [ Website ] [ Products ] [ Business ] …`
— **not** `J4 floating over [ Studio | Website | … ]`.

**Why**: compact J4 must be larger and more recognizable than a normal chatbot
button *without covering the workspace*. The dedicated corner gives room for his
face, the circular green frame, the restrained honeycomb environment, facial
expressions, listening/thinking/speaking feedback, the Talk interaction, and an
obvious Expand control.

**J4 should feel like he has a permanent seat inside Genesis, not like a
third-party chat widget floating over the product.**

---

## The two interaction modes

### Compact J4 — Presence Mode: "I'm here."

Persistently available in his home zone. Primarily **his face** inside the
circular green frame over a **restrained** honeycomb background — present, but
never the giant energy/sonar effect of the old orb. Visually quiet; it must
never dominate the workspace.

**A normal conversation does not require expanding him.** Tap J4 → talk → he
listens → understands/thinks → talks back, all from compact. Facial animation
and subtle green/honeycomb behaviour carry the state; the character does most of
the communicating, the frame only supports it.

### Expanded J4 — Partner Mode: "Let's work together."

Reached by an **explicit Expand control**. Double-click/double-tap must not be
the primary discoverable interaction.

**He emerges upward/outward from his existing bottom-left home zone.** The
spatial principle: **J4 expands from his corner; he does not materialize in the
centre of the screen**, and his home position stays spatially understandable
throughout the transition. Minimizing returns him there.

Expanded unlocks the full character: torso, arms and hands, pointing, gesturing,
turning toward content, looking at what he is explaining, presenting choices,
comparing items, reacting, celebrating, and visually guiding the owner.

**Expanded J4 is not a modal.** Studio, Website, Products, Business and the other
primary surfaces stay accessible and usable while he is expanded, and the owner
can move between them with J4 still present.

**Built and verified 2026-09-04** (`b3abbf5`, checks in `b381743`). The dock
opens the same conversation the Office opens — one mount, two presentations —
as a non-modal panel anchored to his corner: no scrim, no scroll lock, no
`aria-modal`, and the workspace stays scrollable behind him. The paragraph
above is no longer only a requirement; `scripts/shoot-j4.ts` hit-tests every
visible link while the panel is open and then clicks a real destination and
waits to arrive. The panel intercepts zero links. Giving it `inset-0` turns
all six links red, which is how we know the check would notice.

Closing him is deliberately *hiding*, not unmounting. Talk Mode sends a spoken
turn through the composer without ever expanding it, so the conversation stays
mounted and merely goes `aria-hidden`. A test that asserts removal is wrong
about the design, not about the code.

**Not yet built:** the torso, arms, pointing and gesturing described above.
Expanded J4 today is the head-and-visor character; he does not yet turn toward
content or guide the owner through it.

---

> **Beyond this direction:** per-owner J4 appearance, a possible product
> tier, and an optional digital-ownership layer are captured in
> [J4_PERSONALIZATION_AND_OWNERSHIP.md](J4_PERSONALIZATION_AND_OWNERSHIP.md)
> (2026-09-04). Not authorised, not designed — but the one-character,
> one-controlled-surface rule below is what keeps it possible.
## Visual language — state through behaviour, not labels

J4 communicates state primarily through **character behaviour**, not persistent
textual status. The owner should be able to look at J4 and understand what he is
doing.

| State | How it reads |
|---|---|
| **Listening** | attentive expression, subtle pulse |
| **Understanding / Thinking** | thoughtful expression, subtle processing animation |
| **Speaking** | facial/mouth animation synchronized with his voice |
| **Working** | more active visual energy, purposeful gesture |
| **Success** | positive expression/gesture |
| **Needs Attention** | clear but non-alarming |

Compact states also include idle/ready. **The old "LISTENING / THINKING" labels
are no longer the primary mechanism.**

---

## Gestures carry meaning, not decoration

J4 should physically participate in an explanation. **Gestures must be
semantic** — do not implement animation for decoration.

| Gesture | Meaning |
|---|---|
| Point | look here |
| Turn | I'm addressing this |
| Open hand | here's an option |
| Two hands toward separate objects | compare these |
| Pull together | group / compare |
| Thinking gesture | processing |
| Thumbs up | completed |

Worked example. Owner: *"J4, give me some font options."* J4 expands; three
choices appear — Original | Requested | J4's Alternative. He points to each in
turn: *"This is your original." / "This is what you asked me to try." / "And
this is another option I created for you."* Then: *"If you don't like any of
them, tell me which one you like most and I can create something different
that's still close to that direction."* The owner answers conversationally.
Website stays visible in the workspace to his right throughout.

---

## Business Map + J4

The Business Map becomes a visual surface J4 navigates and explains **with** the
owner. He remains on the left while the map, entities and data he is explaining
occupy the workspace beside him.

> *"Your TikTok is getting more views than Facebook, but Facebook is generating
> more revenue."*

As he says it, the UI focuses/highlights TikTok, then Facebook, and he can point
toward each. Then:

> *"Do you want me to break down Facebook specifically, or compare all your
> social media?"*

The owner's answer **changes the scope of the visual explanation**. The same
model should eventually apply to Social, Products, Customers, Commerce, Orders,
Connections, Marketing, Growth and other Business Map entities.

Speech, highlight and navigation are **one synchronized act**, not three
features that coexist.

**The separation to preserve:**

| Layer | What it is |
|---|---|
| J4 | the conversational partner |
| Business Map | what J4 understands about the business |
| Entity views | what J4 understands about individual things |
| Genesis UI | the workspace where the work happens |
| Intelligence Engine | the underlying business understanding |

---

## Appearance / personalization

**"Choose your J4."** Treated as personalization, not a complicated identity
system. Initially the **white/black** (primary) and **black/black** concepts;
more skins later.

**Expressions and behaviour must be independent of appearance**, so a future
skin never requires rebuilding the interaction system.

---

## Size adaptability

Roughly 128 / 80 / 48 / 32 / 16px, per the concept sheet. **Do not assume the
detailed concept art can be displayed at every size** — the production
implementation needs a representation strategy that keeps him recognizable and
useful when compact.

---

## Voice and visual speech

When J4 speaks aloud his mouth/face should animate with the speech, so the cue
is immediate: *J4 is talking — listen.* This is preferable to a textual
indicator.

**Do not pretend the voice pipeline is production-proven.** Voice output shipped
in `77cc202`, but real synthesis is UNVERIFIED and depends on a provider
credential that is not present. Treat voice/mouth synchronization as a
**downstream implementation dependency** — not something to fake in the
architecture, and not something whose absence should be designed around
silently.

---

## Capability principle for the audit

> **Anything the owner can legitimately accomplish through Genesis should, where
> appropriate, be requestable conversationally through J4.**

J4 should ultimately become the conversational interface through which the owner
operates the business. **"Legitimately" and "where appropriate" are load-bearing**
— destructive, financial and irreversible actions already sit behind approval and
verification, and that boundary is to be read off the existing systems rather
than re-litigated.

**Before creating new tools, audit what exists.** Reuse the existing execution,
approval, verification, recommendation, integration and intelligence
architecture wherever it already provides the correct behaviour. **Do not create
duplicate architecture**, and do not create a second audit document —
`J4_CAPABILITY_AUDIT.md` (2026-08-08) is stale and must be **superseded and
updated**, not paralleled.

The audit answers: what Genesis can do today; what J4 can inspect; what J4 can
explain; what J4 can execute; every Genesis capability J4 cannot invoke; which
gaps need a genuinely new tool/action; which need only conversational routing;
which actions require owner approval; which require execution verification; and
which existing actions can be reused rather than duplicated.

---

## The target experience

> Owner asks J4 → J4 understands → J4 explains/shows → owner approves if
> necessary → Genesis executes → Genesis verifies → J4 reports back.

And when explaining: **J4 should be able to show the owner what he is talking
about, not merely tell them.**

---

## Timing and priority

The exhaustive visual/UI polish pass is **deliberately not now**. Mobile becomes
a major implementation/testing phase around **the 23rd**, so this phase
prioritizes: architecture, capability completeness, J4 action/tool coverage, safe
execution, approval boundaries, verification, Business Map data/interaction
contracts, and conversational behaviour.

Do not polish desktop interactions that mobile implementation will likely
revisit. **Build the shared J4 behaviour and architecture once**, so web and
mobile become different presentation surfaces for the same J4.

Responsive geometry is an **interaction model, not identical pixels**: desktop
gives J4 a dedicated bottom-left zone and a larger left-side expanded area;
mobile needs its own interpretation with less horizontal room but the same mental
model — *J4 has a persistent home → talk to him there → expand him for the full
partner experience → return him home when finished.*

---

## Implementation readiness — audited 2026-09-03, before building anything

Audited against the real components rather than assumed, because the standing
instruction is to report a conflict rather than build a parallel system.

### What already exists, and is more than expected

| Piece | Where | State |
|---|---|---|
| A persistent J4 presence | `app/dashboard/J4Summon.tsx` | Built. Renders the avatar and nothing else — "the orb is J4". |
| A state machine driving it | `lib/dashboard/genesisActivity.ts` | Built: `idle | listening | thinking`. |
| The avatar itself | `app/dashboard/GenesisAvatar.tsx` | A static PNG (`public/brand/genesis-avatar-orb.png`), ~85–90% of what is seen. |
| A slot in the shell | `DashboardShell.tsx` | Mobile bar, CENTRE slot, deliberate. |
| Conversational surface/selection context | P2, shipped | `workspacePath` + `selection.nodeIds` + `focus.nodeIds`. |

**Three of the five states the direction asks for already exist and are wired.**
Missing: `speaking` and `success`/`attention`.

### The position difference is NOT a conflict

The mobile bar puts J4 in the centre slot on purpose — "he is the thing your
thumb reaches first and the navigation arranges itself around him" — which
contradicts the approved bottom-left zone. It is not a conflict to resolve,
because both documents already say so: this direction states mobile needs its
own responsive interpretation, and the shell's own comment says "desktop is its
own design pass that hasn't happened yet".

**So the bottom-left zone belongs on DESKTOP, where nothing exists yet, and
mobile's centre slot stays until the mobile phase around the 23rd.** Building
the desktop zone does not touch the mobile bar, and does not change the tab
count, so it does not intersect E25.

### The genuine blocker: there is no character, only a photograph

`GenesisAvatar` displays one image of one pose with one expression. "J4 is a
recognizable character" with `speaking`, `success` and `attention` needs
something that can *change* — and states × expressions × skins × sizes is the
unmade asset decision this document already records. Prior art says it is not a
prompt away: gpt-image-1 could not preserve locked regions, which is exactly
what an expression matrix requires.

**This is a design decision, not an implementation one**, and it is the thing
standing between "the architecture is ready" and "this feels like J4".

### Focus consumer — server half DONE, UI wired but NOT behaviourally verified

**Shipped and verified** (`focusPlan.ts`, `j4Focus.ts`, `verify-j4-focus.ts`):
31 assertions, six sabotages. The map is the authorization, exactly as in
`selectionContext` — foreign, nonexistent and malformed ids are indistinguishable
from each other. Focus is presentation state: never persisted, never returned to
the server, and asserted to leave the node byte-identical.

**Wired but unverified** (`BusinessMapCanvas.tsx`, `EntityCarousel.tsx`):
type-checked and lint-clean, and **that is all that has been established**. No
render has happened. The two-stage interaction has never been seen working.

The architecture, approved and deliberate:

- **focus request = event → `step()`**, in the subscription callback. NOT an
  effect. An effect would re-apply focus on every render and fight an owner who
  navigated away manually; as written, J4 opens a domain once and a subsequent
  tap stays where the owner put it.
- **focused entity = render state**, a `data-focused` attribute plus a ring in
  the card's existing certainty colour at heavier weight. **J4 green is reserved
  for the character system** and is deliberately not used here.

### THE EXACT NEXT VERIFICATION — nothing else closes this gap

1. Render the Business Map.
2. Issue a real J4 focus request (not a synthetic store write).
3. Verify the node's domain opens.
4. Verify the correct carousel entity is focused, and only that one.
5. Verify manual owner navigation afterwards is NOT overridden.

**Do not manufacture DOM or screenshot evidence to close this.** Green DOM
assertions have passed under a full-screen overlay in this codebase before,
which is why step 1 is "render", not "assert".

**The harness for it already exists — extend, do not build.**
`scripts/verify-business-map-browser.ts` (browser lane, run with `--browser`)
already signs a user in (`signIn`), navigates to `/dashboard`, and locates cards
by `[data-testid="entity-card"]`. So the whole verification is a new scenario in
that file:

1. `setJ4Focus([<node id>])` — or better, drive a real `take_me_there` with a
   `nodeLabel`, so the server resolves the id and nothing is synthesised.
2. Assert the expected domain opened.
3. Assert exactly one card carries `data-focused="true"`, and it is the right
   one. **That attribute exists for this purpose** and is why it was added.
4. Click a different domain, then assert `data-focused` has NOT reappeared —
   this is the assertion that proves focus is an event and not an effect that
   re-applies.

**Screenshot it too.** A `data-focused` attribute can be present on a card that
is invisible behind something — that exact failure has happened here.

### The smallest slice that is real, in order

1. **Give `focus` a consumer.** P2 emits `focus.nodeIds` and nothing renders it.
   **This is the next implementation step and needs no new asset** — but it is
   two-stage, not one highlight, and that was found by reading the canvas rather
   than assumed:

   `BusinessMapCanvas` renders the **nine DOMAINS** as its ring (`key:
   MapDomainKey`, `step(key)` drills in), not individual nodes. Entities appear
   in the carousel *after* a domain is opened. So focusing `product:<id>` means
   **open that node's domain, then highlight it within the carousel** — and the
   node's domain is already on `MapNode.domain`, so no new resolution is needed.

   The mechanism should be a small presentation-only store in the shape of
   `lib/dashboard/genesisActivity.ts` (`subscribe`/`getSnapshot`/`set`), holding
   node ids and nothing else: focus is temporary presentation state, must not be
   persisted, and must not touch map data or the understanding.
2. **Add `speaking` and `attention` to `GenesisActivityState`**, driven by the
   existing machine. Behaviour first, appearance later.
3. **A desktop bottom-left zone** hosting the existing presence, with an explicit
   Expand control.
4. **The character asset set** — blocked on the decision above.

Steps 1–3 are implementable against what exists. Step 4 is not, and pretending
otherwise would produce a prototype screen with a placeholder in it, which
`feedback_no_prototype_screens` exists to prevent.

## Open dependencies — flagged, not decided

- **Mouth sync is blocked on an unproven voice pipeline** (above). A real
  blocker for that requirement, not a detail.
- **The concept art is not an asset set.** States × expressions × skins × sizes
  is a matrix; 16px and 128px are different design problems. Sprites vs a vector
  rig vs a composed component is an unmade decision with very different costs.
  Prior art: gpt-image-1 could not preserve locked regions, which is exactly the
  problem an expression matrix hits.
- **E25 is adjacent and still Sean's**: five primary nav tabs against a rooms
  model locked at four in `GENESIS_SURFACES.md`. A J4-driven Business Map
  walkthrough navigates those surfaces. It does not block the audit.
