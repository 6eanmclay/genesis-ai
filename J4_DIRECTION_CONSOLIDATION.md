# J4 / Genesis — Direction Consolidation

**Status: SOURCE OF TRUTH for the next J4/Office design decisions, 2026-09-09.**
Sean's consolidated handoff of that date, recorded verbatim in intent, plus the
review he asked for in the same message:

> *"I don't want us to lose the other work we've already done just because we're
> focusing on the visuals right now. Please review the existing J4/Genesis
> implementation and our previous decisions and identify anything important that
> isn't represented above before making architectural changes. The list above is
> the fresh consolidation, not permission to discard previous requirements."*

**Nothing in this document is implemented.** He asked for the gap review *before*
architectural changes. §B is that review, and it is the reason this file exists.

This does not supersede `GENESIS_SURFACES.md` (locked), `J4_IDENTITY.md`
(frozen), `GENESIS_EXPERIENCE.md` (frozen) or `J4_APP_ROADMAP.md` (frozen).
Where it touches them, that is called out as a decision he has to make, not a
change made on his behalf.

---

## A. THE CONSOLIDATION (Sean, 2026-09-09)

Captured so the direction survives without the chat log. Numbering is his.

1. **The Final Hybrid is the canonical J4** — white shell, black wide visor,
   green illumination, retro-anime influence without cartoonishness, refined
   mechanical detail, distinctive ear module, J4 identity built into the
   hardware. The older expressive artwork stops being the primary character.
   The cropped runtime asset (white/black J4, full outer green ring, blank black
   visor, no wording) stays for runtime and **must not be reconstructed or
   substituted**. Appearance stays customisable later (white/black, black/black);
   Final Hybrid is the canonical starting point.
2. **The J4 emblem** is `J` + a *reversed* `4`, tightly integrated into one
   glyph — geometric, futuristic, legible as a tiny UI icon and as illuminated
   hardware. **Not** a conventional typed "J4".
3. **Intelligence must look earned, not magical.** No generic AI-brain graphic.
   Show the business's own data flowing in from its connections, converging into
   J4, and understanding flowing back out as insights, strategy, content,
   automation, decisions, opportunities, growth. The user should read the screen
   and conclude *"the more of my business J4 is connected to, the more J4
   understands."* **A foundational product concept, not decoration.**
4. **Office is a workspace, not a dashboard** — where the owner works *with* J4.
   PLAN → CREATE → EXECUTE → GROW. Talk to J4, see what J4 knows, see what J4 is
   working on, review insights, work tasks, decide, create, execute, see active
   projects and opportunities, move into the right business area.
5. **J4 is one persistent partner, not a collection of agents.** The owner says
   what they want; J4 works out what must happen. Audit real capability and
   close gaps rather than artificially limiting J4.
6. **Business Map = what J4 understands** — a human-facing profile of the
   business as connected entities and relationships, growing as connections and
   information arrive. Not database tables on screen.
7. **Business Map and Office are one system.** Map = what J4 knows. Office =
   what we are doing with what it knows.
8. **The visor is part of J4's language** — a real stateful visual system
   (default, thinking, listening, focused, happy, surprised, excited, serious,
   analysing, working, processing, success, warning, error), while keeping the
   clean wide-visor aesthetic rather than the old over-expressive artwork.
9. **Executive presence.** J4 is a business partner, not a chatbot mascot; the
   suit direction is brand language, not necessarily the core character's dress.
10. **Genesis is the platform, J4 is the partner.** Genesis keeps its own
    (blue) world; J4 is green and distinct. **Do not collapse the two.**
11. **The loop the whole experience must communicate:**
    CONNECT → UNDERSTAND → THINK → CREATE → EXECUTE → VERIFY → LEARN → GROW.
12. **Execution + verification stay foundational** — Request → Execute → Verify
    → Record → Display → Offer Recovery; `SUCCESS | WARNING | FAILED | PENDING`;
    actors `USER | J4/GENESIS | SYSTEM`. PENDING matters for async handoffs like
    Stripe OAuth. **Not to be redesigned away for a new UI.**
13. **Integrations are part of J4's brain**, not a settings page — every
    connection is more business context or more authorised action. Stripe is the
    reference connector (Connect / Verify / Disconnect / Status).
14. **Permissions**: J4's conversational actions respect the same model as the
    UI. Never show J4 able to do what the current user may not.
15. **The dashboard answers**: what is happening, what does J4 know, what needs
    me, what opportunities exist, what is J4 doing, what next. Analytics are one
    part of intelligence, not the experience.
16. **Creation Station writes per platform** — Instagram/Facebook/X/TikTok get
    genuinely different output, because J4 understands the platform.
17. **The mission is a business, not a website**: Idea → Product → Store →
    Customer → Revenue → Optimisation → Growth, explicitly for people starting
    without capital or inventory access; dropshipping/POD/wholesale are stepping
    stones toward better margins and more control.
18. **Priority order**: Permissions → Integration framework + verification →
    Owner dashboard → PayPal → J4 capability expansion. Do not over-polish web
    before mobile; architecture should support mobile rather than needing a
    rebuild.
19. **The images are direction, not a spec to reproduce.** Extract the design
    language and combine it with the existing architecture.

---

## B. THE REVIEW HE ASKED FOR — what the consolidation does not represent

Ordered by how much damage it does if missed.

### B1. DIRECT CONTRADICTIONS WITH WORK SIGNED OFF IN THE LAST WEEK

**1. Two facial states versus fourteen.** §8 asks for a stateful visor
(fourteen states listed; the reference sheet shows eight). On **2026-09-04**,
after repeated failed attempts at drawn/approximated expressions, Sean's
instruction was the opposite and emphatic:

> *"Exactly two facial states, OFF and ON. No listening/thinking/speaking
> expressions."* … *"Do not regenerate J4. Do not redraw J4. Do not recreate the
> eyes with CSS… Do not create different J4 artwork for different parts of the
> application."*

`components/j4/J4Character.tsx` implements exactly that today: one base image,
one face layer, opacity 0→1, nothing else can move. **These cannot both hold.**
The reason for the two-state rule was not aesthetics — it was that every
approximation of his artwork read as *nearly right and visibly not him*. A
fourteen-state visor is fourteen more chances to reproduce that failure.
**Needs his decision**, and if states return they must come from rendered
artwork he approves, not from anything drawn at runtime.

**2. Three canonical J4s now exist in the direction, and the drift rule
forbids that.** Shipped **2026-09-05** (`b24f29f`): the *calm* black/honeycomb
badge for persistent surfaces, the *green* badge for the entrance. §1 adds the
Final Hybrid as canonical **and** keeps the cropped runtime asset **and**
anticipates customisable treatments. The standing rule from 2026-09-04 is *"one
canonical pair, everywhere"*, because two separate registrations produced two
different eye spacings. **Needs an explicit surface→artwork map** before any of
it is built: which exact asset the dock draws, the workspace draws, the entrance
draws, and the emblem uses.

**3. The entrance sequence is unmentioned.** The coin flip, the six systems
arriving, and Sean's own model for the character — *"like a dog when its person
comes home; the entrance is the excited greeting, then he settles"* — are built,
deployed and confirmed. §1 does not say whether the Final Hybrid replaces the
entrance artwork or only the persistent one. **The "barely alive" movement work
is still explicitly not started**, pending his verification of the calm artwork
in production.

### B2. LOCKED AND FROZEN DOCUMENTS THIS DIRECTION TOUCHES

**4. `GENESIS_SURFACES.md` is ARCHITECTURE LOCKED (2026-08-14), rooms locked
(2026-08-15).** It governs the four surfaces and states *"J4 is not a place I go,
J4 is who comes with me."* §4's Office rebuild is a change to a locked surface.
Either it conforms, or **he amends the lock deliberately** — implementation
convenience is explicitly not allowed to relitigate it.

**5. E25 has been waiting on his decision since 2026-09-02, and it blocks the
Office work.** The nav has **five** primary tabs; the locked document says
**four**. `verify-rooms.ts` is deliberately left FAILING rather than edited,
because quietly editing a lock to match the code is how a lock stops meaning
anything. **An Office/IA redesign cannot be specified while the room count is
undecided.**

**6. Other frozen documents that must be checked against, not around:**
`J4_IDENTITY.md` (who J4 is — §5/§9 look consistent, but it is the checkpoint),
`GENESIS_EXPERIENCE.md`, `J4_APP_ROADMAP.md` (frozen v1 — §18's mobile), and the
frozen 2026-08-01 Genesis avatar identity, which is the blue world §10 keeps
separate. **A new J4 emblem needs a home in that identity set**, or the two
identity systems drift.

### B3. ARCHITECTURE THAT MUST SURVIVE A REDESIGN (built, absent from the list)

**7. One J4, two presentations.** The dock panel and Office open the *same*
conversation — one mount, two presentations — as a **non-modal** panel: no
scrim, no scroll lock, no `aria-modal`, workspace stays usable behind it
(`b3abbf5`, 12/12 browser checks). Sean's own sentence: *"There is one J4. We are
only changing how much of him the owner sees."* **An Office that becomes a
second composer breaks this.** His standing instruction: *"Do not create another
composer."*

**8. The Growth Points economy is not mentioned anywhere in the consolidation.**
Every J4 action has a cost; the ledger has three unlimited sources (plan, trial,
platform operator). §5's "J4 should do conversationally anything Genesis can do"
has a direct, unpriced cost consequence. **Which new capabilities cost what is a
product decision, and the catalogue is locked.**

**9. Proactive J4** — J4 speaks first, once per finding occurrence. Built, and
two critical defects were fixed after launch. §15 asks what needs attention;
that mechanism already exists and should not be rebuilt as UI-only.

**10. The Genesis Language is a frozen five-state model** — Peace, Curiosity,
Optimism, Responsibility, Concern — retrofitted and on screen today. §8 proposes
a *different* state vocabulary for the visor. **Two state systems will drift**
unless one is derived from the other or they are explicitly separated (Genesis's
mood versus J4's activity).

**11. The Business Map already exists** (`a29eca7`): entity layer deployed, the
orb *is* J4, the category level was deleted, and the carousel is what J4 knows
about each thing. §6 reads as if new. The gap is not the map — it is that
**Connections do not yet feed it visibly**, which is exactly §3's point.

**12. Multi-business is half-built**: explicit active business shipped; business
in the URL is a 28-screen route migration, then the switcher. **Any Office IA
should assume multi-business** or it gets rebuilt.

**13. Verification discipline beyond §12**: `verify()` is required by the
compiler, 33 executables read their work back, and there are three verification
states. Plus two standing rules: **no prototype screens** (confirmed design *and*
real backend wiring), and **never fake a dependency to make a UI render**.

### B4. REAL-WORLD STATE THAT CONSTRAINS SEQUENCING

**14. Three real customers still have no receipts.** Order communications is
recorded as priority 1; the retroactive-send guard shipped and is inert, waiting
on a Resend account **and** his approval of the sending plan. **A visual
programme should not outrank customers not being told their orders shipped.**

**15. J4's tools were broken for nine days and the fix is still unconfirmed.**
An invalid tool schema made every unified triage call return 400 from
2026-08-26; J4 had **no tools at all** on the dashboard path, and every turn fell
through to a full store regeneration at 22–27 seconds. Fixed and deployed
(`2035762`, `a5ca4db`) — but **no successful triage call has been recorded since
2026-08-27**, because no turn has run since. **§5's capability expansion is
meaningless until one real message proves tools work again.** That is one
message from Sean.

**16. Latency is roughly 2× better, not the 3× he asked for.** The remaining
lever is a quality tradeoff (effort/model), which by his own rule is not to be
taken silently.

**17. Queued work he asked for is still open**, and he previously said the
Intelligence redesign should not start until it is done — **§3 is that
redesign**: the platform-admin billing diagnostic, notice diagnostics (#5), and
human-readable dashboard action labels (#6).

**18. Integrations are aspirational today.** §13 lists Google/Slack/Notion/
HubSpot/Salesforce/Microsoft/Teams/Monday/Discord. Reality: Stripe and PayPal
are live; Meta, AliExpress, Twilio, Square and Xero are **built but never
connected**; Square and Xero need only two env vars each and no app review. The
Meta app now exists (`Genesis J4`) with redirect URIs and keys still outstanding.
**"Integrations are J4's brain" is currently a promise, not a capability.**

**19. Other live constraints**: the Vercel Blob quota is Sean's to resolve at
the plan level with no app-side workaround; E26 leaves two real currency leaks
inside Studio; and his desktop cannot complete any OAuth login
(`WebAuthNGetCredentialList` never returns), which is why the Meta setup moved to
his phone.

---

## C. THE FOUR DECISIONS — RESOLVED BY SEAN, 2026-09-09

Answered the same day they were raised. These are now binding, not proposals.

**C1. Facial states: OFF and ON only.** No runtime-generated facial
expressions. Any future additional state must be **approved artwork**, never
drawn at runtime. This preserves the 2026-09-04 rule and the reason behind it.

**C2. One canonical J4.** The **Final Hybrid** is the primary J4 identity. The
established **cropped runtime asset** is the canonical runtime representation.
Every other render — the Office hero, the suited J4, the concept sheets — is a
**reference or marketing concept, not a competing runtime identity**. That
settles the surface→artwork question: runtime has exactly one answer.

**C3. E25 closed: FIVE primary tabs** — Business, Storefront, Studio, Commerce,
Account. **Office is part of Business, not a sixth room.** The sixteen-item
primary navigation in the Office reference is **not adopted**.

> Applied 2026-09-09, in the order E25 itself required and only after his
> decision: `GENESIS_SURFACES.md` amended (title and lock), `navConfig.ts`'s
> comment corrected — it had claimed "Your Business is gone from this list"
> for a week while Business sat first in that list — and `verify-rooms.ts`
> updated to assert five. **The suite is green for the first time since
> 2026-09-02.** Its J4 assertion is untouched: an Office *tab* would still
> break the architecture at any room count.

**C4. Sequence: reliability and customer obligations first.**

1. **Send J4 a real message and confirm a successful tool call.** Only Sean can
   do this — the harness signs into a database it creates itself, and there are
   no production test credentials. Verified afterwards from production
   telemetry, not assumed.
2. **The three customers still missing receipts.**
3. **Then** the Office reconstruction.

### The standing constraints on that reconstruction

Sean, verbatim: *"The goal of the Office redesign is not to invent a new J4
system. It is to create the best interface for the J4 system we already have
and are continuing to build."*

- **One J4 conversation** shared by Dock and Office. **One composer mount.**
- **Existing Growth Points economics.** Not re-priced by a new surface.
- **Existing Task / J4 Suggestions / Today's Focus systems.** Office renders
  them; it does not reimplement them.
- **The frozen five-state Genesis Language** stands. No parallel state system.
- **No invented metrics.** "Business Health 87" is removed unless a real
  calculation and source exist.
- **No capability claims without the capability.** "Search anything in your
  business" is removed or deferred until it is real.
- **No parallel systems**, at all. This is the rule the other bullets are
  instances of.
---

## D. THE OFFICE REFERENCES SPECIFICALLY (added 2026-09-09, second batch)

Two further images: J4 in a suit at a desk (executive presence, §9), and a full
J4 OFFICE mock — *PLAN · CREATE · EXECUTE · GROW*, a left rail, a J4 hero, an
embedded conversation, Quick Actions, Recent Activity, Today's Focus, Business
Health, Active Projects, J4 Suggestions.

Read as direction rather than a spec, per §19. What they add, and what they
collide with:

**20. The left rail in the mock has ~16 destinations.** Office, Overview,
Strategy, Tasks, Ideas, Decisions, Information, Files, Storefront, Products,
Customers, Marketing, Commerce, Integrations, Analytics, Settings, Upgrade.
That is a **third** information architecture alongside the locked four rooms and
the shipped five tabs. **E25 is now blocking two designs, not one.** Whatever is
decided has to cover the primary nav *and* Office's internal navigation, or they
will disagree the way the lock and the nav already do.

**21. "Business Health — 87, Overall Score" is an invented metric.** The
standing rule is that a new BI figure answers four questions before it exists,
and that Genesis never shows a number it cannot ground. A composite score built
from Sales/Traffic/Customers/Operations percentages needs a real definition, real
inputs, and an honest empty state — three of those four have no source today for
a store with two orders. **The same applies to every percentage in the mock.**
A demo screen may show 87; the product may not, until it means something.

**22. The mock puts a composer inside Office.** That is right *only* if it is
the same mount the dock opens. Sean's rule, twice: *"Do not create another
composer"*, and *"There is one J4. We are only changing how much of him the owner
sees."* The quick-option buttons under J4's greeting are a good pattern — but
they must feed the one conversation, not a parallel one.

**23. Today's Focus, Active Projects and J4 Suggestions already have owners.**
Tasks exist (Task model + trust framework + auto-execute), and Proactive J4
already decides what to raise and raises it once per occurrence. These panels
should render those systems. Rebuilding them as Office-local UI is how the
second knowledge system gets created — the exact failure Sean named when J4
could not explain Connections: *"Do not create a second Connections knowledge
system. Find the existing source of truth and make J4 use it."*

**24. "Search anything in your business" does not exist.** It is a real and
substantial capability (cross-entity search over products, orders, customers,
content, documents, connections), not a UI element. Either it is scoped as work
or it is left out of the design; a search box that half-works teaches the owner
not to trust the surface.

**25. "Upgrade — Unlock more power" places monetisation inside the workspace.**
Plans and Growth Points exist and are locked. Where the upsell sits is a product
decision, and it interacts with Sean's own principle that J4 recommends the plan
that fits observed usage rather than the one that earns most.

**26. The J4 in the Office hero is yet another render** — a blue-lattice helmet,
not the Final Hybrid. Combined with §1's three variants, that is four. This is
the surface→artwork map (B1.2) becoming urgent rather than tidy.

**27. What the references get right, and should be kept:** the *environment*
reads as a place of work rather than a page of cards; J4 is present in it rather
than docked to the side of it; the PLAN · CREATE · EXECUTE · GROW spine is
visible; and the business's own state — projects, focus, activity, suggestions —
is the content, not decoration. That is genuinely a workspace, and it is the
part of the direction worth protecting through the decisions above.
