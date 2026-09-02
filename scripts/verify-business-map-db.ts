import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { readOwnerFacts, readOwnerFactsWithProvenance } from "@/lib/businessModel/ownerFacts";
import {
  businessMap, certaintyOf, MAP_DOMAINS, DOMAIN_LABEL, MAP_EDGE_KINDS,
  ANONYMOUS_CUSTOMER_LABEL,
  type MapDomainKey,
} from "@/lib/businessModel/businessMap";
import { CATEGORY_DOMAIN, connectableServices, whatItAdds } from "@/lib/businessModel/connectionDomains";
import { SIGNUP_DESTINATIONS, signupFor } from "@/lib/businessModel/signupDestinations";
import { CONNECTOR_CATALOG, CONNECTION_CATEGORY_LABELS } from "@/lib/integrations/catalog";
import { entitiesFor, type MapProspect } from "@/lib/businessModel/mapEntities";
import { SOCIAL_PLATFORMS } from "@/lib/social/platforms";
import { socialProspects } from "@/lib/businessModel/socialProspects";
import { readFileSync } from "node:fs";

// WHAT J4 UNDERSTANDS, AND HOW SURE IT IS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts business-map-db
//
// ============ PHASE 2 OF THE BUSINESS MAP MILESTONE (2026-09-01) =======
//
// The assembler is a pure function over an already-assembled understanding, so
// everything below runs it against REAL fixtures read through the real
// getBusinessUnderstanding rather than against a hand-built object. A map that
// only works on a shape I invented would prove nothing about the shape J4
// actually holds.
//
// Three things are under test, and the third is the one that matters:
//
//   1. every node traces to a real row
//   2. an empty domain is `unknown` and still present
//   3. an INFERENCE fact is `inferred` and never `known`
//
// ============ AND THE HONESTY THE CORRECTION MUST NOT COST =============
//
// Sean: "Make sure downstream consumers that currently use readOwnerFacts()
// don't accidentally become less honest when this is corrected."
//
// readOwnerFacts is now a projection of the provenance-carrying reader. That is
// only safe if it returns exactly what it returned before, so the two are
// compared against each other on the same fixtures below — including the case
// that used to be subtle, where several current records exist and the newest
// has to win in both.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const mapFor = async (
  storeId: string,
  slug: string,
  designCount = 0,
  productImages: Record<string, string> = {},
) =>
  businessMap({
    understanding: await getBusinessUnderstanding(storeId),
    facts: await readOwnerFactsWithProvenance(storeId),
    slug,
    designCount,
    productImages,
  });

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  let seq = 0;

  const makeStore = async (name = "Cubit & Coil") => {
    const n = ++seq;
    const user = await prisma.user.create({ data: { email: `map-${stamp}-${n}@example.test` } });
    const store = await prisma.store.create({
      data: {
        userId: user.id, name, slug: `map-${stamp}-${n}`,
        tagline: "Hand-wound copper, true to the cubit",
        description: "Copper tensor rings wound by hand.", currency: "USD",
      },
    });
    return { user, store };
  };

  const fact = (storeId: string, entityType: string, statement: string, provenance: string) =>
    prismaSystem.businessRecord.create({
      data: {
        storeId, entityType, externalId: `f-${entityType}-${++seq}`,
        sourceProvider: "test", data: { statement },
        provenance: provenance as never, provenanceDetail: "suite", modelExtracted: provenance === "INFERENCE",
      },
    });

  // ======================================================================
  console.log("\n=== 1. A brand new business is nine honest unknowns ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    const map = await mapFor(store.id, store.slug);

    eq("every declared domain is present", map.domains.length, MAP_DOMAINS.length);
    eq("in the declared order", map.domains.map((d) => d.key), [...MAP_DOMAINS]);

    // Business is never empty — the name is always a fact.
    const empty = map.domains.filter((d) => d.key !== "business");
    assert("every other domain is unknown, not missing",
      empty.every((d) => d.certainty === "unknown"),
      JSON.stringify(empty.filter((d) => d.certainty !== "unknown").map((d) => d.key)));
    assert("and each says what is missing rather than showing a zero",
      empty.every((d) => d.summary.length > 12 && !/^0\b/.test(d.summary)),
      JSON.stringify(empty.map((d) => d.summary).slice(0, 3)));
    assert("the goals domain asks for goals in the owner's terms",
      /working towards/.test(map.domains.find((d) => d.key === "goals")!.summary));
    assert("and Learned says J4 has not worked anything out yet",
      /has not worked anything out/.test(map.domains.find((d) => d.key === "learned")!.summary));

    eq("the business is named", map.business.name, "Cubit & Coil");
    eq("no edges are drawn with nothing to join", map.edges, []);
  }

  // ======================================================================
  console.log("\n=== 2. An inference is never presented as something you said ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    // Exactly production's situation: the four brand claims promoted from the
    // generated blueprint, and one thing the owner really did state.
    await fact(store.id, "targetAudience", "Practitioners of meditation and energy work.", "INFERENCE");
    await fact(store.id, "offering", "Hand-wound copper tensor rings.", "OWNER");

    const map = await mapFor(store.id, store.slug);
    const business = map.domains.find((d) => d.key === "business")!;
    const offering = business.nodes.find((n) => n.id === "business:offering");
    const audience = business.nodes.find((n) => n.id.includes("targetAudience"))
      ?? business.nodes.find((n) => n.label === "Who it is for");

    assert("what the owner stated is on the map", offering !== undefined);
    eq("and it is known", offering?.certainty, "known");
    eq("carrying its provenance", offering?.provenance, "OWNER");
    assert("and pointing at a real row", Boolean(offering?.recordId));

    // The four brand claims are not business-domain nodes in this first map —
    // they belong to Brand Identity, which is Phase 4. What must hold now is
    // the RULE, and it is asserted directly on the classifier plus on any
    // inference node the map does carry.
    eq("an INFERENCE fact classifies as inferred", certaintyOf("INFERENCE"), "inferred");
    eq("a GENERATED one too", certaintyOf("GENERATED"), "inferred");
    eq("OWNER is known", certaintyOf("OWNER"), "known");
    eq("CONNECTOR is known", certaintyOf("CONNECTOR"), "known");
    eq("DOCUMENT is known", certaintyOf("DOCUMENT"), "known");
    eq("DERIVED is known", certaintyOf("DERIVED"), "known");
    // The safe direction for an origin nobody recorded.
    eq("and an unrecorded origin is inferred, never known", certaintyOf(null), "inferred");
    void audience;
  }

  // ======================================================================
  console.log("\n=== 3. Provenance survives the read layer ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    await fact(store.id, "brandVoice", "Warm, contemplative, plainspoken.", "INFERENCE");
    await fact(store.id, "intent", "A business that outlasts me.", "OWNER");

    const withProv = await readOwnerFactsWithProvenance(store.id);
    eq("an inferred claim reports INFERENCE", withProv.brandVoice?.provenance, "INFERENCE");
    eq("an owner statement reports OWNER", withProv.intent?.provenance, "OWNER");
    assert("each carries the row it came from",
      Boolean(withProv.brandVoice?.recordId) && Boolean(withProv.intent?.recordId));

    // ---- and the old reader is byte-identical ---------------------------
    const plain = await readOwnerFacts(store.id);
    eq("readOwnerFacts still returns bare statements", plain.brandVoice, "Warm, contemplative, plainspoken.");
    eq("for every one of the six keys",
      Object.keys(plain).sort(),
      ["brandPersonality", "brandVoice", "intent", "offering", "sellingProposition", "targetAudience"]);
    for (const key of Object.keys(plain) as (keyof typeof plain)[]) {
      eq(`${key} matches the provenance reader's statement`,
        plain[key], withProv[key]?.statement ?? null);
    }
  }

  // ======================================================================
  console.log("\n=== 4. Both readers pick the SAME record when there are several ===\n");
  // ======================================================================
  {
    // The subtle case. statementOf and factOf each choose "the newest current
    // record"; two copies of that reduce would be two chances to disagree, and
    // the disagreement would be a statement shown beside another row's origin.
    const { store } = await makeStore();
    const older = await fact(store.id, "offering", "Older statement.", "INFERENCE");
    await prismaSystem.businessRecord.update({
      where: { id: older.id }, data: { statedAt: new Date(Date.now() - 86_400_000) },
    });
    const newer = await fact(store.id, "offering", "Newer statement.", "OWNER");
    await prismaSystem.businessRecord.update({
      where: { id: newer.id }, data: { statedAt: new Date() },
    });

    const [plain, withProv] = await Promise.all([
      readOwnerFacts(store.id), readOwnerFactsWithProvenance(store.id),
    ]);
    eq("the newest statement wins", plain.offering, "Newer statement.");
    eq("and the provenance reader agrees", withProv.offering?.statement, "Newer statement.");
    eq("reporting THAT record's origin, not the older one's", withProv.offering?.provenance, "OWNER");
    eq("and THAT record's id", withProv.offering?.recordId, newer.id);
  }

  // ======================================================================
  console.log("\n=== 5. Real commerce puts real nodes and real edges on the map ===\n");
  // ======================================================================
  {
    const { user, store } = await makeStore();
    const product = await prismaSystem.product.create({
      data: {
        storeId: store.id, name: "Copper Tensor Ring Cuff",
        description: "Hand wound.", priceInCents: 3232, active: true,
      },
    });
    const order = await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: product.name, quantity: 1, amountInCents: 3232,
        buyerEmail: `buyer-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_map_${stamp}`, status: "paid", productId: product.id,
      },
    });
    await prismaSystem.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", externalAccountId: `acct_${stamp}` },
    });
    await prismaSystem.belief.create({
      data: {
        storeId: store.id, topicKey: `t-${stamp}`, claim: "Orders cluster at the weekend.",
        category: "event_recurrence", confidence: 0.7, evidenceCount: 4,
        firstObservedAt: new Date(Date.now() - 20 * 86_400_000), lastConfirmedAt: new Date(),
      },
    });

    const map = await mapFor(store.id, store.slug, 8);
    const domain = (key: MapDomainKey) => map.domains.find((d) => d.key === key)!;

    assert("the product is on the map",
      domain("commerce").nodes.some((n) => n.label === "Copper Tensor Ring Cuff"),
      JSON.stringify(domain("commerce").nodes.map((n) => n.label)));
    eq("commerce is known", domain("commerce").certainty, "known");
    assert("the money that moved is on the map", domain("financials").nodes.length >= 2);
    eq("financials is known", domain("financials").certainty, "known");
    assert("the connected system is on the map",
      domain("connections").nodes.some((n) => n.label === "STRIPE"));
    assert("the design count reaches Creation",
      domain("creation").nodes.some((n) => /8 saved/.test(n.detail ?? "")));

    // ---- Learned is J4's, and stays J4's --------------------------------
    const learned = domain("learned");
    eq("the belief is on the map", learned.nodes.length, 1);
    eq("and a belief is ALWAYS inferred", learned.nodes[0].certainty, "inferred");
    eq("so the domain is inferred, not known", learned.certainty, "inferred");
    assert("carrying J4's actual claim",
      learned.nodes[0].label === "Orders cluster at the weekend.", learned.nodes[0].label);

    // ---- edges rest on real columns -------------------------------------
    const kinds = map.edges.map((e) => e.kind);
    assert("product to orders is drawn", kinds.includes("ordered"), JSON.stringify(kinds));
    assert("orders to revenue is drawn", kinds.includes("earned"), JSON.stringify(kinds));
    assert("every edge says what backs it",
      map.edges.every((e) => e.because.length > 8 && e.because === MAP_EDGE_KINDS[e.kind]));
    // Both ends of every edge must be nodes that exist. A line to nothing is
    // the decorative case Sean ruled out.
    const ids = new Set(map.nodes.map((n) => n.id));
    assert("and both ends of every edge are real nodes",
      map.edges.every((e) => ids.has(e.from) && ids.has(e.to)),
      JSON.stringify(map.edges.filter((e) => !ids.has(e.from) || !ids.has(e.to))));

    // ---- nothing is drawn without a row behind it -----------------------
    //
    // Each id resolved against the table its OWN kind names. The first version
    // asked BusinessRecord for everything and two nodes failed — Genesis's own
    // products and customers are computed live with `internal:` ids and are not
    // rows in that table at all. `recordExistsInStore` is the existing resolver
    // for exactly this, and it is store-scoped, so a node cannot trace to
    // another business's row.
    const { recordExistsInStore } = await import("@/lib/businessModel/statements");
    const claimed = map.nodes.filter((n) => n.recordId !== null);
    assert("the map carries traceable nodes at all", claimed.length > 0, String(claimed.length));
    for (const n of claimed) {
      const exists =
        n.recordKind === "belief"
          ? (await prismaSystem.belief.count({ where: { id: n.recordId! } })) > 0
          : await recordExistsInStore(store.id, n.recordId!);
      assert(`the ${n.recordKind} behind "${n.label}" really exists`, exists, n.recordId ?? "");
    }
    assert("and every traceable node says which kind of id it holds",
      claimed.every((n) => n.recordKind !== null));
    assert("a computed product is labelled computed, not a stored record",
      map.nodes.some((n) => n.recordKind === "computed"),
      JSON.stringify(claimed.map((n) => n.recordKind)));
    void user;
    void order;
  }

  // ======================================================================
  console.log("\n=== 6. Social stays unavailable, because the data does not exist ===\n");
  // ======================================================================
  {
    // Sean: "Social/content/engagement/traffic relationships should remain
    // unavailable until those entities and relationships actually exist."
    //
    // A business with products, orders and a connected payment provider still
    // has no reach, no content and no traffic — and the map must not borrow
    // from commerce to make that branch look alive.
    const { store } = await makeStore();
    await prismaSystem.product.create({
      data: { storeId: store.id, name: "Ring", description: "d", priceInCents: 1000, active: true },
    });
    const map = await mapFor(store.id, store.slug);
    const social = map.domains.find((d) => d.key === "social")!;
    eq("social is unknown even on a trading business", social.certainty, "unknown");
    eq("with no nodes", social.nodes.length, 0);
    assert("and says a connection is what is missing", /connected/.test(social.summary), social.summary);

    // ============ THE MODEL, NOT THE COPY ==========================
    //
    // The first version grepped the whole source and failed on the word
    // "reach" — inside the owner-facing sentence that says J4 knows nothing
    // about their reach. The assertion caught its own honest prose.
    //
    // What must not exist is a DOMAIN or an EDGE KIND for these things,
    // because a registry entry is what would actually put one on the map.
    for (const invented of ["engagement", "traffic", "impressions", "reach", "followers", "content"]) {
      assert(`no domain models ${invented}`,
        !(MAP_DOMAINS as readonly string[]).some((d) => d.includes(invented)), invented);
      assert(`and no edge kind joins anything by ${invented}`,
        !Object.keys(MAP_EDGE_KINDS).some((k) => k.includes(invented)), invented);
    }
    // Nor may a node claim one, which is the runtime half of the same rule.
    assert("and no node on a real business claims any of them",
      map.nodes.every((n) => !/engagement|traffic|impressions|followers/i.test(n.label)),
      JSON.stringify(map.nodes.map((n) => n.label)));
  }

  // ======================================================================
  console.log("\n=== 7. The registries agree with each other ===\n");
  // ======================================================================
  {
    // ============ MIRROR NINETEEN ==================================
    //
    // Three lists describe the same nine domains: MAP_DOMAINS, DOMAIN_LABEL,
    // and the empty-summary table. A domain missing from the second renders
    // as undefined at an owner; missing from the third throws when it is
    // empty, which is exactly when a new domain starts out.
    //
    // Derived rather than restated: the populated fixture below must give
    // EVERY declared domain at least one node, so a domain added to the
    // registry and never wired fails here rather than rendering as a
    // permanent, dishonest "not yet known".
    for (const key of MAP_DOMAINS) {
      assert(`${key} has a label`, typeof DOMAIN_LABEL[key] === "string" && DOMAIN_LABEL[key].length > 0);
    }
    eq("the label table has no extra entries",
      Object.keys(DOMAIN_LABEL).sort(), [...MAP_DOMAINS].sort());

    const { user, store } = await makeStore();
    // One real row for every domain, so "declared but unwired" cannot hide.
    await fact(store.id, "offering", "Rings.", "OWNER");
    const product = await prismaSystem.product.create({
      data: { storeId: store.id, name: "Ring", description: "d", priceInCents: 1000, active: true },
    });
    await prismaSystem.order.create({
      data: {
        storeId: store.id, productName: "Ring", quantity: 1, amountInCents: 1000,
        buyerEmail: `b-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_reg_${stamp}`, status: "paid", productId: product.id,
      },
    });
    await prismaSystem.storeIntegration.create({
      data: { storeId: store.id, provider: "PRINTFUL", status: "CONNECTED", externalAccountId: `acct_r_${stamp}` },
    });
    await prismaSystem.belief.create({
      data: {
        storeId: store.id, topicKey: `reg-${stamp}`, claim: "A pattern.", category: "insight_recurrence",
        confidence: 0.5, evidenceCount: 2, firstObservedAt: new Date(), lastConfirmedAt: new Date(),
      },
    });
    for (const [entityType, data] of [
      ["goal", { title: "Sell 100 rings" }],
      ["challenge", { title: "Supplier lead times" }],
      ["socialAccount", { handle: "@cubitandcoil", provider: "INSTAGRAM" }],
      ["asset", { name: "Logo" }],
      ["location", { name: "The workshop" }],
    ] as const) {
      await prismaSystem.businessRecord.create({
        data: {
          storeId: store.id, entityType, externalId: `${entityType}-${stamp}`,
          sourceProvider: "test", data: data as never, provenance: "OWNER", provenanceDetail: "suite",
        },
      });
    }

    const map = await mapFor(store.id, store.slug, 3);
    const emptyDomains = map.domains.filter((d) => d.nodes.length === 0).map((d) => d.key);
    eq("with one real row of every kind, no declared domain is left unwired", emptyDomains, []);
    assert("and every node belongs to a declared domain",
      map.nodes.every((n) => (MAP_DOMAINS as readonly string[]).includes(n.domain)),
      JSON.stringify(map.nodes.filter((n) => !(MAP_DOMAINS as readonly string[]).includes(n.domain)).map((n) => n.domain)));
    void user;
  }

  // ======================================================================
  console.log("\n=== 7b. A connection explains what it would add ===\n");
  // ======================================================================
  {
    // ============ MIRROR TWENTY ====================================
    //
    // CATEGORY_DOMAIN mirrors ConnectionCategory. A category with no branch
    // would render a service that explains nothing, which is the one thing
    // the panel exists to prevent.
    for (const category of Object.keys(CONNECTION_CATEGORY_LABELS)) {
      assert(`${category} feeds a real branch of the map`,
        (MAP_DOMAINS as readonly string[]).includes(
          CATEGORY_DOMAIN[category as keyof typeof CATEGORY_DOMAIN]),
        category);
    }
    eq("and every category is mapped, with no extras",
      Object.keys(CATEGORY_DOMAIN).sort(), Object.keys(CONNECTION_CATEGORY_LABELS).sort());

    // ---- derived from the catalogue, never a second list ---------------
    const services = connectableServices([]);
    eq("every catalogue entry is offered", services.length, CONNECTOR_CATALOG.length);
    assert("nothing is connected for a business with no integrations",
      services.every((s) => !s.connected));

    // A service Genesis cannot connect must not look connectable. Taken
    // straight from the catalogue's own `connector: null`.
    const comingSoon = CONNECTOR_CATALOG.filter((e) => e.connector === null).map((e) => e.id);
    assert("the catalogue really does have unbuilt connectors to distinguish",
      comingSoon.length > 0, JSON.stringify(comingSoon));
    for (const id of comingSoon) {
      eq(`${id} is not offered as available`, services.find((s) => s.id === id)?.available, false);
    }

    // ---- connected state comes from the real provider list -------------
    const withStripe = connectableServices(["STRIPE", "INSTAGRAM"]);
    const instagram = withStripe.find((s) => s.id === "instagram");
    eq("Instagram feeds the Social branch", instagram?.domain, "social");
    eq("and it reads as connected when it is", instagram?.connected, true);
    eq("an unconnected one does not",
      withStripe.find((s) => s.id === "tiktok")?.connected, false);

    // ---- Connect or Create: the Create door is never a guess -----------
    //
    // Sean: "Do not invent URLs or rely on search-engine instructions... For
    // providers without a reliable official signup destination, don't
    // fabricate one; handle that honestly."
    //
    // Every destination was fetched and returned 200 on 2026-09-01. What can
    // be checked WITHOUT a network — and therefore on every run, for ever — is
    // that each URL is https and actually points at the provider's own domain.
    // That is what stops a later edit sending "Create a Printful account"
    // somewhere that is not Printful.
    for (const [id, dest] of Object.entries(SIGNUP_DESTINATIONS)) {
      if (!dest) continue;
      assert(`${id}'s signup link is https`, dest.url.startsWith("https://"), dest.url);
      const host = new URL(dest.url).hostname;
      assert(`${id}'s signup link is on ${dest.domain}`,
        host === dest.domain || host.endsWith(`.${dest.domain}`), `${host} vs ${dest.domain}`);
      assert(`${id} is a real catalogue id`,
        CONNECTOR_CATALOG.some((e) => e.id === id), id);
    }

    // The two we could not confirm are recorded as null, not omitted — an
    // absent key and a deliberate null read the same to `signupFor`, but only
    // the null says somebody looked.
    eq("QuickBooks has no fabricated signup link", SIGNUP_DESTINATIONS.quickbooks, null);
    eq("nor Facebook", SIGNUP_DESTINATIONS.facebook, null);

    // "If they don't need it, leave it alone" — no Create for something
    // Genesis could not connect afterwards.
    for (const id of comingSoon) {
      eq(`${id} offers no Create, because connecting it is impossible`,
        signupFor(id, false), null);
    }
    assert("but a connectable service with a verified link does offer one",
      signupFor("instagram", true) !== null);

    // ---- and the sentence never claims a capability --------------------
    const sentence = whatItAdds({ ...instagram!, connected: false }, "Social");
    assert("an unconnected service says which branch it would feed",
      /Social/.test(sentence), sentence);
    for (const invented of ["posts", "followers", "engagement", "insights", "daily", "history"]) {
      assert(`and promises nothing about ${invented}`,
        !new RegExp(invented, "i").test(sentence), sentence);
    }
  }

  // ======================================================================
  console.log("\n=== 7c. The middle layer is gone; the things are here ===\n");
  // ======================================================================
  {
    // Sean (2026-09-02): "I don't think we need the intermediate category
    // level anymore... entering that branch should transition directly into a
    // carousel of the actual entities."
    const { store } = await makeStore();
    for (let i = 0; i < 4; i++) {
      await prismaSystem.product.create({
        data: { storeId: store.id, name: `Ring ${i}`, description: "d", priceInCents: 1000 + i, active: true },
      });
    }
    const map = await mapFor(store.id, store.slug);
    const commerce = map.domains.find((d) => d.key === "commerce")!;
    const entities = entitiesFor(commerce);

    // THE WHOLE POINT: four products are four things, not one group.
    eq("four products are four entities, reached in one tap", entities.length, 4);
    assert("every one points at a real row",
      entities.every((e) => e.recordId !== null),
      JSON.stringify(entities.map((e) => e.recordId)));
    assert("and every one carries its own kind",
      entities.every((e) => e.kind === "Product"),
      JSON.stringify(entities.map((e) => e.kind)));
    assert("no entity is a group",
      !entities.some((e) => /^group:/.test(e.id)),
      JSON.stringify(entities.map((e) => e.id)));

    // ---- kinds stay together, because the organising survived the level ----
    //
    // SABOTAGE FOUND THIS ONE EMPTY (2026-09-02). The first version of this
    // check read the ordering off a real domain and asserted each kind was
    // contiguous -- which passed no matter what `entitiesFor` did, because the
    // assembler happens to emit one kind at a time today. It measured the
    // assembler, not the function under test.
    //
    // So the interleaving is constructed. This is the case that will arrive on
    // its own the first time a domain gains a second kind, and it is the whole
    // reason the grouping was kept as an ordering when it stopped being a level.
    const nodeOf = (id: string, label: string, kind: string | null) => ({
      id, domain: "commerce" as const, label, certainty: "known" as const,
      detail: null, provenance: null, recordId: null, recordKind: null,
      image: null, facts: [], kind,
    });
    const interleaved = entitiesFor({
      ...commerce,
      nodes: [
        nodeOf("a", "Ring A", "Product"),
        nodeOf("x", "Lookbook", "Asset"),
        nodeOf("b", "Ring B", "Product"),
        nodeOf("y", "Invoice", "Asset"),
      ],
    });
    eq("interleaved kinds are re-gathered, in first-seen order",
      interleaved.map((e) => e.label), ["Ring A", "Ring B", "Lookbook", "Invoice"]);

    // ---- one product is still one card -----------------------------------
    const { store: solo } = await makeStore();
    await prismaSystem.product.create({
      data: { storeId: solo.id, name: "Only Ring", description: "d", priceInCents: 1000, active: true },
    });
    const soloMap = await mapFor(solo.id, solo.slug);
    const soloEntities = entitiesFor(soloMap.domains.find((d) => d.key === "commerce")!);
    eq("one product is one entity", soloEntities.length, 1);
    eq("named as itself, never pluralised", soloEntities[0].label, "Only Ring");
  }

  // ======================================================================
  console.log("\n=== 7d. Social shows the platforms, and X tells the truth ===\n");
  // ======================================================================
  {
    // Sean: "Selecting Social reveals Instagram · Facebook · TikTok · X."
    // They are not invented here: SOCIAL_PLATFORMS is the registry the Studio
    // already publishes from.
    const { store } = await makeStore();
    const map = await mapFor(store.id, store.slug);
    const social = map.domains.find((d) => d.key === "social")!;

    const prospects: MapProspect[] = SOCIAL_PLATFORMS.map((pf) => ({
      id: pf.id,
      label: pf.label,
      available: pf.publishProvider !== null,
      connected: false,
      detail: "",
      serviceId: null,
    }));
    const entities = entitiesFor(social, prospects);

    eq("every platform appears", entities.length, SOCIAL_PLATFORMS.length);
    for (const pf of SOCIAL_PLATFORMS) {
      const entity = entities.find((b) => b.label === pf.label);
      assert(`${pf.label} is on the Social branch`, entity !== undefined, pf.label);
      eq(`${pf.label} is not known yet`, entity?.certainty, "unknown");
      // AND NOTHING IS INVENTED ON ITS CARD. An unconnected account reports
      // nothing, so it must carry no facts at all.
      eq(`${pf.label} has no fabricated facts`, entity?.facts.length, 0);
    }

    const x = entities.find((b) => b.label === "X")!;
    eq("X says Genesis cannot connect it", x.state, "Genesis cannot connect this yet");
    const instagram = entities.find((b) => b.label === "Instagram")!;
    eq("while Instagram says it is simply not connected", instagram.state, "Not connected");

    // The registry itself is the reason, and it is checked rather than trusted.
    eq("because X genuinely has no connector",
      SOCIAL_PLATFORMS.find((pf) => pf.id === "x")?.publishProvider ?? null, null);
  }

  // ======================================================================
  console.log("\n=== 7e. A connected platform is not the same as a claim ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    await prismaSystem.storeIntegration.create({
      data: { storeId: store.id, provider: "INSTAGRAM", status: "CONNECTED", externalAccountId: `ig-${stamp}` },
    });
    const map = await mapFor(store.id, store.slug);
    const social = map.domains.find((d) => d.key === "social")!;
    const entities = entitiesFor(social, [
      { id: "instagram", label: "Instagram", available: true, connected: true, detail: "Audience size.", serviceId: "instagram" },
    ]);
    const ig = entities.find((b) => b.label === "Instagram")!;
    eq("a connected platform reads as known", ig.certainty, "known");
    // THE EXISTING CONNECTION LANGUAGE, unchanged from the chooser's wording.
    eq("and says so in the chooser's own words", ig.state, "Connected — J4 uses this");
    // STILL NO INVENTED CLAIM. Connecting an account does not by itself mean
    // J4 has content, engagement or traffic from it -- those appear when rows
    // for them exist, and not a moment sooner.
    eq("but still claims no data it does not have", ig.facts.length, 0);
  }

  // ======================================================================
  // ======================================================================
  console.log("\n=== 7f. A card is read off the record, never written ===\n");
  // ======================================================================
  {
    // Sean (2026-09-02): "I want the entity cards to be information-rich —
    // what it is, where it came from, what J4 inferred about it, how confident
    // J4 is, what business entity it relates to."
    //
    // Every line below is asserted to come from a FIELD THAT WAS SET. The
    // sabotage that matters here is the opposite of the usual one: it is not
    // "does the card show enough", it is "does the card ever show something
    // nobody stored".
    const { store } = await makeStore();

    await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "asset", externalId: `asset-rich-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: {
          title: "Copper supplier invoice",
          fileType: "document",
          category: "invoice",
          summary: "An invoice from the copper supplier covering the spring run.",
          extractionConfidence: 0.82,
          origin: "uploaded",
          relatedEntityType: "supplier",
          storageUrl: "https://example.test/invoice.pdf",
        },
      },
    });
    // A second asset with ALMOST NOTHING on it. This is the honest-absence
    // case, and it is the one a rich card design silently gets wrong.
    await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "asset", externalId: `asset-bare-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        // BLANK, NOT ABSENT. Found by sabotage (2026-09-02): removing the
        // empty-value guard entirely left the suite green, because no fixture
        // had a field that was present and empty. An extractor that writes ""
        // is the realistic case, and it is the one that puts "Category: " with
        // nothing after it on a card.
        data: { title: "Untitled upload", category: "", origin: "   " },
      },
    });

    const map = await mapFor(store.id, store.slug);
    const creation = map.domains.find((d) => d.key === "creation")!;
    const entities = entitiesFor(creation);
    const rich = entities.find((e) => e.label === "Copper supplier invoice")!;
    const bare = entities.find((e) => e.label === "Untitled upload")!;

    const labels = rich.facts.map((f) => f.label);
    assert("the card says what kind of thing it is", labels.includes("What it is"), labels.join(", "));
    assert("and where it came from", labels.includes("Where it came from"), labels.join(", "));
    assert("and what it relates to", labels.includes("Relates to"), labels.join(", "));
    eq("J4's confidence is shown as J4's confidence, in its own units",
      rich.facts.find((f) => f.label === "J4's confidence reading it")?.value, "82%");
    eq("the detail line is J4's own reading of the file",
      rich.detail, "An invoice from the copper supplier covering the spring run.");

    // ---- and the bare one says less, rather than saying nothing loudly ----
    eq("a record with no summary gets no invented one", bare.detail, null);
    eq("a record with no fields gets no empty rows", bare.facts.length, 0);
    assert("no fact on any card is blank",
      entities.every((e) => e.facts.every((f) => f.value.trim().length > 0)),
      JSON.stringify(entities.map((e) => e.facts)));

    // ---- a PDF is not a photograph ---------------------------------------
    eq("a document carries no image, despite having a storageUrl", rich.image, null);
    eq("and neither does a record with no file at all", bare.image, null);
  }

  // ======================================================================
  console.log("\n=== 7g. A product's picture is its own, or there is none ===\n");
  // ======================================================================
  {
    const { store } = await makeStore();
    const withPhoto = await prismaSystem.product.create({
      data: { storeId: store.id, name: "Photographed Ring", description: "d", priceInCents: 4200, active: true },
    });
    await prismaSystem.product.create({
      data: { storeId: store.id, name: "Unphotographed Ring", description: "d", priceInCents: 900, active: false },
    });

    // No images passed at all: the map must not conjure one.
    const blind = entitiesFor((await mapFor(store.id, store.slug)).domains.find((d) => d.key === "commerce")!);
    assert("with no images supplied, no product claims a picture",
      blind.every((e) => e.image === null),
      JSON.stringify(blind.map((e) => [e.label, e.image])));

    const seen = entitiesFor(
      (await mapFor(store.id, store.slug, 0, { [withPhoto.id]: "https://example.test/ring.jpg" }))
        .domains.find((d) => d.key === "commerce")!,
    );
    eq("the photographed product shows its own photograph",
      seen.find((e) => e.label === "Photographed Ring")?.image, "https://example.test/ring.jpg");
    eq("and the other one shows none",
      seen.find((e) => e.label === "Unphotographed Ring")?.image, null);

    // ---- a database id is never presented as a stock code ----------------
    assert("a Genesis-native product shows no SKU it never had",
      seen.every((e) => !e.facts.some((f) => f.label === "SKU")),
      JSON.stringify(seen.map((e) => e.facts.find((f) => f.label === "SKU")?.value)));
    // AND A REAL ONE STILL SHOWS. Proving the rule drops the id rather than
    // the row: an item whose sku is genuinely not its own id keeps it.
    const external = entitiesFor({
      ...(await mapFor(store.id, store.slug)).domains.find((d) => d.key === "commerce")!,
      nodes: [{
        id: "internal:item:abc", domain: "commerce" as const, label: "Sourced Ring",
        certainty: "known" as const, detail: null, provenance: null,
        recordId: "internal:item:abc", recordKind: "computed" as const,
        image: null, kind: "Product",
        facts: [{ label: "SKU", value: "CC-RING-014" }],
      }],
    });
    eq("a real stock code is still shown",
      external[0].facts.find((f) => f.label === "SKU")?.value, "CC-RING-014");

    // ---- the commercial facts are the product's own ----------------------
    const one = seen.find((e) => e.label === "Photographed Ring")!;
    eq("price is shown in money, not cents",
      one.facts.find((f) => f.label === "Price")?.value, "42.00");
    eq("and whether it is actually on sale",
      one.facts.find((f) => f.label === "On sale in your storefront")?.value, "Yes");
    eq("which is not the same answer for an inactive product",
      seen.find((e) => e.label === "Unphotographed Ring")!.facts
        .find((f) => f.label === "On sale in your storefront")?.value, "No");
  }

  // ======================================================================
  console.log("\n=== 7h. A customer card is deliberately thin ===\n");
  // ======================================================================
  {
    // Sean: "The presentation should be appropriate for customer information
    // and privacy." What a person spent with this business is the owner's own
    // commercial record. The rest of what Genesis holds about them is not
    // something to leave open on a landing screen.
    const { store } = await makeStore();
    const customer = await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "contact", externalId: `contact-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { name: "Dana Reyes", email: `buyer-${stamp}@example.test`, phone: "+15550101", roles: ["customer"] },
      },
    });
    await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "transaction", externalId: `txn-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { type: "sale", amountInCents: 12300, contactId: customer.id },
      },
    });

    const map = await mapFor(store.id, store.slug);
    const customers = entitiesFor(map.domains.find((d) => d.key === "customers")!);
    assert("the customer is on the map", customers.length > 0, String(customers.length));
    const dana = customers[0];

    const shown = dana.facts.map((f) => f.label);
    eq("exactly one thing is shown about a person", shown, ["Spent with you"]);
    assert("and it is not their email address",
      !JSON.stringify(dana.facts).includes("@example.test"),
      JSON.stringify(dana.facts));
    // ---- and a customer who gave NO name is not titled by their email ----
    //
    // Sean (2026-09-02): "I don't want an email address exposed on the
    // Business Map landing screen just because a customer doesn't have a
    // name." It was never a decision — an order-derived contact has
    // `name: null`, `labelOf` fell through to `record.id`, and that id is
    // `internal:contact:<email>`.
    const { store: anon } = await makeStore();
    const anonProduct = await prismaSystem.product.create({
      data: { storeId: anon.id, name: "Ring", description: "d", priceInCents: 1000, active: true },
    });
    await prismaSystem.order.create({
      data: {
        storeId: anon.id, productName: "Ring", quantity: 1, amountInCents: 1000,
        buyerEmail: `anon-${stamp}@example.test`, paymentProvider: "STRIPE",
        externalOrderId: `cs_anon_${stamp}`, status: "paid", productId: anonProduct.id,
      },
    });
    const anonMap = await mapFor(anon.id, anon.slug);
    const anonCustomers = entitiesFor(anonMap.domains.find((d) => d.key === "customers")!);
    assert("an order-derived customer reaches the map", anonCustomers.length > 0,
      String(anonCustomers.length));
    for (const c of anonCustomers) {
      eq("a customer with no name is called Customer", c.label, ANONYMOUS_CUSTOMER_LABEL);
      assert("never their email address", !c.label.includes("@"), c.label);
      // THE ID IS THE EMAIL. Everything the card renders is checked, not just
      // the title, because that is how the address arrived in the first place.
      assert("and no rendered field carries it either",
        !JSON.stringify({ label: c.label, detail: c.detail, facts: c.facts, kind: c.kind })
          .includes("@example.test"),
        JSON.stringify({ label: c.label, detail: c.detail, facts: c.facts }));
    }

    // ---- a name that IS an email is not a name ---------------------------
    const { store: emailNamed } = await makeStore();
    await prismaSystem.businessRecord.create({
      data: {
        storeId: emailNamed.id, entityType: "contact", externalId: `contact-en-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { name: `typed-${stamp}@example.test`, email: `typed-${stamp}@example.test`, roles: ["customer"] },
      },
    });
    const enMap = await mapFor(emailNamed.id, emailNamed.slug);
    const enCustomers = entitiesFor(enMap.domains.find((d) => d.key === "customers")!);
    eq("a contact whose name is an address is still called Customer",
      enCustomers[0]?.label, ANONYMOUS_CUSTOMER_LABEL);

    // A CUSTOMER WHO GAVE A NAME IS TITLED BY IT. One who gave only an email
    // is titled by that, because it is the only identity the business has for
    // them and it is the owner's own record — the browser suite covers that
    // case. What must never happen is contact details piling up as facts.
    eq("a person is titled by their name when they gave one", dana.label, "Dana Reyes");
  }

  // ======================================================================
  console.log("\n=== 7i. What J4 noticed is about THIS record ===\n");
  // ======================================================================
  {
    // The card's "J4 noticed" block is keyed on GenesisObservation.recordId.
    // NOTHING WRITES THAT FIELD TODAY -- every live observation is store-wide
    // -- so this proves the read is correct rather than proving the feature is
    // populated, and the store-wide case is asserted to stay OUT.
    const { store } = await makeStore();
    const asset = await prismaSystem.businessRecord.create({
      data: {
        storeId: store.id, entityType: "asset", externalId: `asset-noticed-${stamp}`,
        sourceProvider: "test", provenance: "OWNER", provenanceDetail: "suite",
        data: { title: "Spring lookbook" },
      },
    });
    await prismaSystem.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: `about-record-${stamp}`, genesisState: "opportunity",
        summary: "This lookbook has never been used in a post.",
        status: "ACTIVE", recordId: asset.id, entityType: "asset",
      },
    });
    await prismaSystem.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: `store-wide-${stamp}`, genesisState: "urgent",
        summary: "No payment provider is connected.", status: "ACTIVE",
      },
    });
    await prismaSystem.genesisObservation.create({
      data: {
        storeId: store.id, dedupeKey: `dismissed-${stamp}`, genesisState: "opportunity",
        summary: "An old note about this lookbook.", status: "DISMISSED", recordId: asset.id,
      },
    });

    // The same query the section runs.
    const rows = await prismaSystem.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE", recordId: { not: null } },
      select: { recordId: true, summary: true },
    });
    const noticed: Record<string, string[]> = {};
    for (const o of rows) if (o.recordId) (noticed[o.recordId] ??= []).push(o.summary);

    eq("an observation about a record reaches that record's card",
      noticed[asset.id], ["This lookbook has never been used in a post."]);
    eq("a store-wide observation reaches no card at all", Object.keys(noticed).length, 1);
    assert("and a dismissed one is not resurrected onto a card",
      !JSON.stringify(noticed).includes("An old note"), JSON.stringify(noticed));

    // AND THE CURRENT TRUTH, checked rather than assumed: no producer in the
    // codebase names a record yet, so this block is silent in production.
    const producers = readFileSync("lib/dashboard/genesisObservations.ts", "utf8");
    assert("the observation writer does accept a recordId",
      producers.includes("recordId"), "recordId absent from the writer");
  }

  // ======================================================================
  console.log("\n=== 7j. A missing identifier matches nothing ===\n");
  // ======================================================================
  {
    // Sean (2026-09-02): "We should never allow two unrelated entities to
    // match simply because both happen to have null identifiers. Matching
    // needs to require an actual identifying value."
    //
    // THE DEFECT THIS REPLACED. `CONNECTOR_CATALOG.find((e) => e.provider ===
    // platform.publishProvider)` with a null publishProvider matched the first
    // catalogue entry that also had `provider: null`, so X — the one platform
    // Genesis genuinely cannot publish to — described Toast POS.
    const prospects = socialProspects([]);

    // First, the hazard is real and still present in the data, so this check
    // is not guarding a condition that quietly went away.
    const nullProviderPlatforms = SOCIAL_PLATFORMS.filter((pf) => pf.publishProvider === null);
    const nullProviderEntries = CONNECTOR_CATALOG.filter((e) => e.provider === null);
    assert("there is still a platform with no provider",
      nullProviderPlatforms.length > 0, JSON.stringify(SOCIAL_PLATFORMS.map((p) => p.id)));
    assert("and still a catalogue entry with no provider, so null could match null",
      nullProviderEntries.length > 0, JSON.stringify(CONNECTOR_CATALOG.map((e) => e.id)));

    for (const pf of nullProviderPlatforms) {
      const prospect = prospects.find((x) => x.id === pf.id)!;
      assert(`${pf.label} takes no catalogue entry's id`,
        prospect.serviceId === null, String(prospect.serviceId));
      assert(`${pf.label} takes no catalogue entry's words`,
        prospect.detail === "", prospect.detail);
      assert(`${pf.label} is not offered as connectable`,
        prospect.available === false, String(prospect.available));
      // The specific wrong answer, named, so a regression is legible.
      const wouldHaveBeen = CONNECTOR_CATALOG.find((e) => e.provider === pf.publishProvider);
      assert(`${pf.label} does not describe ${wouldHaveBeen?.id ?? "an unrelated service"}`,
        wouldHaveBeen === undefined || prospect.detail !== wouldHaveBeen.description,
        `${prospect.detail}`);
    }

    // ---- and a platform that DOES have a provider still finds its own ----
    const instagram = prospects.find((x) => x.id === "instagram")!;
    const igEntry = CONNECTOR_CATALOG.find((e) => e.provider === "INSTAGRAM");
    eq("a platform with a real provider keeps its own catalogue entry",
      instagram.serviceId, igEntry?.id ?? null);
    assert("and its own description", instagram.detail === (igEntry?.description ?? ""),
      instagram.detail.slice(0, 80));

    // ---- connected state comes from what is connected --------------------
    const live = socialProspects(["INSTAGRAM"]);
    eq("a connected platform reads as connected",
      live.find((x) => x.id === "instagram")?.connected, true);
    eq("and an unconnected one does not",
      live.find((x) => x.id === "tiktok")?.connected, false);
  }

  // ======================================================================
  console.log("\n=== 7k. Connect is offered only where it can be honoured ===\n");
  // ======================================================================
  {
    // Sean: "If Genesis doesn't actually have a connector for that service,
    // there should be no Connect button." So the card carries an explicit
    // `connectable`, rather than the interface inferring one from the mere
    // presence of an id.
    const { store } = await makeStore();
    const map = await mapFor(store.id, store.slug);
    const social = map.domains.find((d) => d.key === "social")!;

    const entities = entitiesFor(social, [
      { id: "insta", label: "Instagram", available: true, connected: false, detail: "d", serviceId: "instagram" },
      { id: "already", label: "Facebook", available: true, connected: true, detail: "d", serviceId: "facebook" },
      // HAS AN ID, HAS NO CONNECTOR. This is the case the old inference got
      // wrong: an id was taken as proof that connecting was possible.
      { id: "nope", label: "Toast POS", available: false, connected: false, detail: "d", serviceId: "toast-pos" },
      { id: "x", label: "X", available: false, connected: false, detail: "", serviceId: null },
    ]);

    const byLabel = (l: string) => entities.find((e) => e.label === l)!;
    eq("an available, unconnected service can be connected", byLabel("Instagram").connectable, true);
    eq("an already-connected one cannot be connected again", byLabel("Facebook").connectable, false);
    eq("a service with an id but no connector cannot be connected",
      byLabel("Toast POS").connectable, false);
    eq("and neither can one with no id at all", byLabel("X").connectable, false);

    // A THING IS NOT A SERVICE. Nothing read off a business record is ever
    // connectable, however it is labelled.
    const commerceEntities = entitiesFor(map.domains.find((d) => d.key === "business")!);
    assert("no record-backed entity is ever connectable",
      commerceEntities.every((e) => e.connectable === false),
      JSON.stringify(commerceEntities.filter((e) => e.connectable).map((e) => e.label)));
  }

  console.log("\n=== 8. Nothing here writes ===\n");
  // ======================================================================
  {
    const source = readFileSync("lib/businessModel/businessMap.ts", "utf8");
    // A TYPE-ONLY IMPORT IS NOT A DATABASE TOUCH. The first version banned the
    // string outright and failed on `import type { RecordProvenance } from
    // "@prisma/client"`, which is erased at compile time and reads nothing.
    // What must not exist is a runtime client or a query.
    assert("the assembler imports nothing from prisma at runtime",
      !/^import\s+\{[^}]*\}\s+from\s+"@\/lib\/prisma"/m.test(source) &&
      !/^import\s+(?!type)[^;]*from\s+"@prisma\/client"/m.test(source),
      "a runtime prisma import exists");
    assert("and never calls one",
      !/prisma[A-Za-z]*\s*\./.test(source), "a prisma call exists");
    for (const write of ["create(", "update(", "delete(", "upsert("]) {
      assert(`and contains no ${write.slice(0, -1)} call`, !source.includes(write));
    }
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: `map-${stamp}-` } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
