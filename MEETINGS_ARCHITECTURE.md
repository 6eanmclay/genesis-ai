# Meetings — Architecture Proposal

**Status: PROPOSAL. Nothing in this document has been built. Written before implementation, consolidating three of Sean's messages this session (Work Mode vs. Meeting Mode's default chat tone, Meetings as first-class organizational units, and "Meetings should be suggested, not required") into one coherent design.**

Date: 2026-08-06

---

## 0. What's real today — and the one correction worth making up front

Before proposing anything, I checked whether the existing "Meeting with J4" feature (built earlier this session, M1-M7) is a foundation to extend. **It isn't, and being honest about that changes the shape of this proposal:**

- `Store.firstMeetingCompletedAt` is a single nullable timestamp — "Meeting with J4" is a **one-time onboarding ritual**, gated to fire once between Partnership and Growth, not a repeatable "start a meeting" capability. There's no `Meeting` table anywhere in the schema.
- Its transcript is never persisted — kept only as local component state (`useState`) and discarded the moment the page unmounts.
- Its structure is thinner than what you're describing: one AI-generated reflection paragraph, a single-question Q&A loop, and exactly one recommendation. No notes list, no decisions list, no action items.
- What it *does* have that's real and reusable: its Approve/Decline buttons delegate to the exact same `performApproveGenesisAction`/`performRejectGenesisAction` the dashboard already uses — proof that "a meeting's recommendation becomes a real approved change" already works as a pattern, just not as a persisted, repeatable one.

**What this means**: this proposal is mostly a real, new build — a repeatable `Meeting` concept with real persistence — not an extension of the onboarding ritual, which stays exactly as it is (a separate, one-time thing).

---

## 1. The three messages, as one principle

> Chat helps you get work done. Meetings help you build the business.

1. **Default chat tone**: concise, direct, action-oriented. Most interactions optimize for execution.
2. **Meetings are suggested, never forced**: when a conversation turns strategic, J4 offers — never redirects — a choice between **Start Meeting** and **Continue in Chat**.
3. **A meeting is a structured business record**: notes, decisions, action items, assets, a summary, and a permanent place to revisit it — not just a longer conversation.

---

## 2. Data model

### 2.1 A real `Meeting`

```prisma
model Meeting {
  id          String    @id @default(cuid())
  storeId     String
  title       String    // "Brand Strategy Meeting" — see 3.3 for how this gets named
  purpose     String?   // one-line "what this meeting is for," shown in the library
  status      String    @default("ACTIVE") // ACTIVE | COMPLETED
  startedFrom String?   // StoreMessage.id this meeting was suggested from, when applicable — provenance, not identity

  summary     String?   // real synthesized summary, written once the meeting is marked COMPLETED (see 3.4)
  startedAt   DateTime  @default(now())
  completedAt DateTime?

  store    Store          @relation(fields: [storeId], references: [id], onDelete: Cascade)
  messages StoreMessage[]
  tasks    Task[]         // real action items / follow-ups (see 2.3)

  @@index([storeId, status])
}
```

### 2.2 Messages belong to a meeting the same way they belong to a task

`StoreMessage.meetingId String?` — additive, same pattern as `taskId` (M2). A meeting doesn't need its own separate message table; it needs its own **scope** over the same real timeline. This also means a meeting's messages stay visible in the store's one overall history (nothing is hidden or duplicated) while also being independently queryable as "everything said in this meeting."

### 2.3 Decisions and action items reuse the Task model — not a new concept

You listed "captures action items," "creates follow-up tasks where appropriate," and "tracks key decisions" as things a meeting does automatically. All three map directly onto infrastructure that already exists and was built specifically to be a *general* foundation:

- **Action items / follow-up tasks** → real `Task` rows (`source: "meeting"`, `sourceId: meeting.id`) — the exact same model M1-M3 already built for dashboard cards, now with a second real source. A meeting's action items show up as real, clickable Task cards on the dashboard *and* are visible inside the meeting itself.
- **Decisions made** → real `ApprovalRequest` rows already tied to the meeting's own messages (via `groupId`/the action-proposal pipeline `proposeAction` already uses) — a "decision" in this system has always meant a real, executed-or-approved change; no new concept needed, just surfacing what already exists, scoped to the meeting.

**No new decision/action-item data model.** This is the single biggest scope-reducer in this proposal — reusing what M1-M3 already built rather than inventing parallel bookkeeping.

### 2.4 Notes and summary are genuinely new

Nothing today summarizes a real message history into structured notes. The closest precedent (`generateMeetingReflection`, the onboarding ritual) synthesizes from *stored business facts*, not from a transcript — different input, same reusable technique (a `callGenesisModel` call with a real Zod-schema'd output). New work: a real "meeting notes" generator that takes the meeting's own `StoreMessage` history and produces structured notes (key points, decisions already captured via 2.3, open questions) — run once when a meeting is marked `COMPLETED`, not on every turn.

---

## 3. The suggestion mechanism

### 3.1 A real two-stage classifier — intent, not length

Resolved: the trigger is the *type* of conversation, never message length or turn count. Two stages, so the cost of real classification is only ever paid when it might matter:

- **Stage 1 — a cheap, deterministic pre-filter, zero AI cost.** A real keyword/topic heuristic over the current message (brand, strategy, pricing, campaign, hiring, financial planning, launch, and their real neighbors) — not a decision, just a cheap gate deciding whether Stage 2 is even worth running. Modeled on the same "cheapest-possible first pass" discipline as the existing upload-intent classifier.
- **Stage 2 — a real but cheap model call, only when Stage 1 flags possible relevance.** Same family as the upload-intent classifier and `classify.ts`'s asset classifier: a small, fast, structured-output call whose only job is *is this conversation genuinely becoming strategic/exploratory, or does it just brush a keyword while staying operational* ("update my homepage" mentions nothing strategic; "help me think through my brand positioning" does, even with zero keyword overlap with Stage 1's list — Stage 2 exists specifically to catch what a keyword filter alone would miss, and to reject what it would over-fire on).

Real examples this must say yes to: strategic planning, brainstorming, brand discussions, marketing planning, product design, financial planning, long-term business decisions, performance review, multi-step collaboration. Must say no to: "change this photo," "update my homepage," "add this product," "what's today's revenue" — ordinary operational work, however the message happens to be phrased.

### 3.2 The offer itself — a recommendation, never an interruption

When Stage 2 confirms it, J4's reply includes the real offer, in your own words: *"This feels like something that would benefit from a meeting. I can organize our discussion, take notes, track decisions, and give you a summary afterward. Would you like to start one, or keep chatting here?"* The UI renders two real buttons — **Start Meeting** / **Continue Chat** — the same "server action directly from a button, no nested form" pattern already used for `ConfirmCeilingOverride` and the Task cards. **Continue Chat** does nothing structural — just dismisses the offer; the conversation carries on exactly as before, in the same timeline, and nothing about it is altered or diminished by having been offered a meeting. A meeting is a recommendation, not an interruption — declining it is always a complete, ordinary outcome, not a fallback.

### 3.3 Starting a meeting — a real brief, never copied history

Resolved, and this replaces the retroactive-scoping idea entirely: **the original chat is never touched, and no prior messages are copied or retroactively tagged into the meeting.** Instead, `Start Meeting` triggers a real, synthesized **meeting brief** — a genuine `callGenesisModel` call (same structured-output technique `generateMeetingReflection` already uses, grounded here in the actual recent conversation rather than stored business facts) producing:

- **Reason for meeting** — why this is becoming its own session, in one real sentence.
- **Discussion so far** — what's actually been covered, synthesized, not quoted.
- **Outstanding questions** — what's still genuinely open.
- **Goal for this meeting** — what a real, completed session here would produce.

This brief becomes the meeting's own first message (`role: "assistant"`, `meetingId` set) — the meeting's real starting point, not a summary bolted onto old content. "People don't begin a meeting by reading the last ten Slack messages verbatim" — J4's role is the person who says "here's where we are" before the meeting actually starts.

### 3.4 Naming a meeting

Sean's examples ("Brand Strategy Meeting," "Q4 Planning") are real, specific titles — not generic. The same call that produces the brief (3.3) can produce a proposed title in the same pass — shown to the owner as an editable suggestion, never silently assigned.

### 3.5 Ending a meeting

Real, explicit action (a button, "End Meeting") rather than an inferred timeout — sets `status: "COMPLETED"`, `completedAt`, and triggers the real notes/summary generation (2.4). Until then, a meeting stays `ACTIVE` and can be returned to.

---

## 4. Background work across meetings — a real, named dependency on unfinished infrastructure

Your own example ("Design a new logo... J4 starts working immediately, the owner can continue using Genesis, and when it's ready, the meeting updates automatically") needs two things:

1. **Deferred execution** — real, already-established pattern (`after()`, used elsewhere in this codebase) for kicking off work without blocking the turn.
2. **A way to deliver the result into a meeting the owner isn't currently looking at, without a manual refresh.**

**(2) does not exist yet.** This is the exact same gap named in `BUSINESS_ASSETS_ARCHITECTURE.md`'s §8 (no polling/SSE/WebSocket anywhere in this codebase today) — flagged there as required infrastructure for background upload analysis to feel "instant." This proposal has the identical dependency. **Recommendation: build the live-delivery mechanism once, as shared infrastructure, not twice** — whichever initiative reaches implementation first should build it in a way the other can reuse, rather than two independent, competing solutions.

Genesis's own product-wide principles (`GENESIS_EXPERIENCE_PRINCIPLES.md`, principle 7) name Meetings explicitly as "the next likely case" for this exact pattern — immediate acknowledgment, visible in-progress work, a real completion signal. This isn't a nice-to-have for Meetings specifically; it's the same standing bar every other real-time-feeling feature in the product is now held to.

---

## 5. The Meetings library

Per your own framing ("a business builds a library of meetings... instead of searching chat history, open the meeting where the decision happened"), this needs a real browse surface — list of `Meeting` rows (title, purpose, status, date), most recent first, click through to the full scoped conversation + its real notes/decisions/action-items. Natural home: alongside or inside the same area Business Assets' own library was scoped to live in (Understanding, or a new peer section) — a real placement decision, not assumed here.

---

## 6. What this proposal does *not* solve, named rather than skipped

- **The classifier's real accuracy** (when exactly something "becomes strategic") can only be tuned against real usage — this proposal builds the mechanism, not a perfectly-tuned trigger from day one.
- **Multi-meeting-at-once / resuming an old ACTIVE meeting from a different entry point** — v1 assumes a meeting is started and ended in one continuous span; picking an old still-ACTIVE meeting back up later (rather than always starting fresh) is a real UX question not resolved here.
- **The live-delivery mechanism itself** (§4) — named as a shared dependency, not designed in this document.

---

## 7. Resolved since v1

1. **Retroactive scoping** — resolved: never copy or retag prior messages. A real, synthesized meeting brief (§3.3) is the meeting's own starting point instead.
2. **Where the classifier runs** — resolved: a two-stage gate (§3.1), a free deterministic pre-filter before any real model call, triggered by conversation *type*, never length or turn count.

## 8. Still open before implementation

1. **Meetings library placement** — new nav destination, or folded into an existing section (mirroring the same "foundational service vs. destination" question already resolved for Business Assets)?
2. **Stage 1's exact keyword/topic list** — real, but not yet enumerated here; needs a first real pass before implementation, and will need tuning against real usage regardless.
