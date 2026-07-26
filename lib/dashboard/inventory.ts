import type { InventorySnapshot } from "./types";

// An honest substitute, not real inventory management — Product has no
// stock-quantity field at all today, and inventing one is a real product/
// schema decision, not something to add as a dashboard-phase side effect.
// Pure function: reuses the `products` array page.tsx already fetches.
export function getInventorySnapshot(products: { active: boolean }[]): InventorySnapshot {
  const activeCount = products.filter((p) => p.active).length;
  const totalCount = products.length;
  return { activeCount, inactiveCount: totalCount - activeCount, totalCount };
}
