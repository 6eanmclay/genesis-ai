# UI6 — the three parked pieces

**Status: BUILT. Pieces 1 and 2 complete; piece 3 implemented and pending live
acceptance.** 2026-08-23.

| Piece | State |
|---|---|
| 1 — Context pane | **Complete** (`244921b`) |
| 2 — Conversations | **Complete** (`9c648cb`, `19c47b2`) |
| 3 — Concise-summary replies | **Implemented, NOT accepted** (`f79f11d`) — acceptance criterion 4, the live prose measurement, is unmet |
| **UI6 overall** | **Pending only external live validation** |

**The remaining acceptance work is narrow and fixed:** run the live prose
measurement; accept if it passes; if it fails, fix only the demonstrated prose
defect and rerun. Nothing else joins that run.

---

*Contract follows.*
Sean: contract first, review before implementation.

**ALL DECISIONS TAKEN 2026-08-23.** Piece 2's definition and lifecycle; piece 1's
trigger, registry and read-only boundary. Nothing in this contract is now waiting
on a product answer.

*(The pane's registry and read-only decisions arrived labelled "Piece 2" and are
filed here under Piece 1, which is the pane. Recorded so the trail is followable.)*

**Implementation authorised for Piece 3 only.** Pieces 2 and 1 stay contracted
and unbuilt.

UI6's shipped half made the conversation the business boundary and made messages
show their real execution state. These are the three §7 pieces left.

**All three are now contracted.** Pieces 2 and 3 are complete. Piece 1's trigger
is decided and the rest of it is specified around that, with two remaining
decisions named in place — they are prior to implementation, not discovered
during it.

---

## A correction to §7 that changes piece 3

§7 says the concise-summary work "is *not* new infrastructure: `GenesisAssistant.tsx`
already renders a `<details>`/`<summary>` 'See what changed' list from a real
`changes: string[]` field **the model already returns**."

**The model does not return it.** `changes` is built server-side in
`app/dashboard/ai-actions.ts` and its own comment says why: it exists to *correct*
the model's reply, because "the model's own inline reply text is generated before
the real server-side outcome is known, so for an auto-execute-tiered action it can
say 'Done' even when execute() actually failed." It is explicitly "deterministic,
code-built — not model-generated."

That makes piece 3 **better** than §7 assumed. The checklist is already the
trustworthy half; only the prose is model-dependent.

---

# Piece 3 — Concise-summary replies

*Taken first because it is the only one that can be contracted in full.*

**User problem.** A reply leads with several paragraphs of model prose, and the
list of what actually changed is a collapsed `<details>` underneath it. The
trustworthy part is subordinate to the part that can be wrong.

**Exact behaviour.** The grouped checklist becomes the primary structure of a
reply that has one. Prose shortens to a single lead sentence. Where they
disagree, the checklist is authoritative — it already is, by construction.

**State transitions.** None. This is rendering plus a prompt instruction; no new
state, no new lifecycle.

**Inputs / outputs.** In: `StoreMessage.content` and `StoreMessage.changes`
(a `string[]`, parsed by `extractChangeList`). Out: rendered markup. Unchanged
shapes.

**Permissions / ownership.** None beyond the conversation's existing
`GENESIS_CHAT` gate. No new read path.

**Failure and recovery.** A message with no `changes` renders exactly as today —
most messages have none. A message with `changes` and empty `content` renders the
checklist alone, which is complete rather than broken.

**J4 may:** generate and shorten the conversational prose. **J4 must never
generate or alter the "See what changed" checklist.** It is deterministic,
server-built and authoritative, precisely because the model's account of what it
did can be wrong — its own comment records it saying "Done" when `execute()` had
failed. Where prose and checklist disagree, the checklist is right. This is the
property the piece exists to strengthen, and weakening it would undo the reason
the field was built.

**Persistence.** None. Both fields exist.

**Verification.** Deterministic: a message with `changes` renders the list
primary and the prose as a lead sentence; a message without renders unchanged;
an empty-content-with-changes message renders the list. **Not deterministic:**
whether the model's lead sentence is actually one sentence. That needs a live run
and is the credential-blocked half.

**Existing architecture.** `app/j4/messageChanges.ts` (`extractChangeList`),
`J4Workspace.tsx`'s render loop, `STORE_CHAT_PRIMARY_SYSTEM_PROMPT`.

**Acceptance criteria.**
1. A reply with changes leads with the checklist.
2. A reply without changes is byte-identical to today.
3. The checklist remains server-built; no prompt asks the model to produce it.
4. The prompt change is measured live before it is called done.

**Out of scope.** The legacy content pipeline itself; the `changes` shape; any
other message artefact (images, voice memos, quick replies).

**Blocked on:** Anthropic credit for the prompt half. The render half is
buildable now, and **should not ship alone** — a primary checklist under
paragraphs of prose is worse than today.

---

# Piece 2 — Navigable conversation history

**DECIDED: a conversation is an explicit, persistent thread.** It may optionally
be anchored to work or another business entity — including the existing `taskId`
— but **a task is not the definition of a conversation**. J4 has to support
conversations about products, customers, documents, decisions, questions and
problems, and anchoring on tasks would have turned every one of those into a task
to exist.

**User problem.** One flat stream per business, read as the newest 50 messages.
An owner cannot return to what was discussed last week, and J4's north star —
"the conversation becomes the working memory of the business" — has nothing to
return *to*.

## The rule that governs resumption

> **Conversation history is a record of what was said, not a frozen snapshot of
> what was known.**

When a conversation resumes, `buildTurnContext` rebuilds current business
understanding for that turn. Historical messages stay historical; current
business state stays current. J4 answering inside an old conversation answers
with what it knows **now**, and never re-derives what it believed then.

This is not new machinery — `buildTurnContext` already assembles understanding
per turn — but it is now a stated invariant rather than an accident, and it is
verifiable.

**Exact behaviour.**
- A conversation is a durable row with an identity, belonging to exactly one
  business.
- Messages belong to at most one conversation.
- Past conversations are listable, openable and resumable; replying appends to
  that conversation.
- An anchor is optional metadata (`taskId` today, other entity kinds later). It
  is context, never identity: removing an anchor must not remove the conversation.

**State transitions.** `current → past → current` on resumption. Nothing is
destroyed by any transition, and a conversation with no messages is not a state
the product creates.

**Inputs / outputs.** In: a conversation id, plus the existing turn inputs. Out:
that conversation's messages, and a turn appended to it. `buildTurnContext` is
unchanged and receives no historical understanding.

**Permissions / ownership.** A conversation belongs to a business and is read
through the conversation's existing `GENESIS_CHAT` gate and `J4Surface`'s slug
resolution. **Must not** introduce a second read path that skips either. A
member's access is the business's access; conversations are not per-person.

**Failure and recovery.**
- An anchor that no longer resolves (a deleted task) renders as an ordinary
  unanchored conversation. **Never vanishes** — the rule proactive delivery
  already follows.
- A message whose conversation id is null is history from before this existed and
  renders as the ongoing default. It is **not backfilled into invented threads**:
  the grouping did not exist when those rows were written, and manufacturing one
  is manufacturing history — the same call made for `executionLogId`.

**J4 may:** answer inside a resumed conversation using current understanding;
read the anchor as context. **J4 must never:** create, merge, rename or delete a
conversation on its own; answer with a reconstructed past understanding; or move
a message between conversations.

**Persistence.** A `Conversation` row (business-scoped, optional anchor) and a
nullable `conversationId` on `StoreMessage`. Nullable and un-backfilled, for the
reason above.

**Verification.**
- Messages group as the rule says; a reply appends to the conversation it was
  sent to.
- One business's conversations are never another's — asserted against a second
  business, structurally where possible.
- A resumed conversation answers with **current** understanding: assert that a
  fact learned *after* the conversation's last message is available to a turn
  resumed in it. This is the stated rule made mechanical.
- An unresolvable anchor degrades to unanchored rather than disappearing.
- Null-conversation history still renders.
- Negative controls: backfilling invented threads; an anchor removal deleting a
  conversation; a resumed turn receiving a snapshot.

**Acceptance criteria.**
1. A conversation exists as a durable, business-scoped row with an optional anchor.
2. Replying to a past conversation appends to it, and that turn's context is
   built fresh.
3. A fact learned after a conversation's last message reaches a turn resumed in it.
4. No message moves between conversations, ever.
5. Pre-existing messages render unchanged and are not assigned a manufactured
   conversation.
6. Cross-business isolation asserted.
7. **A conversation is created only by an explicit owner action** — no code path
   creates one as a side effect of sending a message.
8. **A name is optional and owner-supplied**; no path generates one, and nothing
   in this milestone reads a model.
9. Closing, archiving and deletion are absent rather than stubbed.

**DECIDED — lifecycle, kept deliberately small for v1.**

- **Explicitly created by the owner.** A conversation begins because somebody
  started one, matching the definition's own word. A message sent with none
  selected does not silently create one.
- **Optionally named by the owner.** A name is a plain string the owner may set
  or leave empty.
- **No J4-generated naming.** Stated as a decision rather than an omission: a
  J4-titled thread would make this milestone depend on a model credential, and
  nothing else in it does.
- **Closing and archiving are out of scope for v1.** "Persistent" argues against
  deletion, and nothing here needs an answer to ship.

**Nothing beyond this is invented because the schema could support it.** A row
that can hold a `closedAt` is not a reason to build closing.

**Out of scope.** §7's north star**Out of scope.** §7's north star of linking a conversation to the real changes
it produced — `executionLogId` (UI6) makes that newly possible and it is a
separate milestone. Cross-conversation search. Per-person conversations.

# Piece 1 — Business context beside the conversation

**DECIDED: owner-initiated. The pane is opened deliberately and never opens
itself.** This keeps the first version a workspace/context capability rather than
silently becoming a new proactive J4 behaviour. Proactive surfacing can be its
own capability later, driven by the BI engine — *"show me my context"* and *"J4
decided to interrupt me"* are different products and must not be conflated in one
milestone.

That answers §7's open question, which was exactly this one.

**User problem (from §7).** What is on screen — a homepage draft, a chart, a
product — should be able to sit next to the conversation rather than requiring
the owner to leave it.

**Exact behaviour.** A control in the conversation opens a pane beside it. The
owner closes it and returns. Its content is the business context for what they
are looking at.

**State transitions.** `closed → open → closed`, driven only by the owner.
**There is no transition J4 can cause.** Whether "open" survives navigation is a
UX detail, not a product decision.

**Permissions / ownership.** Reads the same business the conversation belongs to,
through the same gate. **Must not** introduce a read path that skips
`J4Surface`'s slug resolution — the defect class UI6's shipped half removed.

**Failure and recovery.** Nothing to show renders as an honest empty state, never
a spinner or filler. The pane failing must never take the conversation with it.

**J4 may:** have its answers reflect what the owner has open, if the turn context
already carries it — `buildTurnContext` has a workspace line today. **J4 must
never:** open the pane, close it, or change what it shows. That is the decision
above, stated as an invariant so it is testable.

**Persistence.** None required. Whether the open/closed state is remembered per
owner is a later question, and browser-local storage would answer it without a
schema change.

**Verification.** The pane opens and closes only from an owner action — asserted
by there being no server or J4 path that sets it. A business's pane shows that
business's context. An empty context renders an empty state. Negative control:
any code path through which J4 could open it.

**Acceptance criteria.**
1. The pane opens only from a deliberate owner action.
2. No J4 or server path can open, close or change it — asserted, not assumed.
3. Its content is scoped to the conversation's business.
4. Nothing to show is an honest empty state.
5. A failure in the pane leaves the conversation working.
6. **Only registered context types can appear.** An unregistered type renders
   nothing rather than falling back to something generic.
7. **The registry is cross-checked at runtime** — every entry resolves to
   something real, in the pattern ARCHITECTURE.md requires of every mirror.
8. **The pane contains no write path.** Asserted at the source: no server
   action, no mutation, no approval creation reachable from it.
9. A change offered while the pane is open still goes through the proposal card
   and the existing approval path.

**DECIDED: a closed registry, and read-only.**

**What may appear there — a closed registry.** The pane exposes only explicitly
registered business-context types. *"Whatever the owner happens to be looking
at"* is not the contract: that would make UI6 an uncontrolled context surface
whose boundaries nobody could reason about.

It carries the **mirrored-registry invariant** this codebase already applies
sixteen times: if something is eligible for the pane, it is explicitly
represented in the registry, and a runtime cross-check asserts every registered
entry resolves to something real. `lib/j4/workspaceContext.ts` is the closest
existing precedent and is already guarded that way.

**Whether it can be acted on — read-only for v1.**

> **Context pane = understand. Action surface = change.**

The pane helps the owner see what J4 knows and what is relevant. It does not
become a second write surface. Anything that changes business state continues
through proposal → authorization → execution → verification, unchanged.

This is what keeps UI6 from quietly bypassing the guarantees the last several
milestones established. A second surface with write access would inherit every
one of those questions and would answer them again, separately — which is how
two paths to the same change start disagreeing.

**What already constrains it.** `J4Proposal` already renders business content
inside the conversation and has been business-scoped since UI6. The "show a thing
beside the conversation" mechanic exists in one specific form; this should extend
that rather than introduce a second.

**Out of scope.** Proactive surfacing of any kind. Editing, and any write path.
Anything the BI engine would push. An open-ended "show me this page" contract.

## Dependencies

**Between the pieces.** Piece 2 depends on nothing here. Piece 3 depends on
nothing here. **Piece 1 would depend on piece 2** if context is ever scoped to a
conversation rather than to "now" — another reason to settle piece 2 first.

**On U1–U6 (shipped).** Piece 1's pane would read `getBusinessUnderstanding`;
provenance (U1) governs how anything shown there is attributed. Piece 2's
resumed conversation feeds `buildTurnContext`, which already assembles
understanding per turn — so a resumed conversation gets current understanding,
not a snapshot. **That is a property worth stating: history is a record of what
was said, never a frozen view of what was known.**

**On M1–M9 (closed).** None of the three depends on the BI Engine. Piece 1 could
*display* findings, which is a reason to settle proactive J4's surface first, not
a dependency.

**On UI6's shipped half.** All three inherit the conversation's business
boundary and the message-state vocabulary. Piece 3 must not weaken the
server-built `changes`; piece 2 must not introduce a read path that skips
`J4Surface`'s slug resolution.

## Summary

| Piece | State | Blocked by |
|---|---|---|
| 3 — concise summary | **Contracted** | Credit, for the prompt half only |
| 2 — navigable history | **Contracted.** Three lifecycle questions surfaced | Nothing to start; the questions can be answered as it is built |
| 1 — context beside the conversation | **Contracted for the trigger.** Two decisions remain | Both are prior to implementation |

**Implementation order, if approved:** 3 (smallest, and its render half is
independent), then 2, then 1 — which is also dependency order, since a context
pane scoped to a conversation would need conversations to exist.
