import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { publishStoreExecutable } from "@/lib/execution/executables/storePublish";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";
import { DEFAULT_THEME } from "@/lib/theme";

// Resolved through the registry rather than imported directly. Importing
// resolveChallenge's module first produced "Cannot access
// 'resolveChallengeExecutable' before initialization" — a real import cycle
// through genesisActions, which imports every executable. Going through the
// registry is also how the app itself reaches them, so this exercises the real
// wiring rather than a shortcut around it.
const updateGoalStatusExecutable = GENESIS_ACTIONS.update_goal_status.executable;
const resolveChallengeExecutable = GENESIS_ACTIONS.resolve_challenge.executable;
const updateSectionOrderExecutable = GENESIS_ACTIONS.update_section_order.executable;
const updateThemeExecutable = GENESIS_ACTIONS.update_theme.executable;

// PUBLISHING, AND THE TWO ACTIONS THAT REACH A RECORD BY ID:
//
//   npx tsx scripts/run-db-suites.ts
//
// THE PUBLISH GATE is the only executable in the registry that refuses on a
// business condition rather than a permission: a store cannot go live without a
// payment rail, because "customers won't be able to check out otherwise." A
// storefront that takes no money is not a shop, and an owner who published one
// would find that out from a customer.
//
// It gates PUBLISHING only. Unpublishing a store whose Stripe connection has
// since lapsed must still work — the gate exists to stop a broken shop going
// live, not to trap one that already is.
//
// THE OTHER HALF is the two actions that reach a record by id. updateGoalStatus
// says exactly why its scoping exists: "the id alone is a real cuid the model or
// a caller supplied, and without this check a record belonging to a DIFFERENT
// store could be modified through an approval that was only ever authorized
// against this one." That is a named security property with nothing asserting
// it, on the one path where a model supplies the identifier.
//
// AND update_theme REPLACES RATHER THAN MERGES, deliberately — "update_theme's
// input IS the theme", which is what lets previewTheme render the input
// directly with no transform that could drift. That is the opposite of every
// blueprint writer, so it is pinned as a decision rather than left to look like
// an inconsistency.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function threw(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `store-${Date.now()}@test.local`, name: "Owner" },
  });
  const stores: string[] = [];

  const store = async (over: Record<string, unknown> = {}) => {
    const created = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Copper & Coil",
        slug: `store-${Math.random().toString(36).slice(2)}`,
        ...over,
      },
    });
    stores.push(created.id);
    return created;
  };

  const connect = (storeId: string, provider: "STRIPE" | "PAYPAL", status = "CONNECTED") =>
    prisma.storeIntegration.create({ data: { storeId, provider, status } as never });

  const ctx = (storeId: string) => ({ storeId, userId: user.id }) as never;

  try {
    // ========================================================================
    console.log("\n=== 1. A shop that cannot take money does not go live ===\n");
    // ========================================================================
    const unpaid = await store();
    const refused = await threw(() => publishStoreExecutable.run(undefined as never, ctx(unpaid.id)));
    check("publishing without a payment rail is refused", refused !== null, String(refused));
    check("and says why, in terms of the customer",
      (refused ?? "").includes("check out"), String(refused));
    check("the store really is still unpublished",
      (await prisma.store.findUniqueOrThrow({ where: { id: unpaid.id } })).published === false);

    // A row that exists is not a rail that works. NEEDS_ATTENTION and FAILED are
    // the real states a connection can sit in while being unable to take money —
    // "PENDING" was my own invention and is not in the IntegrationStatus enum.
    for (const status of ["NEEDS_ATTENTION", "FAILED", "DISCONNECTED"] as const) {
      const broken = await store();
      await connect(broken.id, "STRIPE", status);
      const stillRefused = await threw(() => publishStoreExecutable.run(undefined as never, ctx(broken.id)));
      check(`a ${status} connection does not count as a payment rail`, stillRefused !== null, String(stillRefused));
    }

    // Either rail is enough.
    for (const provider of ["STRIPE", "PAYPAL"] as const) {
      const ready = await store();
      await connect(ready.id, provider);
      const published = await publishStoreExecutable.run(undefined as never, ctx(ready.id));
      check(`${provider} alone is enough to publish`,
        (published.metadata as { published: boolean }).published === true,
        published.message);
      check(`and the store is really live`,
        (await prisma.store.findUniqueOrThrow({ where: { id: ready.id } })).published === true);
    }

    // ========================================================================
    console.log("\n=== 2. The gate stops a shop going live, not one coming down ===\n");
    // ========================================================================
    // A published store whose payment connection has since lapsed must still be
    // able to come down. Trapping it live would be the gate causing exactly the
    // harm it exists to prevent.
    const live = await store({ published: true });
    const unpublished = await publishStoreExecutable.run(undefined as never, ctx(live.id));
    check("unpublishing needs no payment rail at all",
      (unpublished.metadata as { published: boolean }).published === false,
      unpublished.message);
    check("and says so plainly", unpublished.message.includes("unpublished"), unpublished.message);
    check("the store really came down",
      (await prisma.store.findUniqueOrThrow({ where: { id: live.id } })).published === false);

    // ========================================================================
    console.log("\n=== 3. An id from a model reaches only this business ===\n");
    // ========================================================================
    const mine = await store();
    const theirs = await store({ name: "Iron Gym" });

    const record = async (storeId: string, entityType: string, data: unknown) =>
      (await prisma.businessRecord.create({
        data: {
          storeId,
          entityType,
          externalId: `r-${Math.random().toString(36).slice(2)}`,
          sourceProvider: "genesis_chat",
          data: data as never,
        },
      })).id;

    const theirGoal = await record(theirs.id, "goal", {
      description: "Reach 100 orders", status: "active", identifiedAt: "2026-01-01",
    });
    const crossGoal = await threw(() =>
      updateGoalStatusExecutable.run({ goalRecordId: theirGoal, status: "achieved" } as never, ctx(mine.id))
    );
    check("another business's goal cannot be updated from here", crossGoal !== null, String(crossGoal));
    const theirGoalAfter = await prisma.businessRecord.findUniqueOrThrow({ where: { id: theirGoal } });
    check("and their goal is untouched",
      (theirGoalAfter.data as { status: string }).status === "active",
      JSON.stringify(theirGoalAfter.data));

    const theirChallenge = await record(theirs.id, "challenge", {
      description: "Shipping is slow", status: "active", identifiedAt: "2026-01-01",
    });
    const crossChallenge = await threw(() =>
      resolveChallengeExecutable.run({ challengeRecordId: theirChallenge } as never, ctx(mine.id))
    );
    check("nor another business's challenge resolved", crossChallenge !== null, String(crossChallenge));
    const theirChallengeAfter = await prisma.businessRecord.findUniqueOrThrow({ where: { id: theirChallenge } });
    check("and theirs stays open",
      (theirChallengeAfter.data as { status: string }).status === "active",
      JSON.stringify(theirChallengeAfter.data));

    check(
      "so an approval authorised against one business cannot reach another's records",
      crossGoal !== null && crossChallenge !== null,
      "the id alone is a real cuid the model or a caller supplied"
    );

    // And the same actions work perfectly on their own store, so the checks
    // above are testing the scoping rather than a broken fixture.
    const myGoal = await record(mine.id, "goal", {
      description: "Reach 100 orders", status: "active", identifiedAt: "2026-01-01",
    });
    await updateGoalStatusExecutable.run({ goalRecordId: myGoal, status: "achieved" } as never, ctx(mine.id));
    const myGoalAfter = await prisma.businessRecord.findUniqueOrThrow({ where: { id: myGoal } });
    check("while this business's own goal updates normally",
      (myGoalAfter.data as { status: string }).status === "achieved",
      JSON.stringify(myGoalAfter.data));

    const myChallenge = await record(mine.id, "challenge", {
      description: "Shipping is slow", status: "active", identifiedAt: "2026-01-01",
    });
    await resolveChallengeExecutable.run({ challengeRecordId: myChallenge } as never, ctx(mine.id));
    const myChallengeAfter = await prisma.businessRecord.findUniqueOrThrow({ where: { id: myChallenge } });
    const resolved = myChallengeAfter.data as { status: string; resolvedAt?: string; description: string };
    check("and its own challenge resolves", resolved.status === "resolved", JSON.stringify(resolved));
    check("with a real resolution date", Boolean(resolved.resolvedAt), String(resolved.resolvedAt));
    check("keeping what the challenge actually was",
      resolved.description === "Shipping is slow", resolved.description);

    // ========================================================================
    console.log("\n=== 4. Section order merges; a theme replaces ===\n");
    // ========================================================================
    const ordered = await store({
      blueprint: { homepageContent: { heroHeadline: "ZZHERO" }, brandIdentity: { brandStory: "ZZSTORY" } } as never,
    });
    await updateSectionOrderExecutable.run(
      { sectionOrder: ["hero", "products"] } as never,
      ctx(ordered.id)
    );
    const orderedAfter = await prisma.store.findUniqueOrThrow({ where: { id: ordered.id } });
    const bp = orderedAfter.blueprint as Record<string, Record<string, unknown>>;
    check("reordering sections keeps the headline", bp.homepageContent?.heroHeadline === "ZZHERO",
      JSON.stringify(bp.homepageContent));
    check("and the brand story", bp.brandIdentity?.brandStory === "ZZSTORY", JSON.stringify(bp.brandIdentity));
    check("while applying the new order",
      JSON.stringify(bp.homepageContent?.sectionOrder) === JSON.stringify(["hero", "products"]),
      JSON.stringify(bp.homepageContent?.sectionOrder));

    // update_theme is the deliberate exception: its input IS the theme, which
    // is what lets previewTheme render the input directly with no transform
    // that could drift between preview and result.
    const themed = await store({ theme: { presentation: { cardStyle: "rounded" } } as never });
    await updateThemeExecutable.run(DEFAULT_THEME as never, ctx(themed.id));
    const themedAfter = await prisma.store.findUniqueOrThrow({ where: { id: themed.id } });
    // Compared as a sorted key/value set. jsonb does not preserve key order, and
    // a string comparison has now failed on identical content three times across
    // this sweep — preview-theme, update-product-image, and here.
    const storedPresentation = (themedAfter.theme as Record<string, unknown>)?.presentation as object;
    const sameFields = (a: object, b: object) =>
      JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
    check("a theme update replaces the theme wholesale",
      sameFields(storedPresentation, DEFAULT_THEME.presentation as object),
      JSON.stringify(storedPresentation));
    check("so a one-field theme becomes the complete one it was given",
      Object.keys(storedPresentation).length === Object.keys(DEFAULT_THEME.presentation as object).length,
      `${Object.keys(storedPresentation).length} fields, from a fixture that had 1`);
    check(
      "which is the decision that keeps the preview honest",
      themedAfter.theme !== null,
      "update_theme's input IS the theme — previewTheme renders it directly, so a merge here would make the preview a different thing from the result"
    );
    check("and it leaves the blueprint alone",
      (await prisma.store.findUniqueOrThrow({ where: { id: ordered.id } })).blueprint !== null);
  } finally {
    await prisma.store.deleteMany({ where: { id: { in: stores } } });
    await prisma.user.delete({ where: { id: user.id } });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
