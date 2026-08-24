# J4 Workspace — from a floating panel to a persistent, full-window surface

> ## ⛔ SUPERSEDED — DO NOT BUILD FROM THIS DOCUMENT
>
> **This proposal was never implemented as written, and the direction it proposes
> has been rejected.** It is superseded by `GENESIS_SURFACES.md` (LOCKED), which
> names this document directly and states the reason: this one proposed J4 as a
> full-window workspace you *enter*, and that is the model the current surface
> model exists to reject. The governing principle there is *"J4 is not a place I
> go, J4 is who comes with me."*
>
> **Kept in the repository as the record of a rejected direction**, because
> `GENESIS_SURFACES.md` cites it by name and a reader should be able to see what
> was turned down and why. The bug analysis below is still accurate history; the
> proposed solution is not the one that shipped.
>
> The original document follows unchanged.


**Status: v1, 2026-08-07 — design only, not yet implemented.** This document exists because two real production bugs found the same day, while fixing Response Modes' streaming, exposed the same underlying mismatch: *"J4's work must not be owned by the lifetime of the chat component/page"* (Sean's own words, said directly in response to a real bug where navigating away mid-reply produced a confusing "connection dropped" failure). This document captures the proposed direction — J4 becomes a full-window workspace with its own persistent conversation/task lifecycle, separated from the dashboard page underneath it — and is explicitly **not** authorization to build it. Do not implement against this without a real design pass and Sean's explicit go-ahead.

## The bug that motivated this, stated precisely

Today, `GenesisAssistant.tsx` is a floating panel mounted inside `DashboardShell`, which is mounted inside whatever dashboard page the owner happens to be on. Its local state — `localMessages`, `streamingStatus`, and critically the live `fetch("/api/chat")` call and its `ReadableStream` reader — lives and dies with *that specific component instance*. Real, found-live consequence (2026-08-07): a client-side network interruption (backgrounding the tab) during a streamed reply caused the client's own read loop to fail, and the code's original response to that was to silently resubmit the same message through a completely different, older mechanism — because nothing about the architecture distinguished "the conversation is still going, just not visible right now" from "this turn never happened." That specific symptom is fixed at the request level (`app/api/chat/route.ts`'s `emit()` now survives a dead connection and still persists the real result; `GenesisAssistant.tsx` no longer auto-resubmits on a read-loop failure). But the *architectural* cause — a conversation's liveness being entangled with one page's component tree — is still real, and this document is the proposed fix for that, not the narrow bug.

## The direction: J4 as a full-window workspace, not a floating panel

- Opening J4 takes over the available viewport — full-screen on mobile, a genuine large workspace pane on desktop, not a small floating card. The dashboard underneath isn't destroyed; it's simply not the active surface while J4 is open. Closing J4 returns to the dashboard exactly where it was left.
- The real motivation isn't cosmetic: J4 needs room to hold actionable embedded UI *inside* the conversation (forms, choices, previews — see `[[project_j4_workspace_embedded_workflows]]` memory for the fuller embedded-workflow spec), which a small floating panel structurally cannot fit.
- Concrete example (Sean's own, restated exactly): owner opens J4 → "What do we need to accomplish today?" → J4 replies briefly, identifies the task ("Let's get your first ring live. I need a photo, price, and description.") → J4 presents the photo upload, price field, and description choice *inside the workspace* → the owner completes the task without leaving J4.

## The rebrand, made concrete (2026-08-08)

Sean confirmed directly, after discovering the phone still correctly shows "Genesis" (the rebrand was never implemented, not a deployment bug — see the session's own diagnosis right before this): he wants the visible UI rebrand as real next work, with the exact copy specified —

- "How can Genesis help today?" → **"How can J4 help today?"**
- "Your business partner for {storeName}" → **"Your business partner for [business]"** (same interpolation, new lead word)
- "Ask Genesis" (the submit button label) → **"Ask J4"**
- Plus the J4 *visual* identity, not just the label — this session's own earlier work already has a real `GenesisAvatar`/`genesisAtmosphere.ts` palette to reconcile or replace, not just a find-and-replace of the word "Genesis" in JSX strings.

Still explicitly **not authorized to build** — captured here so the exact copy is on record for whenever this is greenlit, not because it's scheduled next. As of this writing, Sean's own instruction was to finish the in-progress streaming diagnosis and wait for his phone retest before implementing anything, including this.

## Lifecycle separation — the part that's actually architectural, not visual

The full-window layout change alone doesn't fix the root bug — a bigger panel that's still torn down and rebuilt by ordinary page navigation has the same liveness problem, just with more screen real estate. Two genuinely different pieces of work are being conflated in "make J4 a workspace," and they should probably be scoped separately even though Sean described them together:

1. **Server-side durability (already real, proven today).** `app/api/chat/route.ts`'s fix — a dead client connection no longer aborts generation or persistence — is the proof that "the server keeps working regardless of whether a client is currently listening" is achievable in this codebase, not speculative. Any future work here (a task that genuinely runs long, or survives a full app close, not just a backgrounded tab) extends this same principle; it doesn't need to be reinvented.
2. **Client-side lifecycle separation (not yet done — this is the real proposal).** J4's live conversation view should not unmount and remount every time the owner navigates between dashboard pages. Concretely, this likely means J4 stops being an ordinary child component of whatever page is currently rendered, and becomes a persistent surface mounted once, above or alongside the dashboard's own page-to-page navigation — its own open/closed state and in-flight request genuinely independent of which page is "underneath." Whether that's a real route (`/dashboard/j4` or similar, getting back-button/bookmark/reload semantics for free) or a persistent overlay that survives client-side navigation without a URL of its own is a real, undecided tradeoff — see Open Questions.

## Real new infrastructure this implies — named honestly, not hand-waved

- **The full-window UI itself** is a real layout/interaction-design change: how it opens/closes, whether closing preserves the dashboard's scroll position, how the existing `focusedContext` mechanism ("why you're here," today passed from a Task card into the floating panel) carries into a full-window surface instead.
- **Task context tracking is a genuinely new concept, not something this codebase has today.** Making "upload a photo → it's automatically attached to the ring we're currently creating" work requires the conversation to hold real state about *what's currently being assembled and doesn't have a database id yet* — distinct from `StoreMessage` (a transcript) and `ApprovalRequest` (a single, already-fully-formed proposed diff). Before inventing a new mechanism for this, check whether the existing `Task` model (Business Assets / Action Cards architecture) is the right foundation to extend, rather than a second, parallel concept.

## Relationship to existing and adjacent work — don't duplicate or conflate

- **Not the same as `COLLABORATIVE_WORKSPACE.md`** (still draft, unfrozen) — that document is about real-time, multi-device presence (voice, live desktop↔phone sync, Shared Context). This proposal is narrower and single-device: one session's own conversation surviving navigation *within itself*, not live synchronization across devices.
- **Builds directly on Meeting with J4's M7** (`[[project_meeting_with_j4]]`) — the existing "explain, approve, execute, inline in the conversation" moment (`ActionDiffRows`, `performApproveGenesisAction`) is the same trust pattern this proposal generalizes into a longer, multi-field, multi-turn assembly process (collect → preview → approve) instead of a single one-shot diff.
- **Directly informed by two real, found-live facts from the same day this was proposed**: (a) entangling a conversation's liveness with one dashboard page's component lifecycle is what turned a transient network hiccup into confusing lost/duplicated work; (b) the server-side durability fix proves the underlying "keeps working regardless of the client" principle this whole direction depends on is real and already shipped, not aspirational.

## Open questions this document doesn't answer

- **Real route vs. persistent overlay** — a dedicated URL gets browser navigation semantics (back button, reload, bookmark, share) for free but is a bigger structural change; a persistent overlay avoids a real page transition but needs its own not-yet-designed "survive client-side navigation" mechanism. Not decided here.
- **Where task-context state actually lives** — pure client state (simple, but lost on reload — arguably reintroducing the exact fragility this document exists to fix), server-persisted against the conversation (survives reload, needs real schema work), or something in between.
- **How approval/execution generalizes** — is a fully-assembled multi-field task ("create this product with these 4 fields, now collected") one `ApprovalRequest` created only once assembly is complete, or something new? The current guess (create the real `ApprovalRequest` only at the final "owner approves" step, exactly like today, with the conversation itself owning the not-yet-a-record assembly state beforehand) is the natural fit but not confirmed.
- **The still-unmigrated heavy-edit path** (`edit_store_content`, today's unstreamed PRIMARY fallback) — a full-window workspace strengthens the case for eventually migrating that path to real streaming/backgrounding too, but that stays explicitly out of scope for this document.

## How to apply

Do not build against this. Per this project's own standing discipline (no prototype screens without a confirmed design and real backend wiring together), this needs a real design pass — and per Sean's own instruction when this was requested, no Phase 3 intelligence work either. Treat this as the starting scope for whenever that design pass happens, not a spec ready to implement.
