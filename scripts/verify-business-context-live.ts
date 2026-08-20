import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// Business context, against a real database:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-business-context-live.ts" -OutFile out.txt
//
// One Genesis account holds several businesses. Each keeps its own identity,
// catalogue, orders, connections, Growth Points, plan and J4 understanding — the
// domain was already keyed that way. What did not exist was any notion of WHICH
// business a person is working in: the app picked the most recently UPDATED
// store, and 47 call sites relied on it.
//
// THE ONE PROPERTY EVERYTHING HERE EXISTS TO DEFEND:
//
//   A business never becomes the active one by being touched. Only by being
//   chosen, or by being the only one there is.
//
// Section 2 is that property stated as an attack, and it is the reason this file
// exists rather than a unit test of the resolver.

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

  const { resolveBusiness, setActiveBusiness, accessibleBusinesses, accessTo, adoptNewBusiness } =
    await import("@/lib/businessContext");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

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

  const makeUser = (email: string) => prisma.user.create({ data: { email } });
  const makeBusiness = (userId: string, slug: string) =>
    prisma.store.create({
      data: { userId, name: `${slug} co`, slug, tagline: "t", description: `${slug} description` },
    });

  const activeOf = async (userId: string) =>
    (await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { activeStoreId: true } }))
      .activeStoreId;

  try {
    // -----------------------------------------------------------------------
    console.log("\n1. One business is not a guess, it is the only answer");
    {
      await reset();
      const user = await makeUser("solo@example.test");
      check("no business yet is an ordinary state", (await resolveBusiness(user.id)).kind, "none");

      const only = await makeBusiness(user.id, "solo");
      const resolved = await resolveBusiness(user.id);
      check("one business resolves", resolved.kind, "resolved");
      check("to itself", resolved.kind === "resolved" ? resolved.storeId : null, only.id);
      check("as its owner", resolved.kind === "resolved" ? resolved.role : null, "OWNER");
      // No pointer was needed and none was invented.
      check("without anything being stored", await activeOf(user.id), null);
    }

    // -----------------------------------------------------------------------
    console.log("\n2. A business never becomes active by being touched");
    {
      await reset();
      const user = await makeUser("two@example.test");
      const first = await makeBusiness(user.id, "first");
      await setActiveBusiness(user.id, first.id);
      const second = await makeBusiness(user.id, "second");
      await setActiveBusiness(user.id, first.id);

      // THE OLD BEHAVIOUR, EXACTLY. resolveUserStore ordered by updatedAt desc,
      // so every one of these would have silently moved the person into the
      // second business. Editing a product. Buying a label. A background sync.
      await prisma.store.update({ where: { id: second.id }, data: { tagline: "edited" } });
      await prisma.product.create({
        data: { storeId: second.id, name: "A product", description: "d", priceInCents: 1000 },
      });
      await prisma.store.update({ where: { id: second.id }, data: { published: true } });

      const after = await resolveBusiness(user.id);
      assert("the second business is genuinely the most recently updated",
        (await prisma.store.findFirstOrThrow({ where: { userId: user.id }, orderBy: { updatedAt: "desc" } })).id ===
          second.id);
      check("and the person is still in the first one", after.kind === "resolved" ? after.storeId : null, first.id);
      check("the stored pointer is untouched", await activeOf(user.id), first.id);
    }

    // -----------------------------------------------------------------------
    console.log("\n3. More than one, and nothing says which, is a question");
    {
      await reset();
      const user = await makeUser("ambiguous@example.test");
      const a = await makeBusiness(user.id, "alpha");
      const b = await makeBusiness(user.id, "bravo");

      const resolution = await resolveBusiness(user.id);
      // It used to pick. Now it asks.
      check("it is ambiguous", resolution.kind, "ambiguous");
      check("and offers both", resolution.kind === "ambiguous" ? resolution.choices.length : 0, 2);
      assert("by name, not by recency",
        resolution.kind === "ambiguous" &&
          resolution.choices.map((c) => c.slug).join(",") === "alpha,bravo",
        JSON.stringify(resolution.kind === "ambiguous" ? resolution.choices.map((c) => c.slug) : []));

      // Choosing resolves it, durably.
      const chosen = await setActiveBusiness(user.id, b.id);
      check("switching works", chosen.ok, true);
      const now = await resolveBusiness(user.id);
      check("and it stays chosen", now.kind === "resolved" ? now.storeId : null, b.id);
      check("stored, not inferred", await activeOf(user.id), b.id);

      // Switching back is symmetrical.
      await setActiveBusiness(user.id, a.id);
      const back = await resolveBusiness(user.id);
      check("switching back works", back.kind === "resolved" ? back.storeId : null, a.id);
    }

    // -----------------------------------------------------------------------
    console.log("\n4. Creating a business is choosing it");
    {
      await reset();
      const user = await makeUser("creator@example.test");
      const first = await makeBusiness(user.id, "one");
      await adoptNewBusiness(user.id, first.id);
      const second = await makeBusiness(user.id, "two");
      await adoptNewBusiness(user.id, second.id);

      // This is what keeps the ambiguous branch unreachable through any normal
      // path, rather than merely handled when it happens.
      const resolved = await resolveBusiness(user.id);
      check("the new business is the active one", resolved.kind === "resolved" ? resolved.storeId : null, second.id);
      check("not a question", resolved.kind, "resolved");
    }

    // -----------------------------------------------------------------------
    console.log("\n5. A named business wins, and a business you cannot reach is refused");
    {
      await reset();
      const owner = await makeUser("owner@example.test");
      const stranger = await makeUser("stranger@example.test");
      const mine = await makeBusiness(owner.id, "mine");
      const theirs = await makeBusiness(stranger.id, "theirs");
      const other = await makeBusiness(owner.id, "other");
      await setActiveBusiness(owner.id, mine.id);

      // An explicit id beats the active one. A product page that resolved the
      // business from the product must act on THAT business.
      const named = await resolveBusiness(owner.id, other.id);
      check("the named business is used", named.kind === "resolved" ? named.storeId : null, other.id);
      check("and the active one is not silently substituted", await activeOf(owner.id), mine.id);

      // Naming a business you cannot reach is refused, never quietly swapped for
      // one you can. Succeeding with a different business is worse than failing.
      const forbidden = await resolveBusiness(owner.id, theirs.id);
      check("another account's business is refused", forbidden.kind, "none");
      assert("and is not replaced with your own", forbidden.kind !== "resolved");

      // Switching to it is refused too, and changes nothing.
      const stolen = await setActiveBusiness(owner.id, theirs.id);
      check("switching to it fails", stolen.ok, false);
      assert("as no access", !stolen.ok && stolen.reason === "no_access");
      check("and the pointer is untouched", await activeOf(owner.id), mine.id);
    }

    // -----------------------------------------------------------------------
    console.log("\n6. Employees reach the businesses they belong to, and no others");
    {
      await reset();
      const owner = await makeUser("boss@example.test");
      const staff = await makeUser("staff@example.test");
      const shop = await makeBusiness(owner.id, "shop");
      const otherShop = await makeBusiness(owner.id, "other-shop");
      await prisma.storeMember.create({
        data: { storeId: shop.id, userId: staff.id, role: "EMPLOYEE" },
      });

      const access = await accessibleBusinesses(staff.id);
      check("one business reachable", access.length, 1);
      check("the one they belong to", access[0].store.id, shop.id);
      check("with their real role", access[0].role, "EMPLOYEE");

      const resolved = await resolveBusiness(staff.id);
      check("and it resolves without a choice", resolved.kind, "resolved");
      check("as an employee, not the owner", resolved.kind === "resolved" ? resolved.role : null, "EMPLOYEE");

      // The owner's OTHER business is invisible to them.
      check("the other business is unreachable", await accessTo(staff.id, otherShop.id), null);
      check("naming it resolves to nothing", (await resolveBusiness(staff.id, otherShop.id)).kind, "none");
      check("switching to it fails", (await setActiveBusiness(staff.id, otherShop.id)).ok, false);

      // An owner who is also a member of their own business is still an owner.
      await prisma.storeMember.create({ data: { storeId: shop.id, userId: owner.id, role: "EMPLOYEE" } });
      const ownerAccess = await accessibleBusinesses(owner.id);
      check("no duplicate entry", ownerAccess.filter((a) => a.store.id === shop.id).length, 1);
      check("and not demoted", ownerAccess.find((a) => a.store.id === shop.id)?.role, "OWNER");
    }

    // -----------------------------------------------------------------------
    console.log("\n7. Losing the active business does not strand the account");
    {
      await reset();
      const user = await makeUser("deleter@example.test");
      const keep = await makeBusiness(user.id, "keep");
      const going = await makeBusiness(user.id, "going");
      await setActiveBusiness(user.id, going.id);

      await prisma.store.delete({ where: { id: going.id } });
      // SetNull, so the pointer clears rather than dangling.
      check("the pointer is cleared", await activeOf(user.id), null);
      const resolved = await resolveBusiness(user.id);
      check("and the remaining business resolves", resolved.kind, "resolved");
      check("as the only one left", resolved.kind === "resolved" ? resolved.storeId : null, keep.id);

      // A revoked membership is the other way a pointer goes stale, and it must
      // not error — it falls through rather than dangling.
      await reset();
      const boss = await makeUser("boss2@example.test");
      const temp = await makeUser("temp@example.test");
      const one = await makeBusiness(boss.id, "one");
      const member = await prisma.storeMember.create({
        data: { storeId: one.id, userId: temp.id, role: "EMPLOYEE" },
      });
      await setActiveBusiness(temp.id, one.id);
      await prisma.storeMember.delete({ where: { id: member.id } });
      const gone = await resolveBusiness(temp.id);
      check("a revoked membership leaves nothing reachable", gone.kind, "none");
      assert("rather than resolving to a business they cannot reach", gone.kind !== "resolved");
    }

    // -----------------------------------------------------------------------
    console.log("\n8. Every business-specific thing follows the active business");
    {
      await reset();
      const user = await makeUser("multi@example.test");
      const fitness = await makeBusiness(user.id, "fitness");
      const candles = await makeBusiness(user.id, "candles");

      // One row of each kind Sean named, on each business.
      for (const [store, tag] of [[fitness, "fit"], [candles, "wax"]] as const) {
        await prisma.product.create({
          data: { storeId: store.id, name: `${tag} product`, description: "d", priceInCents: 1000 },
        });
        await prisma.order.create({
          data: {
            storeId: store.id,
            productName: `${tag} product`,
            amountInCents: 1000,
            buyerEmail: `${tag}@example.test`,
            status: "paid",
            paymentProvider: "STRIPE",
            externalOrderId: `cs_${tag}`,
          },
        });
        await prisma.storeIntegration.create({
          data: { storeId: store.id, provider: tag === "fit" ? "PRINTFUL" : "STRIPE", status: "CONNECTED" },
        });
        await prisma.growthPointTransaction.create({
          data: {
            storeId: store.id,
            type: "GRANT",
            amount: tag === "fit" ? 100 : 250,
            balanceAfter: tag === "fit" ? 100 : 250,
            description: "test grant",
          },
        });
      }

      const surfacesFor = async (storeId: string) => ({
        products: await prisma.product.count({ where: { storeId } }),
        orders: await prisma.order.count({ where: { storeId } }),
        connections: await prisma.storeIntegration.count({ where: { storeId } }),
        points: (await prisma.growthPointTransaction.findFirst({ where: { storeId }, orderBy: { createdAt: "desc" } }))?.balanceAfter ?? 0,
      });

      await setActiveBusiness(user.id, fitness.id);
      const inFitness = await resolveBusiness(user.id);
      const fitnessSurfaces = await surfacesFor(inFitness.kind === "resolved" ? inFitness.storeId : "");
      check("products, orders and connections belong to the active business",
        fitnessSurfaces, { products: 1, orders: 1, connections: 1, points: 100 });

      await setActiveBusiness(user.id, candles.id);
      const inCandles = await resolveBusiness(user.id);
      const candleSurfaces = await surfacesFor(inCandles.kind === "resolved" ? inCandles.storeId : "");
      // The number that would be wrong if points were pooled at the account, and
      // the one where being wrong costs real money.
      check("and switching moves every one of them",
        candleSurfaces, { products: 1, orders: 1, connections: 1, points: 250 });

      // Connecting a supplier to one business does not connect the other.
      const fitnessProviders = (await prisma.storeIntegration.findMany({ where: { storeId: fitness.id } })).map((i) => i.provider);
      const candleProviders = (await prisma.storeIntegration.findMany({ where: { storeId: candles.id } })).map((i) => i.provider);
      check("each business has its own sourcing relationships", fitnessProviders, ["PRINTFUL"]);
      check("kept apart", candleProviders, ["STRIPE"]);
    }

    // -----------------------------------------------------------------------
    console.log("\n9. The permission layer refuses rather than picking");
    {
      await reset();
      const user = await makeUser("perms@example.test");
      await makeBusiness(user.id, "p-one");
      await makeBusiness(user.id, "p-two");

      // requireStorePermission cannot run here (it needs a session), so what is
      // asserted is the resolution it delegates to — the branch that used to
      // silently return a store and now returns a question.
      const resolution = await resolveBusiness(user.id);
      check("ambiguous, not resolved", resolution.kind, "ambiguous");
      assert("so nothing downstream receives a storeId to write against",
        !("storeId" in resolution), JSON.stringify(resolution));

      // And the legacy adapter fails CLOSED rather than picking, which is the
      // property that matters for the 19 call sites still using it.
      const { resolveUserStore } = await import("@/lib/permissions");
      check("the legacy resolver returns nothing", await resolveUserStore(user.id), null);
    }
    // -----------------------------------------------------------------------
    console.log("\n10. The migration's backfill, run against real rows");
    {
      await reset();
      // The three shapes an existing account can be in when the column arrives.
      const single = await makeUser("single@example.test");
      const one = await makeBusiness(single.id, "single-biz");

      const doubled = await makeUser("doubled@example.test");
      await makeBusiness(doubled.id, "doubled-a");
      await makeBusiness(doubled.id, "doubled-b");

      const employee = await makeUser("employee@example.test");
      await prisma.storeMember.create({ data: { storeId: one.id, userId: employee.id, role: "EMPLOYEE" } });

      const empty = await makeUser("empty@example.test");

      // Clear anything set along the way, so this starts where the migration
      // starts: every pointer null.
      await prisma.user.updateMany({ data: { activeStoreId: null } });

      // The migration's own two statements, verbatim.
      await prisma.$executeRawUnsafe(`
        UPDATE "User" u SET "activeStoreId" = s.id FROM "Store" s
        WHERE s."userId" = u.id AND u."activeStoreId" IS NULL
          AND (SELECT count(*) FROM "Store" s2 WHERE s2."userId" = u.id) = 1`);
      await prisma.$executeRawUnsafe(`
        UPDATE "User" u SET "activeStoreId" = m."storeId" FROM "StoreMember" m
        WHERE m."userId" = u.id AND u."activeStoreId" IS NULL
          AND (SELECT count(*) FROM "Store" s2 WHERE s2."userId" = u.id) = 0
          AND (SELECT count(*) FROM "StoreMember" m2 WHERE m2."userId" = u.id) = 1`);

      check("one business is backfilled", await activeOf(single.id), one.id);
      check("an employee of exactly one is backfilled", await activeOf(employee.id), one.id);
      check("an account with no business is left alone", await activeOf(empty.id), null);
      // THE DELIBERATE OMISSION. There is no correct answer for an account with
      // two, and inventing one in a migration is the exact recency guess this
      // whole change exists to remove.
      check("an account with two is left for the person to choose", await activeOf(doubled.id), null);

      // And that account lands in the branch that asks rather than picks.
      check("which is the ambiguous branch", (await resolveBusiness(doubled.id)).kind, "ambiguous");
      // Everyone else carries on exactly as before.
      const singleResolved = await resolveBusiness(single.id);
      check("everyone else is unaffected",
        singleResolved.kind === "resolved" ? singleResolved.storeId : null, one.id);

      // Re-running is a no-op, because both statements only touch NULLs.
      await setActiveBusiness(doubled.id, (await accessibleBusinesses(doubled.id))[0].store.id);
      const chosen = await activeOf(doubled.id);
      await prisma.$executeRawUnsafe(`
        UPDATE "User" u SET "activeStoreId" = s.id FROM "Store" s
        WHERE s."userId" = u.id AND u."activeStoreId" IS NULL
          AND (SELECT count(*) FROM "Store" s2 WHERE s2."userId" = u.id) = 1`);
      check("re-running never overwrites a real choice", await activeOf(doubled.id), chosen);
    }

    // -----------------------------------------------------------------------
    console.log("\n11. An account can own a second business today");
    {
      await reset();
      // The question Phase B was written to answer, asked of the real schema
      // rather than reasoned about. StoreDraft.userId is UNIQUE, so an account
      // can only have one business BEING CREATED at a time. The plan assumed
      // that blocked owning several. It does not, and the difference matters.
      const user = await makeUser("second-business@example.test");

      const firstDraft = await prisma.storeDraft.create({
        data: { userId: user.id, name: "First", tagline: "t", description: "d" },
      });
      const first = await makeBusiness(user.id, "first-business");
      await adoptNewBusiness(user.id, first.id);
      // Confirming a draft deletes it, which is what frees the constraint.
      await prisma.storeDraft.delete({ where: { id: firstDraft.id } });

      // Now the same account starts another.
      const secondDraft = await prisma.storeDraft.create({
        data: { userId: user.id, name: "Second", tagline: "t", description: "d" },
      });
      assert("a second draft is allowed once the first is confirmed", secondDraft.id !== firstDraft.id);
      const second = await makeBusiness(user.id, "second-business");
      await adoptNewBusiness(user.id, second.id);
      await prisma.storeDraft.delete({ where: { id: secondDraft.id } });

      check("the account owns two businesses", await prisma.store.count({ where: { userId: user.id } }), 2);
      const both = await accessibleBusinesses(user.id);
      check("and reaches both", both.map((b) => b.store.slug).sort(), ["first-business", "second-business"]);
      const resolved = await resolveBusiness(user.id);
      check("working in the newest", resolved.kind === "resolved" ? resolved.storeId : null, second.id);

      // WHAT THE CONSTRAINT ACTUALLY BLOCKS, stated as a test so the limitation
      // is a recorded fact rather than a guess: two drafts at the same time.
      await prisma.storeDraft.create({
        data: { userId: user.id, name: "Third", tagline: "t", description: "d" },
      });
      const twoAtOnce = await prisma.storeDraft
        .create({ data: { userId: user.id, name: "Fourth", tagline: "t", description: "d" } })
        .then(() => null)
        .catch((e: unknown) => (e instanceof Error ? e.constructor.name : String(e)));
      assert("but two businesses cannot be created at the SAME time", twoAtOnce !== null, String(twoAtOnce));
      check("which leaves the account with its two real businesses",
        await prisma.store.count({ where: { userId: user.id } }), 2);
    }

    // -----------------------------------------------------------------------
    console.log("\n12. Two tabs, two businesses, one account");
    {
      await reset();
      // THE TEST THAT DECIDES WHETHER ANY OF THIS WORKED. Two requests in flight
      // at once, each naming a different business, from the same account. It
      // fails against any implementation that reads ambient state and passes
      // only when the business is genuinely carried per request.
      const owner = await makeUser("two-tabs@example.test");
      const gym = await makeBusiness(owner.id, "iron-gym");
      const coil = await makeBusiness(owner.id, "copper-and-coil");
      await setActiveBusiness(owner.id, gym.id);

      // Each business gets one of everything Sean named, so "did the wrong
      // business answer" is visible in the data rather than only in an id.
      for (const [store, tag] of [[gym, "gym"], [coil, "coil"]] as const) {
        await prisma.product.create({
          data: { storeId: store.id, name: `${tag} product`, description: "d", priceInCents: 1000 },
        });
        await prisma.order.create({
          data: {
            storeId: store.id, productName: `${tag} order`, amountInCents: 1000,
            buyerEmail: `${tag}@example.test`, status: "paid",
            paymentProvider: "STRIPE", externalOrderId: `cs_tab_${tag}`,
          },
        });
        await prisma.storeIntegration.create({
          data: { storeId: store.id, provider: tag === "gym" ? "PRINTFUL" : "EASYPOST", status: "CONNECTED" },
        });
        await prisma.growthPointTransaction.create({
          data: {
            storeId: store.id, type: "GRANT",
            amount: tag === "gym" ? 500 : 900,
            balanceAfter: tag === "gym" ? 500 : 900,
            description: "tab test",
          },
        });
      }

      /** What one request sees, given the business it named. */
      const asTab = async (storeId: string) => {
        const context = await resolveBusiness(owner.id, storeId);
        if (context.kind !== "resolved") return { slug: null };
        const id = context.storeId;
        const [product, order, connection, points] = await Promise.all([
          prisma.product.findFirst({ where: { storeId: id } }),
          prisma.order.findFirst({ where: { storeId: id } }),
          prisma.storeIntegration.findFirst({ where: { storeId: id } }),
          prisma.growthPointTransaction.findFirst({ where: { storeId: id }, orderBy: { createdAt: "desc" } }),
        ]);
        return {
          slug: context.store.slug,
          product: product?.name ?? null,
          order: order?.productName ?? null,
          connection: connection?.provider ?? null,
          points: points?.balanceAfter ?? null,
        };
      };

      // Interleaved deliberately, and repeatedly — a context leak that depends
      // on ordering would pass a single sequential run.
      for (let round = 0; round < 5; round++) {
        const [tabA, tabB] = await Promise.all([asTab(gym.id), asTab(coil.id)]);
        check(`round ${round + 1}: tab A is the gym`, tabA, {
          slug: "iron-gym", product: "gym product", order: "gym order",
          connection: "PRINTFUL", points: 500,
        });
        check(`round ${round + 1}: tab B is the coil business`, tabB, {
          slug: "copper-and-coil", product: "coil product", order: "coil order",
          connection: "EASYPOST", points: 900,
        });
      }

      // Six at once, alternating, is the version a sequential implementation
      // survives and a shared-state one does not.
      const mixed = await Promise.all([
        asTab(gym.id), asTab(coil.id), asTab(gym.id),
        asTab(coil.id), asTab(gym.id), asTab(coil.id),
      ]);
      check("six concurrent requests each answer for the business they named",
        mixed.map((m) => m.slug),
        ["iron-gym", "copper-and-coil", "iron-gym", "copper-and-coil", "iron-gym", "copper-and-coil"]);

      // AND SWITCHING IN ONE TAB MUST NOT MOVE THE OTHER. The active business is
      // a landing preference; a request that named its business is unaffected.
      const [switched, stillCoil] = await Promise.all([
        setActiveBusiness(owner.id, coil.id),
        asTab(gym.id),
      ]);
      check("the switch takes", switched.ok, true);
      check("but a request that named the gym still got the gym", stillCoil.slug, "iron-gym");
      check("and the landing preference did move", await activeOf(owner.id), coil.id);

      // A tab holding a business the account loses access to gets nothing — not
      // the other business.
      await prisma.store.delete({ where: { id: gym.id } });
      const orphaned = await asTab(gym.id);
      check("a deleted business resolves to nothing", orphaned.slug, null);
      assert("not silently to the surviving one", orphaned.slug !== "copper-and-coil");
    }

  } finally {
    await prisma.$disconnect().catch(() => {});
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
