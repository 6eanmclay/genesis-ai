// WHAT GROWS FOREVER, AND WHAT MAY BE DONE ABOUT IT.
//
// ============ THE AUDIT THAT PRODUCED THIS (2026-08-30) ================
//
// Four tables in this platform had time-based retention: ProductEvent,
// AuthAttempt, SecuritySignal and TemporaryAsset. Eight more grow without limit
// — including WebhookDelivery, which stores every provider payload VERBATIM.
// Those payloads carry customer names, email addresses, postal addresses and
// amounts, kept indefinitely, for a reason that expired the moment the delivery
// was handled.
//
// ============ THREE VERDICTS, AND THE THIRD IS REAL ====================
//
//   prune    delete rows past a horizon. For operational noise, where the row
//            itself stops meaning anything.
//
//   redact   clear the heavy or sensitive FIELD and keep the row. The right
//            answer for WebhookDelivery: the payload is what a customer would
//            mind us keeping, and the record — which provider, which event,
//            did the signature verify, what happened — is the evidence. Losing
//            the row would destroy the audit trail; keeping the body serves
//            nothing after replay is no longer possible.
//
//   decide   no action, deliberately. Sean, 2026-08-30: "Do not silently delete
//            security/audit information based on an arbitrary assumption."
//            Five tables hold audit, financial or product-memory data whose
//            horizon is a legal, accounting or product question rather than an
//            engineering one. Inventing ninety days for an execution log would
//            be exactly the arbitrary assumption that instruction forbids.
//
// A table with a `decide` verdict is not an oversight. It is a table this
// document is refusing to guess about, and every one names who has to answer.

export type Verdict = "prune" | "redact" | "decide";

export interface RetentionPolicy {
  /** The Prisma model, as it appears on the client. */
  model: string;
  verdict: Verdict;
  /** What the table accumulates, and how fast. */
  holds: string;
  /** Days to keep, for `prune` and `redact`. Null when the verdict is `decide`. */
  keepDays: number | null;
  /** Why this horizon, or why there is not one. */
  reasoning: string;
  /** For `decide`: whose question it is. */
  needs?: string;
}

const DAY = 24 * 60 * 60 * 1000;
export const daysAgo = (days: number, now = new Date()) => new Date(now.getTime() - days * DAY);

export const RETENTION: RetentionPolicy[] = [
  // ---- redact: keep the record, drop the body ----------------------------
  {
    model: "webhookDelivery",
    verdict: "redact",
    keepDays: 30,
    holds:
      "Every provider payload ever received, stored verbatim — customer names, " +
      "email addresses, postal addresses, amounts. One row per event, for ever.",
    reasoning:
      "The payload exists so a failed delivery can be replayed, and a delivery that has " +
      "been processed for a month is not going to be replayed — the provider has long " +
      "since moved on and the order it created is the record now. So the body goes and " +
      "the row stays: which provider, which event id, whether the signature verified, " +
      "what happened and when. That is the whole audit value, and it is a few hundred " +
      "bytes rather than a full checkout session. " +
      "A delivery still in `failed` is EXEMPT — it may yet be replayed, and replay needs " +
      "the bytes. Redacting one would quietly turn a recoverable failure into a permanent one.",
  },

  // ---- prune: operational noise ------------------------------------------
  {
    model: "scheduledTaskRun",
    verdict: "prune",
    keepDays: 30,
    holds: "One row per scheduled task per run. Twelve tasks, hourly at the fastest.",
    reasoning:
      "Evidence that the scheduler is alive, which is a question about now and the recent " +
      "past. Nobody asks whether a sweep ran in March. Due-ness reads only the newest " +
      "successful run, so pruning older ones changes no behaviour at all — the table was " +
      "designed that way.",
  },
  {
    model: "job",
    verdict: "prune",
    keepDays: 30,
    holds: "One row per unit of queued work, kept after completion.",
    reasoning:
      "A completed job is a receipt for work whose real record lives elsewhere — the order " +
      "was written, the notification was sent, the telemetry was pruned. After a month the " +
      "receipt is noise. " +
      "DEAD LETTERS ARE EXEMPT, whatever their age: a job that gave up is unfinished " +
      "business and the only place it is recorded. Deleting one would erase work nobody " +
      "has yet decided what to do about.",
  },

  // ---- decide: not ours to guess -----------------------------------------
  {
    model: "executionLog",
    verdict: "decide",
    keepDays: null,
    holds: "Every action Genesis or an owner has ever taken, with its verification state.",
    reasoning:
      "This is the audit trail. It answers 'what did this platform do to my business, and " +
      "was it confirmed' — which is exactly the question somebody asks months later, and " +
      "often the question a dispute turns on. Choosing ninety days for it would be the " +
      "arbitrary assumption that ruins an investigation nobody has started yet.",
    needs: "A retention decision from Sean, informed by what accounting and dispute evidence actually requires.",
  },
  {
    model: "outboundOperation",
    verdict: "decide",
    keepDays: null,
    holds: "Every external effect this platform has ever attempted, and its outcome.",
    reasoning:
      "The idempotency record. Deleting a row does not merely lose history — it makes the " +
      "key reusable, so a replayed operation could genuinely happen twice. Any horizon here " +
      "has to be longer than the longest window in which anything could be replayed, and " +
      "that is a question about providers rather than about storage.",
    needs: "A decision on the longest plausible replay window, once real providers are connected.",
  },
  {
    model: "aiUsageEvent",
    verdict: "decide",
    keepDays: null,
    holds: "Every model call, with its token counts and cost.",
    reasoning:
      "Cost history. The aggregates are what /admin reports and what any future pricing " +
      "decision rests on, so deleting rows silently changes the numbers a business decision " +
      "was made from. Pre-aggregating before deleting is the right answer and is a piece of " +
      "work rather than a horizon.",
    needs: "A decision on whether monthly roll-ups are worth building before rows are dropped.",
  },
  {
    model: "businessEvent",
    verdict: "decide",
    keepDays: null,
    holds: "The event pipeline J4's understanding is derived from.",
    reasoning:
      "Consumers read it through a cursor. Deleting behind a cursor is safe; deleting ahead " +
      "of one silently drops events a consumer had not reached, and the consumer cannot " +
      "tell the difference between an event that never happened and one that was removed. " +
      "Any prune here must be cursor-aware, which is design work.",
    needs: "Cursor-aware pruning, designed rather than assumed.",
  },
  {
    model: "cognitiveOutput",
    verdict: "decide",
    keepDays: null,
    holds: "What J4 has concluded about each business over time.",
    reasoning:
      "This is memory, not logs. Deleting it changes what J4 knows about a business and " +
      "therefore what it says — a product change wearing a maintenance change's clothes.",
    needs: "A product decision about how long J4 should remember.",
  },
];

export function policyFor(model: string): RetentionPolicy | undefined {
  return RETENTION.find((p) => p.model === model);
}

/** Tables this policy deliberately refuses to guess about. */
export function awaitingDecision(): RetentionPolicy[] {
  return RETENTION.filter((p) => p.verdict === "decide");
}
