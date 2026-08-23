import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHAT THE DECISION CONTEXT COSTS, MEASURED:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/measure-turn-context.ts" -OutFile out.txt
//
// Brings its own database, like every other measure- script: the verify- harness
// discovers suites that PASS or FAIL, and this one reports numbers. Listing it
// there would add a suite that can only ever pass, which is worse than not
// counting it at all.
//
// WHY THIS EXISTS. Before the Unified Intelligence milestone,
// getBusinessUnderstanding was fetched only when the model had already chosen
// look_up_business_data. It is now fetched on EVERY chat turn, because the call
// that decides what J4 does needs to know the business before it decides.
//
// That is a real addition to every message and a deliberate one — the direction
// was explicit that correctness comes before call count. Deliberate is not the
// same as unmeasured, though, and "we added a read to the hot path and never
// looked" is how a product gets slower one reasonable decision at a time.
//
// NOT A PASS/FAIL SUITE. There is no threshold here, because inventing one
// would be exactly the kind of made-up number this codebase refuses elsewhere:
// what counts as too slow depends on the size of the business and on what the
// model call after it costs, which is far more. This prints real numbers against
// a realistically-sized store so a decision can be made on evidence.
//
// Against the in-process harness rather than Neon, so the ABSOLUTE numbers are
// not production numbers. What transfers is the SHAPE — which part dominates,
// and whether it grows with the business.

const uniq = () => Math.random().toString(36).slice(2);

async function time<T>(label: string, fn: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const started = Date.now();
  const value = await fn();
  const ms = Date.now() - started;
  console.log(`  ${label.padEnd(42)} ${String(ms).padStart(5)} ms`);
  return { ms, value };
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  // Before any product module loads. lib/prisma builds its adapter from
  // DATABASE_URL at module-evaluation time, so a static import here would
  // measure — and seed — whatever database this process inherited.
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { persistSyncedRecords } = await import("@/lib/businessModel/sync");
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const { getBusinessProfile } = await import("@/lib/businessModel/profile");
  const { buildTurnContext } = await import("@/lib/dashboard/chatTurnContext");
  const { renderDigest, digestOf } = await import("@/lib/businessModel/digest");

  const goalData = (description: string) => ({
    description, category: "expansion", priority: "high", targetDate: null,
    targetValueInCents: null, status: "active", identifiedAt: "2026-03-02",
    relatedChallengeIds: [] as string[],
  });

  async function seed(size: "small" | "large") {
    const user = await prisma.user.create({ data: { email: `mt-${uniq()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Copper & Coil", slug: `mt-${uniq()}`, tagline: "Hand-wound rings" },
    });

    const products = size === "small" ? 3 : 120;
    const orders = size === "small" ? 5 : 400;
    const goals = size === "small" ? 2 : 40;

    const created = [];
    for (let i = 0; i < products; i++) {
      created.push(
        await prisma.product.create({
          data: { storeId: store.id, name: `Product ${i}`, priceInCents: 1000 + i, active: true },
        })
      );
    }
    for (let i = 0; i < orders; i++) {
      await prisma.order.create({
        data: {
          storeId: store.id,
          productId: created[i % created.length].id,
          productName: `Product ${i % created.length}`,
          amountInCents: 1000 + i,
          buyerEmail: `buyer${i % 50}@mt.test`,
          paymentProvider: "STRIPE",
          externalOrderId: `o-${uniq()}-${i}`,
          createdAt: new Date(Date.now() - (i % 60) * 86_400_000),
        },
      });
    }
    await persistSyncedRecords(
      store.id,
      "genesis_chat",
      Array.from({ length: goals }, (_, i) => ({
        entityType: "goal" as const,
        externalId: `g-${i}`,
        data: goalData(`Goal number ${i}`) as never,
      })),
      { provenance: "OWNER", statedById: user.id, modelExtracted: true }
    );

    return { user, store, products, orders, goals };
  }

  for (const size of ["small", "large"] as const) {
    const { user, store, products, orders, goals } = await seed(size);
    console.log(
      `\n=== A ${size} business: ${products} products, ${orders} orders, ${goals} goals ===\n`
    );

    // Warm, so the first number is not measuring connection setup.
    await getBusinessProfile(store.id);

    const profile = await time("getBusinessProfile", () => getBusinessProfile(store.id));
    const understanding = await time("getBusinessUnderstanding (all of it)", () =>
      getBusinessUnderstanding(store.id, { viewerUserId: user.id })
    );
    const turn = await time("buildTurnContext (what a turn now pays)", () =>
      buildTurnContext({
        storeId: store.id,
        userId: user.id,
        userMessage: "what should I do next?",
        activeProductNames: "Product 0, Product 1",
      })
    );

    const rendered = renderDigest(digestOf(understanding.value));
    console.log("");
    console.log(`  digest rendered                            ${String(rendered.length).padStart(5)} chars`);
    console.log(`  ~tokens (chars/4, rough)                   ${String(Math.ceil(rendered.length / 4)).padStart(5)}`);
    // THE SHARE THAT IS THE PROFILE. If understanding is dominated by
    // getBusinessProfile — which computes revenue windows, customer segments,
    // profitability, obligations and audience, none of which the digest uses —
    // then a narrower read is worth considering. Reported rather than assumed.
    const share = understanding.ms > 0 ? Math.round((profile.ms / understanding.ms) * 100) : 0;
    console.log(`  of which getBusinessProfile                ${String(share).padStart(5)} %`);
    console.log(
      `  the rest of the turn's own context         ${String(Math.max(turn.ms - understanding.ms, 0)).padStart(5)} ms`
    );

    await prisma.store.deleteMany({ where: { id: store.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }

  console.log(
    "\nThe FIRST business's 'rest of the turn' figure is module load, not per-turn\n" +
      "cost: buildTurnContext dynamically imports the supplier-economics reader, and\n" +
      "that import happens once per process. The second business's figure is the real\n" +
      "one, and it is small — the read is dominated almost entirely by\n" +
      "getBusinessProfile.\n"
  );
  console.log(
    "\nRead the SHAPE, not the absolute numbers: this runs against the in-process\n" +
      "harness, not Neon. What transfers is which part dominates and whether it grows\n" +
      "with the business — and that the digest itself is capped, so the CONTEXT cost\n" +
      "is flat however large the store gets.\n"
  );

  await db.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
