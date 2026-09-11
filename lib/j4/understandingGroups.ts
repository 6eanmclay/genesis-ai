import { formatMoney } from "@/lib/money";
import type { RecordProvenance } from "@prisma/client";
import type { BusinessUnderstanding } from "@/lib/businessModel/understanding";
import type { UnderstandingGroup, UnderstandingFact } from "@/app/j4/J4Workspace";

/**
 * WHAT J4 UNDERSTANDS, SHAPED FOR THE OFFICE.
 *
 * ============ MOVED OUT OF J4Surface (2026-09-09) ======================
 *
 * Not a refactor for tidiness. getBusinessUnderstanding is the single most
 * expensive read on the Office path - 921ms measured against production, where
 * the whole rest of the critical path is 167ms - and it sat inside the awaited
 * Promise.all that renders the shell. So every owner waited most of a second
 * for a picture most of them were not about to open, on EVERY dashboard page,
 * because the layer pays the same cost.
 *
 * Sean's tier for it is on-demand: "anything that only needs to load after I
 * open/interact with it". Living here lets the server action load it when the
 * Understanding view is actually opened, without the component that renders
 * the Office importing a 900ms dependency to do it. THAT IS UNCHANGED by the
 * evidence work below: this is the same single call, mapped differently.
 *
 * ============ AND EVERY FACT NOW CARRIES ITS EVIDENCE (2026-09-11) =====
 *
 * This produced `lines: string[]`. Fifteen groups of prose, and every fact
 * arrived at the owner with no author, no confidence and no handle - on the
 * one surface whose entire purpose is saying what J4 believes and why.
 *
 * That mattered most for the six owner-authoritative claims, which THIS FILE
 * DID NOT RENDER AT ALL. What the business offers, what the owner is trying to
 * do, who they are for, how they sound, what makes them different: the model
 * carried all six and the Understanding view showed none of them. In
 * production all 48 brand-claim rows are INFERENCE - J4's own conclusions,
 * promoted from a generated blueprint - so an owner looking for "what does J4
 * think about my business" was shown neither the claims nor the fact that J4
 * had made them up.
 *
 * ============ NULL IS THE DEFAULT, AND THAT IS THE POINT ===============
 *
 * `source`, `confidence` and `recordId` are null unless the canonical model
 * genuinely records one. Nothing here derives an author from the group a fact
 * sits in, and nothing computes a confidence. Where J4 does not know, the
 * surface says nothing rather than something plausible.
 *
 * The attributions that ARE made are read from real fields:
 *
 *   the six claims    identityProvenance - provenance, recordId, statedAt
 *   beliefs           a real computed confidence, and INFERENCE by nature
 *   revenue/customers DERIVED - "computed from the store's own orders", which
 *                     is exactly what PROVENANCE_GROUNDING says it means
 *   connected systems CONNECTOR - a connected system published it
 *   generated copy    GENERATED - profile.ts's own comment on those fields
 *   everything else   null, including every CanonicalRecord, because
 *                     CanonicalRecord does not expose provenance today and
 *                     inventing one here would be the exact failure this
 *                     slice exists to correct
 */

const formatCents = formatMoney;

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function trendArrow(direction: "up" | "down" | "flat" | undefined): string {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : "—";
}

/**
 * One fact, with whatever evidence really exists for it.
 *
 * Every argument after the text is optional and defaults to null, so the
 * cheapest thing to write is the honest thing: a caller that knows nothing
 * about a fact's origin says nothing about it.
 */
function fact(
  text: string,
  evidence?: { source?: RecordProvenance | null; confidence?: number | null; recordId?: string | null },
): UnderstandingFact {
  return {
    text,
    source: evidence?.source ?? null,
    confidence: evidence?.confidence ?? null,
    recordId: evidence?.recordId ?? null,
  };
}

/** Facts with no recorded evidence at all. Used where the model carries none. */
function plain(texts: string[]): UnderstandingFact[] {
  return texts.map((t) => fact(t));
}

export function toUnderstandingGroups(u: BusinessUnderstanding, currency: string): UnderstandingGroup[] {
  const { profile, beliefs, recentDecisions, activeThoughts, platformRelationship, currentAssets } = u;
  const p = profile.identity;
  const prov = profile.identityProvenance;

  const identity: UnderstandingFact[] = [];
  // The store's own name and tagline. No provenance is recorded for either, so
  // none is claimed.
  identity.push(fact(p.tagline ? `${p.name} — ${p.tagline}` : p.name));
  // GENERATED, by profile.ts's own declaration: "GENERATED COPY, all of it —
  // what the storefront says about itself."
  if (p.description) identity.push(fact(p.description, { source: "GENERATED" }));
  const classification = [
    ...profile.classification.businessCategories.map((c) => c.label),
    ...profile.classification.revenueStreams.map((r) => r.label),
  ];
  if (classification.length > 0) identity.push(fact(classification.join(" · ")));

  // ============ THE SIX CLAIMS, WITH WHO SAID THEM ===================
  //
  // Rendered here for the first time. Each takes its statement and its author
  // from the SAME record via identityProvenance (4afb6c8), so the sentence and
  // its attribution cannot come from different rows.
  const claims: [string, keyof typeof prov][] = [
    ["Offers", "offering"],
    ["Trying to", "intent"],
    ["For", "targetAudience"],
    ["Sounds", "brandPersonality"],
    ["Voice", "brandVoice"],
    ["Different because", "sellingProposition"],
  ];
  for (const [label, key] of claims) {
    const f = prov[key];
    if (!f) continue;
    identity.push(
      fact(`${label}: ${f.statement}`, { source: f.provenance, recordId: f.recordId }),
    );
  }

  const offerings: UnderstandingFact[] = [
    // DERIVED: counted from the store's own catalogue.
    fact(`${profile.offerings.activeCount} active product${profile.offerings.activeCount === 1 ? "" : "s"}`, {
      source: "DERIVED",
    }),
    ...profile.offerings.trends
      .filter((t) => t.trend !== null)
      .slice(0, 3)
      .map((t) =>
        fact(`${trendArrow(t.trend?.direction)} ${t.item.data.name} — ${Math.round((t.trend?.changeRatio ?? 0) * 100)}%`, {
          source: "DERIVED",
          recordId: t.item.id,
        }),
      ),
  ];

  const people: UnderstandingFact[] = [];
  if (profile.people.owner) people.push(fact(`${profile.people.owner.name ?? profile.people.owner.email} — Owner`));
  for (const m of profile.people.members) people.push(fact(`${m.name ?? m.email} — ${m.role}`));
  for (const e of profile.people.employees) {
    people.push(
      fact(`${e.data.name}${e.data.title ? ` — ${e.data.title}` : ""}${e.data.status === "former" ? " (former)" : ""}`, {
        recordId: e.id,
      }),
    );
  }

  const goals: UnderstandingFact[] = [
    ...profile.goals.map((g) => fact(`Goal (${g.data.status}) — ${g.data.description}`, { recordId: g.id })),
    ...profile.challenges.map((c) => fact(`Challenge (${c.data.status}) — ${c.data.description}`, { recordId: c.id })),
  ];

  return [
    { key: "identity", label: "Identity", facts: identity, empty: "I don't have your business identity yet." },
    {
      // What J4 can point at by name. This is the visible proof that a
      // designated asset resolves to a real record rather than a URL on a
      // column — if "brand.logo" appears here, "that logo" has something to
      // mean.
      key: "assets",
      label: "Assets I can use",
      facts: Object.entries(currentAssets).map(([role, asset]) =>
        fact(`${role} — ${asset.summary ?? asset.originalFilename}${asset.origin ? ` (${asset.origin})` : ""}`, {
          recordId: asset.id,
        }),
      ),
      empty: "Nothing designated yet. Generated and uploaded files become usable assets once they have a role.",
    },
    { key: "offerings", label: "What you sell", facts: offerings, empty: "Nothing in the catalog yet." },
    {
      key: "revenue",
      label: "Revenue",
      // DERIVED: "computed from the store's own orders and products. It is as
      // reliable as those records and needs no hedging." (PROVENANCE_GROUNDING)
      facts: [
        fact(`Last 30 days — ${formatCents(profile.revenue.last30DaysInCents, currency)}`, { source: "DERIVED" }),
        fact(`All time — ${formatCents(profile.revenue.allTimeInCents, currency)}`, { source: "DERIVED" }),
      ],
      empty: "No revenue recorded yet.",
    },
    {
      key: "customers",
      label: "Customers",
      facts: [
        fact(`${profile.customers.totalContactCount} known contact${profile.customers.totalContactCount === 1 ? "" : "s"}`, {
          source: "DERIVED",
        }),
        fact(
          `Repeat ${profile.customers.segments.repeatCustomers.length} ${trendArrow(profile.customers.segmentTrends.repeatCustomers?.direction)} · ` +
            `High-value ${profile.customers.segments.highValueCustomers.length} ${trendArrow(profile.customers.segmentTrends.highValueCustomers?.direction)} · ` +
            `Lapsed ${profile.customers.segments.lapsedCustomers.length} ${trendArrow(profile.customers.segmentTrends.lapsedCustomers?.direction)} · ` +
            `New ${profile.customers.segments.newCustomers.length} ${trendArrow(profile.customers.segmentTrends.newCustomers?.direction)}`,
          { source: "DERIVED" },
        ),
      ],
      empty: "No customers yet.",
    },
    { key: "people", label: "People", facts: people, empty: "Just you so far." },
    {
      key: "suppliers",
      label: "Suppliers",
      facts: profile.suppliers.map((s) =>
        fact(`${s.data.name}${s.data.email ? ` — ${s.data.email}` : ""}`, { recordId: s.id }),
      ),
      empty: "None known yet. Mention one in conversation and I'll remember it.",
    },
    {
      key: "locations",
      label: "Locations",
      facts: profile.locations.map((l) =>
        fact(`${l.data.name}${l.data.city ? ` — ${l.data.city}${l.data.state ? `, ${l.data.state}` : ""}` : ""}`, {
          recordId: l.id,
        }),
      ),
      empty: "None known yet.",
    },
    { key: "goals", label: "Goals and challenges", facts: goals, empty: "Nothing stated yet. Tell me a goal and I'll hold onto it." },
    {
      key: "assets",
      label: "Business assets",
      facts: profile.assets.map((a) =>
        fact(
          `${a.data.originalFilename}${a.data.category === "unclassified" ? " — not yet reviewed" : ` — ${a.data.category.replace(/_/g, " ")}`}` +
            `${a.data.summary ? `: ${a.data.summary}` : ""}`,
          { recordId: a.id },
        ),
      ),
      empty: "Nothing uploaded yet.",
    },
    {
      key: "systems",
      label: "Connected systems",
      // CONNECTOR: "A connected system published this." (PROVENANCE_GROUNDING)
      facts: profile.connectedSystems.map((s) =>
        fact(
          `${s.displayName} — ${s.status}${s.syncedAgoLabel ? ` — synced ${s.syncedAgoLabel}${s.isStale ? " (stale)" : ""}` : ""}`,
          { source: "CONNECTOR" },
        ),
      ),
      empty: "Nothing connected yet.",
    },
    {
      key: "beliefs",
      label: "What I've learned",
      // THE ONE PLACE A REAL CONFIDENCE EXISTS. It is computed, so it is shown;
      // nowhere else gets one. INFERENCE by nature: "You concluded this
      // yourself. Nothing outside this system asserted it, so it may be wrong."
      facts: beliefs.map((b) =>
        fact(`${b.claim} — ${b.maturity.replace(/_/g, " ")}`, { source: "INFERENCE", confidence: b.confidence }),
      ),
      empty: "Nothing yet. Beliefs form once a real pattern repeats.",
    },
    {
      key: "decisions",
      label: "Recent decisions",
      facts: recentDecisions.map((d) =>
        fact(`${d.decision === "executed" ? "✓" : "✕"} ${d.summary} — ${formatDate(d.decidedAt)}`, { source: "DERIVED" }),
      ),
      empty: "Nothing in the last two weeks.",
    },
    {
      key: "open",
      label: "Still open",
      // J4's own cognitive output — nothing outside this system asserted it.
      facts: activeThoughts.slice(0, 5).map((t) => fact(t.summary, { source: "INFERENCE", recordId: t.id })),
      empty: "Nothing open right now.",
    },
    {
      key: "platform",
      label: "Your relationship with Genesis",
      facts: plain([
        `${platformRelationship.planName ?? "No plan"} — ${platformRelationship.growthPointBalance} Growth Points`,
        ...(platformRelationship.subscriptionStatus ? [platformRelationship.subscriptionStatus] : []),
        ...(platformRelationship.businessPartnerTrialEndsAt
          ? [`Business Partner trial ends ${formatDate(platformRelationship.businessPartnerTrialEndsAt)}`]
          : []),
      ]),
      empty: "No plan yet.",
    },
  ];
}
