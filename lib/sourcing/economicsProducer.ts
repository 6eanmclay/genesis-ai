import { getProductSource } from "./registry";
import { ingestFromSupplier, type EconomicsRecord, type IngestReport } from "./economicsIngest";
import type { PriceTier } from "./economics";
import type { OwnerCapability } from "./methodProfile";

// WHAT A SUPPLIER CONNECTOR HAS TO PROVIDE, AND WHERE IT HANDS IT OVER.
//
// No connector is built yet, and this file does not build one. It defines the
// contract one would have to satisfy and the single door it would come through,
// so that when a real supplier integration is written there is nothing left to
// decide about how its numbers reach the database — and no route by which they
// could reach it any other way.
//
// THE BOUNDARY IS THE POINT. A connector produces an `EconomicsStatement`; this
// file turns statements into `ingestFromSupplier` calls. A connector never sees
// Prisma, never picks a provenance, never chooses a currency, and never learns
// what a `sourceKey` column is. Everything that decides whether a number can be
// trusted lives on this side of the door, where it is tested once rather than
// re-implemented per supplier.
//
// WHY NOT JUST LET A CONNECTOR CALL `ingestFromSupplier`? Because that function
// takes a sourceKey, and a connector supplying its own is a connector that could
// supply somebody else's. Here the key comes from the registry entry the caller
// names, and the statement has no field for it.

/**
 * What a producer says about one supplier product.
 *
 * EVERY FIGURE IS OPTIONAL AND ABSENT MEANS ABSENT. A connector that cannot
 * discover a minimum order says nothing about it; it does not send 1, or 0, or
 * its best guess. The whole progression engine is built on unknown staying
 * unknown, and a producer is where the first opportunity to break that lives.
 */
export interface EconomicsStatement {
  /** The supplier's own id for the product. Required — terms are about a thing. */
  externalProductId: string;
  /** The supplier's own id for the variant, or null when the listing has none. */
  externalVariantId?: string | null;

  /** What one unit costs at `minimumOrderUnits`. Cents. */
  unitCostInCents?: number | null;
  /** The smallest order the supplier will take. Never 0, never 1-as-a-default. */
  minimumOrderUnits?: number | null;
  /** Price breaks, if published. An empty array means "there are none", which is not null. */
  tiers?: PriceTier[] | null;
  /** Delivery per unit on a bulk order. A stated 0 means included. */
  shippingPerUnitInCents?: number | null;
  /** How many days from order to arrival. */
  leadTimeDays?: number | null;
  /** What this product demands of the owner beyond its method's own. */
  requiresCapabilities?: OwnerCapability[];
  /** Anything a person would want to read. Never parsed. */
  note?: string | null;
}

/**
 * What a producer must be able to answer before it is allowed to write.
 *
 * Declared, not discovered, exactly like `ProductSource.blockedOn`: "why is this
 * supplier's pricing not showing up" has to be answerable without making a
 * request to find out.
 */
export interface EconomicsProducer {
  /** Must match a registered `ProductSource.key`. Checked, not trusted. */
  sourceKey: string;

  /**
   * Which currency this producer's figures are in.
   *
   * REQUIRED, and the one field a producer cannot leave out. A supplier that
   * quotes in EUR to a business selling in USD has stated a real fact, and
   * reading it as USD would be a wrong number about money that looks exactly
   * like a right one. Genesis does not convert; `assessFeasibility` refuses to
   * compare across currencies rather than applying a rate nobody supplied.
   */
  currency: string;

  /**
   * What this producer still needs before it can be used at all.
   *
   * Empty when genuinely ready. Same convention as `ProductSource.blockedOn`,
   * and read the same way: a producer with anything here is not called.
   */
  blockedOn: string[];

  /**
   * Everything this producer can currently state for one business.
   *
   * ONE CALL, WHOLE CATALOGUE, and that is deliberate: `ingestFromSupplier`
   * treats a sync as a complete statement of what a supplier offers, so a price
   * break that has vanished has been withdrawn. A producer that returned a
   * partial catalogue would look identical to a supplier that had withdrawn
   * everything it omitted. If a real API can only page, the producer is
   * responsible for assembling the whole page set before returning.
   */
  statements(params: { storeId: string }): Promise<EconomicsStatement[]>;
}

export type ProducerRunOutcome =
  | { status: "ran"; report: IngestReport }
  /** Not run, and why — never silently skipped. */
  | { status: "not_run"; reason: string };

/**
 * Run one producer for one business, through the ingest contract.
 *
 * THE ONLY WAY A CONNECTOR'S FIGURES REACH THE TABLE. Everything a producer says
 * is validated, attributed and currency-stamped by `ingestFromSupplier`, which
 * is where per-fact provenance and the never-overwrite-an-owner rule live.
 *
 * Malformed data is data. A statement that fails validation is rejected
 * individually and reported; the rest of the catalogue still lands, and nothing
 * partial is written for the one that failed. That behaviour is
 * `ingestFromSupplier`'s and is deliberately not re-implemented here — a second
 * validator is a second definition of "valid".
 */
export async function runEconomicsProducer(
  producer: EconomicsProducer,
  params: { storeId: string; now?: Date }
): Promise<ProducerRunOutcome> {
  // A PRODUCER MUST BE A REGISTERED SOURCE. Without this, a caller could invent
  // a key and write terms that no product will ever match — or worse, match a
  // real source's key and put one supplier's prices on another's products.
  const source = getProductSource(producer.sourceKey);
  if (!source) {
    return {
      status: "not_run",
      reason: `"${producer.sourceKey}" is not a registered product source`,
    };
  }

  if (producer.blockedOn.length > 0) {
    return { status: "not_run", reason: `${source.displayName} is not ready: ${producer.blockedOn.join("; ")}` };
  }

  const statements = await producer.statements({ storeId: params.storeId });
  if (statements.length === 0) {
    // Nothing to say is not a failure, and it is not an instruction to forget
    // everything either — a producer that returns nothing writes nothing.
    return { status: "not_run", reason: `${source.displayName} had nothing to state` };
  }

  const records: EconomicsRecord[] = statements.map((statement) => ({
    externalProductId: statement.externalProductId,
    externalVariantId: statement.externalVariantId ?? null,
    unitCostInCents: statement.unitCostInCents ?? null,
    minimumOrderUnits: statement.minimumOrderUnits ?? null,
    tiers: statement.tiers ?? null,
    shippingPerUnitInCents: statement.shippingPerUnitInCents ?? null,
    leadTimeDays: statement.leadTimeDays ?? null,
    requiresCapabilities: statement.requiresCapabilities ?? [],
    note: statement.note ?? null,
  }));

  const report = await ingestFromSupplier({
    storeId: params.storeId,
    // FROM THE REGISTRY, NOT THE PRODUCER'S SAY-SO — the same structural
    // protection `ingestFromSupplier` gives records: there is no field for a
    // producer to get wrong, and the key it writes under is the key it is.
    sourceKey: source.key,
    records,
    // THE SUPPLIER'S OWN MONEY, carried rather than assumed. A producer that
    // quotes in EUR to a business selling in USD has stated a real fact; the
    // figures are stored as EUR and `assessFeasibility` refuses to compare them
    // rather than applying a rate nobody supplied.
    currency: producer.currency,
    now: params.now,
  });

  return { status: "ran", report };
}

/**
 * Whether a producer could legitimately be run, without running it.
 *
 * For the operator-facing "why is this supplier's pricing not here" question,
 * answerable from the declaration rather than from an attempt.
 */
export function producerReadiness(producer: EconomicsProducer): { ready: boolean; blockedOn: string[] } {
  const blockedOn = [...producer.blockedOn];
  if (!getProductSource(producer.sourceKey)) {
    blockedOn.push(`"${producer.sourceKey}" is not a registered product source`);
  }
  if (!producer.currency || producer.currency.trim() === "") {
    blockedOn.push("it does not state which currency its figures are in");
  }
  return { ready: blockedOn.length === 0, blockedOn };
}
