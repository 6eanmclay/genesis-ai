import { prisma } from "@/lib/prisma";
import { Prisma, type EconomicsProvenance } from "@prisma/client";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { OwnerCapability } from "./methodProfile";
import { OWNER_CAPABILITIES } from "./methodProfile";
import { toVariantKey } from "./types";
import {
  tierProblem,
  type EconomicsFact,
  type PriceTier,
  type SupplierProductRef,
} from "./economics";

// THE ONLY WAY SUPPLIER ECONOMICS GET WRITTEN.
//
// Three things will eventually want to write here — a supplier connector, an
// owner-entry screen, and a bulk import — and they are not the same caller with
// different arguments. They differ in what they are ALLOWED to say, and that is
// a property of the writer, not of the payload.
//
// So the contract is not "a function that takes a provenance". It is one entry
// point per kind of writer, each of which decides the provenance itself:
//
//   ingestFromSupplier  — a connector, syncing a catalogue. Writes SUPPLIER.
//   recordOwnerQuote    — a person who asked and was told. Writes OWNER.
//   recordUnavailable   — a person who asked and was refused. Writes UNAVAILABLE.
//
// THREE PROTECTIONS ARE STRUCTURAL RATHER THAN CHECKED.
//
// 1. A CONNECTOR CANNOT WRITE UNDER ANOTHER SOURCE'S KEY. `ingestFromSupplier`
//    takes ONE sourceKey for the whole batch and stamps it onto every record;
//    the records themselves have no sourceKey field to get wrong. A Printful
//    sync handed a row claiming to be from AliExpress writes it as Printful,
//    because that is what it is: something Printful said. There is no code path
//    by which one supplier's sync reaches another supplier's row.
//
// 2. A SYNC CANNOT ERASE WHAT A PERSON FOUND OUT — now PER FACT (2026-08-21).
//    A catalogue that publishes a price cannot touch a minimum the owner rang up
//    and asked for, and it does not have to give up its own price to leave that
//    minimum alone. Before per-field provenance those two shared one column, so
//    the sync was refused whole; now each fact is decided on its own.
//
// 3. AN OWNER STATES ONLY WHAT THEY SAID. Answering the second half of a
//    question does not retract the first half, and says nothing at all about the
//    supplier's own published figures — which therefore keep the supplier's name
//    on them rather than quietly becoming the owner's.
//
// NOTHING HERE INVENTS A VALUE. Every figure is optional and absent stays
// absent; a rejected record writes nothing at all rather than writing the half
// that parsed.

/** One product's terms, as a writer states them. No sourceKey — see above. */
export interface EconomicsRecord {
  externalProductId: string;
  externalVariantId?: string | null;
  unitCostInCents?: number | null;
  minimumOrderUnits?: number | null;
  tiers?: PriceTier[] | null;
  shippingPerUnitInCents?: number | null;
  leadTimeDays?: number | null;
  requiresCapabilities?: OwnerCapability[];
  note?: string | null;
}

export type IngestOutcome =
  | {
      status: "recorded";
      externalProductId: string;
      externalVariantId: string | null;
      /** The facts this write actually stated. */
      wrote: EconomicsFact[];
      /** Facts left alone because a person had stated them. Often empty. */
      preserved: EconomicsFact[];
    }
  /**
   * Refused, with the reason, and NOTHING was written.
   *
   * Data, not an exception. A connector syncing four hundred products must not
   * lose the three hundred and ninety-nine good ones because one row had a
   * negative price, and it must not be able to pretend the bad one was fine.
   */
  | { status: "rejected"; externalProductId: string; externalVariantId: string | null; problem: string }
  /** Every fact this write would have touched was a person's. Nothing written. */
  | { status: "preserved"; externalProductId: string; externalVariantId: string | null; reason: string };

export interface IngestReport {
  sourceKey: string;
  recorded: number;
  rejected: number;
  preserved: number;
  outcomes: IngestOutcome[];
}

// --- validation -------------------------------------------------------------

function wholeNonNegative(label: string, value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!Number.isInteger(value) || value < 0) {
    return `${label} is ${JSON.stringify(value)}, which is not a whole number of ${label.includes("cost") || label.includes("shipping") ? "cents" : "units"}`;
  }
  return null;
}

/**
 * Why this record cannot be stored, or null.
 *
 * Runs BEFORE anything is written, and rejects the whole record rather than the
 * offending field. A row that is half-believable is the most dangerous shape
 * this table can hold: it looks answered.
 */
export function recordProblem(record: EconomicsRecord): string | null {
  if (!record.externalProductId || record.externalProductId.trim() === "") {
    return "no product id — a supplier's terms have to be about a specific product";
  }
  if (record.externalProductId.length > 255) return "product id is implausibly long";
  if ((record.externalVariantId ?? "").length > 255) return "variant id is implausibly long";

  const numbers: [string, number | null | undefined][] = [
    ["unit cost", record.unitCostInCents],
    ["minimum order", record.minimumOrderUnits],
    ["shipping", record.shippingPerUnitInCents],
    ["lead time", record.leadTimeDays],
  ];
  for (const [label, value] of numbers) {
    const problem = wholeNonNegative(label, value);
    if (problem) return problem;
  }
  // A minimum order of zero is not a minimum, it is a missing value wearing a
  // number. Absence is expressible; this is not.
  if (record.minimumOrderUnits === 0) {
    return "minimum order is 0 — leave it out rather than record a quantity nobody can order";
  }

  if (record.tiers) {
    const problem = tierProblem(record.tiers);
    if (problem) return `price breaks include ${problem}`;
  }

  for (const capability of record.requiresCapabilities ?? []) {
    if (!(OWNER_CAPABILITIES as readonly string[]).includes(capability)) {
      return `requires "${capability}", which is not something Genesis knows how to ask an owner about`;
    }
  }

  return null;
}

// --- the write --------------------------------------------------------------

/** Every fact a catalogue statement covers. */
export const ALL_FACTS: EconomicsFact[] = [
  "minimumOrder",
  "unitCost",
  "tiers",
  "shipping",
  "handling",
];

/** The two a bulk decision actually needs, and the two J4 asks about. */
export const QUOTABLE_FACTS: EconomicsFact[] = ["minimumOrder", "unitCost"];

function valuesFor(fact: EconomicsFact, record: EconomicsRecord): Record<string, unknown> {
  switch (fact) {
    case "minimumOrder":
      return { minimumOrderUnits: record.minimumOrderUnits ?? null };
    case "unitCost":
      return { unitCostInCents: record.unitCostInCents ?? null };
    case "tiers":
      return {
        // Prisma reads `undefined` as "leave this column alone", which would
        // silently keep tiers a previous write put there. A writer that states
        // this fact and gives no breaks is saying there are none.
        tiers:
          record.tiers === null || record.tiers === undefined
            ? Prisma.DbNull
            : (record.tiers as unknown as Prisma.InputJsonValue),
      };
    case "shipping":
      return { shippingPerUnitInCents: record.shippingPerUnitInCents ?? null };
    case "handling":
      return {
        leadTimeDays: record.leadTimeDays ?? null,
        requiresCapabilities: record.requiresCapabilities ?? [],
      };
  }
}

interface WriteInput {
  storeId: string;
  sourceKey: string;
  provenance: EconomicsProvenance;
  record: EconomicsRecord;
  statedByUserId: string | null;
  now: Date;
  /** Exactly the facts this writer is stating. Everything else is untouched. */
  states: EconomicsFact[];
  /**
   * The currency these figures are in, when the writer knows its own.
   *
   * A connector does: a supplier quotes in the supplier's money, and it may not
   * be the business's. An owner typing what they were quoted does not — they
   * think in their own currency, so the business's is the honest default.
   */
  currency?: string;
  /** True for a machine, which may not overwrite a fact a person stated. */
  yieldsToOwner: boolean;
}

async function writeOne(input: WriteInput): Promise<IngestOutcome> {
  const { record } = input;
  const variantKey = toVariantKey(record.externalVariantId ?? null);
  const identity = {
    externalProductId: record.externalProductId,
    externalVariantId: record.externalVariantId ?? null,
  };

  const problem = recordProblem(record);
  if (problem) return { status: "rejected", ...identity, problem };

  // WHICH CURRENCY, ANSWERED RATHER THAN ASSUMED. Taken from the business that
  // owns the row, because that is the only currency any writer here is actually
  // stating figures in today: an owner types what their supplier quoted them,
  // and a connector states what its catalogue lists in the store's own
  // currency. Recording it makes the assumption visible and checkable instead
  // of implicit, so the day a supplier quotes in something else, feasibility
  // refuses rather than reading it as the wrong money.
  const store = await prisma.store.findUnique({
    where: { id: input.storeId },
    select: { currency: true },
  });
  if (!store) {
    return { status: "rejected", ...identity, problem: "that business does not exist" };
  }

  const existing = await prisma.supplierEconomics.findFirst({
    where: {
      storeId: input.storeId,
      sourceKey: input.sourceKey,
      externalProductId: record.externalProductId,
      externalVariantId: variantKey,
    },
  });
  const held = existing as unknown as Record<string, unknown> | null;

  // PER FACT, NOT PER ROW. A catalogue that publishes a price no longer has to
  // be refused wholesale because the owner once rang up about the minimum.
  const wrote: EconomicsFact[] = [];
  const preserved: EconomicsFact[] = [];
  const data: Record<string, unknown> = { currency: input.currency ?? store.currency };

  for (const fact of input.states) {
    const heldBy = held?.[`${fact}Provenance`] as EconomicsProvenance | null | undefined;

    if (input.yieldsToOwner && heldBy === "OWNER") {
      preserved.push(fact);
      continue;
    }

    Object.assign(data, valuesFor(fact, record));
    data[`${fact}Provenance`] = input.provenance;
    data[`${fact}StatedAt`] = input.now;
    data[`${fact}StatedById`] = input.statedByUserId;
    wrote.push(fact);
  }

  if (wrote.length === 0) {
    return {
      status: "preserved",
      ...identity,
      reason:
        "the owner stated every one of these figures themselves; a catalogue sync does not overwrite what somebody asked for",
    };
  }

  // The note belongs to whoever last wrote something, and an absent note does
  // not withdraw the one already there — an owner adding "and it's 410" has not
  // retracted "quoted by phone".
  if (record.note !== null && record.note !== undefined) data.note = record.note;

  await prisma.supplierEconomics.upsert({
    where: {
      storeId_sourceKey_externalProductId_externalVariantId: {
        storeId: input.storeId,
        sourceKey: input.sourceKey,
        externalProductId: record.externalProductId,
        externalVariantId: variantKey,
      },
    },
    create: {
      storeId: input.storeId,
      sourceKey: input.sourceKey,
      externalProductId: record.externalProductId,
      externalVariantId: variantKey,
      ...data,
    } as unknown as Prisma.SupplierEconomicsUncheckedCreateInput,
    update: data as unknown as Prisma.SupplierEconomicsUncheckedUpdateInput,
  });

  return { status: "recorded", ...identity, wrote, preserved };
}

function report(sourceKey: string, outcomes: IngestOutcome[]): IngestReport {
  return {
    sourceKey,
    recorded: outcomes.filter((o) => o.status === "recorded").length,
    rejected: outcomes.filter((o) => o.status === "rejected").length,
    preserved: outcomes.filter((o) => o.status === "preserved").length,
    outcomes,
  };
}

// --- the three writers ------------------------------------------------------

/**
 * A supplier connector, stating what its catalogue says.
 *
 * `sourceKey` is an argument to the BATCH, not to each record, and that is the
 * whole safety property: every row is stamped with the key of the connector that
 * produced it, so one supplier's sync cannot land on another supplier's product
 * however wrong its payload is.
 *
 * A SYNC STATES EVERY FACT IT OWNS, including the ones it has stopped
 * mentioning. A catalogue is a complete statement of what a supplier currently
 * offers, so a price break that has disappeared from it has been withdrawn, and
 * carrying the old one forward would quote a price nobody sells at. Facts a
 * person stated are the exception and are left exactly as they are.
 */
export async function ingestFromSupplier(input: {
  storeId: string;
  sourceKey: string;
  records: EconomicsRecord[];
  /** The supplier's own currency. Defaults to the business's when unstated. */
  currency?: string;
  now?: Date;
}): Promise<IngestReport> {
  const now = input.now ?? new Date();
  const outcomes: IngestOutcome[] = [];

  for (const record of input.records) {
    outcomes.push(
      await writeOne({
        storeId: input.storeId,
        sourceKey: input.sourceKey,
        provenance: "SUPPLIER",
        record,
        statedByUserId: null,
        now,
        currency: input.currency,
        states: ALL_FACTS,
        yieldsToOwner: true,
      })
    );
  }

  const result = report(input.sourceKey, outcomes);

  // A sync that rejected rows is an operator's problem, not an owner's. Reported
  // once per batch rather than per row, because four hundred identical alerts is
  // the same as none.
  if (result.rejected > 0) {
    const examples = result.outcomes
      .filter((o): o is Extract<IngestOutcome, { status: "rejected" }> => o.status === "rejected")
      .slice(0, 3)
      .map((o) => `${o.externalProductId}: ${o.problem}`);
    reportIssue(
      `supplier economics sync rejected ${result.rejected} of ${input.records.length} records from ${input.sourceKey} — ${examples.join("; ")}`,
      null,
      {
        subsystem: "sourcing",
        stage: "economics.ingest",
        storeId: input.storeId,
        extra: { sourceKey: input.sourceKey, rejected: result.rejected, total: input.records.length },
      }
    );
  }

  return result;
}

/**
 * The owner rang the supplier and is telling Genesis what they said.
 *
 * The path that makes the progression engine work in production TODAY, with no
 * connector involved.
 *
 * A call with NEITHER of the two quotable figures is not a quote and is refused.
 * Either one alone is accepted, and that is deliberate: an owner who rang their
 * supplier and came back knowing the minimum but not the price has found out
 * something real, and demanding both would throw it away and ask them the same
 * two questions again.
 *
 * ONLY THE FACTS THEY GAVE ARE TOUCHED — see protection 3 above.
 */
export async function recordOwnerQuote(input: {
  storeId: string;
  ref: SupplierProductRef;
  minimumOrderUnits?: number | null;
  bulkUnitCostInCents?: number | null;
  shippingPerUnitInCents?: number | null;
  leadTimeDays?: number | null;
  requiresCapabilities?: OwnerCapability[];
  userId?: string | null;
  note?: string | null;
  now?: Date;
}): Promise<IngestOutcome> {
  const given = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

  if (!given(input.minimumOrderUnits) && !given(input.bulkUnitCostInCents)) {
    return {
      status: "rejected",
      externalProductId: input.ref.externalProductId,
      externalVariantId: input.ref.externalVariantId,
      problem: "neither the minimum nor the price was given, which is not a quote",
    };
  }

  const states: EconomicsFact[] = [];
  if (given(input.minimumOrderUnits)) states.push("minimumOrder");
  if (given(input.bulkUnitCostInCents)) states.push("unitCost");
  if (given(input.shippingPerUnitInCents)) states.push("shipping");
  if (given(input.leadTimeDays) || (input.requiresCapabilities?.length ?? 0) > 0) states.push("handling");

  return writeOne({
    storeId: input.storeId,
    sourceKey: input.ref.sourceKey,
    provenance: "OWNER",
    record: {
      externalProductId: input.ref.externalProductId,
      externalVariantId: input.ref.externalVariantId,
      minimumOrderUnits: input.minimumOrderUnits ?? null,
      unitCostInCents: input.bulkUnitCostInCents ?? null,
      shippingPerUnitInCents: input.shippingPerUnitInCents ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      requiresCapabilities: input.requiresCapabilities ?? [],
      note: input.note ?? null,
    },
    statedByUserId: input.userId ?? null,
    now: input.now ?? new Date(),
    states,
    // An owner correcting their own earlier answer is the point.
    yieldsToOwner: false,
  });
}

/**
 * Somebody looked and there is no answer to be had.
 *
 * Deliberately recordable. "Nobody has asked" and "we asked and this supplier
 * will not say" are different states, and only the first is worth putting in
 * front of an owner again next week — see `economicsPolicy.ts` for what happens
 * when "next week" becomes "two months".
 *
 * PER FACT, because a refusal usually is. A supplier that publishes a price and
 * will not discuss minimums has refused one thing, not both, and recording it as
 * both would throw away a price somebody could still use.
 */
export async function recordUnavailable(input: {
  storeId: string;
  ref: SupplierProductRef;
  /** Defaults to the two figures a bulk decision actually needs. */
  facts?: EconomicsFact[];
  userId?: string | null;
  note?: string | null;
  now?: Date;
}): Promise<IngestOutcome> {
  return writeOne({
    storeId: input.storeId,
    sourceKey: input.ref.sourceKey,
    provenance: "UNAVAILABLE",
    record: {
      externalProductId: input.ref.externalProductId,
      externalVariantId: input.ref.externalVariantId,
      note: input.note ?? null,
    },
    statedByUserId: input.userId ?? null,
    now: input.now ?? new Date(),
    states: input.facts ?? QUOTABLE_FACTS,
    // Recording that a person could not get an answer must not quietly delete
    // the answer a person previously got. If a figure is on file because
    // somebody asked for it, that is still the last thing anybody actually knew.
    yieldsToOwner: true,
  });
}
