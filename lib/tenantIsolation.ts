import type { PrismaClient } from "@prisma/client";

// Track 0 (Operational Foundations) — structural tenant isolation.
// Defense-in-depth, not the primary authorization mechanism: the real gate
// is requireStorePermission (lib/permissions.ts), which independently
// re-verifies the actual authenticated session user against a target
// storeId on every mutation routed through execute(). That's already
// correct — confirmed by tracing it, not assumed — including a real,
// intentional, widespread "fetch a record by bare id, then authorize
// against whatever store it turns out to belong to" pattern (e.g.
// app/dashboard/actions.ts's editProduct/toggleProductActive/deleteProduct).
// That pattern is explicitly OUT of scope here — see ARCHITECTURE.md's
// Permissions & Roles section for the full reasoning on why it must stay
// untouched.
//
// What this closes instead: two narrower, real gaps found by tracing real
// call sites, not by assumption —
// 1. Mutations (update/delete/updateMany/deleteMany) on tenant-scoped
//    models often run *after* authorization has already passed, but the
//    mutation query itself has no storeId in its own `where` — e.g.
//    lib/execution/executables/products.ts's `prisma.product.delete({
//    where: { id } })`. A future bug that ever let a mismatched id/storeId
//    pair reach that point could mutate the wrong store's row; the DB
//    query itself currently has no way to know the difference.
// 2. Collection reads (findMany/count/aggregate) on tenant-scoped models
//    have no legitimate reason to omit store-scoping — unlike a
//    single-record lookup, there's no "authorize after" story for a list;
//    an omitted filter here leaks an entire other store's rows, not one.
//
// Single-record lookups (findFirst/findUnique) are deliberately NOT
// guarded — that's the confirmed-safe fetch-then-authorize pattern above.
// create/createMany/upsert/groupBy are also not guarded — out of the
// scope Sean approved for this pass.

const GUARDED_MUTATION_OPERATIONS = new Set(["update", "delete", "updateMany", "deleteMany"]);
const GUARDED_READ_OPERATIONS = new Set(["findMany", "count", "aggregate"]);

// Each tenant-scoped model's real, valid top-level scope keys — verified
// against prisma/schema.prisma field-by-field, not assumed uniform. Most
// models have a single required `storeId`; a few have a genuine dual-phase
// nullable pattern (draft vs. live, or store vs. user) where either key is
// independently a valid, real scope. `store` (the relation-filter form,
// e.g. `store: { slug, published: true }`) is checked separately below for
// every model, since it's a real, legitimate pattern regardless of which
// flat keys a given model has.
const TENANT_SCOPED_MODELS: Readonly<Record<string, readonly string[]>> = {
  storeMember: ["storeId"],
  storeIntegration: ["storeId"],
  storeMessage: ["storeId"],
  product: ["storeId"],
  newsletterSignup: ["storeId"],
  order: ["storeId"],
  generatedRecommendation: ["storeId"],
  cognitiveOutput: ["storeId"],
  approvalRequest: ["storeId"],
  delegatedAuthority: ["storeId"],
  postExecutionMeasurement: ["storeId"],
  genesisObservation: ["storeId"],
  businessRecord: ["storeId"],
  businessEvent: ["storeId"],
  businessEventCursor: ["storeId"],
  belief: ["storeId"],
  // Dual-phase (draft vs. live) — see ARCHITECTURE.md's Database model
  // section for the storeDraftId/storeId re-pointing pattern.
  storeGeneration: ["storeId", "storeDraftId"],
  executionLog: ["storeId", "storeDraftId"],
  // Dual-key (store vs. pre-store-creation user) — see this session's
  // AiUsageEvent/ProductEvent design comments in schema.prisma. ProductEvent
  // also has a storeDraftId, deliberately excluded here — its own schema
  // comment marks it "not a real relation... loose, unconstrained," so it
  // isn't treated as a reliable scoping key.
  productEvent: ["storeId", "userId"],
  // Experience-First Onboarding — a third real scope key, anonymousSessionToken
  // (lib/genesisModel.ts's GenesisModelScope), for AI usage recorded before
  // any account exists. Found via real testing, not by inspection: without
  // this, callGenesisModel's anonymous-scoped usage-ceiling *read*
  // (aggregate) was rejected by this guard, and that rejection was silently
  // absorbed by callGenesisModel's own "fail open on an infrastructure
  // error" catch — which meant anonymous usage was recorded correctly
  // (create isn't a guarded operation) but never actually checked against
  // a ceiling. Two independently-reasonable pieces of defensive code
  // combined into a real, silent gap; caught only by making it actually
  // fire in a real run.
  aiUsageEvent: ["storeId", "userId", "anonymousSessionToken"],
  // Growth Points Economy (Chapter 2) — the balance ledger. Plan is
  // deliberately excluded: it's global platform config, not a store's own
  // data, so no store-scoping requirement applies to it.
  growthPointTransaction: ["storeId"],
};

function isRealFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

// True if `where` includes a real value for one of `scopeKeys`, a
// non-empty nested `store: {...}` relation filter, or composes down to one
// via AND (any branch scoped is enough) / OR (every branch must be scoped,
// since an unscoped OR branch could still return unscoped rows).
function hasValidScope(where: unknown, scopeKeys: readonly string[]): boolean {
  if (!isRealFilterObject(where)) return false;

  if (scopeKeys.some((key) => key in where && where[key] !== undefined)) return true;
  if (isRealFilterObject(where.store)) return true;
  if (Array.isArray(where.AND) && where.AND.some((clause) => hasValidScope(clause, scopeKeys))) return true;
  if (Array.isArray(where.OR) && where.OR.length > 0 && where.OR.every((clause) => hasValidScope(clause, scopeKeys))) {
    return true;
  }

  return false;
}

export function withTenantIsolation<T extends PrismaClient>(client: T) {
  return client.$extends({
    name: "tenant-isolation",
    query: {
      $allModels: {
        async $allOperations({ model, operation, args, query }) {
          const modelKey = model.charAt(0).toLowerCase() + model.slice(1);
          const scopeKeys = TENANT_SCOPED_MODELS[modelKey];
          if (!scopeKeys) return query(args);

          const isGuardedMutation = GUARDED_MUTATION_OPERATIONS.has(operation);
          const isGuardedRead = GUARDED_READ_OPERATIONS.has(operation);
          if (!isGuardedMutation && !isGuardedRead) return query(args);

          const where = (args as { where?: unknown } | undefined)?.where;
          if (!hasValidScope(where, scopeKeys)) {
            throw new Error(
              `Tenant isolation: ${model}.${operation} was called without a store-scoping filter in its ` +
                `where clause (expected one of: ${scopeKeys.join(", ")}, or a nested "store" relation filter). ` +
                `See lib/tenantIsolation.ts for what this guards and why.`
            );
          }

          return query(args);
        },
      },
    },
  });
}
