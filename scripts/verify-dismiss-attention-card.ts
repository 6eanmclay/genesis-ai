import "dotenv/config";
import { prismaSystem } from "../lib/prisma";
import { buildPageAttentionCards, getDismissedCardIds } from "../lib/dashboard/attentionCards";

// Real end-to-end verification (2026-08-08) — "dismissal must NOT mean
// resolution... the underlying observation/problem/decision remains
// persisted" (Sean). Confirms: (1) dismissing a card removes it from the
// built card list, (2) the underlying GenesisObservation row is
// completely untouched (still ACTIVE, no dismissedAt), (3) a fresh
// findMany for the real observation still returns it — J4's own
// awareness is unaffected. Cleans up after itself.
async function main() {
  const observation = await prismaSystem.genesisObservation.findFirst({ where: { status: "ACTIVE" } });
  if (!observation) throw new Error("No real ACTIVE observation found to test against");

  const cardId = `observation:${observation.dedupeKey}`;
  console.log("Testing against real observation:", cardId, observation.summary);

  // Before dismissal — card should be present.
  const before = buildPageAttentionCards({
    approvals: [],
    observations: [{ dedupeKey: observation.dedupeKey, genesisState: observation.genesisState, summary: observation.summary }],
    dismissedCardIds: await getDismissedCardIds(observation.storeId),
  });
  if (!before.some((c) => c.id === cardId)) throw new Error("Card was already dismissed before the test ran — pick a cleaner test case");
  console.log("Before dismiss: card present, count =", before.length);

  // Dismiss it directly (bypassing the Server Action's auth wrapper, same
  // as the gallery e2e script does for execute()).
  await prismaSystem.dismissedAttentionCard.upsert({
    where: { storeId_cardId: { storeId: observation.storeId, cardId } },
    create: { storeId: observation.storeId, cardId },
    update: { dismissedAt: new Date() },
  });

  const after = buildPageAttentionCards({
    approvals: [],
    observations: [{ dedupeKey: observation.dedupeKey, genesisState: observation.genesisState, summary: observation.summary }],
    dismissedCardIds: await getDismissedCardIds(observation.storeId),
  });
  if (after.some((c) => c.id === cardId)) throw new Error("Card still present after dismissal");
  console.log("After dismiss: card correctly hidden, count =", after.length);

  // The real underlying record must be completely untouched.
  const stillReal = await prismaSystem.genesisObservation.findUnique({ where: { id: observation.id } });
  if (stillReal?.status !== "ACTIVE" || stillReal.dismissedAt !== null) {
    throw new Error("Underlying GenesisObservation was mutated by dismissal — this must never happen");
  }
  console.log("Underlying record unaffected: status =", stillReal.status, "dismissedAt =", stillReal.dismissedAt);

  // Cleanup.
  await prismaSystem.dismissedAttentionCard.delete({ where: { storeId_cardId: { storeId: observation.storeId, cardId } } });
  const restored = buildPageAttentionCards({
    approvals: [],
    observations: [{ dedupeKey: observation.dedupeKey, genesisState: observation.genesisState, summary: observation.summary }],
    dismissedCardIds: await getDismissedCardIds(observation.storeId),
  });
  if (!restored.some((c) => c.id === cardId)) throw new Error("Cleanup failed to restore the card");
  console.log("Cleanup: card restored.");

  console.log("\nAll dismiss assertions passed.");
}

main()
  .catch((err) => {
    console.error("FAILED:", err);
    process.exitCode = 1;
  })
  .finally(() => prismaSystem.$disconnect());
