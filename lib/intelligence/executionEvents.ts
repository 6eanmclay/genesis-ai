import * as Sentry from "@sentry/nextjs";
import { prisma } from "@/lib/prisma";
import { internalItemId } from "@/lib/businessModel/internalMapper";
import { writeBusinessEvents, type BusinessEventInput } from "./businessEvents";

// Business Intelligence Engine M3 (2026-08-18) — Genesis records what happens
// inside it.
//
// THE GAP THIS CLOSES. Before M3 exactly three places wrote a BusinessEvent:
// connector syncs, the Stripe webhook and the PayPal return. So the only
// first-party event in the entire system was "transaction.created". A store
// with no sales had no events, was therefore never due, and M1's cycle never
// ran for it — the engine was reachable only through the one door that
// requires revenue.
//
// NOTHING NEW IS INVENTED. This writes through the same writeBusinessEvents
// every other producer uses, using the same canonical `<entity>.<verb>`
// vocabulary changeDetection.ts already established, from the one choke point
// every Genesis action already passes through (execute(), lib/execution/
// engine.ts). No new table, no new pipeline, no second event log.
//
// WHAT IT DOES NOT COVER, deliberately: uploads, chat decisions and general
// owner activity. Sean's boundary for M3 — executed actions only, evaluated as
// a separate event-source milestone once this plumbing is proven.

/**
 * Actions that map onto a real canonical entity.
 *
 * `item` is the canonical entity for a product (ENTITY_REGISTRY,
 * entities.ts) — the same one internalMapper already maps live Products into
 * and detectLowInventory already reads. So a product event from Genesis and a
 * future product event from a connector are the same shape, which is the whole
 * reason the vocabulary is canonical rather than action-shaped.
 */
const ITEM_ACTIONS: Readonly<Record<string, { eventType: string; verb: string }>> = {
  create_product: { eventType: "item.created", verb: "added" },
  create_product_from_design: { eventType: "item.created", verb: "added" },
  update_product: { eventType: "item.updated", verb: "updated" },
  update_product_image: { eventType: "item.image_replaced", verb: "image replaced" },
  delete_product: { eventType: "item.removed", verb: "removed" },
};

/**
 * Only a genuinely completed action is something that happened.
 *
 * SUCCESS only, deliberately. PENDING means it has not happened yet (a
 * redirect, an awaited confirmation). WARNING means the executable's own
 * verify() said the change could not be confirmed — writing "the product was
 * updated" on the back of a failed verification would be recording a fact we
 * do not have. PARTIAL is by definition unclear. An event is a claim about
 * reality, so only the unambiguous outcome earns one.
 */
export function isEventWorthyStatus(status: string): boolean {
  return status === "SUCCESS";
}

function readString(input: unknown, field: string): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>)[field];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** What kind of answer it was — the only thing worth remembering about one. */
const ANSWER_EVENT: Readonly<Record<string, { eventType: string; said: string }>> = {
  quoted: { eventType: "supplier.terms_answered", said: "answered what their supplier charges" },
  supplier_would_not_say: {
    eventType: "supplier.terms_refused",
    said: "reported that their supplier would not quote",
  },
  dont_know_yet: { eventType: "supplier.terms_unknown", said: "has not found out what their supplier charges" },
};

function mapEconomicsAnswer(
  input: unknown,
  metadata: unknown,
  executionId: string
): BusinessEventInput | null {
  const answer = readNested(input, "answer");
  const kind = readString(answer, "kind");
  if (!kind) return null;

  const shape = ANSWER_EVENT[kind];
  if (!shape) return null;

  // WHICH RECORD, from what the execution discovered rather than what it was
  // asked. An answer about a candidate nobody has adopted concerns no owned
  // product, and a null recordId is the honest result — the event is still
  // worth having, it just is not about a record understanding knows.
  const result = readNested(metadata, "result");
  const productId = readString(result, "productId");

  return {
    recordId: productId ? internalItemId(productId) : null,
    entityType: "item",
    eventType: shape.eventType,
    summary: `The owner ${shape.said}.`,
    // The supplier's identity, NOT its figures. Enough to tell two answers
    // apart and to trace one back, and nothing a consumer could mistake for a
    // price.
    data: {
      executionId,
      actionType: "answer_supplier_economics",
      sourceKey: readString(input, "sourceKey"),
      externalProductId: readString(input, "externalProductId"),
    },
  };
}

function readNested(value: unknown, field: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return (value as Record<string, unknown>)[field] ?? null;
}

/**
 * The canonical event for an executed action, or null when there is no honest
 * mapping — the pure decision, provable without a database.
 *
 * NULL IS THE COMMON, CORRECT ANSWER. Storefront, brand and marketing actions
 * (update_hero, update_theme, update_brand_identity...) return null today, not
 * because they don't matter but because no canonical entity represents "the
 * storefront" in ENTITY_REGISTRY. Inventing an entityType to make them fit
 * would put a shape into the event log that no consumer can reason about, and
 * would be exactly the fabrication this engine is not allowed to do. When a
 * storefront entity genuinely exists, this table is where it lands.
 */
export function mapExecutionToEvent(params: {
  actionType: string | null | undefined;
  input: unknown;
  status: string;
  executionId: string;
  /**
   * The executable's own metadata, when it has any.
   *
   * Needed because some actions know which record they concern only AFTER they
   * have run: an owner answering a supplier question names a product in their
   * own words, and which owned record that resolved to is something the
   * execution discovered rather than something its input carried. Still pure —
   * this function reads what it is handed and touches no database.
   */
  metadata?: unknown;
}): BusinessEventInput | null {
  const { actionType, input, status, executionId } = params;

  if (!isEventWorthyStatus(status)) return null;
  // execute() is called without a registry actionType on plenty of internal
  // paths (syncs, drafts). No action type is no honest mapping.
  if (!actionType) return null;

  // AN OWNER TELLING GENESIS WHAT A SUPPLIER CHARGES IS SOMETHING THAT HAPPENED
  // (2026-08-21). It was invisible to the memory pipeline: no event, therefore
  // no change detection, no insight and no belief — a real fact about the
  // business, learned by a person and immediately forgotten by the layer whose
  // whole job is remembering.
  //
  // NO FIGURE IS COPIED HERE. SupplierEconomics stays the system of record for
  // what anything costs; the event records that an answer was given, about which
  // product, and what kind of answer it was. A belief distilled from these can
  // only ever be a pattern across them — "this keeps going unanswered" — never a
  // price living in a second table.
  if (actionType === "answer_supplier_economics") {
    return mapEconomicsAnswer(input, params.metadata, executionId);
  }

  const item = ITEM_ACTIONS[actionType];
  if (!item) return null;

  const productId = readString(input, "productId");
  const name = readString(input, "name");

  return {
    // internalItemId is the same canonical id queryRecords already exposes
    // products under, so an event points at the record understanding knows —
    // not at a raw Product row id that nothing else in the model recognises.
    recordId: productId ? internalItemId(productId) : null,
    entityType: "item",
    eventType: item.eventType,
    summary: name ? `Product ${item.verb}: ${name}` : `Product ${item.verb}`,
    // executionId is what makes this idempotent, and it is genuinely useful
    // provenance besides — it ties the event to its own ExecutionLog row.
    data: { executionId, actionType },
  };
}

/**
 * Where events are looked up and written.
 *
 * A seam, not an abstraction layer — the same one writeBusinessEvents already
 * uses by taking its client as a parameter. Production passes the Prisma sink
 * below; the regression suite passes an in-memory one, so "exactly one event
 * per execution" and "idempotent per execution" are provable facts about the
 * real function rather than claims about a reimplementation of it.
 */
export interface ExecutionEventSink {
  hasEventForExecution(storeId: string, executionId: string): Promise<boolean>;
  write(storeId: string, event: BusinessEventInput): Promise<void>;
}

export const prismaExecutionEventSink: ExecutionEventSink = {
  async hasEventForExecution(storeId, executionId) {
    const existing = await prisma.businessEvent.findFirst({
      where: { storeId, data: { path: ["executionId"], equals: executionId } },
      select: { id: true },
    });
    return existing !== null;
  },
  async write(storeId, event) {
    await writeBusinessEvents(prisma, storeId, "internal", [event]);
  },
};

/**
 * Record the event for a successfully executed action.
 *
 * NEVER THROWS, and never changes what the caller returns. An event describes
 * something that already happened; failing the action because the description
 * could not be written would be the tail wagging the dog. Failures go to Sentry
 * rather than being swallowed silently, so a broken emitter is visible without
 * ever being able to break an execution.
 *
 * IDEMPOTENT per execution: the sink is asked whether this executionId already
 * produced an event before anything is written.
 */
export async function recordExecutionEvent(
  params: {
    storeId: string | null;
    executionId: string;
    actionType: string | null | undefined;
    input: unknown;
    status: string;
    /** What the executable returned, for actions that discover their record. */
    metadata?: unknown;
  },
  sink: ExecutionEventSink = prismaExecutionEventSink
): Promise<void> {
  const { storeId, executionId } = params;
  if (!storeId) return;

  try {
    const event = mapExecutionToEvent({
      actionType: params.actionType,
      input: params.input,
      status: params.status,
      executionId,
      metadata: params.metadata,
    });
    if (!event) return;

    if (await sink.hasEventForExecution(storeId, executionId)) return;
    await sink.write(storeId, event);
  } catch (error) {
    Sentry.captureException(error, {
      tags: { subsystem: "business-event-pipeline", stage: "execution-events" },
      extra: { executionId, actionType: params.actionType ?? null },
    });
  }
}
