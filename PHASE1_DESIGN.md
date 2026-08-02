# Phase 1 design: completing the Business Event Pipeline

**Status:** Frozen — approved by Sean 2026-08-01 (see *Decisions made* below). Implementation begins once Track 0 (Operational Foundations) is complete.
**Scope:** Wire commerce (starting with order/payment creation) into the existing `BusinessEvent` infrastructure. This is deliberately *not* a new architecture — see `ARCHITECTURE.md`'s Database model section and the audit that preceded this doc. Everything below either reuses an existing component as-is, or extends one additively.

## 1. Existing components we reuse, unchanged

- **`BusinessEvent` model** (`prisma/schema.prisma`) — the event table itself. No changes to its existing columns.
- **The `transaction` canonical entity type** (`lib/businessModel/entities.ts`) — `amountInCents`, `currency`, `type` (`"sale" | "refund" | "payment" | "expense"`), `contactId`, `itemIds`, `status`. This is the vocabulary commerce events will use in their `data` payload — already defined, already proven against real `Order` rows.
- **`mapOrdersToTransactions()` / `internalTransactionId()` / `internalContactId()` / `internalItemId()`** (`lib/businessModel/internalMapper.ts`) — the exact shape-mapping and stable-ID functions the new event-write code will call, so an event's `data` and a snapshot read of the same order via `queryRecords()` describe the order identically.
- **`queryRecords()` / the Insight Engine's snapshot-based functions** (`lib/businessModel/reasoning.ts`, most of `lib/intelligence/insights.ts`) — completely unaffected. This design only touches the *event* side; the *snapshot* side (which already blends internal + connector data live) needs no changes.
- **The existing dot-notation `eventType` convention** (`"invoice.paid"`, `"appointment.cancelled"`, etc.) — commerce events extend it (`"transaction.created"`, `"transaction.refunded"`), not replace it.
- **The Stripe webhook handler and PayPal capture handler** (`app/api/webhooks/stripe/route.ts`, `app/api/checkout/paypal/return/route.ts`) — their existing idempotent `Order` upsert logic is the trigger point; the design changes *what happens around* that write, not the payment-verification logic itself.

## 2. New components

- **A `sequence` column on `BusinessEvent`** — see Database changes below. Needed for correct multi-consumer cursoring; `occurredAt` alone isn't safe (two events created in the same `createMany` batch, or the same millisecond, would be ambiguous for a consumer trying to resume exactly where it left off).
- **A `BusinessEventCursor` model** — one row per `(storeId, consumerName)`, tracking that consumer's own progress through the event log. Replaces the single shared `processedAt` flag.
- **A shared event-write helper**, living in a new file — `lib/intelligence/businessEvents.ts` — rather than being added to `changeDetection.ts`. Reasoning: `changeDetection.ts`'s whole job is *diffing synced snapshots*, which is a mechanism commerce events don't use (see the audit — internal data is computed live, never diffed). Putting the shared primitive in a neutrally-named file means both the connector/sync path and the new commerce write paths import from something that describes what it does (records a `BusinessEvent`), not how one particular caller produces its input. `changeDetection.ts`'s `recordBusinessEvents()` becomes a thin wrapper around the new shared primitive, so its existing behavior for connector events doesn't change.
- **A generic consumer-cursor read/advance helper** (also in `lib/intelligence/businessEvents.ts`) — `getNewEventsForConsumer(storeId, consumerName)` and `advanceConsumerCursor(storeId, consumerName, upToSequence)`, so the Insight Engine, a future interpreter feature, and a future J4 trigger all share one correct implementation instead of each hand-rolling cursor math.

## 3. Database changes

Additive only — no destructive changes, no existing data touched beyond a backfilled default.

```prisma
model BusinessEvent {
  // ...existing fields unchanged...
  sequence    BigInt    @default(autoincrement())
  // processedAt stays for now — see Migration section, item 2

  @@index([storeId, sequence])
}

model BusinessEventCursor {
  id                    String   @id @default(cuid())
  storeId               String
  consumerName          String
  lastProcessedSequence BigInt   @default(0)
  updatedAt             DateTime @updatedAt

  store Store @relation(fields: [storeId], references: [id], onDelete: Cascade)

  @@unique([storeId, consumerName])
}
```

Postgres backfills `sequence` for every existing row automatically on migration (standard behavior for adding a serial/bigserial column) — no data migration script needed.

This is the first real schema migration since the Track 0 migration gate went in — a good first exercise of that new process (write it, read the generated SQL, run `migrate:deploy` deliberately, then deploy the dependent code).

## 4. Transaction boundaries

**Verified directly against this project's real setup before writing this** (not assumed): Prisma's interactive `$transaction(async (tx) => {...})` commits and rolls back correctly under the Prisma 7 + `@prisma/adapter-pg` driver-adapter pattern this project uses — tested a real commit and a real deliberate rollback against the local database. No open question here.

The Stripe handler's current write is `prisma.order.upsert({ ..., update: {} })` — idempotent, but `update: {}` means a retry is indistinguishable from a fresh order by the return value alone. Rather than infer "was this new" from `upsert`'s result, the new pattern checks first, inside the same transaction:

```
await prisma.$transaction(async (tx) => {
  const existing = await tx.order.findUnique({ where: { paymentProvider_externalOrderId: {...} } });
  if (existing) return; // genuine Stripe retry — no-op, exactly like today

  const order = await tx.order.create({ data: {...} });
  await tx.businessEvent.create({ data: { entityType: "transaction", eventType: "transaction.created", ... } });
});
```

Both writes commit together or neither does. The PayPal capture handler gets the identical treatment. **This same pattern — event write inside the same transaction as the state change, guarded by an existence check — is the convention for every future Phase 1 write path** (inventory decrement, order status progression, refund handling), not just today's order-creation case.

## 5. Event flow: payment → `BusinessEvent`

1. Stripe sends `checkout.session.completed`; signature verified (unchanged).
2. `storeId`/`productId` resolved (unchanged).
3. Inside one `$transaction`: check for an existing `Order` on `(paymentProvider, externalOrderId)`. If found, stop — this is a retry.
4. If not found: create the `Order`, then create a `BusinessEvent` row — `entityType: "transaction"`, `eventType: "transaction.created"`, `sourceProvider: "internal"`, `recordId: internalTransactionId(order.id)`, `data` shaped exactly like `mapOrdersToTransactions()`'s output (`amountInCents`, `type: "sale"`, `contactId: internalContactId(order.buyerEmail)`, `itemIds`, `status`).
5. Transaction commits — both rows exist, or neither does.
6. The existing `after()` hook (`runDeterministicObservationSweep`/`measureDueMeasurements`) is unrelated, pre-existing Phase 4/5 machinery in the same file — untouched, no interaction with this design.
7. PayPal's capture handler follows the same shape at step 3-5, adapted to its own idempotency markers.

Refunds follow the identical pattern once refund handling exists: `eventType: "transaction.refunded"`, same transaction-wrapped write. Not building refund handling in this pass — noting the pattern extends to it cleanly when it's built.

## 6. Consumer flow — Insights, J4, future systems

Each named consumer owns exactly one `BusinessEventCursor` row per store:

1. `cursor = upsert BusinessEventCursor where (storeId, consumerName) — create with lastProcessedSequence: 0 if absent`.
2. `events = BusinessEvent.findMany({ where: { storeId, sequence: { gt: cursor.lastProcessedSequence } }, orderBy: { sequence: "asc" } })`.
3. Consumer processes `events` however it needs to.
4. `advanceConsumerCursor(storeId, consumerName, events[events.length - 1].sequence)` — only after successful processing, so a crash mid-processing doesn't skip events on the next run.

The Insight Engine gets a `consumerName: "insight-engine"` cursor — during the transition period (see Migration section, item 2) it runs *alongside*, not instead of, the existing `updateMany({ processedAt: null → now })`, so real behavior doesn't change until the new path is proven. A future "Genesis as interpreter" feature would be `consumerName: "genesis-interpreter"`, walking the identical log independently from day one — including able to start its cursor at `0` and replay all history, without touching or being blocked by the Insight Engine's own progress. A future J4 write-action trigger gets the same treatment as a third named consumer. None of them can starve or race each other.

## 7. Migration and backward-compatibility concerns

1. **Schema migration itself** — additive, low risk, goes through the new deliberate migration-gate process (Track 0).
2. **`processedAt`'s transition — decided: parallel run, not a direct cutover.** Sean's call: prove the new consumer model against real production data before retiring the old mechanism. Concrete shape, since "run in parallel" needs a precise mechanism, not just a policy:
   - `computeInsights()` (`lib/intelligence/insights.ts`) keeps its existing `processedAt`-based query and `updateMany` as the *real, live* mechanism — zero behavior change during the transition.
   - In the same pass, it also advances an `"insight-engine"` cursor via the new helper — reading `sequence > cursor.lastProcessedSequence`, then calling `advanceConsumerCursor`. This does not feed real logic yet; it exists purely to exercise the cursor path against real data and accumulate real progress.
   - Each pass, compare the two event sets (the `processedAt: null` set vs. the cursor's `sequence`-based set) for exact equality; a mismatch means something about the cursor mechanism is wrong and needs fixing before cutover, not a state to paper over — report it through `Sentry.captureMessage()` (Track 0's error monitoring, once the account-link step is complete) rather than a console log nobody's watching, so a real discrepancy surfaces instead of sitting silently in logs.
   - **Cutover criteria**: once the two sets have matched with zero discrepancies for a period Sean is comfortable with, switch `computeInsights()`'s real query to the cursor-based read, stop writing `processedAt`, and drop the column in a follow-up migration. This gives an objective, evidence-based "safe to retire" signal instead of a guess.
   - **Invariant (holds until cutover): the `processedAt` path must remain completely independent of the cursor system.** The comparison is strictly one-directional — the cursor system observes and compares against `processedAt`'s results, but `processedAt`'s own query and `updateMany` logic must never read from, branch on, or otherwise depend on `BusinessEventCursor` or `sequence` for correctness. Concretely: `computeInsights()`'s real code path may call the cursor-advance/compare step *after* its existing logic has already run to completion using only `processedAt`, but must never use a `sequence` value to decide what counts as "unprocessed," and a bug or outage in the new cursor helper must never be able to change which events `computeInsights()` treats as real or to break its `updateMany`. This is what keeps `processedAt` a true fallback throughout the transition, not a fallback in name only.
3. **Existing `BusinessEvent` rows predate `sequence`.** Postgres assigns default `sequence` values to old rows in whatever order it backfills them, which may not perfectly match their original `occurredAt` order. Practically irrelevant: nothing today does cross-row ordering over historical data, and a new cursor-based consumer starting at `0` still processes every row exactly once — the only theoretical effect is processing very old rows in a slightly different order than they originally occurred, which no current or planned consumer depends on.
4. **Idempotency under webhook retries** — the existence-check-then-write pattern (section 4) is what prevents a duplicate `transaction.created` event on a Stripe/PayPal retry. This needs to be correct from the first implementation, not patched in after — a duplicated commerce event would double-count revenue in every downstream consumer.
5. **No impact on `BusinessRecord`/`queryRecords()`** — the snapshot read path is untouched by this entire design.

## Decisions made

- **`processedAt` transition**: parallel run with an explicit, evidence-based cutover criterion (item 2 above), not a direct cutover. Confirmed by Sean.
- **Independence invariant**: the `processedAt` path must remain completely independent of the cursor system until cutover — the cursor may observe and compare against it, but `processedAt` must never depend on the cursor for correctness. Confirmed by Sean; this is what makes it a true fallback, not one in name only.

## Design frozen

Approved by Sean 2026-08-01. No further changes pending — implementation begins once Track 0 (Operational Foundations) is complete.
