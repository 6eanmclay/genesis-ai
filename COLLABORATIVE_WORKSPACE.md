# Collaborative Workspace — the operating layer between owner and J4

**Status: Draft — under review with Sean, not yet frozen.** Unlike `GENESIS_EXPERIENCE.md` (approved v1), this document is being actively shaped. Sections marked **OPEN QUESTION** are genuine unresolved design decisions, not rhetorical framing — they need a real answer before this freezes.

## Why: the relationship, not the sync

This is not being built so two devices can stay in sync. It's being built to establish the **operating relationship between the owner and J4** — the thing every other piece of this platform sits on top of.

The clearest evidence for this came from a real reaction, not a design exercise: the first thing Sean's mother said after creating her business wasn't "where are the settings?" It was **"I can't talk to it."** She was already expecting someone to be on the other side. That expectation is the product. Genesis is not winning by being a better dashboard — it wins by making that expectation true.

Two names, deliberately fixed from here on:
- **Genesis is the operating environment** — where the business is visible: products, analytics, orders, the storefront itself. This is what the desktop workspace is for.
- **J4 is the pocket business partner** — the relationship. This is what a phone in the owner's hand is for.

These are **complementary experiences of one business, not two ways to reach the same app.** An owner should never think "I'm opening Genesis on my phone." They should think "I'm meeting with J4."

Shared Context, daily meetings, weekly strategy sessions, voice conversations, approvals, notifications, and eventual team collaboration are not eight features. They are **eight expressions of that one relationship**, expanding over time — which is why they need one shared primitive underneath them, not eight bolt-ons to a chat widget.

That primitive is the **Workspace Session**.

**The standing bar for everything that follows, and for every future feature built on this primitive — a core product principle from here on**: *does this expand the relationship, or just add another dashboard feature?* If a proposed addition reads as "a new dashboard capability" rather than "a new way to work with your partner," it doesn't belong here — the same discipline `GENESIS_EXPERIENCE.md` already applies to its own reference screen.

### The relationship deepens over time — this is not a new mechanism, it already exists

J4 on day one only knows what the business-creation conversation taught it. After a first meeting, it knows more. After weeks of real sessions, it should understand *how this specific owner makes decisions* — not businesses in general, this one. After months, it should feel like part of the business.

This isn't a new system to build — it's a new **source of evidence** feeding a real mechanism that already exists: `Belief` (`lib/intelligence/learn.ts`). A belief already has `confidence` (0–1), `evidenceCount`, `firstObservedAt`/`lastConfirmedAt`/`lastContradictedAt`, and grounding in real `ExecutionLog`/`CognitiveOutput`/`BusinessEvent`/`PostExecutionMeasurement` ids — and its `category` vocabulary already includes `"owner_preference"`, sitting there today, real, mostly unfed. Right now beliefs are built almost entirely from *what happened in the business* (outcomes, patterns in events). Workspace Sessions become a new, much richer stream of evidence about *how this owner actually thinks and decides* — a live session's transcript and decisions are exactly the kind of thing `"owner_preference"` beliefs should be grounded in going forward.

This is explicitly long-term, not something the first Shared Context build needs to touch — no new fields, no new pipeline required right now. Worth stating plainly so it isn't lost: the growth arc Sean's describing already has a real home in this codebase; Workspace Sessions just need to eventually become one of the things that feeds it.

## What a Workspace Session fundamentally is

**A Workspace Session is a bounded period of live, mutually visible attention between one or more humans and J4, anchored to some scope of the business, during which state is shared in real time and actions can be proposed and applied.**

Three things distinguish this from everything that exists in Genesis today:

1. **It's stateful and live**, not request-scoped. Every existing interaction — a dashboard page load, a chat message, an approval click — is a single request/response. Nothing today represents "we are in this together, right now."
2. **It's the substrate, not a feature.** Chat, voice, live desktop editing, and a strategy meeting are different *presentations* of the same underlying object — the same way `Executable` is one contract that `storePublish`, `productEdit`, and `integrationConnect` all implement, rather than each inventing its own execution shape.
3. **J4 is not a participant row — it's the counterpart the session exists to talk to.** `participants` is the list of real Users present; J4's presence is architectural, not an enumerated party. This matters for the schema: a session with one owner is a normal 1-human session, not a "2-participant" session that happens to include an AI.

## What a session is NOT — the refinement worth confirming

**OPEN QUESTION:** Sean's list (meetings, onboarding, approvals, notifications, live editing, voice, team collaboration, Shared Context) mixes two genuinely different things, and I think the difference matters for what gets built:

- **Live sessions** — real-time, bounded, mutual presence: Shared Context (live editing), voice conversations, scheduled meetings, team collaboration. These need the real-time transport and live state this document is about.
- **Async artifacts** — durable objects that either *originate from* a session or *invite someone into* one, but aren't themselves a live thing: an `ApprovalRequest` can be approved from a push notification without ever opening a session; a notification is an invitation ("J4 found something — want to talk about it?"), not a session with zero duration.

My recommendation: model `ApprovalRequest`/notifications as things a session can **produce** (a proposal made live becomes a durable `ApprovalRequest` if not immediately decided) or **reference** (a notification deep-links into starting a new session), rather than forcing them into the same live-state machinery real-time editing needs. Onboarding is the genuinely ambiguous middle case — it's live and guided like a meeting, but today has no other participant besides the owner and no real-time cross-device component. I'd leave it unclassified for now rather than force an answer before either meetings or onboarding v2 exist to compare against.

## Core shape

```
WorkspaceSession {
  id
  storeId                    // which business
  participants: User[]       // real humans present — J4 is implicit, not listed
  kind: SessionKind           // "live_editing" | "meeting" | "voice" | ... — open set, only "live_editing" built first
  scope: {                    // what part of the business this session is anchored to
    kind: "page" | "product" | "general"
    targetId?: string
  }
  status: "active" | "ended"
  startedAt, endedAt

  // The live, mutable part — the thing needing real-time sync:
  liveState: Json             // shape varies by kind; for live_editing: { currentPageUrl, focusedElementId, pendingProposal }
}
```

History (what was said, what was proposed, what was decided) is deliberately **not** a new event log — it composes the durable models that already exist:

| Concern | Already-real mechanism | What changes |
|---|---|---|
| Conversation history | `StoreMessage` (`storeId, role, content, changes`) | Add an optional `workspaceSessionId` reference; the model itself doesn't change shape |
| A proposal awaiting a decision | `ApprovalRequest` (`actionType, input, previousValues, summary, status, groupId, topicKey`) | A session-originated proposal creates one of these exactly like Discovery-feed suggestions do today — no new "proposal" concept needed |
| Applying a confirmed change | `Executable` / `execute()` (`lib/execution`) | Unchanged. A session is a new *caller*, not a new execution path — `ctx.actorType`/`actorId` already carries who did it |
| What's worth bringing up in a meeting | `CognitiveOutput`, `GenesisObservation`, `Belief`, `BusinessEvent` | Unchanged — these already compute "what's worth discussing"; a meeting-kind session just becomes a new *consumer* of them |
| Presence/activity ("Genesis is thinking") | `lib/dashboard/genesisActivity.ts` | This is honestly worth naming as a real gap: today it's a **module-level, single-tab JS variable** — it doesn't even sync across two tabs in the same browser, let alone across a desktop and a phone. A session's `liveState` is what actually needs to drive this going forward |

## What doesn't exist yet — the real new infrastructure

- **The `WorkspaceSession` model and lifecycle** itself (start, join, end, timeout/idle-close).
- **A real-time transport.** Every part of this stack today (Next.js on Vercel serverless) is request/response — there is no persistent-connection layer anywhere in this codebase, confirmed by grep. This is a genuine vendor/infra decision (Ably, Pusher, Supabase Realtime, or self-hosting something), not just new code.
- **Element addressability.** The dashboard/storefront UI has no concept today of "this heading is referenceable as a discrete thing." `focusedElementId` in the shape above is meaningless until editable surfaces expose stable, addressable IDs — this has to be designed into the UI layer, not assumed.
- **Device pairing / "which session is this device looking at."** Desktop and phone are independent NextAuth sessions on the same account today; nothing associates a specific browser tab with a specific phone as a live pair. For v1, the simplest honest model is probably "one active session per store at a time," not real multi-device presence — worth confirming before building.
- **Voice (STT/TTS)** and the **native mobile app** — both real, both explicitly separate initiatives from this document, referenced but not designed here.

## Scope of the first concrete implementation: Shared Context

Same discipline as Creative Direction's phased build — name the full architecture, ship one narrow, real slice of it.

**In scope:**
- One `kind`: `"live_editing"`.
- Exactly one human participant (the owner) — no multi-user yet.
- One `scope.kind`: `"page"` — a single dashboard/storefront page at a time.
- `liveState` limited to `{ currentPageUrl, focusedElementId, pendingProposal }`.
- Minimum real-time wiring: desktop publishes current page + focused element; phone (mobile web, not native) subscribes and can propose changes; proposals flow through the existing `Executable`/`ApprovalRequest` machinery unchanged.
- Element addressability for a deliberately small, real surface (e.g. just the Website page's hero/theme elements already editable via `VisualProposal` today) — not the whole dashboard at once.

**Explicitly out of scope, named so it isn't silently forgotten:**
- Voice modality.
- Scheduled/recurring meetings (daily/weekly cadence).
- Multi-user/team collaboration (more than owner + J4).
- Notifications as session entry points.
- The native mobile app.
- Onboarding-as-a-session.
- Real multi-device presence beyond "one active session per store."

## Open questions before this freezes

1. The live-session vs. async-artifact split above — does that match your mental model, or do you see approvals/notifications as needing to be live-session-native from the start?
2. "One active session per store" as the v1 simplification for device pairing — acceptable, or does even the first version need to handle a genuine multi-device-presence question?
3. Real-time vendor: any existing preference/constraint (cost, self-hosted vs. managed) before I go research options?
