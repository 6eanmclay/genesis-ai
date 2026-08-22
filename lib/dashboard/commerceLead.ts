import type { OwnerBriefingChangeSet } from "./genesisBriefingComposer";
import { formatMoneyApprox } from "@/lib/money";

// Commerce's lead — "one line: what changed since you were last here."
//
// The room architecture (GENESIS_SURFACES.md, locked 2026-08-22) gives each
// room a lead, a density and a ground. Commerce's ground and density shipped
// with the room work; this is its lead, and it is the last piece of that
// decision.
//
// COUNT-BASED, NOT NARRATIVE, and deliberately so. The same discipline
// buildBriefing already holds: "a short, count-based briefing line rather than
// echoing the real text into this ambient surface — the full detail already
// lives on its real page." The orders, the customers and the revenue are all
// one scroll below this line. A lead that retold them would be a summary of
// what the owner is already looking at.
//
// It is therefore DETERMINISTIC — no model call. There is nothing here a model
// could add that the counts do not already say, and a generated sentence would
// put a paraphrase of somebody's revenue in front of them. The one Genesis
// composes IS a narrative and lives elsewhere: composeOwnerBriefing, on arrival.
//
// THE HONEST-ABSENCE RULE IS THE WHOLE SHAPE OF THIS FUNCTION, and it is the
// reason OwnerBriefingChangeSet carries hasPriorAnchor at all:
//
//   no prior anchor   ->  null. Genesis has never briefed this store, so there
//                         is no "since" to speak of. Saying "nothing has
//                         changed" would be a claim about a period that does
//                         not exist.
//   anchor, no change ->  a real, quiet sentence. "Nothing new" is TRUE here,
//                         and an owner who checks twice in an hour deserves to
//                         be told so rather than shown a blank.
//   anchor, changes   ->  the counts, in the order they matter to a shop.
//
// Collapsing the first two is exactly the failure ARCHITECTURE.md names: "two
// silences are not the same silence."

export interface CommerceLead {
  /** The line itself. Always a complete sentence. */
  text: string;
  /** True when there is genuinely nothing new — the caller may render it quieter. */
  quiet: boolean;
}

// No pennies on a headline figure: this is a glance, not a ledger row.
const money = formatMoneyApprox;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Joins real clauses into one sentence. Never invents a connective for an
 * empty list — an empty list means the caller should not be building a
 * sentence at all.
 */
function sentence(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}

/**
 * The one line Commerce opens with, or null when there is no honest one.
 *
 * `currency` is the store's own — a figure is always in the money the owner
 * actually takes, never a default that happens to be the developer's.
 */
export function buildCommerceLead(
  changeSet: OwnerBriefingChangeSet,
  currency: string
): CommerceLead | null {
  // Nothing to measure against. Not "nothing happened" — genuinely no period
  // to speak about, which is a different fact and is left unsaid.
  if (!changeSet.hasPriorAnchor) return null;

  const parts: string[] = [];
  if (changeSet.orderCount > 0) {
    parts.push(plural(changeSet.orderCount, "new order", "new orders"));
  }
  // Revenue only alongside real orders. A revenue delta with no orders behind
  // it is a refund, an adjustment, or a correction — none of which reads as
  // "since you were last here" news, and all of which would be misleading
  // stated as a gain.
  if (changeSet.orderCount > 0 && changeSet.revenueDeltaInCents > 0) {
    parts.push(`${money(changeSet.revenueDeltaInCents, currency)} in revenue`);
  }
  if (changeSet.newCustomerCount > 0) {
    parts.push(plural(changeSet.newCustomerCount, "new customer", "new customers"));
  }

  if (parts.length === 0) {
    return { text: "Nothing new since you were last here.", quiet: true };
  }

  return { text: `Since you were last here: ${sentence(parts)}.`, quiet: false };
}
