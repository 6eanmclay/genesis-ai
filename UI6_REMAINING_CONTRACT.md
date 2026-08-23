# UI6 — the three parked pieces

**Status: CONTRACT / DESIGN PASS. Nothing implemented.** 2026-08-23.
Sean: contract first, review before implementation.

UI6's shipped half made the conversation the business boundary and made messages
show their real execution state. These are the three §7 pieces left. They are not
equally ready, and saying so is most of the value here: **one is contractible
today, one needs a single product decision, and one is undesigned by §7's own
admission and cannot be honestly specified without inventing behaviour.**

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

**J4 may:** shorten its own prose. **J4 must never:** write the checklist. It is
server-built precisely because the model's account of what it did can be wrong,
and that is the property this piece must not weaken.

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

*Contractible after one product decision, which I will not make.*

**User problem.** There is one flat stream per business, read as the newest 50
messages. An owner cannot return to what was discussed last week, and J4's own
north star — "the conversation becomes the working memory of the business" —
has nothing to return *to*.

**The decision required.** **What is a conversation?** `StoreMessage` has
`storeId`, `role`, `content`, `changes`, `taskId`, `executionLogId` — and no
grouping. Candidates, each giving a different product:

- **(a) A time window.** A day, or a gap of N hours. Needs no owner action and no
  new writes; boundaries are arbitrary and can split one exchange.
- **(b) A topic.** J4 groups by subject. Needs a model, and a wrong grouping is a
  wrong history.
- **(c) An explicit thread.** The owner starts one. Honest and never wrong; asks
  the owner to do filing.
- **(d) Anchored on work.** A conversation is the messages around a proposal or
  task — `taskId` already exists on `StoreMessage` and already does this for
  task-opened turns.

**(d) is the only one with existing structure behind it**, and `taskId` is
evidence the idea already half-exists. I am not choosing it: the four produce
genuinely different products and that is Sean's call.

Everything below is conditional on that answer.

**Exact behaviour, once decided.** Past conversations are listable, openable, and
resumable — a reply continues that conversation rather than starting a new one.

**State transitions.** A conversation is open or past; resuming makes it current.
Whether it can be closed explicitly depends on the decision above.

**Permissions.** Unchanged — history is read through the conversation's existing
gate, and the business boundary is `J4Surface`'s already-shipped slug resolution.
**Must not** introduce a second read path that skips it.

**Failure and recovery.** A conversation whose grouping key no longer resolves
(a deleted task under (d)) must render as an ordinary past conversation, never
vanish. **Never silently retract history** — the rule proactive delivery already
follows.

**Persistence.** A grouping key on `StoreMessage`, nullable, backfilled or not
depending on the decision. Under (d) it may need nothing new at all.

**Verification.** Messages group as the rule says; resuming appends to the right
group; a business sees only its own; a broken grouping key degrades rather than
disappears.

**Existing architecture.** `StoreMessage.taskId`, `J4Surface`'s
`CHAT_HISTORY_WINDOW = 50`, `lastAssistantContent`, `buildTurnContext`.

**Acceptance criteria.** Deferred until the decision — writing them now would be
inventing the answer.

**Out of scope.** §7's north star of linking a conversation to the real changes
it produced. `executionLogId` (UI6) makes that newly possible, and it is a
separate milestone.

---

# Piece 1 — Business context beside the conversation

**This cannot be contracted, and §7 says so itself:** *"Undesigned here: whether
this is context J4 proactively surfaces per the topic … or something the owner
opens deliberately — a real decision for whenever this phase actually starts."*

Writing behaviour, transitions and acceptance criteria for it would be inventing
the product, which is what I was told not to do. What can be established:

**User problem (real, and from §7).** What is on screen — a homepage draft, a
chart, a product — should be able to sit next to the conversation rather than
requiring the owner to leave it.

**The decisions required, and they are prior to any contract:**
1. **Who opens it** — J4 surfaces it by topic, or the owner opens it deliberately.
   §7 names this as the open question.
2. **What can appear there** — a closed set of surfaces, or anything the owner is
   looking at. A closed set is a registry with a mirrored-registry invariant; an
   open one is a rendering contract for arbitrary content.
3. **Whether it can be acted on** — a live pane, or a view. If a homepage draft
   beside the conversation is editable, this is a second surface with write
   access and inherits every approval and authorization question UI6 just settled
   for the proposal card.

**What is already true and would constrain it:** the proposal card
(`J4Proposal`) already renders business content inside the conversation and is
business-scoped since UI6 — so the "show a thing beside the conversation"
mechanic exists in one specific form and would be the honest starting point
rather than a new one.

**Recommendation:** answer decision 1 first. It determines whether this is a
J4 capability or a workspace layout, and those are different milestones.

---

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
| 3 — concise summary | **Contractible now** | Credit, for the prompt half only |
| 2 — navigable history | Contract pending **one decision**: what a conversation is | Sean |
| 1 — context beside the conversation | **Not contractible.** Undesigned by §7 | Three decisions, one prior to the rest |
