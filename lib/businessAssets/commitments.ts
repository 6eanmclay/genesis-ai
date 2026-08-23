import { createHash } from "crypto";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { prisma } from "@/lib/prisma";
import type { Commitment } from "@/lib/businessModel/entities";

// A DATED COMMITMENT SURVIVES THE FILE BEING CLOSED (2026-08-21).
//
// J4_FOUNDATION.md's last non-blocked coverage gap, in its own words: "if an
// uploaded lease says it expires in December, that's understood as a sentence in
// Asset.summary — not a date J4 holds anywhere it could act on weeks later."
//
// The decision that shapes this file: the model proposes, and this decides.
// Everything a model returns passes through planCommitments before it can become
// a record, so the rules about what may be written are readable in one pure
// function rather than distributed across a prompt nobody can test.
//
// NO NEW MECHANISM. A commitment is an ordinary BusinessRecord under an ordinary
// registry entity type, written through persistSyncedRecords — the same
// validated upsert path a connector sync and an uploaded asset already use. No
// migration: BusinessRecord.data is JSON.

const SOURCE_PROVIDER = "genesis_upload";

/** Exactly what the extractor is allowed to hand over. */
export interface CommitmentCapture {
  title: string;
  kind: string;
  dueDate: string;
  counterparty: string | null;
  amountInCents: number | null;
  sourceQuote: string;
}

/**
 * A real calendar date in YYYY-MM-DD, or null.
 *
 * Checked by round-tripping rather than by regex alone: "2026-02-30" matches any
 * reasonable pattern and is not a day. Date.parse would accept it and roll it
 * forward to March 2nd — a deadline silently moved by two days, which is exactly
 * the kind of quiet wrongness a deadline must never have.
 */
export function readDueDate(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * Stable identity for one commitment, so re-reading the same document updates
 * its dates in place instead of writing them again.
 *
 * Keyed on the asset it came from plus what falls due and when. A re-run of the
 * same file produces the same key; a genuinely different deadline in the same
 * file produces a different one. This is the existing @@unique upsert doing the
 * work — there is no dedupe pass anywhere.
 */
export function commitmentKey(assetRecordId: string, dueDate: string, title: string): string {
  const digest = createHash("sha256")
    .update(`${assetRecordId}|${dueDate}|${title.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 32);
  return `commitment:${digest}`;
}

export interface PlannedCommitment {
  externalId: string;
  data: Commitment;
}

/**
 * Which proposed commitments may be written, and as what — pure.
 *
 * THE THREE RULES, all of them refusals:
 *
 *   1. No real date, no commitment. Not a null field on a record that still
 *      exists — no record. A commitment without a date is a sentence, and
 *      Asset.summary already holds the sentences.
 *   2. No quote, no commitment. The quote is how the owner checks the date
 *      without reopening the file. A date with nothing behind it is a claim.
 *   3. Two readings of the same deadline collapse to one, by key rather than by
 *      comparison, so this stays order-independent.
 *
 * `confidence` is carried onto every record rather than used to filter here —
 * the caller owns that gate, the same way it does for category and newEntity.
 */
export function planCommitments(params: {
  raw: CommitmentCapture[];
  assetRecordId: string;
  confidence: number | null;
}): PlannedCommitment[] {
  const byKey = new Map<string, PlannedCommitment>();

  for (const item of params.raw) {
    const dueDate = readDueDate(item.dueDate);
    if (!dueDate) continue;

    const title = item.title.trim();
    const sourceQuote = item.sourceQuote.trim();
    if (!title || !sourceQuote) continue;

    const externalId = commitmentKey(params.assetRecordId, dueDate, title);
    byKey.set(externalId, {
      externalId,
      data: {
        title,
        kind: item.kind.trim() || "other",
        dueDate,
        counterparty: item.counterparty?.trim() || null,
        amountInCents: item.amountInCents,
        sourceQuote,
        sourceAssetRecordId: params.assetRecordId,
        confidence: params.confidence,
      },
    });
  }

  return [...byKey.values()];
}

/**
 * Write them. Returns what was actually persisted, never what was proposed.
 */
export async function recordCommitments(
  storeId: string,
  planned: PlannedCommitment[]
): Promise<{ recordId: string; title: string; dueDate: string }[]> {
  if (planned.length === 0) return [];

  const { changes } = await persistSyncedRecords(
    storeId,
    SOURCE_PROVIDER,
    planned.map((c) => ({ entityType: "commitment" as const, externalId: c.externalId, data: c.data })),
    {
      // Every one of these was read out of a file. CommitmentSchema already
      // carries the sentence it came from and the asset it was read from, which
      // is per-fact provenance in all but name; this states the KIND, so a
      // reader that never opens the record still knows not to treat the date as
      // something a person typed.
      provenance: "DOCUMENT",
      statedById: null,
      modelExtracted: true,
    }
  );

  // Read back from the change itself, NOT by index into `planned`. A record
  // that failed validation is absent from `changes`, so positional pairing
  // would quietly attribute one commitment's date to another's title.
  return changes.map((change) => {
    const data = change.current as Commitment;
    return { recordId: change.recordId, title: data.title, dueDate: data.dueDate };
  });
}

/** One commitment as a reader sees it, with the only derived number that matters. */
export interface CommitmentView extends Commitment {
  recordId: string;
  /** Whole days from today. Negative when the date has already passed. */
  daysUntilDue: number;
}

export interface CommitmentHorizon {
  /** Already past. Kept separate because a missed deadline is not a future one. */
  overdue: CommitmentView[];
  /** Still ahead, soonest first. */
  upcoming: CommitmentView[];
  /** Null when nothing is ahead — not a date in the past dressed up as next. */
  nextDueDate: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Sort real commitments into what has passed and what is coming — pure.
 *
 * NO THRESHOLD, for the reason lib/businessModel/obligations.ts states about
 * orders: nothing here decides what counts as "soon". Days remaining is reported
 * raw, and how much warning a lease renewal needs is not something this module
 * can know for every business. A "due soon" bucket would be a detector wearing a
 * different hat.
 *
 * `today` is injected rather than read, so the arithmetic is provable rather than
 * only observable against the wall clock.
 */
export function planCommitmentHorizon(params: {
  commitments: { recordId: string; data: Commitment }[];
  today: Date;
}): CommitmentHorizon {
  const todayUtc = Date.UTC(
    params.today.getUTCFullYear(),
    params.today.getUTCMonth(),
    params.today.getUTCDate()
  );

  const views: CommitmentView[] = [];
  for (const row of params.commitments) {
    const dueDate = readDueDate(row.data.dueDate);
    // A stored row whose date is not a date is skipped rather than shown as
    // NaN days away. planCommitments cannot write one; a hand-edited row can.
    if (!dueDate) continue;
    views.push({
      ...row.data,
      dueDate,
      recordId: row.recordId,
      daysUntilDue: Math.round((new Date(`${dueDate}T00:00:00Z`).getTime() - todayUtc) / DAY_MS),
    });
  }

  views.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.title.localeCompare(b.title));

  // Due TODAY is upcoming, not overdue — a deadline you can still meet has not
  // been missed.
  const overdue = views.filter((v) => v.daysUntilDue < 0);
  const upcoming = views.filter((v) => v.daysUntilDue >= 0);

  return { overdue, upcoming, nextDueDate: upcoming[0]?.dueDate ?? null };
}

/**
 * Every commitment this business is under, as a horizon.
 *
 * Part of Understand rather than a separate lookup, for the reason
 * understanding.ts states at the top of itself: there is one answer to "what
 * does J4 know", and a deadline read out of the owner's own lease is part of it.
 */
export async function getCommitments(storeId: string): Promise<CommitmentHorizon> {
  const rows = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "commitment" },
    select: { id: true, data: true },
  });

  return planCommitmentHorizon({
    commitments: rows.map((r) => ({ recordId: r.id, data: r.data as unknown as Commitment })),
    today: new Date(),
  });
}
