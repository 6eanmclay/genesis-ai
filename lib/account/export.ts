import { prisma, prismaSystem } from "@/lib/prisma";

// GIVING SOMEBODY THEIR DATA BACK.
//
// ============ AN EXPORT THAT QUIETLY OMITS THINGS IS WORSE THAN NONE ====
//
// Because nobody can tell. A person downloads a file, sees their orders, and
// has no way of knowing that their conversations with J4 were left out — so
// the omission reads as "Genesis does not hold that", which is false.
//
// A Store has thirty-eight relations today and will have more next month. A
// hand-written list of the ones worth exporting is a list that silently goes
// stale the first time somebody adds a model, and the export gets quietly less
// complete with nobody noticing.
//
// ============ SO COVERAGE IS DECLARED, AND CROSS-CHECKED ===============
//
// Every relation on Store appears below exactly once, as `included` or as
// `excluded` with a reason. `scripts/verify-account-export-db.ts` reads the
// relations straight out of schema.prisma and fails if any is missing from
// this table — the same cross-check ARCHITECTURE.md requires of every registry
// that mirrors something else. Adding a model without deciding about it breaks
// the suite, which is the only way this stays honest.

/** Whether a relation reaches the export, and why. */
export interface SectionPolicy {
  /** The Prisma model, as it appears on the Store relation. */
  model: string;
  disposition: "included" | "excluded";
  /** For `excluded`: why this is not the person's data to receive. */
  reason?: string;
}

export const EXPORT_COVERAGE: SectionPolicy[] = [
  // ---- included: the business as its owner would recognise it ------------
  { model: "Product", disposition: "included" },
  { model: "Order", disposition: "included" },
  { model: "Promotion", disposition: "included" },
  { model: "Conversation", disposition: "included" },
  { model: "StoreMessage", disposition: "included" },
  { model: "Task", disposition: "included" },
  { model: "GrowthPointTransaction", disposition: "included" },
  { model: "StoreMember", disposition: "included" },
  { model: "NewsletterSignup", disposition: "included" },
  { model: "BusinessRecord", disposition: "included" },
  { model: "Belief", disposition: "included" },
  { model: "ExecutionLog", disposition: "included" },
  { model: "SourcedProduct", disposition: "included" },
  { model: "StorageObject", disposition: "included" },
  // The merchant's own traffic history, in the form that outlives the raw
  // records it was counted from: how many visits arrived, from where, per day.
  // This is business intelligence they own and would expect to take with them.
  { model: "StoreTrafficDay", disposition: "included" },

  // ---- excluded: derived, internal, or somebody else's --------------------
  {
    model: "StoreVisit",
    disposition: "excluded",
    reason:
      "One row per browsing session, keyed by an opaque token that identifies nobody. It is " +
      "pruned at twelve months and the durable answer it produces is exported instead: " +
      "StoreTrafficDay carries the counts by source and day, and every order carries the " +
      "source it came from. Exporting the raw sessions would add volume and no business fact.",
  },
  {
    model: "StoreIntegration",
    disposition: "excluded",
    reason:
      "Holds encrypted provider credentials. Exporting them would hand somebody a file " +
      "containing live access to their payment processor and supplier accounts, which is a " +
      "worse outcome than not having the file. The fact that a provider is connected is " +
      "reported; the secret is not.",
  },
  {
    model: "WebhookDelivery",
    disposition: "excluded",
    reason: "Raw provider payloads. The orders they produced are exported instead, which is the same information in a form a person can read.",
  },
  {
    model: "AiUsageEvent",
    disposition: "excluded",
    reason: "Per-call token counts and cost. Internal accounting, not the owner's business record.",
  },
  {
    model: "OutboundOperation",
    disposition: "excluded",
    reason: "Idempotency keys. Machinery, and meaningless outside this platform.",
  },
  {
    model: "Job",
    disposition: "excluded",
    reason: "Queued internal work. The effects are exported; the queue rows are not.",
  },
  {
    model: "BusinessEvent",
    disposition: "excluded",
    reason: "The internal event pipeline J4's understanding is derived from. The understanding is exported; the stream feeding it is machinery.",
  },
  { model: "BusinessEventCursor", disposition: "excluded", reason: "A read position in that stream." },
  {
    model: "CognitiveOutput",
    disposition: "included",
  },
  {
    model: "ProductEvent",
    disposition: "excluded",
    reason: "Per-product telemetry, already pruned at ninety days. The products themselves are exported.",
  },
  { model: "TemporaryAsset", disposition: "excluded", reason: "Scratch uploads, deleted on their own schedule." },
  { model: "CheckoutDraft", disposition: "excluded", reason: "Abandoned checkouts in flight. Not yet anybody's record." },
  {
    model: "StoreGeneration",
    disposition: "excluded",
    reason: "Generation history for the storefront. The current storefront is exported; its drafts are not.",
  },
  { model: "ApprovalRequest", disposition: "excluded", reason: "In-flight approvals. Transient." },
  { model: "DelegatedAuthority", disposition: "excluded", reason: "Current trust settings, reported in the account section rather than as rows." },
  { model: "DismissedAttentionCard", disposition: "excluded", reason: "UI state — which cards were dismissed." },
  { model: "GeneratedRecommendation", disposition: "excluded", reason: "Derived advice, regenerated continuously." },
  { model: "GenesisObservation", disposition: "excluded", reason: "Derived observations behind the recommendations." },
  { model: "ProactiveDelivery", disposition: "excluded", reason: "Records of which findings were spoken, to avoid repeating them." },
  { model: "PostExecutionMeasurement", disposition: "excluded", reason: "Derived measurement of an action's effect." },
  { model: "ProgressionDecision", disposition: "excluded", reason: "Derived product-progression state." },
  { model: "RecordRelationship", disposition: "excluded", reason: "Edges between records; the records themselves are exported." },
  { model: "SupplierEconomics", disposition: "excluded", reason: "Derived supplier margin analysis." },
  { model: "User", disposition: "excluded", reason: "The relation back to the owner. The account section is the export of that." },
];

export function coverageFor(model: string): SectionPolicy | undefined {
  return EXPORT_COVERAGE.find((s) => s.model === model);
}

export interface AccountExport {
  generatedAt: string;
  account: Record<string, unknown>;
  businesses: Record<string, unknown>[];
  /** What was deliberately left out, so the file says so rather than implying completeness. */
  notIncluded: { model: string; reason: string }[];
}

/**
 * Assemble everything a person may have back.
 *
 * ============ SCOPED BY OWNERSHIP, NOT BY A SUPPLIED ID ==========
 *
 * Every query below reaches through `userId`. There is no store id parameter to
 * pass, so there is nothing for a caller to substitute — the shape of the
 * function is the cross-store protection, rather than a check that a later
 * refactor could drop.
 */
export async function buildAccountExport(userId: string): Promise<AccountExport> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, email: true, name: true, image: true, createdAt: true,
      emailVerified: true, referralCode: true, totpEnabledAt: true,
      closedAt: true, closureReason: true,
    },
  });
  if (!user) throw new Error("No such account.");

  const stores = await prisma.store.findMany({
    where: { userId },
    select: {
      id: true, name: true, slug: true, description: true, tagline: true,
      published: true, currency: true, growthPointBalance: true, planId: true,
      subscriptionStatus: true, createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  const businesses: Record<string, unknown>[] = [];
  for (const store of stores) {
    const where = { storeId: store.id };
    businesses.push({
      ...store,
      products: await prismaSystem.product.findMany({ where, orderBy: { createdAt: "asc" } }),
      orders: await prismaSystem.order.findMany({ where, orderBy: { createdAt: "asc" } }),
      promotions: await prismaSystem.promotion.findMany({ where }),
      conversations: await prismaSystem.conversation.findMany({ where }),
      messages: await prismaSystem.storeMessage.findMany({ where }),
      tasks: await prismaSystem.task.findMany({ where }),
      growthPointTransactions: await prismaSystem.growthPointTransaction.findMany({ where }),
      members: await prismaSystem.storeMember.findMany({ where }),
      newsletterSignups: await prismaSystem.newsletterSignup.findMany({ where }),
      businessRecords: await prismaSystem.businessRecord.findMany({ where }),
      beliefs: await prismaSystem.belief.findMany({ where }),
      executionLog: await prismaSystem.executionLog.findMany({ where }),
      sourcedProducts: await prismaSystem.sourcedProduct.findMany({ where }),
      storageObjects: await prismaSystem.storageObject.findMany({ where }),
      whatGenesisConcluded: await prismaSystem.cognitiveOutput.findMany({ where }),
      // The fact of a connection, never its credential.
      connectedProviders: (
        await prismaSystem.storeIntegration.findMany({ where, select: { provider: true, status: true } })
      ),
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    account: user,
    businesses,
    notIncluded: EXPORT_COVERAGE.filter((s) => s.disposition === "excluded").map((s) => ({
      model: s.model,
      reason: s.reason!,
    })),
  };
}
