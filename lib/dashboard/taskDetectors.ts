import { prisma } from "@/lib/prisma";
import { upsertTask, resolveStaleTasks } from "./tasks";

// Store.blueprint is opaque Json — same read-site cast pattern
// lib/execution/executables/updateSeo.ts already uses for the exact same
// field, so this detector and the action that resolves it agree on shape.
interface BlueprintShape {
  marketingAssets?: { seoTitle?: string; seoMetaDescription?: string };
  [key: string]: unknown;
}

// BUSINESS_ASSETS_ARCHITECTURE.md M1/M3 — M1's proof-of-concept pass
// (no_products dual-write, no_logo genuinely new detector) plus M3's own
// real proof point: no_seo, the first task whose actionType
// ("update_seo") is now genuinely auto-executable (see genesisActions.ts's
// promotion of update_seo to authorizationTier "auto") — the concrete case
// that proves the whole conversational-auto-execute mechanism end to end,
// not just plumbing with nothing real to trigger it. All three use
// priority "opportunity", never "FAILED"/"WARNING" — calm, routine-setup
// signals in BusinessJourney's own voice, not genuine issues (see
// AttentionPanel.tsx's own comment on why that distinction is deliberate).
export async function runTaskDetection(
  storeId: string,
  params: { hasActiveProducts: boolean; logoUrl: string | null; blueprint: unknown }
): Promise<void> {
  const freshDedupeKeys: string[] = [];
  const blueprint = (params.blueprint as BlueprintShape | null) ?? {};

  if (!params.hasActiveProducts) {
    const dedupeKey = "task.no_products";
    freshDedupeKeys.push(dedupeKey);
    await upsertTask(storeId, {
      dedupeKey,
      source: "state_issue",
      title: "Add your first product",
      summary: "You have no active products yet — customers need something real to buy before your store can sell anything.",
      context: { hasActiveProducts: params.hasActiveProducts },
      // create_product's own maxAuthorityTier is hard-locked to always_ask
      // (a real, deliberate safety boundary — see genesisActions.ts) — this
      // task will always end in a real approval click, never auto-execute,
      // even though it now has a real actionType binding for completion
      // tracking (lib/dashboard/tasks.ts's completeTasksForAction).
      actionType: "create_product",
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
      // No actionType — no real GENESIS_ACTIONS entry sets a logo yet.
      // Honest null rather than a fabricated binding.
      priority: "opportunity",
      actionHref: "/dashboard/brand",
    });
  }

  if (!blueprint.marketingAssets?.seoTitle) {
    const dedupeKey = "task.no_seo";
    freshDedupeKeys.push(dedupeKey);
    await upsertTask(storeId, {
      dedupeKey,
      source: "state_issue",
      title: "Add an SEO title and description",
      summary: "Your store has no SEO title or meta description yet, so search engines have nothing real to show for it.",
      context: { seoTitle: blueprint.marketingAssets?.seoTitle ?? null },
      actionType: "update_seo",
      trustLevel: "auto_execute",
      priority: "opportunity",
      actionHref: "/dashboard/website",
    });
  }

  await resolveStaleTasks(storeId, "state_issue", freshDedupeKeys.filter((k) => k !== "task.no_logo"));
  await resolveStaleTasks(storeId, "brand_gap", freshDedupeKeys.filter((k) => k === "task.no_logo"));

  // P0.5 — the supplier-economics question, raised from the same pass as every
  // other thing Genesis needs from an owner (2026-08-21).
  //
  // THIS IS THE DETECTION PASS, so this is where it belongs. A separate
  // scheduler for one question would be a second thing to run, a second thing
  // to forget to run, and a second answer to "why did this card appear now".
  //
  // GATED, because it is not free. raiseEconomicsQuestions runs the whole
  // progression engine, and Home awaits this call so the cards are current on
  // THIS load rather than lagging a view behind. The gate is exact rather than a
  // heuristic: a question can only concern a product that names a supplier
  // listing, so a store with none cannot produce one, and one indexed count
  // settles it. Everything past the gate is a store that genuinely might have a
  // deepen worth unblocking.
  const sourcedProducts = await prisma.product.count({
    where: {
      storeId,
      active: true,
      // BOTH parts present. Prisma reads a NOT array as "not all of these",
      // which would have let a product with a source and no external id through.
      sourceKey: { not: null },
      externalProductId: { not: null },
    },
  });
  if (sourcedProducts > 0) {
    const { raiseEconomicsQuestions } = await import("@/lib/sourcing/economicsQuestions");
    // Its own source and its own stale sweep, so it can neither be retired by
    // the sweeps above nor retire anything they own.
    await raiseEconomicsQuestions(storeId);
  }
}
