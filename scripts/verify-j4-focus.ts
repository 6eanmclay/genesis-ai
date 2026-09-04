import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// J4 CAN BRING A THING FORWARD ON THE MAP (P2's focus, consumed):
//
//   npx tsx scripts/run-pg-suites.ts j4-focus
//
// ============ WHY THIS IS TWO STAGES ===============================
//
// P2 gave J4 `focus.nodeIds` and nothing rendered them. Wiring it up is not
// "put a ring around a circle": BusinessMapCanvas draws the NINE DOMAINS as its
// ring, and individual entities only exist once a domain is opened, in the
// carousel. So focusing `product:<id>` means OPEN THAT NODE'S DOMAIN and then
// HIGHLIGHT IT among the entities.
//
// `focusPlan` is the pure half of that decision and is what this suite drives.
// The map is still the authorization, exactly as in selectionContext: an id not
// in this store's map is not found, whether it is another store's, a typo, or
// nonsense.
//
// ============ AND FOCUS IS PRESENTATION, NOTHING ELSE ==============
//
// Assertions below check that focusing changes what is SHOWN and nothing else:
// no map data moves, no understanding changes, nothing persists. A focus that
// could alter a fact about the business would be a second source of truth
// wearing a highlight.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passes++;
    console.log(`  PASS  ${label}`);
  } else {
    failures++;
    failed.push(label);
    console.log(`  FAIL  ${label}  — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function assert(label: string, ok: boolean): void {
  check(label, ok, true);
}

const uniq = () => Math.random().toString(36).slice(2, 10);

async function main(): Promise<void> {
  const db = await startRealPostgres();
  try {
    await run(db);
  } finally {
    await db.close();
  }
}

async function run(db: Awaited<ReturnType<typeof startRealPostgres>>): Promise<void> {
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { mapForStore } = await import("@/lib/businessModel/mapForStore");
  const { focusPlan } = await import("@/lib/businessModel/focusPlan");
  const focusStore = await import("@/lib/dashboard/j4Focus");

  const owner = await prisma.user.create({ data: { email: `foc-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `foc-${uniq()}`, published: true },
  });
  const stranger = await prisma.user.create({ data: { email: `foc-other-${uniq()}@test.local` } });
  const otherStore = await prisma.store.create({
    data: { userId: stranger.id, name: "Someone Else", slug: `foc-other-${uniq()}`, published: true },
  });

  const mug = await prisma.product.create({
    data: { storeId: store.id, name: "Copper Mug", priceInCents: 2200, active: true },
  });
  const ring = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 4200, active: true },
  });
  const theirs = await prisma.product.create({
    data: { storeId: otherStore.id, name: "Their Secret Product", priceInCents: 9900, active: true },
  });

  const understanding = await getBusinessUnderstanding(store.id);
  const map = await mapForStore(store.id, understanding, { slug: store.slug });
  const nodeFor = (productId: string) =>
    map.nodes.find((n) => n.recordId?.includes(productId))?.id ?? null;
  const mugNode = nodeFor(mug.id)!;
  const ringNode = nodeFor(ring.id)!;

  console.log("=== 1. a valid node opens its own domain and lights up ===");
  const one = focusPlan(map, [mugNode]);
  check("exactly that node is focused", one.nodeIds, [mugNode]);
  const mugDomain = map.nodes.find((n) => n.id === mugNode)!.domain;
  check("and the domain opened is the one it lives in", one.domain, mugDomain);
  assert("which is a real domain on this map", map.domains.some((d) => d.key === one.domain));

  console.log("=== 2. several nodes are a comparison, in the order asked for ===");
  const many = focusPlan(map, [ringNode, mugNode]);
  check("both are focused", many.nodeIds, [ringNode, mugNode]);
  check("in the order J4 named them", many.nodeIds[0], ringNode);
  check("and the domain is the first one's", many.domain, map.nodes.find((n) => n.id === ringNode)!.domain);
  check("a repeat is one focus, not two", focusPlan(map, [mugNode, mugNode]).nodeIds, [mugNode]);

  console.log("=== 3. nothing that is not on THIS map focuses anything ===");
  const otherMap = await mapForStore(otherStore.id, await getBusinessUnderstanding(otherStore.id));
  const theirNode = otherMap.nodes.find((n) => n.recordId?.includes(theirs.id))!.id;
  const foreign = focusPlan(map, [theirNode]);
  check("another store's node focuses nothing", foreign.nodeIds, []);
  check("and opens no domain", foreign.domain, null);
  check("a node that never existed focuses nothing", focusPlan(map, ["product:nope"]).nodeIds, []);
  check("and neither does a malformed id", focusPlan(map, ["'; DROP TABLE--", "", "::"]).nodeIds, []);
  check("nor a non-array", focusPlan(map, "product:whatever").domain, null);
  check("nor non-strings inside one", focusPlan(map, [null, 7, {}]).nodeIds, []);
  // INDISTINGUISHABLE, the same property selectionContext holds: a caller who
  // could tell a foreign id from a nonsense one has been handed a probe.
  check("another store's node is indistinguishable from one that never existed",
    JSON.stringify(foreign), JSON.stringify(focusPlan(map, ["product:nope"])));

  console.log("=== 4. a good id alongside bad ones still works ===");
  const mixed = focusPlan(map, [theirNode, mugNode, "rubbish"]);
  check("only the good one is focused", mixed.nodeIds, [mugNode]);
  check("and its domain is opened", mixed.domain, mugDomain);

  console.log("=== 5. a node that has since gone focuses nothing ===");
  //
  // Stale focus is a real case: J4 names a thing, the owner deletes it, the
  // focus arrives against a map that no longer has it.
  await prisma.product.deleteMany({ where: { id: ring.id, storeId: store.id } });
  const afterDelete = await mapForStore(store.id, await getBusinessUnderstanding(store.id), { slug: store.slug });
  check("the removed node is gone from the map", afterDelete.nodes.some((n) => n.id === ringNode), false);
  check("and focusing it does nothing", focusPlan(afterDelete, [ringNode]).nodeIds, []);
  check("while the one still there is unaffected", focusPlan(afterDelete, [mugNode]).nodeIds, [mugNode]);

  console.log("=== 6. focusing changes nothing about the business ===");
  const before = JSON.stringify(map.nodes.find((n) => n.id === mugNode));
  focusPlan(map, [mugNode]);
  focusPlan(map, [mugNode, ringNode]);
  check("the node is byte-identical after being focused",
    JSON.stringify(map.nodes.find((n) => n.id === mugNode)), before);
  const understandingAfter = await getBusinessUnderstanding(store.id);
  check("and the understanding still says the same thing",
    understandingAfter.recentOrders.length, understanding.recentOrders.length);
  check("no focus was written anywhere",
    await prisma.businessRecord.count({ where: { storeId: store.id, entityType: "focus" } }), 0);

  console.log("=== 7. the store is presentation state, and behaves like it ===");
  focusStore.resetJ4FocusForTests();
  check("nothing is focused to begin with", focusStore.getJ4FocusSnapshot().nodeIds, []);
  // ASSERTED WHILE FOCUS IS SET, which is the only way it discriminates:
  // checking the server snapshot on an empty store passes whether or not it
  // reads the client's state, and a sabotage that returned the live snapshot
  // stayed green because of exactly that.
  focusStore.setJ4Focus([mugNode]);
  check("the client has focus", focusStore.getJ4FocusSnapshot().nodeIds, [mugNode]);
  check("but the server never does", focusStore.getJ4FocusServerSnapshot().nodeIds, []);
  focusStore.resetJ4FocusForTests();

  let notified = 0;
  const unsubscribe = focusStore.subscribeJ4Focus(() => { notified++; });
  focusStore.setJ4Focus([mugNode]);
  check("setting focus notifies the surface", notified, 1);
  check("and the snapshot holds it", focusStore.getJ4FocusSnapshot().nodeIds, [mugNode]);
  focusStore.setJ4Focus([mugNode]);
  check("setting the same focus again does not re-render", notified, 1);
  focusStore.setJ4Focus([mugNode, ringNode]);
  check("a different focus does", notified, 2);
  focusStore.clearJ4Focus();
  check("clearing empties it", focusStore.getJ4FocusSnapshot().nodeIds, []);
  unsubscribe();
  focusStore.setJ4Focus([mugNode]);
  check("and an unsubscribed surface stops hearing about it", notified, 3);

  await prisma.product.deleteMany({ where: { storeId: otherStore.id } });
  await prisma.store.delete({ where: { id: otherStore.id } });
  await prisma.user.delete({ where: { id: stranger.id } });

  console.log("");
  console.log(`${failures} failed, ${passes} passed`);
  for (const label of failed) console.log(`  - ${label}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
