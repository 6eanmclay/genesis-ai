import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// A TOGGLE THE OWNER APPROVED MUST STILL MEAN WHAT IT SAID (P1):
//
//   npx tsx scripts/run-pg-suites.ts j4-order-fulfilment
//
// ============ WHY A TOGGLE IS NOT AN ORDINARY ACTION ===============
//
// toggleOrderFulfilledExecutable reads the current state and flips it, on
// purpose: in the dashboard the click and the write are a second apart, and
// reading live is what makes it safe against a stale page.
//
// An approval is a different shape. The proposal and the execution are
// separated by however long the owner takes to say yes, and a flip is the one
// operation whose MEANING INVERTS when the state moves underneath it. "Mark it
// shipped", approved an hour later against an order somebody already shipped,
// un-ships it — and the owner's approval was truthful when they gave it.
//
// So the guard is the drift check that already exists: previousValues freezes
// the fulfilment state that made the summary true, getCurrentValues reads it
// live at approval, and a difference is a refusal. Nothing new was invented,
// and the executable was NOT converted into a set-state action — its semantics
// are right for the dashboard; it is the approval gap that needed the guard.
//
// ============ AND THE SABOTAGE HAS TO CROSS THAT BOUNDARY ==========
//
// Testing the predicate alone would prove nothing. Every assertion below runs
// driftFor against a REAL ApprovalRequest row, which is the same call the
// approval path makes — that is the only place the answer matters.

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
  const { TOOL_HANDLERS } = await import("@/lib/execution/toolHandlers");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const { driftFor } = await import("@/lib/execution/approvalDrift");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { toggleOrderFulfilledExecutable } = await import("@/lib/execution/executables/orders");

  const owner = await prisma.user.create({ data: { email: `ff-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `ff-${uniq()}`, published: true },
  });
  const stranger = await prisma.user.create({ data: { email: `ff-other-${uniq()}@test.local` } });
  const otherStore = await prisma.store.create({
    data: { userId: stranger.id, name: "Someone Else", slug: `ff-other-${uniq()}`, published: true },
  });

  const makeOrder = (storeId: string, productName: string, buyerEmail: string, fulfilled = false) =>
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
        ...(fulfilled ? { fulfillmentStatus: "fulfilled", fulfilledAt: new Date() } : {}),
      },
    });

  const runTool = (storeId: string, userId: string, input: unknown) =>
    TOOL_HANDLERS.toggle_order_fulfilled({
      storeId,
      userId,
      userMessage: "mark it shipped",
      conversationalReply: "",
      input,
      status: "SUCCESS",
      products: [],
    } as unknown as Parameters<(typeof TOOL_HANDLERS)["toggle_order_fulfilled"]>[0]);

  const latest = async (storeId: string) =>
    (await prisma.approvalRequest.findFirst({
      where: { storeId, actionType: "toggle_order_fulfilled" },
      orderBy: { createdAt: "desc" },
    }))!;

  // ============================================================
  console.log("=== 1. an unchanged proposal is approvable, and says which way it goes ===");
  const mug = await makeOrder(store.id, "Copper Mug", "jane@example.test");
  const proposed = await runTool(store.id, owner.id, { productName: "Copper Mug" });
  check("proposed, not performed", proposed.handled && proposed.executionStatus, "PENDING");

  const approval = await latest(store.id);
  check("against the existing action", approval.actionType, "toggle_order_fulfilled");
  check("the summary says which direction", approval.summary, "Mark Copper Mug as shipped");
  const frozen = approval.previousValues as { fulfillmentStatus?: string };
  check("and freezes the state that made it true", frozen.fulfillmentStatus, "unfulfilled");
  // 5. NO INTERNAL ID IN OWNER-FACING TEXT.
  assert("the summary never shows an order id", !approval.summary.includes(mug.id));
  assert("nor does the reply", proposed.handled && !proposed.reply.includes(mug.id));
  // 6. AND IT IS APPROVABLE — measured through driftFor, the approval path's own call.
  check("nothing has drifted, so the owner can approve it", await driftFor(approval, store.id), []);
  check("it still needs that approval", approval.authorizationTier, "always_ask");

  // ============================================================
  console.log("=== 2. unfulfilled at proposal, fulfilled before approval → refused ===");
  //
  // The exact failure the guard exists for: approving now would UN-ship an order
  // that has already gone out, against a summary that said "mark as shipped".
  await prisma.order.updateMany({
    where: { id: mug.id, storeId: store.id },
    data: { fulfillmentStatus: "fulfilled", fulfilledAt: new Date() },
  });
  const driftedForward = await driftFor(approval, store.id);
  check("the approval is refused as stale", driftedForward.length, 1);
  check("naming the field that moved", driftedForward[0]?.key, "fulfillmentStatus");
  check("in words an owner reads", driftedForward[0]?.label, "Fulfilment");
  check("what it was when they were asked", driftedForward[0]?.was, "unfulfilled");
  check("and what it is now", driftedForward[0]?.now, "fulfilled");

  // ============================================================
  console.log("=== 3. fulfilled at proposal, unfulfilled before approval → refused ===");
  //
  // The mirror image, and it must refuse just as hard: approving would re-ship
  // an order somebody deliberately un-marked.
  const ring = await makeOrder(store.id, "Tensor Ring", "sam@example.test", true);
  const proposedUndo = await runTool(store.id, owner.id, { productName: "Tensor Ring" });
  const undoApproval = await latest(store.id);
  check("the summary reads the other way", undoApproval.summary, "Mark Tensor Ring as NOT shipped");
  check("and it is approvable while nothing has moved", await driftFor(undoApproval, store.id), []);

  await prisma.order.updateMany({
    where: { id: ring.id, storeId: store.id },
    data: { fulfillmentStatus: "unfulfilled", fulfilledAt: null },
  });
  const driftedBack = await driftFor(undoApproval, store.id);
  check("the reverse change is refused too", driftedBack.length, 1);
  check("was fulfilled when offered", driftedBack[0]?.was, "fulfilled");
  check("and is not now", driftedBack[0]?.now, "unfulfilled");
  void proposedUndo;

  // ============================================================
  console.log("=== 4. another store's order is unreachable ===");
  const theirs = await makeOrder(otherStore.id, "Their Secret Product", "buyer@example.test");
  const before = await prisma.approvalRequest.count({ where: { storeId: store.id } });
  const cross = await runTool(store.id, owner.id, { productName: "Their Secret Product" });
  check("it cannot be found from here", cross.handled && cross.kind, "fulfilment_order_unresolved");
  check("and nothing was proposed", await prisma.approvalRequest.count({ where: { storeId: store.id } }), before);
  const untouched = await prisma.order.findFirst({ where: { id: theirs.id, storeId: otherStore.id } });
  check("their order is untouched", untouched?.fulfillmentStatus, "unfulfilled");

  // ============================================================
  console.log("=== 5. an unclear order is never silently chosen ===");
  await makeOrder(store.id, "Copper Mug", "chris@example.test");
  const ambiguous = await runTool(store.id, owner.id, { productName: "Copper Mug" });
  check("two orders for one product are not guessed between", ambiguous.handled && ambiguous.kind, "fulfilment_order_ambiguous");
  assert("and the refusal names them by buyer, not by id",
    ambiguous.handled && ambiguous.reply.includes("jane@example.test") && !ambiguous.reply.includes(mug.id));

  const soleOwner = await prisma.user.create({ data: { email: `ff-sole-${uniq()}@test.local` } });
  const soleStore = await prisma.store.create({
    data: { userId: soleOwner.id, name: "One Order Only", slug: `ff-sole-${uniq()}`, published: true },
  });
  await makeOrder(soleStore.id, "The Only Thing", "only@example.test");
  const soleVague = await runTool(soleStore.id, soleOwner.id, {});
  check("even with a single order, naming none is refused", soleVague.handled && soleVague.kind, "fulfilment_order_ambiguous");
  check("and nothing is proposed for it", await prisma.approvalRequest.count({ where: { storeId: soleStore.id } }), 0);

  // ============================================================
  console.log("=== 6. verification is enforced, and the result reaches J4 ===");
  assert("the action routes to the executable that already existed",
    GENESIS_ACTIONS.toggle_order_fulfilled.executable === toggleOrderFulfilledExecutable);
  assert("which can be read back after it runs",
    typeof GENESIS_ACTIONS.toggle_order_fulfilled.executable.verify === "function");

  const shipMe = await makeOrder(store.id, "Ready To Ship", "ship@example.test");
  const seenBefore = await getBusinessUnderstanding(store.id);
  check("J4 sees it as unshipped", seenBefore.recentOrders.find((o) => o.id === shipMe.id)?.fulfillmentStatus, "unfulfilled");

  await toggleOrderFulfilledExecutable.run(
    { orderId: shipMe.id },
    { storeId: store.id, userId: owner.id, actorType: "GENESIS" },
  );
  const seenAfter = await getBusinessUnderstanding(store.id);
  check("and knows once it has shipped", seenAfter.recentOrders.find((o) => o.id === shipMe.id)?.fulfillmentStatus, "fulfilled");

  await prisma.order.deleteMany({ where: { storeId: soleStore.id } });
  await prisma.store.delete({ where: { id: soleStore.id } });
  await prisma.user.delete({ where: { id: soleOwner.id } });
  await prisma.order.deleteMany({ where: { storeId: otherStore.id } });
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
