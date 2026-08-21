import { prisma } from "@/lib/prisma";
import { Prisma, type EconomicsProvenance } from "@prisma/client";
import { reportIssue } from "@/lib/observability/reportIssue";
import type { OwnerCapability } from "./methodProfile";
import { OWNER_CAPABILITIES } from "./methodProfile";
import { toVariantKey } from "./types";
import { tierProblem, type PriceTier, type SupplierProductRef } from "./economics";

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
// TWO PROTECTIONS ARE STRUCTURAL RATHER THAN CHECKED.
//
// 1. A CONNECTOR CANNOT WRITE UNDER ANOTHER SOURCE'S KEY. `ingestFromSupplier`
//    takes ONE sourceKey for the whole batch and stamps it onto every record;
//    the records themselves have no sourceKey field to get wrong. A Printful
//    sync handed a row claiming to be from AliExpress writes it as Printful,
//    because that is what it is: something Printful said. There is no code path
//    by which one supplier's sync reaches another supplier's row.
//
// 2. A SYNC CANNOT ERASE WHAT A PERSON FOUND OUT. An OWNER row is what somebody
//    got by ringing the supplier up. A catalogue sync that would overwrite it is
//    refused and reported as `preserved`, not silently applied. This was written
//    down as a rule the day the table was created and enforced by nothing, which
//    is the state in which rules stop being true.
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
  | { status: "recorded"; externalProductId: string; externalVariantId: string | null }
  /**
   * Refused, with the reason, and NOTHING was written.
   *
   * Data, not an exception. A connector syncing four hundred products must not
   * lose the three hundred and ninety-nine good ones because one row had a
   * negative price, and it must not be able to pretend the bad one was fine.
   */
  | { status: "rejected"; externalProductId: string; externalVariantId: string | null; problem: string }
  /** An OWNER statement was left alone. Also nothing written. */
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

interface WriteInput {
  storeId: string;
  sourceKey: string;
  provenance: EconomicsProvenance;
  record: EconomicsRecord;
  statedByUserId: string | null;
  now: Date;
  /** True for a machine sync, which may not overwrite what a person stated. */
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

  if (input.yieldsToOwner) {
    const existing = await prisma.supplierEconomics.findFirst({
      where: {
        storeId: input.storeId,
        sourceKey: input.sourceKey,
        externalProductId: record.externalProductId,
        externalVariantId: variantKey,
      },
      select: { provenance: true, statedAt: true },
    });
    if (existing?.provenance === "OWNER") {
      return {
        status: "preserved",
        ...identity,
        reason: `the owner stated these terms on ${existing.statedAt.toISOString().slice(0, 10)}; a catalogue sync does not overwrite what somebody asked for`,
      };
    }
  }

  const data = {
    provenance: input.provenance,
    unitCostInCents: record.unitCostInCents ?? null,
    minimumOrderUnits: record.minimumOrderUnits ?? null,
    // Prisma reads `undefined` as "leave this column alone", which on an update
    // would silently keep tiers a previous sync wrote. Absent means absent.
    tiers:
      record.tiers === null || record.tiers === undefined
        ? Prisma.DbNull
        : (record.tiers as unknown as Prisma.InputJsonValue),
    shippingPerUnitInCents: record.shippingPerUnitInCents ?? null,
    leadTimeDays: record.leadTimeDays ?? null,
    requiresCapabilities: record.requiresCapabilities ?? [],
    statedByUserId: input.statedByUserId,
    statedAt: input.now,
    note: record.note ?? null,
  };

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
    },
    update: data,
  });

  return { status: "recorded", ...identity };
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
 */
export async function ingestFromSupplier(input: {
  storeId: string;
  sourceKey: string;
  records: EconomicsRecord[];
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
 * connector involved. Recorded as OWNER, which is what stops a later catalogue
 * sync refreshing away something a person went and found out.
 *
 * Both figures are required here, unlike the connector path: this call exists
 * because somebody asked the two questions, and a call with neither answer is
 * not a quote.
 */
export async function recordOwnerQuote(input: {
  storeId: string;
  ref: SupplierProductRef;
  minimumOrderUnits: number;
  bulkUnitCostInCents: number;
  shippingPerUnitInCents?: number | null;
  leadTimeDays?: number | null;
  requiresCapabilities?: OwnerCapability[];
  userId?: string | null;
  note?: string | null;
  now?: Date;
}): Promise<IngestOutcome> {
  return writeOne({
    storeId: input.storeId,
    sourceKey: input.ref.sourceKey,
    provenance: "OWNER",
    record: {
      externalProductId: input.ref.externalProductId,
      externalVariantId: input.ref.externalVariantId,
      minimumOrderUnits: input.minimumOrderUnits,
      unitCostInCents: input.bulkUnitCostInCents,
      shippingPerUnitInCents: input.shippingPerUnitInCents ?? null,
      leadTimeDays: input.leadTimeDays ?? null,
      requiresCapabilities: input.requiresCapabilities ?? [],
      note: input.note ?? null,
    },
    statedByUserId: input.userId ?? null,
    now: input.now ?? new Date(),
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
 */
export async function recordUnavailable(input: {
  storeId: string;
  ref: SupplierProductRef;
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
    // Recording that a person could not get an answer must not quietly delete
    // the answer a person previously got. If terms are on file and somebody is
    // now being refused, the terms on file are still the last thing anybody
    // actually knew.
    yieldsToOwner: true,
  });
}
