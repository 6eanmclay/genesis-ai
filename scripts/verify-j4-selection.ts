import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHAT THE OWNER IS POINTING AT (P2, the conversation/surface contract):
//
//   npx tsx scripts/run-pg-suites.ts j4-selection
//
// ============ WHAT THIS CONTRACT IS ================================
//
// workspaceContext.ts has told J4 which SURFACE the owner is on since
// 2026-08-14. It could never say which THING on it, so "the product catalog"
// was sayable and "the Copper Mug" was not.
//
// This adds the second half, and almost all of it is reuse:
//
//   selection.nodeIds   in, resolved against THIS STORE'S OWN Business Map
//   focus.nodeIds       out, for a surface to bring something forward
//   take_me_there       may now name a thing, not only a place
//   scope               DERIVED from how many things are pointed at
//
// ============ THE PROPERTIES THAT MATTER ===========================
//
// A POINTER, NEVER DATA. Labels and kinds reach the prompt; recordId does not.
// The understanding stays the only answer to "what does J4 know" - a selection
// says which part of it the conversation is about.
//
// THE MAP IS THE AUTHORIZATION. A node from another store, one that never
// existed, and a malformed string all fail identically: they are not in this
// store's map. One rule rather than three checks, because three checks are
// three chances to write one of them wrongly.
//
// AND THE PROMPT MUST ACTUALLY CHANGE. A selection that altered only UI state
// would be theatre. Every scope assertion below reads the assembled parts that
// go to the model.

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
  const { resolveSelection, describeSelectionForJ4 } = await import("@/lib/j4/selectionContext");
  const { buildTurnContext } = await import("@/lib/dashboard/chatTurnContext");
  const { makeTakeMeThere } = await import("@/lib/execution/toolHandlers");

  const owner = await prisma.user.create({ data: { email: `sel-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `sel-${uniq()}`, published: true },
  });
  const stranger = await prisma.user.create({ data: { email: `sel-other-${uniq()}@test.local` } });
  const otherStore = await prisma.store.create({
    data: { userId: stranger.id, name: "Someone Else", slug: `sel-other-${uniq()}`, published: true },
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
    map.nodes.find((node) => node.recordId?.includes(productId))?.id ?? null;
  const mugNode = nodeFor(mug.id);
  const ringNode = nodeFor(ring.id);

  console.log("=== 1. the map gives every selectable thing an id and a human name ===");
  assert("the mug is on the map", mugNode !== null);
  assert("so is the ring", ringNode !== null);
  const mugMapNode = map.nodes.find((n) => n.id === mugNode);
  check("named the way a person says it", mugMapNode?.label, "Copper Mug");
  assert("and classed, so a comparison can say what it compares", mugMapNode?.kind !== null);

  console.log("=== 2. scope is derived from how many things are pointed at ===");
  check("nothing selected is the whole business", resolveSelection(map, []).scope, "business");
  check("one thing is a drill-down", resolveSelection(map, [mugNode]).scope, "entity");
  check("more than one is a comparison", resolveSelection(map, [mugNode, ringNode]).scope, "comparison");
  check("and the entities come back in the order they were picked",
    resolveSelection(map, [ringNode, mugNode]).entities.map((e) => e.label), ["Tensor Ring", "Copper Mug"]);
  check("a repeat is one thing, not two",
    resolveSelection(map, [mugNode, mugNode]).entities.length, 1);

  console.log("=== 3. nothing that is not on THIS map survives ===");
  const theirNode = (await mapForStore(otherStore.id, await getBusinessUnderstanding(otherStore.id)))
    .nodes.find((n) => n.recordId?.includes(theirs.id))?.id ?? null;
  assert("the other store really does have such a node", theirNode !== null);
  check("but it resolves to nothing here", resolveSelection(map, [theirNode]).entities, []);
  check("a node that never existed resolves to nothing", resolveSelection(map, ["product:does-not-exist"]).entities, []);
  check("and so does a malformed one", resolveSelection(map, ["'; DROP TABLE--", "", "product:"]).entities, []);
  check("a non-array is simply no selection", resolveSelection(map, "product:whatever").scope, "business");
  check("and neither are non-strings inside one", resolveSelection(map, [null, 42, {}]).entities, []);
  // The mixed case is the one that matters: a real id alongside a foreign one
  // must keep the real one and drop the other, not refuse everything.
  const mixed = resolveSelection(map, [mugNode, theirNode, "product:nope"]);
  check("a good id alongside bad ones keeps only the good one", mixed.entities.map((e) => e.label), ["Copper Mug"]);
  check("and that is still a drill-down", mixed.scope, "entity");

  // INDISTINGUISHABLE, not merely all-empty. A caller who could tell a
  // cross-store id from a nonsense one has been handed a probe: it would
  // answer "that exists, just not for you" about somebody else's business.
  const foreign = JSON.stringify(resolveSelection(map, [theirNode]));
  const missing = JSON.stringify(resolveSelection(map, ["product:does-not-exist"]));
  const rubbish = JSON.stringify(resolveSelection(map, ["'; DROP TABLE--"]));
  check("another store's node reads exactly like one that never existed", foreign, missing);
  check("and so does malformed input", rubbish, missing);

  console.log("=== 4. what J4 is told carries names, never internal ids ===");
  const oneLine = describeSelectionForJ4(resolveSelection(map, [mugNode]))!;
  assert("it names the thing", oneLine.includes("Copper Mug"));
  assert("it never contains the node id", !oneLine.includes(mugNode!));
  assert("nor the record id behind it", !oneLine.includes(mug.id));
  const twoLine = describeSelectionForJ4(resolveSelection(map, [mugNode, ringNode]))!;
  assert("a comparison names both", twoLine.includes("Copper Mug") && twoLine.includes("Tensor Ring"));
  assert("and still leaks no ids", !twoLine.includes(mug.id) && !twoLine.includes(ring.id));
  check("nothing selected says nothing at all", describeSelectionForJ4(resolveSelection(map, [])), null);
  // The record id IS available server-side, which is the whole point of the split.
  check("but a handler can still find the row",
    resolveSelection(map, [mugNode]).entities[0]?.recordId !== null, true);

  console.log("=== 5. THE PROMPT ITSELF CHANGES WITH SCOPE ===");
  //
  // The assertion that stops this being UI theatre: the parts assembled for the
  // model must genuinely differ.
  const turn = (selectedNodeIds: unknown) =>
    buildTurnContext({
      storeId: store.id,
      userId: owner.id,
      userMessage: "what about this?",
      activeProductNames: "Copper Mug, Tensor Ring",
      workspacePath: "/dashboard/products",
      selectedNodeIds,
    });

  const whole = await turn([]);
  const one = await turn([mugNode]);
  const both = await turn([mugNode, ringNode]);

  check("no selection is the whole business", whole.selection.scope, "business");
  check("one is an entity", one.selection.scope, "entity");
  check("two is a comparison", both.selection.scope, "comparison");

  const text = (parts: string[]) => parts.join("\n");
  assert("the whole-business prompt mentions no specific selection",
    !text(whole.parts).includes("looking at Copper Mug"));
  assert("the entity prompt tells J4 what 'this' means",
    text(one.parts).includes("Copper Mug") && text(one.parts).includes("this"));
  assert("the comparison prompt asks for both together",
    text(both.parts).includes("Copper Mug") && text(both.parts).includes("Tensor Ring"));
  assert("the three prompts are genuinely different",
    text(whole.parts) !== text(one.parts) && text(one.parts) !== text(both.parts));
  assert("and no prompt anywhere carries a record id",
    !text(one.parts).includes(mug.id) && !text(both.parts).includes(ring.id));
  // The surface line still works, unchanged.
  assert("the surface J4 was already told about is still there",
    text(one.parts).includes("product catalog"));

  console.log("=== 6. navigation may name a thing, and cannot leave the store ===");
  const takeMeThere = makeTakeMeThere((href) => href);
  // `intent` is nullable but REQUIRED. Omitting it fails the parse and sends
  // every case to the "I am not sure where you want to go" branch — which is
  // how this section passed its first two assertions while exercising none of
  // the new path.
  const nav = (input: unknown) =>
    takeMeThere({
      storeId: store.id,
      userId: owner.id,
      userMessage: "show me that",
      conversationalReply: "",
      input,
      status: "SUCCESS",
      products: [],
      understanding,
    } as unknown as Parameters<typeof takeMeThere>[0]);

  const toMug = await nav({ destination: "commerce", nodeLabel: "Copper Mug", intent: null });
  check("naming a real thing focuses it", toMug.handled && toMug.kind, "take_me_there");
  check("the focus is that node", toMug.handled && toMug.focus, [mugNode]);
  assert("and the reply names it without its id",
    toMug.handled && toMug.reply.includes("Copper Mug") && !toMug.reply.includes(mugNode!));

  const toTheirs = await nav({ destination: "commerce", nodeLabel: "Their Secret Product", intent: null });
  check("another store's thing cannot be navigated to", toTheirs.handled && toTheirs.kind, "take_me_there_unresolved");
  assert("and nothing is focused", toTheirs.handled && toTheirs.focus === undefined);

  const toNothing = await nav({ destination: "commerce", nodeLabel: "A Thing That Does Not Exist", intent: null });
  check("nor can something that does not exist", toNothing.handled && toNothing.kind, "take_me_there_unresolved");

  // NO NEAR MISSES. A partial name must not resolve to the thing it is part
  // of: bringing up the Copper Mug when the owner said something else is a
  // quiet wrong answer, which is worse than saying it could not be found.
  const partial = await nav({ destination: "commerce", nodeLabel: "Copper", intent: null });
  check("a partial name resolves to nothing", partial.handled && partial.kind, "take_me_there_unresolved");
  const spaced = await nav({ destination: "commerce", nodeLabel: "  Copper Mug  ", intent: null });
  check("but surrounding whitespace is forgiven", spaced.handled && spaced.kind, "take_me_there");

  // The surface-only destinations must be exactly as they were.
  const toSurface = await nav({ destination: "storefront", intent: null });
  check("a plain destination still navigates", toSurface.handled && toSurface.kind, "take_me_there");
  check("to the surface it always did", toSurface.handled && toSurface.navigate, "/dashboard/website");
  assert("and focuses nothing", toSurface.handled && toSurface.focus === undefined);

  // THE TRAP THIS SUITE ALREADY FELL INTO, now an assertion. `intent` is
  // nullable but REQUIRED, so an input without it fails the parse and lands
  // in the "I am not sure where you want to go" branch — which returns
  // handled:true and a take_me_there kind, and therefore looks like a pass.
  // Pinning the difference means a fixture that stops exercising the schema
  // path can no longer be mistaken for a working one.
  const malformedNav = await nav({ destination: "storefront" });
  assert("an input that fails the schema does not navigate",
    malformedNav.handled && malformedNav.navigate === undefined);
  assert("and is distinguishable from one that does",
    toSurface.handled && toSurface.navigate !== undefined);

  console.log("=== 7. an ordinary turn does not build the map at all ===");
  //
  // Almost every turn has nothing selected, and the map costs two queries
  // plus an assembly. SOURCE-ASSERTED rather than measured, and said plainly:
  // this checks that the call sits behind the conditional, not that a query
  // did not run. The behavioural half is above — an unselected turn still
  // produces a correct whole-business context.
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const turnSrc = readFileSync(join(process.cwd(), "lib", "dashboard", "chatTurnContext.ts"), "utf8");
  assert("mapForStore is only reached when something is selected",
    /requested\.length[\s\S]{0,120}mapForStore\(/.test(turnSrc));
  assert("and an unselected turn resolves without one",
    whole.selection.entities.length === 0 && whole.selection.scope === "business");

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
