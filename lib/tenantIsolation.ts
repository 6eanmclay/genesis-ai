import type { PrismaClient } from "@prisma/client";
import { recordSignal, SIGNAL_KINDS } from "@/lib/security/signals";

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
// create/createMany/upsert are also not guarded — out of the scope Sean
// approved for the original pass.
//
// groupBy WAS in that deferred list and is now guarded (2026-08-23). It is a
// collection read like the three below it, and reason 2 above applies to it
// word for word: there is no "authorize after" story for an aggregate, and an
// omitted filter returns every store's rows rolled up rather than one row from
// the wrong store. The shape of that leak is the worst of the four — the real
// call sites group ORDERS by buyer email and GROWTH POINT TRANSACTIONS by
// action, so an unscoped one is other people's customers and other people's
// money, already summed.
//
// Safe to add because every existing call site already complies: all five
// groupBy calls on this client pass `where: { storeId }` today, checked before
// changing this. Nothing was relying on the gap.

export const GUARDED_MUTATION_OPERATIONS = new Set(["update", "delete", "updateMany", "deleteMany"]);
export const GUARDED_READ_OPERATIONS = new Set(["findMany", "count", "aggregate", "groupBy"]);

// Each tenant-scoped model's real, valid top-level scope keys — verified
// against prisma/schema.prisma field-by-field, not assumed uniform. Most
// models have a single required `storeId`; a few have a genuine dual-phase
// nullable pattern (draft vs. live, or store vs. user) where either key is
// independently a valid, real scope. `store` (the relation-filter form,
// e.g. `store: { slug, published: true }`) is checked separately below for
// every model, since it's a real, legitimate pattern regardless of which
// flat keys a given model has.
const TENANT_SCOPED_MODELS: Readonly<Record<string, readonly string[]>> = {
  // Dual-key (store vs. the person), added 2026-08-20 for business context.
  //
  // "Which businesses can this account reach" is inherently a cross-store
  // question, and StoreMember is where it is answered. `userId` is a required
  // column, so filtering by it bounds the read to exactly one person's own
  // membership rows — it leaks nothing, which is the actual test this guard
  // applies. Same dual-key shape as productEvent and aiUsageEvent below, and
  // added for the same reason they were: a real call site that is genuinely
  // scoped by a key this map had not been told about.
  //
  // Deliberately NOT a bypass, and it is worth being precise about why. The
  // rejection this replaces was correct on its own terms — an unscoped
  // findMany on StoreMember does leak other tenants' rows. What was wrong was
  // the map, not the rule: `where: { userId }` is a real scope, and the
  // negation and relation-filter bypasses closed below still apply to it.
  storeMember: ["storeId", "userId"],
  storeIntegration: ["storeId"],

  // ============ SEVEN MODELS THE MAP HAD NEVER BEEN TOLD ABOUT =========
  //
  // Added 2026-08-31 by the fetch-then-authorize sweep. Every one carries a
  // storeId and every one was missing here, so the guard silently did not
  // cover them — and nothing in the repository would ever have said so,
  // because a hand-written mirror of the schema has no way to notice the
  // schema moving.
  //
  // Nothing was leaking. All but one call site already passed a storeId, and
  // most of these tables are reached through `prismaSystem`, which bypasses
  // this guard by design. The defect was the silence: seven models sat
  // outside a protection everybody would have said covered them, and the
  // eighth would have too.
  //
  // `scripts/verify-tenant-isolation-db.ts` now derives the store-scoped
  // models from schema.prisma and fails when one is absent from this map
  // without an explicit exemption, so this cannot drift again — the same rule
  // ARCHITECTURE.md applies to every registry that mirrors another.
  //
  // storeId is nullable on six of the seven (a job or a delivery may belong to
  // no business). That does not weaken the entry: the guard asks whether the
  // FILTER names a business, not whether the column can be null.
  job: ["storeId"],
  outboundOperation: ["storeId"],
  securitySignal: ["storeId"],
  storageEvent: ["storeId"],
  storageObject: ["storeId"],
  storeTrafficDay: ["storeId"],
  storeVisit: ["storeId"],
  temporaryAsset: ["storeId"],
  webhookDelivery: ["storeId"],
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
  dismissedAttentionCard: ["storeId"],
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

  // P0.5 sourcing, added 2026-08-20. Every one of these holds a fact about what
  // a business sells or what it would cost them, and a collection read that
  // omitted the store would return another business's supplier terms — the
  // narrowest, most expensive kind of leak this map exists to prevent. All three
  // were built store-scoped throughout; adding them here means a future query
  // that forgets cannot compile-and-run rather than merely being unlikely.
  sourcedProduct: ["storeId"],
  supplierEconomics: ["storeId"],
  progressionDecision: ["storeId"],

  // ============ THE EIGHT THAT HAD NO NET (2026-08-27) ====================
  //
  // Found by sweeping the schema for models carrying `storeId` and comparing
  // that list to this map, rather than by reading either — the two had drifted
  // by eight models, every one of them added since this map was last widened.
  //
  // NOT A LEAK, AND WORTH BEING PRECISE ABOUT THAT. All fourteen live call
  // sites across these models already pass `storeId`, checked one by one
  // before adding them here. What was missing was the ENFORCEMENT: the guard
  // returns early for any model it does not know (`if (!scopeKeys) return
  // query(args)`), so a forgetful query against one of these would have
  // compiled, run, and returned another business's rows without anything
  // objecting.
  //
  // That distinction is why adding them is safe: nothing should begin throwing,
  // and the full suite is what proves it rather than the reasoning.
  //
  // Several are squarely on the isolation list a second business depends on:
  //
  //   conversation        every word an owner has said to J4, per business
  //   proactiveDelivery   what J4 raised unprompted, and to which business
  //   task                the work a business has outstanding
  //   recordRelationship  the edges of the business understanding graph
  //   promotion           what a shop has on sale
  //   checkoutDraft       a customer's frozen order, mid-payment
  //
  // A collection read that forgot the store on any of them would show one
  // owner another owner's conversations, sales or orders.
  conversation: ["storeId"],
  proactiveDelivery: ["storeId"],
  task: ["storeId"],
  recordRelationship: ["storeId"],
  promotion: ["storeId"],
  checkoutDraft: ["storeId"],
  supplierRequestEvent: ["storeId"],
  businessPartnerTrialGrant: ["storeId"],
};

function isRealFilterObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

// Two bypasses closed 2026-08-20, found by probing this function rather than
// reading it. Both passed the old check while selecting other tenants' rows:
//
//   { storeId: { not: "mine" } }        every store EXCEPT mine
//   { store: { published: true } }      every published store on the platform
//
// The first was accepted because `storeId` was merely PRESENT; the second
// because `store` was merely a non-empty object. Presence is not scoping — a
// negation is the exact opposite of it, and a relation filter that names no
// particular store narrows nothing.

/**
 * Does this value pin the query to specific store(s)? — pure.
 *
 * `in: []` is allowed even though it is empty: it matches no rows, so it
 * cannot leak, and rejecting it would fail a legitimate query over an
 * empty list.
 */
function isIdentifyingValue(value: unknown): boolean {
  if (typeof value === "string" || typeof value === "number") return true;
  if (!isRealFilterObject(value)) return false;
  if ("equals" in value && (typeof value.equals === "string" || typeof value.equals === "number")) return true;
  if ("in" in value && Array.isArray(value.in)) return true;
  // Everything else — `not`, `notIn`, `contains`, a bare `{}` — either selects
  // other tenants or selects everything.
  return false;
}

// A `store: {...}` relation filter is legitimate (the storefront looks products
// up by slug), but only when it names a particular store.
const STORE_IDENTIFYING_KEYS = ["id", "slug", "userId"] as const;

function isIdentifyingStoreFilter(value: unknown): boolean {
  if (!isRealFilterObject(value)) return false;
  return STORE_IDENTIFYING_KEYS.some((key) => key in value && isIdentifyingValue(value[key]));
}

/**
 * True if `where` pins the query to specific store(s) — pure, and exported so
 * scripts/verify-tenant-isolation.ts can assert it without a database.
 *
 * AND: any one scoped branch is enough, since every branch must match.
 * OR: every branch must be scoped, since one unscoped branch returns
 * unscoped rows on its own.
 */
export function hasValidScope(where: unknown, scopeKeys: readonly string[]): boolean {
  if (!isRealFilterObject(where)) return false;

  if (scopeKeys.some((key) => key in where && isIdentifyingValue(where[key]))) return true;
  if (isIdentifyingStoreFilter(where.store)) return true;
  if (Array.isArray(where.AND) && where.AND.some((clause) => hasValidScope(clause, scopeKeys))) return true;
  if (Array.isArray(where.OR) && where.OR.length > 0 && where.OR.every((clause) => hasValidScope(clause, scopeKeys))) {
    return true;
  }

  return false;
}

/** The models this guard covers, exported for the same test. */
export const TENANT_SCOPED_MODEL_KEYS = TENANT_SCOPED_MODELS;

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
            // ============ THE VIOLATION IS NOW RECORDED (2026-08-30) ===
            //
            // This threw into the void. A query reaching across businesses is
            // the single most serious thing this codebase can do wrong, and the
            // only trace was an exception somebody might see in a log.
            //
            // Fire-and-forget rather than awaited: this extension sits in the
            // hot path of every guarded query, and the throw below must not
            // wait on a write. recordSignal never rejects, so the floating
            // promise cannot become an unhandled rejection.
            void recordSignal({
              kind: SIGNAL_KINDS.isolationViolation,
              // CRITICAL, not warning. Unlike a permission denial, this one
              // should be impossible — reaching it means a query was written
              // without a scope, not that somebody clicked the wrong thing.
              severity: "critical",
              actorKind: "system",
              surface: `${model}.${operation}`,
              detail: { model, operation, expectedScopeKeys: scopeKeys },
            });
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
