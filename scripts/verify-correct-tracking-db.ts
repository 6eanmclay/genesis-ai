import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { correctTrackingExecutable } from "@/lib/execution/executables/correctTracking";
import { attachTrackingExecutable } from "@/lib/execution/executables/attachTracking";
import { readFileSync } from "node:fs";

// CORRECTING A TRACKING NUMBER THAT WAS TYPED WRONG:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts correct-tracking-db
//
// ============ THE GUARD THAT WAS RIGHT AND INCOMPLETE (2026-09-01) =====
//
// attachTracking refuses to replace an existing number because "the buyer may
// already be following it". True, and it stays.
//
// It was not true of the case that actually happens. A merchant reads a number
// off a counter receipt, transposes two digits, and it is permanent — with
// nobody having been told, because this deployment has never had an email
// provider. The guard protected a buyer who did not exist and stranded the
// merchant who did.
//
// So the condition is the BUYER, not the column: correction is allowed right up
// until something external has committed to the old number. Most of this suite
// is the three refusals, because a correction path that is too permissive is
// worse than none — it would let somebody silently swap a number a customer is
// refreshing.

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

const GOOD = "9400111899223817200001";
const TYPO = "9400111899223817200002";

let seq = 0;
async function makeStore(stamp: number) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `ct-${stamp}-${n}@example.test` } });
  return prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `ct-${stamp}-${n}`, tagline: "t", description: "d" },
  });
}

let orderSeq = 0;
async function order(storeId: string, stamp: number, over: Record<string, unknown> = {}) {
  const n = ++orderSeq;
  return prismaSystem.order.create({
    data: {
      storeId, productName: "Cuff", quantity: 1, amountInCents: 3232,
      buyerEmail: `buyer-${stamp}-${n}@example.test`, paymentProvider: "STRIPE",
      externalOrderId: `cs_ct_${stamp}_${n}`, status: "paid",
      ...over,
    },
  });
}

const ctx = (storeId: string) => ({ storeId, userId: "u", actorType: "USER" as const, executionId: "e" });

async function run(o: { storeId: string; orderId: string; trackingNumber: string; carrier?: string }) {
  return correctTrackingExecutable
    .run({ orderId: o.orderId, trackingNumber: o.trackingNumber, carrier: o.carrier }, ctx(o.storeId))
    .then((r) => ({ ok: true as const, r }))
    .catch((e: Error) => ({ ok: false as const, error: e.message }));
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a typo can be fixed while nobody has been told ---\n");
  {
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp, {
      trackingNumber: TYPO, carrier: "USPS", fulfillmentStatus: "fulfilled", fulfilledAt: new Date(),
    });

    const result = await run({ storeId: store.id, orderId: o.id, trackingNumber: GOOD });
    assert("the correction is allowed", result.ok, result.ok ? "" : result.error);

    const after = await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } });
    eq("the number is the corrected one", after.trackingNumber, GOOD);
    assert("the old number is gone", after.trackingNumber !== TYPO);
    assert("the tracking link follows it", (after.trackingUrl ?? "").includes(GOOD), String(after.trackingUrl));

    // ============ A CORRECTION IS NOT AN UN-SHIPPING ============
    eq("fulfilment is untouched", after.fulfillmentStatus, "fulfilled");
    assert("and so is when it was fulfilled", after.fulfilledAt !== null);

    if (result.ok) {
      eq("the previous number is recorded for the log", result.r.metadata?.previousTrackingNumber, TYPO);
      assert("and the message says the customer needs nothing",
        /not been told/i.test(result.r.message), result.r.message);
      const verified = await correctTrackingExecutable.verify!(
        { orderId: o.id, trackingNumber: GOOD }, ctx(store.id), result.r.metadata!,
      );
      eq("the read-back verifies", verified.state, "verified");
    }
  }

  console.log("\n--- REFUSED: the customer is already following the old number ---\n");
  {
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp, {
      trackingNumber: TYPO, carrier: "USPS", shipmentNotifiedAt: new Date(),
    });

    const result = await run({ storeId: store.id, orderId: o.id, trackingNumber: GOOD });
    assert("it is refused", !result.ok);
    assert("and says the customer already has the number",
      !result.ok && /already been sent/i.test(result.error), result.ok ? "" : result.error);
    eq("nothing changed",
      (await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } })).trackingNumber, TYPO);
  }

  console.log("\n--- REFUSED: the carrier issued the number, not the merchant ---\n");
  {
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp, {
      trackingNumber: TYPO, carrier: "USPS", labelUrl: "https://labels.test/a.pdf",
    });

    const result = await run({ storeId: store.id, orderId: o.id, trackingNumber: GOOD });
    assert("it is refused", !result.ok);
    assert("and says a label was bought",
      !result.ok && /label was bought/i.test(result.error), result.ok ? "" : result.error);
    eq("nothing changed",
      (await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } })).trackingNumber, TYPO);
  }

  console.log("\n--- REFUSED: there is nothing to correct ---\n");
  {
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp);
    const result = await run({ storeId: store.id, orderId: o.id, trackingNumber: GOOD });
    assert("it is refused", !result.ok);
    assert("and points at adding one instead",
      !result.ok && /add one rather than correcting/i.test(result.error), result.ok ? "" : result.error);
    eq("and no number was created by the attempt",
      (await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } })).trackingNumber, null);
  }

  console.log("\n--- REFUSED: nonsense, and no-ops ---\n");
  {
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp, { trackingNumber: TYPO, carrier: "USPS" });

    const short = await run({ storeId: store.id, orderId: o.id, trackingNumber: "12" });
    assert("an implausible number is refused", !short.ok);
    const same = await run({ storeId: store.id, orderId: o.id, trackingNumber: TYPO, carrier: "USPS" });
    assert("correcting it to what it already is is refused", !same.ok);
    eq("and it is still the original",
      (await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } })).trackingNumber, TYPO);
  }

  console.log("\n--- one business cannot correct another's order ---\n");
  {
    const mine = await makeStore(stamp);
    const theirs = await makeStore(stamp);
    const o = await order(theirs.id, stamp, { trackingNumber: TYPO, carrier: "USPS" });

    const result = await run({ storeId: mine.id, orderId: o.id, trackingNumber: GOOD });
    assert("it is not found", !result.ok && /not found/i.test(result.error), result.ok ? "" : result.error);
    eq("and their order is untouched",
      (await prismaSystem.order.findUniqueOrThrow({ where: { id: o.id } })).trackingNumber, TYPO);
  }

  console.log("\n--- attaching still refuses to replace, exactly as before ---\n");
  {
    // The original guard must not have been loosened on the way past. Adding is
    // still add-only; replacing has its own verb and its own refusals.
    const store = await makeStore(stamp);
    const o = await order(store.id, stamp, { trackingNumber: TYPO, carrier: "USPS" });
    const attached = await attachTrackingExecutable
      .run({ orderId: o.id, trackingNumber: GOOD, carrier: "USPS" }, ctx(store.id))
      .then(() => ({ ok: true as const }))
      .catch((e: Error) => ({ ok: false as const, error: e.message }));
    assert("attach still refuses an order that already has tracking", !attached.ok);
    assert("with its own reason about the buyer",
      !attached.ok && /already has tracking/i.test(attached.error), attached.ok ? "" : attached.error);
  }

  console.log("\n--- the refusals are re-asserted in the write, not only checked ---\n");
  {
    // Source-asserted, apart from the executed evidence. The read and the write
    // are separated by awaits; a label bought in between must make the write
    // lose rather than overwrite the carrier's own number.
    const src = readFileSync("lib/execution/executables/correctTracking.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("the update is conditional on the old number", /trackingNumber: previousTrackingNumber/.test(src));
    assert("and on no label existing", /labelUrl: null/.test(src));
    assert("and on the customer not having been told", /shipmentNotifiedAt: null/.test(src));
    assert("and it is store-scoped", /storeId: ctx\.storeId/.test(src));
    assert("it never touches fulfilment", !/fulfillmentStatus:/.test(src));
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "ct-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
