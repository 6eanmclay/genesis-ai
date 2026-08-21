import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// WHICH BUSINESS DID THAT WRITE GO TO? — BUSINESS_CONTEXT.md Phase C:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-execute-binding-live.ts" -OutFile out.txt
//
// THE DEFECT THIS COVERS. Eleven server actions resolved the business from the
// slug in the URL — and then called execute() without passing it, so execute()
// re-resolved the account's ACTIVE business on its own. Permission was checked
// against the business named in the URL while the executable ran against a
// different one.
//
// That is the one direction BUSINESS_CONTEXT.md's "refused, never substituted"
// rule does not catch, because BOTH businesses are reachable: nothing is denied,
// the write simply lands somewhere else. Seven of the eleven write payment or
// carrier credentials.
//
// WHAT IS ASSERTED HERE is the engine contract those call sites depend on, at
// the layer where it is decidable: given an explicit storeId, execute() runs
// against that business and no other, whatever the account's active business
// happens to be. The call sites are bound by construction — a bound slug is
// visible in the diff — but the contract they rely on was never proved.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { execute } = await import("@/lib/execution/engine");
  const { setActiveBusiness } = await import("@/lib/businessContext");
  const { prismaSystem: prisma } = await import("@/lib/prisma");
  const { PERMISSIONS } = await import("@/lib/permissions");

  async function reset() {
    const tables = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables
      WHERE schemaname = 'public'
        AND tablename <> '_prisma_migrations'
        AND tablename <> '_genesis_test_database'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE TABLE ${tables.map((t) => `"${t.tablename}"`).join(", ")} RESTART IDENTITY CASCADE`
    );
  }

  await reset();
  const owner = await prisma.user.create({ data: { email: "binding-owner@example.test" } });
  const active = await prisma.store.create({
    data: { userId: owner.id, name: "Active Business", slug: "active-business", tagline: "t", description: "d", currency: "USD" },
  });
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "The Other One", slug: "other-one", tagline: "t", description: "d", currency: "USD" },
  });
  // The active business is deliberately NOT the one the executable is told to
  // act on — that difference is the entire test.
  await setActiveBusiness(owner.id, active.id);

  // A minimal real executable. It writes something observable and reports the
  // storeId the engine handed it, which is the fact under test.
  const recordingExecutable = {
    action: "test.binding" as never,
    requiredPermission: null,
    async run(input: { name: string }, ctx: { storeId: string }) {
      await prisma.product.create({
        data: { storeId: ctx.storeId, name: input.name, description: "d", priceInCents: 100, active: true },
      });
      return { message: `wrote to ${ctx.storeId}`, metadata: { storeId: ctx.storeId } };
    },
  };

  // ==========================================================================
  console.log("\n=== 1. An explicit storeId decides where the write lands ===\n");
  // ==========================================================================
  const bound = await execute(recordingExecutable as never, { name: "Bound product" }, {
    storeId: other.id,
  });
  check("the execution succeeded", bound.status, "SUCCESS");
  check("the engine ran it against the business it was given", (bound.metadata as { storeId?: string } | undefined)?.storeId, other.id);
  assert("which is NOT the active business", other.id !== active.id);

  const inOther = await prisma.product.findMany({ where: { storeId: other.id } });
  const inActive = await prisma.product.findMany({ where: { storeId: active.id } });
  check("the product exists in the named business", inOther.map((p) => p.name), ["Bound product"]);
  // THE ASSERTION THE ELEVEN CALL SITES EXIST FOR: nothing reached the business
  // that merely happened to be active.
  check("and nothing at all reached the active one", inActive.length, 0);

  // ==========================================================================
  console.log("\n=== 2. The execution record says which business too ===\n");
  // ==========================================================================
  const records = await prisma.executionLog.findMany({ where: { storeId: other.id } });
  assert("the execution is recorded against the named business", records.length === 1);
  check("and none against the active one",
    await prisma.executionLog.count({ where: { storeId: active.id } }), 0);

  // ==========================================================================
  console.log("\n=== 3. Switching the active business changes nothing ===\n");
  // ==========================================================================
  // If the engine were reading ambient state, moving the pointer between two
  // identical calls would move where the second one landed.
  await setActiveBusiness(owner.id, other.id);
  const second = await execute(recordingExecutable as never, { name: "Second product" }, {
    storeId: active.id,
  });
  check("still runs against the business it was given", (second.metadata as { storeId?: string } | undefined)?.storeId, active.id);
  check("even though that is now the INACTIVE one",
    (await prisma.product.findMany({ where: { storeId: active.id } })).map((p) => p.name),
    ["Second product"]);
  check("and the newly-active business gained nothing",
    (await prisma.product.count({ where: { storeId: other.id } })), 1);

  // ==========================================================================
  console.log("\n=== 4. Two concurrent executions naming different businesses ===\n");
  // ==========================================================================
  // The two-tab case at the write layer. Fails against any implementation that
  // resolves from shared state rather than from the call.
  await reset();
  const owner2 = await prisma.user.create({ data: { email: "binding-owner-2@example.test" } });
  const a = await prisma.store.create({
    data: { userId: owner2.id, name: "A", slug: "a-biz", tagline: "t", description: "d", currency: "USD" },
  });
  const b = await prisma.store.create({
    data: { userId: owner2.id, name: "B", slug: "b-biz", tagline: "t", description: "d", currency: "USD" },
  });
  await setActiveBusiness(owner2.id, a.id);

  const [ra, rb] = await Promise.all([
    execute(recordingExecutable as never, { name: "For A" }, { storeId: a.id }),
    execute(recordingExecutable as never, { name: "For B" }, { storeId: b.id }),
  ]);
  check("the call naming A wrote to A", (ra.metadata as { storeId?: string } | undefined)?.storeId, a.id);
  check("the call naming B wrote to B", (rb.metadata as { storeId?: string } | undefined)?.storeId, b.id);
  check("A holds only its own product",
    (await prisma.product.findMany({ where: { storeId: a.id } })).map((p) => p.name), ["For A"]);
  check("B holds only its own product",
    (await prisma.product.findMany({ where: { storeId: b.id } })).map((p) => p.name), ["For B"]);

  // ==========================================================================
  console.log("\n=== 5. A permissioned execute still needs a session ===\n");
  // ==========================================================================
  // The explicit-storeId path must not become a way around authorization. With a
  // requiredPermission set and no human session, this has to fail rather than
  // trust the storeId it was handed.
  const guarded = {
    ...recordingExecutable,
    requiredPermission: PERMISSIONS.PRODUCTS_MANAGE,
  };
  let refused = false;
  try {
    const r = await execute(guarded as never, { name: "Should not exist" }, { storeId: b.id });
    refused = r.status === "FAILED";
  } catch {
    refused = true;
  }
  assert("a permissioned action with no session does not run", refused, "storeId is not a capability");
  check("and wrote nothing",
    (await prisma.product.findMany({ where: { storeId: b.id } })).map((p) => p.name), ["For B"]);

  await reset();
  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All execute-binding assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
