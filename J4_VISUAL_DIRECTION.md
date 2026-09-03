# J4 Visual Direction — J4 becomes a character, not an icon

**Status: DIRECTION, captured 2026-09-03. NOT APPROVED FOR BUILD.** Sean's
instruction was explicit: record this, finish the current engineering work and
gap 27 first, then run a fresh capability audit, and report back *before*
implementing any of it. Nothing in this document has been built. Nothing in it
should be started without Sean saying so.

**References** (in `design/j4-visual-direction/`, copied into the repo because
the originals were in a session-scoped upload folder that does not survive):

| File | What it is |
|---|---|
| `j4-primary-reference.png` | **The primary visual reference.** |
| `j4-concept-sheet.png` | Concept sheet: alternate presentation, expressions, sizes, states. |

---

## The product change this represents

**Genesis is the platform/interface. J4 is the persistent business-partner
character inside Genesis.** That distinction is the whole point, and it is a
change from how the avatar has been treated until now.

**The old blue orb / sonar interaction — the one that displayed "Listening" and
"Thinking" — is now an OLDER INTERACTION MODEL, not the future primary J4
experience.** It is not deleted by this document and nothing about it changes
today; it is reclassified. Anything that treats it as the destination should be
read with that in mind, including `GENESIS_AVATAR.md`-era decisions and the
frozen avatar identity work from 2026-08-01.

**Colour split**: green is J4's identity and interaction colour. Genesis remains
blue. Both are true at once — this is not a rebrand of Genesis.

---

## What the new J4 must eventually support

Recorded as Sean stated them, because a paraphrase of a design brief is how a
design brief gets quietly narrowed:

1. A recognizable **persistent character/avatar**.
2. **Green as J4's identity/interaction colour** while Genesis remains blue.
3. **Animated visual states**: listening, thinking, speaking, working, success,
   attention, and others as needed.
4. **Actual mouth/face animation synchronized with J4's spoken responses**, so
   users immediately understand that J4 is talking.
5. **Different facial expressions appropriate to context.**
6. A **friendly, approachable personality** rather than a generic robotic
   assistant.
7. **Multiple user-selectable appearances/skins.** The initial direction is the
   white/black version and a black/black version, with further customization
   possibly later.
8. **It must work at very small sizes as well as expanded/full-size.**
   Explicitly: *do not assume the detailed concept art can simply be dropped
   into every UI location.* The concept sheet already shows this being reasoned
   about at 128/80/48/32/16px.

**The principle underneath all of it: J4 is becoming a character, not just an
icon.**

---

## What this changes about the Business Map

J4 should be able to **explain what he understands about the business while
visually navigating and highlighting the relevant parts of the Business Map.**

Sean's example, kept verbatim because the sequencing is the requirement:

> "Your TikTok is getting more views than Facebook, but Facebook is generating
> more revenue."

While saying that, J4 should visually focus/highlight TikTok, then Facebook, and
eventually take the owner directly into the relevant detail. J4 then asks:

> "Do you want me to break down Facebook specifically, or compare all of your
> social media?"

The owner answers conversationally and **J4 changes the scope of the visual
experience**. This should eventually work across Products, Customers, Commerce,
Social, Connections, and the rest.

So the Business Map stops being a thing the owner reads on their own and becomes
a surface J4 drives *with* them. Speech, highlight, and navigation are one
synchronized act, not three features that happen to coexist.

---

## The conversational-interface goal

**Eventually, anything the owner can legitimately do through Genesis should be
something they can ask J4 to do conversationally, where appropriate.**

The goal state: **J4 is the single conversational interface to the business,
while the Genesis UI and Business Map remain the visual surfaces J4 can navigate
with the owner.**

---

## The audit Sean asked for (NOT started)

To be run after the current production-readiness work and gap 27. Genesis has
gained many capabilities since the original J4 tool/action design, so
`J4_CAPABILITY_AUDIT.md` (2026-08-08) is stale — **this audit should supersede
and update that document rather than become a second parallel one.**

Seven questions, as specified:

1. Everything Genesis can currently do.
2. Everything J4 can currently inspect/explain.
3. Everything J4 can currently execute.
4. Capabilities Genesis has gained that J4 cannot yet invoke.
5. Which actions require approval.
6. Which actions require verification.
7. Which capabilities need new tools/actions **versus simply better
   conversational routing** — a distinction that decides how much of this is
   building and how much is wiring.

**Hard constraint, stated by Sean:** do not create duplicate architecture where
an existing execution/verification/action system already handles the capability.
Genesis already has an execution layer, an approval/drift layer, a verification
layer, and a tool registry. The audit's job is to find what is *missing*, not to
propose a second version of what exists.

---

## Dependencies and open questions — flagged, NOT decided

These are recorded so whoever picks this up does not discover them late. None is
answered here and none should be answered without Sean.

**Mouth animation depends on a voice system that has never been proven.** J4
voice output shipped in `77cc202`, but real synthesis is UNVERIFIED because
there is no ElevenLabs key. Face animation "synchronized with J4's spoken
responses" cannot be built, let alone verified, against a synthesis path that
has never produced audio. Whatever the sync mechanism ends up being — visemes,
amplitude envelope, or timed markers from the provider — it is downstream of a
working voice provider. **This is a real blocker for requirement 4, not a
detail.**

**The concept art is not an asset set.** Requirement 8 says so directly. A
128px render and a 16px mark are different design problems, and the expression
and state matrix multiplies it: states (listening/thinking/speaking/working/
success/attention) × expressions × skins (white/black, black/black) × sizes.
Whether these are rendered sprites, a vector rig, or a component that composes
parts is an unmade decision with very different cost profiles. Prior art matters
here: `project_j4_avatar_branding` recorded that gpt-image-1 could not preserve
locked regions, which is exactly the problem an expression matrix runs into.

**E25 is adjacent and still Sean's.** The nav currently has five primary tabs
against a rooms model locked at four in `GENESIS_SURFACES.md`. A J4-driven
Business Map walkthrough navigates those surfaces, so the walkthrough design
touches an unresolved decision. It does not block the audit.

**"Legitimately" is doing real work in the conversational-interface goal.**
Not every capability should be conversational — destructive, financial, and
irreversible actions already sit behind approval and verification for reasons
that predate this direction. Question 5 and 6 of the audit exist precisely so
that boundary is drawn from the existing systems rather than re-litigated.

**Existing frozen documents are untouched.** `GENESIS_SURFACES.md` is locked and
`J4_IDENTITY.md` is frozen; this document does not edit either. Where this
direction supersedes them, that is Sean's call to make explicitly, and it should
be made in those documents rather than implied from this one.

---

## Sequencing, as instructed

1. Finish current production-readiness work. *(Gaps 25 and 26 closed, deployed,
   production-verified as of 2026-09-03.)*
2. Gap 27 investigation — the intermittent `verify-order-webhook-live`
   assertion about an order landing in the attacker's own store.
3. The fresh capability audit above.
4. **Report back. Do not begin the avatar, animations, voice system, Business
   Map walkthrough, or new J4 commands before that.**
