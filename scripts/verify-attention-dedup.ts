import { dedupeAttentionItemsByMessage } from "../lib/dashboard/needsAttention";
import type { AttentionItem } from "../lib/dashboard/types";

// Real verification (2026-08-09) — Sean's own report: the dashboard showed
// the exact same Growth Points shortfall message 4-5 times. Pure-function
// test, no DB needed: proves dedupeAttentionItemsByMessage collapses
// identical messages into one item with a real count + groupedItems, and
// leaves genuinely distinct messages (and singletons) completely alone.
function item(id: string, message: string, occurredAt: string): AttentionItem {
  return { id, kind: "recent-failure", severity: "FAILED", message, occurredAt: new Date(occurredAt) };
}

const input: AttentionItem[] = [
  item("5", "J4 prepared your website update, but publishing it needs 2 more Growth Points than you currently have.", "2026-08-09T18:00:00Z"),
  item("4", "J4 prepared your website update, but publishing it needs 2 more Growth Points than you currently have.", "2026-08-09T17:00:00Z"),
  item("3", "No payment method is connected.", "2026-08-09T16:00:00Z"),
  item("2", "J4 prepared your website update, but publishing it needs 2 more Growth Points than you currently have.", "2026-08-09T15:00:00Z"),
  item("1", "J4 prepared your website update, but publishing it needs 2 more Growth Points than you currently have.", "2026-08-09T14:00:00Z"),
];

const result = dedupeAttentionItemsByMessage(input);

if (result.length !== 2) throw new Error(`FAILED: expected 2 groups, got ${result.length}`);

const growthPointsGroup = result.find((r) => r.message.includes("Growth Points"));
if (!growthPointsGroup) throw new Error("FAILED: Growth Points group missing");
if (growthPointsGroup.count !== 4) throw new Error(`FAILED: expected count 4, got ${growthPointsGroup.count}`);
if (growthPointsGroup.id !== "5") throw new Error(`FAILED: expected most-recent id "5" as representative, got "${growthPointsGroup.id}"`);
if (growthPointsGroup.groupedItems?.length !== 4) throw new Error("FAILED: groupedItems should carry all 4 real occurrences");
console.log("Case 1 (4 identical messages collapse into 1 group with count=4, most-recent as representative): PASS");

const paymentItem = result.find((r) => r.message === "No payment method is connected.");
if (!paymentItem) throw new Error("FAILED: distinct message was lost");
if (paymentItem.count !== undefined) throw new Error("FAILED: a genuine singleton should have no count set");
console.log("Case 2 (a genuinely distinct message is left completely untouched, no count/groupedItems): PASS");

console.log("\nAll attention-item dedup assertions passed.");
