import type { BusinessMap, MapNode } from "@/lib/businessModel/businessMap";

// WHAT THE OWNER IS POINTING AT (2026-09-03, P2).
//
// `workspaceContext.ts` already tells J4 which SURFACE the owner is on. It has
// never been able to say which THING on it — so "the product catalog" was
// sayable and "the Copper Mug" was not, and every "compare these three" had to
// be restated in full.
//
// ============ A POINTER, NEVER DATA ================================
//
// A selection carries identity and nothing else. Labels and kinds go into the
// prompt; `recordId` and `recordKind` stay here for server-side handlers that
// genuinely need a row. No fact about the business travels in this contract,
// which is the property that stops it becoming a second answer to "what does
// J4 know" — the understanding remains the only one.
//
// ============ AND THE MAP IS THE AUTHORIZATION ======================
//
// Node ids arrive from a browser. They are not trusted, checked against a
// permission table, or parsed for meaning: they are looked up in THIS STORE'S
// OWN MAP, which is assembled from this store's understanding. A node from
// another store is not in it, a node that never existed is not in it, and a
// malformed string is not in it — all three fail the same way, by not being
// found. That is deliberately one rule rather than three checks, because three
// checks are three chances to write one of them wrongly.
//
// Nothing is reported back about what was discarded. A caller that could learn
// "that id exists but is not yours" has been handed a probe.

/** One thing the owner is pointing at. Identity only. */
export interface SelectedEntity {
  /** The map's own node id, e.g. `product:<id>`. Server-side and outbound only. */
  nodeId: string;
  /** What a person calls it. This is what may be spoken. */
  label: string;
  /** "Product", "Customer", "Social account". Null for a genuine one-off. */
  kind: string | null;
  /** Which part of the business it belongs to. */
  domain: MapNode["domain"];
  /**
   * The row behind it, for a HANDLER that needs one.
   *
   * Deliberately not part of anything rendered or prompted. It is here so that
   * a tool acting on a selection can find the record without re-deriving it,
   * and `verify-j4-selection.ts` asserts it never reaches the prompt.
   */
  recordId: string | null;
  recordKind: MapNode["recordKind"];
}

/**
 * The conversational scope, DERIVED from the selection rather than stored.
 *
 * There is no scope state machine and there should not be one: the number of
 * things being pointed at already says which conversation this is. Storing it
 * separately would create a second thing to keep in step with the first.
 */
export type SelectionScope = "business" | "entity" | "comparison";

export interface SelectionContext {
  scope: SelectionScope;
  entities: SelectedEntity[];
}

/** How many things may be pointed at before it stops being a selection. */
const MAX_SELECTED = 5;

/**
 * Resolve what the browser says is selected against the store's own map.
 *
 * Order is preserved and duplicates collapse, so "compare these three" reads in
 * the order the owner picked them.
 */
export function resolveSelection(map: BusinessMap, nodeIds: unknown): SelectionContext {
  if (!Array.isArray(nodeIds)) return { scope: "business", entities: [] };

  const byId = new Map<string, MapNode>();
  for (const node of map.nodes) byId.set(node.id, node);

  const entities: SelectedEntity[] = [];
  const seen = new Set<string>();
  for (const raw of nodeIds) {
    if (typeof raw !== "string") continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    const node = byId.get(raw);
    // NOT FOUND IS THE ONLY OUTCOME for anything unknown, foreign or
    // malformed. See the header: one rule, not three checks.
    if (!node) continue;
    entities.push({
      nodeId: node.id,
      label: node.label,
      kind: node.kind,
      domain: node.domain,
      recordId: node.recordId,
      recordKind: node.recordKind,
    });
    if (entities.length >= MAX_SELECTED) break;
  }

  return { scope: scopeOf(entities.length), entities };
}

export function scopeOf(count: number): SelectionScope {
  if (count === 0) return "business";
  if (count === 1) return "entity";
  return "comparison";
}

/**
 * The line J4 is told, or null when the owner is pointing at nothing.
 *
 * LABELS AND KINDS ONLY. The node id is not in here and neither is the record
 * id: this string is concatenated into a prompt, and an internal identifier in
 * a prompt is one the model can repeat back to the owner. That has happened in
 * this codebase before — a cuid became a SKU, a primary key became a customer's
 * email on screen — which is why there is a test for exactly this sentence.
 */
export function describeSelectionForJ4(selection: SelectionContext): string | null {
  if (selection.entities.length === 0) return null;

  const name = (entity: SelectedEntity) =>
    entity.kind ? `${entity.label} (${entity.kind})` : entity.label;

  if (selection.scope === "entity") {
    return (
      `(The merchant is looking at ${name(selection.entities[0])} right now. ` +
      `When they say "this" or "it", that is what they mean — answer about it specifically ` +
      `rather than about the business as a whole.)`
    );
  }

  const names = selection.entities.map(name).join(", ");
  return (
    `(The merchant has ${selection.entities.length} things selected: ${names}. ` +
    `They are asking about these together — compare them, or answer across them, ` +
    `rather than picking one or answering about the whole business.)`
  );
}
