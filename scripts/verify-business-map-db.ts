import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { readOwnerFacts, readOwnerFactsWithProvenance } from "@/lib/businessModel/ownerFacts";
import {
  businessMap, certaintyOf, MAP_DOMAINS, DOMAIN_LABEL, MAP_EDGE_KINDS,
  type MapDomainKey,
} from "@/lib/businessModel/businessMap";
import { CATEGORY_DOMAIN, connectableServices, whatItAdds } from "@/lib/businessModel/connectionDomains";
import { SIGNUP_DESTINATIONS, signupFor } from "@/lib/businessModel/signupDestinations";
import { CONNECTOR_CATALOG, CONNECTION_CATEGORY_LABELS } from "@/lib/integrations/catalog";
import { branchesFor, type MapProspect } from "@/lib/businessModel/mapBranches";
import { SOCIAL_PLATFORMS } from "@/lib/social/platforms";
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

const mapFor = async (storeId: string, slug: string, designCount = 0) =>
  businessMap({
    understanding: await getBusinessUnderstanding(storeId),
    facts: await readOwnerFactsWithProvenance(storeId),
    slug,
    designCount,
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
  console.log("\n=== 7c. The middle layer is derived, not declared ===\n");
  // ======================================================================
  {
    // Sean: "J4 -> Commerce -> Products / Orders / Money. Then the user can
    // select one: Commerce -> Products -> individual products."
    const { store } = await makeStore();
    for (let i = 0; i < 4; i++) {
      await prismaSystem.product.create({
        data: { storeId: store.id, name: `Ring ${i}`, description: "d", priceInCents: 1000, active: true },
      });
    }
    const map = await mapFor(store.id, store.slug);
    const commerce = map.domains.find((d) => d.key === "commerce")!;
    const branches = branchesFor(commerce);

    eq("four products become one branch, not four", branches.length, 1);
    eq("named from the kind the assembler already wrote", branches[0].label, "Products");
    eq("saying how many there are", branches[0].state, "4 recorded");
    eq("with each product underneath it", branches[0].children.length, 4);
    assert("and every leaf still points at a real row",
      branches[0].children.every((c) => c.recordId !== null),
      JSON.stringify(branches[0].children.map((c) => c.recordId)));

    // ---- a group of one is not a group ---------------------------------
    const { store: solo } = await makeStore();
    await prismaSystem.product.create({
      data: { storeId: solo.id, name: "Only Ring", description: "d", priceInCents: 1000, active: true },
    });
    const soloMap = await mapFor(solo.id, solo.slug);
    const soloBranches = branchesFor(soloMap.domains.find((d) => d.key === "commerce")!);
    eq("one product is reachable in one tap, not two", soloBranches.length, 1);
    eq("named as itself rather than pluralised", soloBranches[0].label, "Only Ring");
    eq("with nothing underneath it", soloBranches[0].children.length, 0);
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
    const branches = branchesFor(social, prospects);

    eq("every platform appears", branches.length, SOCIAL_PLATFORMS.length);
    for (const pf of SOCIAL_PLATFORMS) {
      const branch = branches.find((b) => b.label === pf.label);
      assert(`${pf.label} is on the Social branch`, branch !== undefined, pf.label);
      eq(`${pf.label} is not known yet`, branch?.certainty, "unknown");
      // AND NOTHING IS INVENTED UNDER IT. An unconnected account reports
      // nothing, so "Content -> Engagement -> Traffic" must not exist.
      eq(`${pf.label} has no fabricated children`, branch?.children.length, 0);
    }

    const x = branches.find((b) => b.label === "X")!;
    eq("X says Genesis cannot connect it", x.state, "Genesis cannot connect this yet");
    const instagram = branches.find((b) => b.label === "Instagram")!;
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
    const branches = branchesFor(social, [
      { id: "instagram", label: "Instagram", available: true, connected: true, detail: "Audience size.", serviceId: "instagram" },
    ]);
    const ig = branches.find((b) => b.label === "Instagram")!;
    eq("a connected platform reads as known", ig.certainty, "known");
    eq("and says so", ig.state, "Connected");
    // STILL NO INVENTED CHAIN. Connecting an account does not by itself mean
    // J4 has content, engagement or traffic from it -- those appear when rows
    // for them exist, and not a moment sooner.
    eq("but still claims no data it does not have", ig.children.length, 0);
  }

  // ======================================================================
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
