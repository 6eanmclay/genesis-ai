import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toUnderstandingGroups } from "@/lib/j4/understandingGroups";
import { PROVENANCE_LABEL, RECORD_PROVENANCE } from "@/lib/businessModel/provenance";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";

// WHAT J4 BELIEVES, AND WHO SAID SO (2026-09-11).
//
//   npx tsx scripts/verify-understanding-evidence.ts
//
// The Understanding surface produced `lines: string[]` — fifteen groups of
// prose in which every fact arrived with no author, no confidence and no
// handle. On the one surface whose entire job is saying what J4 believes and
// why.
//
// It did not render the six owner-authoritative claims AT ALL. In production
// all 48 brand-claim rows are INFERENCE, promoted from a generated blueprint,
// so an owner looking for "what does J4 think about my business" was shown
// neither the claims nor the fact that J4 had concluded them itself.
//
// THE INVARIANT THIS PROTECTS is not "every fact has a source". It is the
// opposite: a fact may only claim a source the canonical model actually
// records, and must claim nothing otherwise. An invented attribution is worse
// than an absent one, because it is unfalsifiable by the person reading it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/**
 * A fixture carrying only what the mapper reads.
 *
 * Partial on purpose: if the mapper starts reading a field this omits it
 * throws, which is the failure we want rather than a quiet pass on invented
 * data.
 */
function understandingWith(opts: {
  offeringProvenance?: "OWNER" | "INFERENCE" | null;
  withBelief?: boolean;
}): BusinessUnderstanding {
  return {
    profile: {
      identity: {
        name: "Cubit & Coil",
        tagline: "Hand-wound copper",
        description: "A rustic candle house.",
        targetAudience: "People who lift at 5am",
        brandPersonality: null,
        brandVoiceAndTone: null,
        uniqueSellingProposition: null,
        offering: "Hand-wound copper tensor rings",
        intent: null,
      },
      identityProvenance: {
        offering:
          opts.offeringProvenance === null
            ? null
            : { statement: "Hand-wound copper tensor rings", provenance: opts.offeringProvenance ?? "OWNER", provenanceDetail: null, recordId: "rec_offering", statedAt: null },
        intent: null,
        // THE PRODUCTION CASE: a brand claim J4 concluded, not one the owner made.
        targetAudience: { statement: "People who lift at 5am", provenance: "INFERENCE", provenanceDetail: null, recordId: "rec_audience", statedAt: null },
        brandPersonality: null,
        brandVoice: null,
        sellingProposition: null,
      },
      classification: { businessCategories: [], revenueStreams: [] },
      offerings: { activeCount: 3, trends: [], items: [], performance: [] },
      revenue: { last30DaysInCents: 58603, allTimeInCents: 147620 },
      customers: {
        totalContactCount: 6,
        segments: { repeatCustomers: [], highValueCustomers: [], lapsedCustomers: [], newCustomers: [] },
        segmentTrends: {},
      },
      people: { owner: null, members: [], employees: [] },
      suppliers: [{ id: "rec_supplier", data: { name: "Copper Co" } }],
      locations: [],
      goals: [],
      challenges: [],
      assets: [],
      connectedSystems: [{ displayName: "Stripe", status: "CONNECTED", syncedAgoLabel: "2 minutes ago", isStale: false }],
    },
    beliefs: opts.withBelief
      ? [{ claim: "Repeat buyers come back within 30 days", confidence: 0.72, maturity: "well_supported" }]
      : [],
    recentDecisions: [],
    activeThoughts: [],
    currentAssets: {},
    platformRelationship: { planName: null, growthPointBalance: 0, subscriptionStatus: null, businessPartnerTrialEndsAt: null },
  } as unknown as BusinessUnderstanding;
}

const groups = toUnderstandingGroups(understandingWith({ withBelief: true }), "USD");
const all = groups.flatMap((g) => g.facts);
const identity = groups.find((g) => g.key === "identity")!;

// ---- 1. the six claims finally reach the owner --------------------------
console.log("\n=== the owner-authoritative claims are shown at all ===\n");
const offering = identity.facts.find((f) => f.text.startsWith("Offers:"));
const audience = identity.facts.find((f) => f.text.startsWith("For:"));
check("what the business offers is rendered", !!offering, offering?.text ?? "ABSENT");
check("and who it is for", !!audience, audience?.text ?? "ABSENT");

// ---- 2. inferred is never presented as owner-stated ---------------------
//
// The production case: all 48 brand-claim rows are INFERENCE. An owner must be
// able to tell their own words from J4's conclusions.
console.log("\n=== J4's conclusions are not the owner's words ===\n");
check("an owner-stated claim is attributed to the owner", offering?.source === "OWNER", String(offering?.source));
check("a claim J4 concluded is attributed to J4", audience?.source === "INFERENCE", String(audience?.source));
check("  and is NOT labelled as owner-stated", audience?.source !== "OWNER", String(audience?.source));
check("the two read differently to a person",
  PROVENANCE_LABEL["OWNER"] !== PROVENANCE_LABEL["INFERENCE"],
  `"${PROVENANCE_LABEL["OWNER"]}" vs "${PROVENANCE_LABEL["INFERENCE"]}"`);

// ---- 3. a real handle for a future correction ---------------------------
console.log("\n=== every claim points at something real ===\n");
check("an owner claim carries its record id", offering?.recordId === "rec_offering", String(offering?.recordId));
check("and so does an inferred one", audience?.recordId === "rec_audience", String(audience?.recordId));
check("a supplier row carries its record id",
  groups.find((g) => g.key === "suppliers")?.facts[0]?.recordId === "rec_supplier",
  String(groups.find((g) => g.key === "suppliers")?.facts[0]?.recordId));

// ---- 4. NOTHING IS INVENTED --------------------------------------------
//
// The invariant that matters most. A fact may only claim a source the model
// actually records.
console.log("\n=== no attribution is invented ===\n");
const legal = new Set<string>(RECORD_PROVENANCE);
check("every source is a real provenance value",
  all.every((f) => f.source === null || legal.has(f.source)),
  all.map((f) => f.source).filter(Boolean).join(", "));

// The store name has no recorded provenance, so it claims none.
const name = identity.facts.find((f) => f.text.startsWith("Cubit & Coil"));
check("a fact with no recorded source claims none", name?.source === null, String(name?.source));
check("  and no confidence either", name?.confidence === null, String(name?.confidence));

// A CanonicalRecord carries no provenance column today, so nothing may invent
// one for it — this is the temptation the slice exists to refuse.
const supplier = groups.find((g) => g.key === "suppliers")?.facts[0];
check("a record with no provenance column gets no source", supplier?.source === null, String(supplier?.source));

// ---- 5. confidence exists in exactly one place --------------------------
console.log("\n=== a confidence is shown only where one is computed ===\n");
const belief = groups.find((g) => g.key === "beliefs")?.facts[0];
check("a belief carries its real confidence", belief?.confidence === 0.72, String(belief?.confidence));
check("and is marked as J4's own conclusion", belief?.source === "INFERENCE", String(belief?.source));
const withConfidence = all.filter((f) => f.confidence !== null);
check("nothing else claims a confidence", withConfidence.length === 1, `${withConfidence.length} facts carry one`);

// ---- 6. derived figures say they are derived ----------------------------
console.log("\n=== computed figures are attributed to the records they came from ===\n");
const revenue = groups.find((g) => g.key === "revenue")?.facts[0];
check("revenue is DERIVED from the store's own orders", revenue?.source === "DERIVED", String(revenue?.source));
const system = groups.find((g) => g.key === "systems")?.facts[0];
check("a connected system's data is attributed to the connector", system?.source === "CONNECTOR", String(system?.source));
const description = identity.facts.find((f) => f.text === "A rustic candle house.");
check("generated storefront copy says it was generated", description?.source === "GENERATED", String(description?.source));

// ---- 7. the surface cannot invent its own words -------------------------
console.log("\n=== the UI reads the labels, it does not write them ===\n");
const ui = readFileSync(join(process.cwd(), "app", "j4", "J4Workspace.tsx"), "utf8");
check("the Understanding view imports the canonical labels",
  /PROVENANCE_LABEL/.test(ui) && /from "@\/lib\/businessModel\/provenance"/.test(ui));
check("and renders no source line when there is no source",
  /f\.source \?/.test(ui) || /f\.source &&/.test(ui),
  "an absent source must render nothing");

// NO FAKE CORRECTION CONTROL. Sean: "Do not build a fake correction action
// yet." The handle is carried; the button is not.
const understandingBlock = ui.slice(ui.indexOf('data-testid="understanding-fact"'), ui.indexOf('data-testid="understanding-fact"') + 1400);
check("a fact offers no correction control it cannot perform",
  !/<button|onClick/.test(understandingBlock),
  "recordId is carried for a future correction; no control claims to do it yet");

// ---- 8. a missing claim is absent, not blank ----------------------------
console.log("\n=== a claim nobody has made is simply not there ===\n");
const noOffering = toUnderstandingGroups(understandingWith({ offeringProvenance: null }), "USD");
const noOfferingIdentity = noOffering.find((g) => g.key === "identity")!;
check("no record means no row, rather than an empty one",
  !noOfferingIdentity.facts.some((f) => f.text.startsWith("Offers:")),
  noOfferingIdentity.facts.map((f) => f.text).join(" | "));

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
