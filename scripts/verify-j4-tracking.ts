import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// J4 CAN SAY A PARCEL HAS GONE OUT (J4_CAPABILITY_AUDIT.md, P1):
//
//   npx tsx scripts/run-pg-suites.ts j4-tracking
//
// ============ WHAT WAS MISSING =====================================
//
// attachTrackingExecutable and correctTrackingExecutable have existed since the
// shipping milestone, with verify() and the ORDERS_MANAGE gate, and NOTHING
// conversational could reach them. An owner could ask J4 to build a store and
// not to say a parcel had shipped — the most ordinary thing they do all day.
//
// ============ AND WHY THE ORDER IS NAMED, NOT NUMBERED =============
//
// There is no order number. The Order model carries a cuid and Stripe's session
// id, and neither is something a person says. So an order is identified the way
// an owner refers to one — what was bought, who bought it — and the handler
// resolves that against their own orders. Inventing a customer-facing order
// number to make the tool tidier would be a new identifier nobody asked for.
//
// The assertions below therefore care as much about what is REFUSED as what is
// proposed: the nearest wrong order is a real customer sent to a courier page
// about somebody else's parcel.

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
function assert(label: string, ok: boolean, detail = ""): void {
  check(label + (detail ? `  (${detail})` : ""), ok, true);
}

const uniq = () => Math.random().toString(36).slice(2, 10);
const GOOD = "1Z999AA10123456784";

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
  const { TOOL_HANDLERS } = await import("@/lib/execution/toolHandlers");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { attachTrackingExecutable } = await import("@/lib/execution/executables/attachTracking");

  const owner = await prisma.user.create({ data: { email: `trk-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `trk-${uniq()}`, published: true },
  });
  const stranger = await prisma.user.create({ data: { email: `trk-other-${uniq()}@test.local` } });
  const otherStore = await prisma.store.create({
    data: { userId: stranger.id, name: "Someone Else", slug: `trk-other-${uniq()}`, published: true },
  });

  const order = async (storeId: string, productName: string, buyerEmail: string, tracking: string | null = null) =>
    prisma.order.create({
      data: {
        storeId,
        productName,
        buyerEmail,
        quantity: 1,
        amountInCents: 4200,
        status: "paid",
        paymentProvider: "STRIPE",
        externalOrderId: `cs_${uniq()}`,
        ...(tracking ? { trackingNumber: tracking, carrier: "USPS" } : {}),
      },
    });

  const mug = await order(store.id, "Copper Mug", "jane@example.test");
  const ring = await order(store.id, "Tensor Ring", "sam@example.test");
  const theirs = await order(otherStore.id, "Their Secret Product", "buyer@example.test");

  const runTool = async (tool: "attach_tracking" | "correct_tracking", input: unknown) =>
    TOOL_HANDLERS[tool]({
      storeId: store.id,
      userId: owner.id,
      userMessage: "the mug order went out",
      conversationalReply: "",
      input,
      status: "SUCCESS",
      products: [],
    } as unknown as Parameters<(typeof TOOL_HANDLERS)["attach_tracking"]>[0]);

  const pending = () =>
    prisma.approvalRequest.findMany({ where: { storeId: store.id, status: "PENDING_APPROVAL" } });

  console.log("=== 1. an order the owner names is proposed, not written ===");
  const attached = await runTool("attach_tracking", { productName: "Copper Mug", trackingNumber: GOOD });
  check("proposed, not performed", attached.handled && attached.executionStatus, "PENDING");
  const proposals = await pending();
  check("exactly one thing is waiting", proposals.length, 1);
  check("against the existing attach action", proposals[0]?.actionType, "attach_tracking");
  const proposedInput = (proposals[0]?.input ?? {}) as { orderId?: string; trackingNumber?: string; carrier?: string };
  check("aimed at the order they named", proposedInput.orderId, mug.id);
  check("carrying the number they gave", proposedInput.trackingNumber, GOOD);
  check("and a carrier, defaulted rather than invented", proposedInput.carrier, "USPS");
  // 5. APPROVAL REQUIREMENTS.
  check("it still needs approval", proposals[0]?.authorizationTier, "always_ask");
  check("and the ceiling says so too", GENESIS_ACTIONS.attach_tracking.maxAuthorityTier, "always_ask");
  const untouched = await prisma.order.findFirst({ where: { id: mug.id, storeId: store.id } });
  check("nothing reached the order yet", untouched?.trackingNumber, null);
  // The id must never be in what the owner reads.
  assert("the reply never shows an internal id", attached.handled && !attached.reply.includes(mug.id));

  console.log("=== 2. the wrong order is refused, never guessed at ===");
  const before = (await pending()).length;
  const nothing = await runTool("attach_tracking", { productName: "A Product Nobody Sold", trackingNumber: GOOD });
  check("an order that does not exist is refused", nothing.handled && nothing.kind, "tracking_order_unresolved");
  const vague = await runTool("attach_tracking", { trackingNumber: GOOD });
  check("naming no order at all is refused, not taken as the newest", vague.handled && vague.kind, "tracking_order_ambiguous");

  // AND WITH EXACTLY ONE ORDER TO CHOOSE FROM, which is the case that
  // actually needs the guard. With several orders, naming nothing is caught
  // by the more-than-one branch anyway — so a sabotage that removed the guard
  // left this section green and proved nothing. A lone order is the shape
  // where 'no name given' would silently resolve to something and ship a
  // tracking number against it.
  const soleOwner = await prisma.user.create({ data: { email: `trk-sole-${uniq()}@test.local` } });
  const soleStore = await prisma.store.create({
    data: { userId: soleOwner.id, name: "One Order Only", slug: `trk-sole-${uniq()}`, published: true },
  });
  await order(soleStore.id, "The Only Thing", "only@example.test");
  const soleVague = await TOOL_HANDLERS.attach_tracking({
    storeId: soleStore.id,
    userId: soleOwner.id,
    userMessage: "it shipped",
    conversationalReply: "",
    input: { trackingNumber: GOOD },
    status: "SUCCESS",
    products: [],
  } as unknown as Parameters<(typeof TOOL_HANDLERS)["attach_tracking"]>[0]);
  check("even with a single order, naming none is still refused",
    soleVague.handled && soleVague.kind, "tracking_order_ambiguous");
  check("and nothing is proposed for it",
    await prisma.approvalRequest.count({ where: { storeId: soleStore.id } }), 0);
  await order(store.id, "Copper Mug", "chris@example.test");
  const ambiguous = await runTool("attach_tracking", { productName: "Copper Mug", trackingNumber: GOOD });
  check("two orders for one product are not guessed between", ambiguous.handled && ambiguous.kind, "tracking_order_ambiguous");
  assert("and the refusal names them by product and buyer, not by id",
    ambiguous.handled && ambiguous.reply.includes("jane@example.test") && !ambiguous.reply.includes(mug.id));
  check("none of that proposed anything", (await pending()).length, before);

  console.log("=== 3. another store's order is unreachable ===");
  const cross = await runTool("attach_tracking", { productName: "Their Secret Product", trackingNumber: GOOD });
  check("it cannot be found from here", cross.handled && cross.kind, "tracking_order_unresolved");
  check("and nothing was proposed against it", (await pending()).length, before);
  const stillTheirs = await prisma.order.findFirst({ where: { id: theirs.id, storeId: otherStore.id } });
  check("their order is untouched", stillTheirs?.trackingNumber, null);

  console.log("=== 4. an implausible tracking number never becomes an approval ===");
  const bad = await runTool("attach_tracking", { productName: "Tensor Ring", trackingNumber: "??" });
  check("refused before an approval is written", bad.handled && bad.kind, "tracking_implausible");
  check("and nothing is waiting for it", (await pending()).length, before);

  console.log("=== 5. attach and correct are not interchangeable ===");
  const shipped = await order(store.id, "Shipped Already", "gone@example.test", "9400111899223197428490");
  const reattach = await runTool("attach_tracking", { productName: "Shipped Already", trackingNumber: GOOD });
  check("attaching to an order that has tracking is refused", reattach.handled && reattach.kind, "tracking_already_present");
  const emptyCorrect = await runTool("correct_tracking", { productName: "Tensor Ring", trackingNumber: GOOD });
  check("correcting one that has none is refused", emptyCorrect.handled && emptyCorrect.kind, "tracking_nothing_to_correct");

  const corrected = await runTool("correct_tracking", { productName: "Shipped Already", trackingNumber: GOOD });
  check("correcting a shipped order is proposed", corrected.handled && corrected.executionStatus, "PENDING");
  const correction = (await pending()).find((a) => a.actionType === "correct_tracking");
  check("against the existing correct action", correction?.actionType, "correct_tracking");
  const prev = (correction?.previousValues ?? {}) as { trackingNumber?: string };
  check("naming the number the owner is agreeing to lose", prev.trackingNumber, "9400111899223197428490");
  check("and it needs approval too", correction?.authorizationTier, "always_ask");

  console.log("=== 6. execution reaches the existing executable, and is verifiable ===");
  //
  // Not a claim that verify() ran — a claim that this action cannot exist
  // without one. The Executable type requires it, so an action whose executable
  // had none would not compile.
  assert("attach routes to the executable that already existed",
    GENESIS_ACTIONS.attach_tracking.executable === attachTrackingExecutable);
  assert("which can be read back after it runs",
    typeof GENESIS_ACTIONS.attach_tracking.executable.verify === "function");
  assert("and correct routes to its own",
    typeof GENESIS_ACTIONS.correct_tracking.executable.verify === "function");
  const handlers = readFileSync(join(process.cwd(), "lib", "execution", "toolHandlers.ts"), "utf8");
  assert("the handler writes an approval rather than calling the executable",
    /actionType,/.test(handlers) && !/attachTrackingExecutable\.run/.test(handlers),
    "a handler that executed directly would tell a customer with nobody deciding");

  console.log("=== 7. the result becomes visible to J4 ===");
  //
  // The loop that makes this usable: J4 names an order, proposes tracking, the
  // owner approves, and J4 must then know the parcel is on its way.
  const seenBefore = await getBusinessUnderstanding(store.id);
  const mugBefore = seenBefore.recentOrders.find((o) => o.id === mug.id);
  assert("J4 can see the order it was asked about", mugBefore !== undefined);
  check("and knows it has no tracking yet", mugBefore?.trackingNumber, null);

  await attachTrackingExecutable.run(
    { orderId: mug.id, trackingNumber: GOOD, carrier: "UPS" },
    { storeId: store.id, userId: owner.id, actorType: "GENESIS" },
  );
  const seenAfter = await getBusinessUnderstanding(store.id);
  const mugAfter = seenAfter.recentOrders.find((o) => o.id === mug.id);
  check("once it is shipped J4 knows the number", mugAfter?.trackingNumber, GOOD);
  check("and the carrier", mugAfter?.carrier, "UPS");
  check("and that it is fulfilled", mugAfter?.fulfillmentStatus, "fulfilled");

  console.log("=== 8. both tools are actually reachable from the chat surface ===");
  const tools = readFileSync(join(process.cwd(), "lib", "execution", "genesisTools.ts"), "utf8");
  assert("attach_tracking is offered to the model", /name: "attach_tracking"/.test(tools));
  assert("correct_tracking is offered to the model", /name: "correct_tracking"/.test(tools));
  const policy = readFileSync(join(process.cwd(), "lib", "execution", "toolPolicy.ts"), "utf8");
  assert("both carry a policy, or mayInvokeTool refuses them",
    /attach_tracking: \{ permission/.test(policy) && /correct_tracking: \{ permission/.test(policy));
  assert("and both are declared as mutating",
    GENESIS_ACTIONS.attach_tracking.category === "operations" &&
      GENESIS_ACTIONS.correct_tracking.category === "operations");

  await prisma.order.deleteMany({ where: { storeId: soleStore.id } });
  await prisma.store.delete({ where: { id: soleStore.id } });
  await prisma.user.delete({ where: { id: soleOwner.id } });
  await prisma.order.deleteMany({ where: { storeId: otherStore.id } });
  await prisma.store.delete({ where: { id: otherStore.id } });
  await prisma.user.delete({ where: { id: stranger.id } });
  void ring;
  void shipped;

  console.log("");
  console.log(`${failures} failed, ${passes} passed`);
  for (const label of failed) console.log(`  - ${label}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
