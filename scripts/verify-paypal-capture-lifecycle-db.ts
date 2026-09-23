import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { getStaleExecutions } from "@/lib/dashboard/needsAttention";
import { EXECUTION_ACTIONS } from "@/lib/execution/actions";
import { readFileSync } from "node:fs";

// A CAPTURE THAT WORKED MUST NOT LOOK LIKE ONE THAT STALLED:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-db-suites.ts paypal-capture-lifecycle" \
//     -OutFile "C:/Users/hyper/AppData/Local/Temp/genesis-ppl.txt"
//
// ISOLATED DATABASE ONLY. No PayPal call, no payment, no credential.
//
// ============ THE DEFECT THIS EXISTS FOR (2026-09-23) =================
//
// app/api/checkout/paypal/return writes a PENDING ExecutionLog row the moment
// PayPal reports a capture, BEFORE creating the order — deliberately, so real
// money can never move without a trace. On failure it supersedes that row with
// FAILED. On SUCCESS it superseded nothing at all.
//
// So every PayPal sale that worked left a PENDING marker behind for ever, and
// the Office read it back as unfinished work. Production showed two of them:
// both orders created within 200ms of their marker, both still reported as
// "finishing order creation — still pending" days later. Nothing was wrong
// with either order. The only defect was that nothing ever said so.
//
// THE MECHANISM IS THE ONE THAT ALREADY EXISTED. getStaleExecutions surfaces a
// PENDING row only while it is the LATEST row for its executionId. Writing
// SUCCESS under the same executionId closes it — no schema change, no second
// lifecycle, the same way FAILED already worked.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

const ROUTE = "app/api/checkout/paypal/return/route.ts";
const HOUR = 60 * 60 * 1000;

async function main() {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `ppl-${stamp}@example.test`, name: "O" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "PPL", slug: `ppl-${stamp}`, tagline: "t", description: "d" },
  });

  /**
   * The marker the route writes the instant PayPal reports a capture.
   *
   * Aged two hours: getStaleExecutions only looks at rows older than one hour
   * and younger than seven days, so a row written "now" is invisible to it for
   * reasons that have nothing to do with this defect.
   */
  let seq = 0;
  async function pendingMarker(token: string): Promise<string> {
    seq++;
    const executionId = `exec_${stamp}_${seq}`;
    await prismaSystem.executionLog.create({
      data: {
        executionId,
        action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE,
        status: "PENDING",
        verified: false,
        message: `PayPal capture succeeded for order ${token}, finishing order creation`,
        retryable: false,
        actorType: "USER",
        storeId: store.id,
        metadata: { token },
        createdAt: new Date(Date.now() - 2 * HOUR),
      },
    });
    return executionId;
  }

  /** Whatever the route writes afterwards, under the SAME executionId. */
  async function close(executionId: string, status: "SUCCESS" | "FAILED", message: string) {
    await prismaSystem.executionLog.create({
      data: {
        executionId,
        action: EXECUTION_ACTIONS.CHECKOUT_PAYPAL_CAPTURE,
        status,
        verified: status === "SUCCESS",
        message,
        retryable: status === "FAILED",
        actorType: "USER",
        storeId: store.id,
        metadata: { token: "t" },
        // Later than the marker, earlier than the one-hour cutoff, so the
        // supersede is what decides the outcome rather than the clock.
        createdAt: new Date(Date.now() - 90 * 60 * 1000),
      },
    });
  }

  const stale = async () => (await getStaleExecutions(store.id)).map((i) => i.message);

  console.log("\n=== 1. CONTROL: an unclosed marker IS surfaced ===\n");
  {
    const token = `TOKEN_A_${stamp}`;
    await pendingMarker(token);
    const rows = await stale();
    assert("a capture marker with nothing after it reaches the owner",
      rows.some((m) => m.includes(token)), JSON.stringify(rows).slice(0, 160));
    assert("  and it is the sentence the owner actually saw",
      rows.some((m) => m.includes("finishing order creation") && m.includes("still pending since")),
      JSON.stringify(rows).slice(0, 200));
  }

  console.log("\n=== 2. THE FIX: order created -> marker closed ===\n");
  {
    const token = `TOKEN_B_${stamp}`;
    const id = await pendingMarker(token);
    assert("CONTROL: before the success row it is surfaced",
      (await stale()).some((m) => m.includes(token)));

    await close(id, "SUCCESS", `PayPal capture ${token} became order ord_${stamp}`);
    const after = await stale();
    assert("a successful capture followed by a created order is NOT surfaced",
      !after.some((m) => m.includes(token)), JSON.stringify(after).slice(0, 200));
    assert("  and the PENDING row is still THERE, not deleted",
      (await prismaSystem.executionLog.count({
        where: { executionId: id, status: "PENDING" },
      })) === 1,
      "the marker is superseded, never erased — it is the record that money moved");
  }

  console.log("\n=== 3. A FAILURE still closes it, as it always did ===\n");
  {
    const token = `TOKEN_C_${stamp}`;
    const id = await pendingMarker(token);
    await close(id, "FAILED", "Order creation failed after capture");
    assert("a failed order creation is not reported as still pending",
      !(await stale()).some((m) => m.includes(token)));
  }

  console.log("\n=== 4. Closing one capture does not silence another ===\n");
  {
    const open = `TOKEN_D_${stamp}`;
    const closed = `TOKEN_E_${stamp}`;
    await pendingMarker(open);
    const closedId = await pendingMarker(closed);
    await close(closedId, "SUCCESS", `PayPal capture ${closed} became an order`);
    const rows = await stale();
    assert("the genuinely stalled one is still surfaced",
      rows.some((m) => m.includes(open)), JSON.stringify(rows).slice(0, 200));
    assert("  while the completed one is not",
      !rows.some((m) => m.includes(closed)), JSON.stringify(rows).slice(0, 200));
  }

  console.log("\n=== 5. SABOTAGE: remove the success row and it returns ===\n");
  {
    const token = `TOKEN_F_${stamp}`;
    const id = await pendingMarker(token);
    await close(id, "SUCCESS", `PayPal capture ${token} became an order`);
    assert("SABOTAGE CONTROL: closed, so absent",
      !(await stale()).some((m) => m.includes(token)));

    await prismaSystem.executionLog.deleteMany({ where: { executionId: id, status: "SUCCESS" } });
    assert("SABOTAGE CAUGHT: without the success row the false alarm comes back",
      (await stale()).some((m) => m.includes(token)),
      "which is exactly the state production was in");
  }

  console.log("\n=== 6. STRUCTURAL: the route closes its own marker ===\n");
  {
    // NOT BEHAVIOURAL, and labelled so. The route cannot be driven without a
    // real PayPal capture, so this asserts the shape that connects the
    // behaviour above to the code that must produce it: three writes, one
    // executionId, one of them SUCCESS on the path that created an order.
    const src = readFileSync(ROUTE, "utf8").replace(/\r\n?/g, "\n");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    for (const status of ["PENDING", "SUCCESS", "FAILED"]) {
      assert(`the capture flow writes a ${status} row`, new RegExp(`status: "${status}"`).test(code));
    }
    // THE ID IS THE WHOLE MECHANISM. One `const executionId`, and the three
    // lifecycle writes all pass that same variable — which is what lets SUCCESS
    // and FAILED supersede PENDING. A fourth write exists (recordCaptureProblem)
    // and deliberately mints its OWN id: it reports a capture that never got a
    // marker, so it has nothing to supersede.
    eq("the marker's id is minted exactly once",
      (code.match(/const executionId = randomUUID\(\)/g) ?? []).length, 1);
    eq("and three lifecycle writes reuse it",
      (code.match(/^\s+executionId,$/gm) ?? []).length, 3);
    assert("  while the standalone capture-problem record mints its own",
      /executionId: randomUUID\(\)/.test(code),
      "it reports a capture with no marker, so there is nothing to supersede");
    assert("the success row is written where the order exists",
      /status: "SUCCESS"[\s\S]{0,400}orderId: order\.id/.test(code));
    // THE SUCCESS WRITE SITS INSIDE THE try THAT REPORTS FAILURE. Unguarded, a
    // thrown bookkeeping write would record a completed sale as FAILED and
    // send the buyer to the payment-pending page. The guard makes the worst
    // case an open marker — the old false alarm — instead of a false failure.
    assert("and it is guarded, so it cannot downgrade a completed sale",
      /try \{\s*await recordExecution\(\{\s*executionId,\s*action: EXECUTION_ACTIONS\.CHECKOUT_PAYPAL_CAPTURE,\s*status: "SUCCESS"/.test(code),
      "a failure closing the marker must not reach the catch that writes FAILED");
    assert("CONTROL: the stripper still sees real code", code.includes("recordExecution"));
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
