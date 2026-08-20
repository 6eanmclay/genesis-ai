// Whether a failed order write is worth retrying (2026-08-20).
//
// A webhook's status code is an instruction to Stripe, not a description of our
// mood. 200 means "done, stop"; 500 means "try again". Getting the two the wrong
// way round is expensive in opposite directions:
//
//   - A PERMANENT failure answered 500 is retried for days against something
//     that can never succeed, and then given up on. The sale is lost either way,
//     but the retries hide it and the eventual give-up is silent.
//   - A TRANSIENT failure answered 200 throws away the one mechanism that would
//     have recovered it. A database blip becomes a permanently missing order.
//
// So the two are told apart explicitly rather than by whichever `catch` happened
// to be nearest.

/**
 * Is this failure one that retrying cannot fix? — pure.
 *
 * P2003 (foreign key violated) and P2025 (record not found) both mean the store
 * or product this payment refers to is gone. Nothing brings it back, so the
 * honest move is to acknowledge and make the loss visible.
 *
 * Everything else — connection resets, timeouts, deadlocks, anything unrecognised
 * — is treated as transient. That direction is deliberate: retrying a permanent
 * failure wastes a few days of Stripe's patience, while NOT retrying a transient
 * one loses a real sale. When unsure, be retried.
 */
export function isPermanentOrderFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return code === "P2003" || code === "P2025";
}
