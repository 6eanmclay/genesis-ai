import { upsertTask, resolveStaleTasks } from "./tasks";

// BUSINESS_ASSETS_ARCHITECTURE.md M1 — the proof-of-concept pass: one real
// dual-write of an existing detected condition (no active products, already
// real via lib/dashboard/needsAttention.ts's getStateIssues and
// BusinessJourney.tsx's own checklist) plus one genuinely new detector with
// no prior detection logic anywhere (no logo). Both use priority
// "opportunity", never "FAILED"/"WARNING" — these are calm, routine-setup
// signals in BusinessJourney's own voice, not genuine issues, and must
// never read like an alarm the way AttentionPanel's real failures do (see
// AttentionPanel.tsx's own comment on why that distinction is deliberate).
export async function runTaskDetection(
  storeId: string,
  params: { hasActiveProducts: boolean; logoUrl: string | null }
): Promise<void> {
  const freshDedupeKeys: string[] = [];

  if (!params.hasActiveProducts) {
    const dedupeKey = "task.no_products";
    freshDedupeKeys.push(dedupeKey);
    await upsertTask(storeId, {
      dedupeKey,
      source: "state_issue",
      title: "Add your first product",
      summary: "You have no active products yet — customers need something real to buy before your store can sell anything.",
      context: { hasActiveProducts: params.hasActiveProducts },
      priority: "opportunity",
      actionHref: "/dashboard/products",
    });
  }

  if (!params.logoUrl) {
    const dedupeKey = "task.no_logo";
    freshDedupeKeys.push(dedupeKey);
    await upsertTask(storeId, {
      dedupeKey,
      source: "brand_gap",
      title: "Add a logo",
      summary: "Your store doesn't have a logo yet — it's one of the first things a visitor notices, and J4 can generate real options from your brand identity.",
      context: { logoUrl: params.logoUrl },
      priority: "opportunity",
      actionHref: "/dashboard/brand",
    });
  }

  await resolveStaleTasks(storeId, "state_issue", freshDedupeKeys.filter((k) => k === "task.no_products"));
  await resolveStaleTasks(storeId, "brand_gap", freshDedupeKeys.filter((k) => k === "task.no_logo"));
}
