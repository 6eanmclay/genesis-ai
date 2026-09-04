# J4 Asset & State Specification

**Status: SPECIFICATION, 2026-09-03. Nothing here is built.** Written so that
once the assets exist, implementation can begin without another architectural
audit. The approved direction is `J4_VISUAL_DIRECTION.md`; this is the concrete
asset list that direction implies.

**Why this exists**: `GenesisAvatar` today displays **one image of one pose with
one expression** (`public/brand/genesis-avatar-orb.png`). Everything the
direction asks for beyond that — a character who looks attentive, thoughtful,
speaking or pleased — needs something that can *change*. That is an asset
decision, and it is the only thing standing between the shipped architecture and
"this feels like J4".

---

## 1. What already exists, so it is not commissioned twice

| Piece | Where | Status |
|---|---|---|
| Persistent presence component | `app/dashboard/J4Summon.tsx` | Built |
| State machine | `lib/dashboard/genesisActivity.ts` | Built: `idle \| listening \| thinking` |
| Avatar renderer | `app/dashboard/GenesisAvatar.tsx` | Built, but renders one static PNG |
| Surface + selection context | P2, shipped | `workspacePath`, `selection.nodeIds`, `focus.nodeIds` |
| Concept references | `design/j4-visual-direction/` | Approved, **not production assets** |

**Two of the five required states have no representation at all**: `speaking`
and `success`/`attention`.

---

## 2. The state matrix — what must be distinguishable

The direction's core states, and what each must communicate *without text*:

| State | Reads as | Trigger that exists today |
|---|---|---|
| `idle` | present, unbothered | default |
| `listening` | attentive, leaning in | mic/turn open — **wired** |
| `thinking` | considering, working | model call in flight — **wired** |
| `speaking` | talking to you | **no trigger yet** — needs voice or streamed-reply hook |
| `success` | pleased, done | execution SUCCESS |
| `attention` | needs you, not alarmed | pending approval / blocked |

**Six states, not five**: `idle` and `listening` are genuinely different and both
already exist in code.

---

## 3. What can be animation, and what must be a separate asset

This is the decision that sizes the whole commission.

**Achievable by animating ONE base asset** (no new art):
- `idle` — slow breathing scale/opacity on the frame
- `thinking` — the honeycomb/frame pulsing, character unchanged
- `attention` — frame colour shift plus a slow pulse
- Compact ↔ expanded **position and scale** transitions

**Requires distinct artwork** (the character's face changes):
- `listening` — eyes/brow attentive
- `speaking` — mouth open/closed positions
- `success` — a pleased expression

**Mouth animation for speech** is the expensive one. Two viable approaches, and
the choice belongs to whoever produces the art:

1. **Two-frame flap** — mouth-closed + mouth-open, alternated against audio
   amplitude. Cheap, reads correctly at small sizes, no viseme mapping. **This
   is the minimum viable option.**
2. **Viseme set** — 5–8 mouth shapes mapped to phonemes. Better at expanded
   size, and requires a voice provider that emits timing data. **Blocked on the
   unproven voice pipeline** — do not commission until synthesis is proven.

---

## 4. Locked regions — what must not move between states

The failure this prevents is already documented: gpt-image-1 could not preserve
locked regions, so regenerating a pose produced a *different character*. Any
asset set must hold these constant across every expression:

- **Head silhouette and helmet geometry** — the outline is the recognition
- **The J4 wordmark** on the chest and the ear-piece disc
- **The white/black panel split** (or black/black for the alternate skin)
- **Frame ring weight and radius** relative to the head
- **Eye position and spacing** — expressions change eye *shape*, never location

**Implication**: expressions should be produced as **layers over one locked base
render**, not as independent generations. Independent generations are what
produced a different character last time.

---

## 5. Minimum viable asset set — first functional release

Deliberately small. Everything else is a later pass.

| # | Asset | Purpose |
|---|---|---|
| 1 | Base character, neutral, transparent background | `idle`, and the base every layer sits on |
| 2 | Eyes: attentive | `listening` |
| 3 | Eyes: thoughtful | `thinking` |
| 4 | Mouth: closed | `speaking` frame A |
| 5 | Mouth: open | `speaking` frame B |
| 6 | Expression: pleased | `success` |

**Six pieces, one skin (white/black), one pose.** Black/black is a recolour of
the same base and should not be a second commission.

**Sizes**: one master at 512px, and the implementation derives the rest. The
concept sheet's 16px case is a **separate mark**, not a downscale — at that size
the character is unreadable and only the frame plus a suggestion of the face
survives. That mark is a seventh asset if the 16px case is genuinely needed.

---

## 6. Compact vs expanded

**Compact** needs only the head-and-shoulders crop of the base, plus the
expression layers. Everything in §5 serves it.

**Expanded** needs the torso, arms and hands the direction describes for
pointing and gesturing — and that is a **materially larger commission**: each
gesture is a pose, and poses cannot be layered over a locked head the way
expressions can.

**Recommendation, stated as one**: ship compact first with the six assets above.
The expanded character's gesture set should not be commissioned until the
compact loop is working and the interaction has been felt, because the gesture
vocabulary is exactly the part most likely to change once it is real.

---

## 7. What implementation needs from the assets

So the handoff is unambiguous:

- **PNG with alpha**, one master per piece at 512px
- **Layers aligned to the same canvas origin** — a layer that needs manual
  nudging per state is a layer that will drift
- **No baked-in frame or honeycomb** — those are drawn in code, so they can
  animate and recolour without touching art
- **Named by state**, matching `GenesisActivityState` exactly, so the mapping is
  the filename and not a lookup table somebody maintains

---

## 8. Blocked, and on what

| Item | Blocked on |
|---|---|
| `speaking` mouth sync | Voice pipeline unproven — no provider credential, synthesis never produced audio |
| Viseme set | The above, plus a provider that emits timing |
| Expanded gestures | Compact loop working first (§6) |
| 16px mark | Whether the 16px case is genuinely needed |

Nothing in §5 is blocked. That is the point of keeping it to six.
