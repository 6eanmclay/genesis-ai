import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";

// WHERE A CONVERSATIONAL TURN SPENDS ITS TIME (2026-09-05).
//
// Sean: "Hey J4, can you hear me?" takes far too long, and it feels like J4 is
// doing a large analysis before answering. This measures whether he is.
//
// EVERYTHING EXCEPT THE MODEL. The provider call and TTS need credentials this
// harness does not have, so what is measured here is the part Genesis controls
// and the part that runs BEFORE a single token can be requested: the context
// assembled for every turn, simple or not.
//
// Measured, not asserted into a target. The budget below is a ceiling that
// catches a regression, not a claim about what good looks like - the numbers
// printed are the finding.

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<[T, number]> {
  const started = Date.now();
  const value = await fn();
  const ms = Date.now() - started;
  console.log(`   ${label.padEnd(34)} ${String(ms).padStart(6)} ms`);
  return [value, ms];
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `latency-${Date.now()}@example.test`, name: "Sean McLay" },
  });
  const store = await prisma.store.create({
    data: {
      userId: user.id,
      name: "Cubit & Coil",
      slug: `latency-${Date.now()}`,
      published: true,
      currency: "USD",
    },
  });

  // A store with enough in it to be realistic rather than empty.
  await prisma.product.createMany({
    data: Array.from({ length: 12 }, (_, i) => ({
      storeId: store.id,
      name: `Product ${i + 1}`,
      description: "A real description of a real thing.",
      priceInCents: 2500 + i * 100,
      active: true,
      position: i,
    })),
  });

  console.log("\n=== 1. What every turn assembles before the model is called ===\n");

  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { digestOf, renderDigest } = await import("@/lib/businessModel/digest");
  const { businessContextOf } = await import("@/lib/businessModel/businessContext");
  const { buildTurnContext } = await import("@/lib/dashboard/chatTurnContext");

  // Cold, as a real first turn is.
  const [understanding, understandingMs] = await timed("getBusinessUnderstanding (cold)", () =>
    getBusinessUnderstanding(store.id, { viewerUserId: user.id }),
  );
  const [, digestMs] = await timed("digestOf + renderDigest", async () =>
    renderDigest(digestOf(understanding)),
  );
  const [, contextMs] = await timed("businessContextOf", async () =>
    businessContextOf(understanding, {
      asOf: understanding.asOf,
      throughEventSequence: understanding.throughEventSequence,
    }),
  );
  const [, turnMs] = await timed("buildTurnContext (the whole thing)", () =>
    buildTurnContext({
      storeId: store.id,
      userId: user.id,
      userMessage: "Hey J4, can you hear me?",
      activeProductNames: "Product 1, Product 2",
      workspacePath: "/dashboard",
      pendingSummary: null,
    }),
  );

  console.log("");
  console.log(`   a simple hello therefore costs ${turnMs} ms of assembly`);
  console.log(`   of which getBusinessUnderstanding is ${Math.round((understandingMs / Math.max(turnMs, 1)) * 100)}%`);

  // A CEILING, NOT A TARGET. Slow enough that a healthy machine passes; fast
  // enough that the shape of today's problem would have failed it.
  record(
    "assembling a turn stays under 2.5s even cold",
    turnMs < 2500,
    `${turnMs} ms`,
  );
  // WHAT THIS USED TO ASSERT, AND WHY IT WAS WRONG.
  //
  // It claimed the understanding is the dominant cost of a turn, comparing
  // understandingMs to turnMs. Those two are not comparable: the first is
  // measured COLD and the second runs afterwards, warm, so the whole of
  // buildTurnContext regularly comes in under the cold understanding alone
  // (106 ms of 54 ms, in the run that failed the regression). The numbers
  // were right and the comparison was meaningless.
  //
  // It was also never an invariant - it was my expectation about where the
  // time goes, written as an assertion. The breakdown is printed above; that
  // is the finding. What is worth failing on is a REGRESSION in the parts
  // that must stay cheap, which the remaining ceilings cover.
  console.log(
    `   cold understanding ${understandingMs} ms is not comparable to the warm`
    + ` ${turnMs} ms whole-context figure - both are printed, neither is asserted`,
  );
  record("the digest itself is cheap", digestMs < 200, `${digestMs} ms`);
  record("business context assembly is cheap", contextMs < 200, `${contextMs} ms`);

  await prisma.product.deleteMany({ where: { storeId: store.id } });
  await prisma.store.deleteMany({ where: { id: store.id } });
  await prisma.user.deleteMany({ where: { id: user.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
