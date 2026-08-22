import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { resolvePreviewTheme } from "@/lib/storefront/previewTheme";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";

// SEEING THE STOREFRONT AS A PROPOSAL WOULD LEAVE IT:
//
//   npx tsx scripts/run-db-suites.ts     (or this file directly, against a test DB)
//
// Sean's principle: "every meaningful visual change J4 proposes must be
// visually inspectable before the owner accepts it." resolvePreviewTheme is how
// that happens — the real storefront renderer, with the proposed theme applied,
// rather than a mock or a description. Nothing covered it.
//
// EVERY RETURN IN IT IS A null, AND THAT IS THE DESIGN. A bad value is never an
// error, "because this is a way of looking at the store rather than a feature
// of it" — so the whole surface fails soft, and a suite is the only thing that
// can tell "correctly fell back" from "quietly broken". Reading the code cannot:
// both look like `return null`.
//
// THE ONE THAT IS NOT A PREFERENCE IS SECTION 2. An unapplied proposal is
// something the owner has not agreed to, and a customer who could see it would
// be shown a shop that does not exist. viewerIsStaff gates it, and the store id
// is IN the query rather than checked after it, so one store's proposal can
// never render on another store's page.
//
// Every row this creates is deleted at the end, and it only ever touches rows it
// created. It never deletes anything pre-existing — see feedback_test_data_safety.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const CURRENT: Theme = { ...DEFAULT_THEME };
// Theme's sub-objects are optional on the type, so the fixture reads them once
// here rather than asserting non-null at every use site.
const CURRENT_PRESENTATION = DEFAULT_THEME.presentation!;

async function main() {
  await requireTestDatabase(prismaSystem);

  const user = await prisma.user.create({
    data: { email: `preview-${Date.now()}@test.local`, name: "Owner" },
  });
  const mine = await prisma.store.create({
    data: { userId: user.id, name: "Copper & Coil", slug: `preview-mine-${Date.now()}` },
  });
  const theirs = await prisma.store.create({
    data: { userId: user.id, name: "Iron Gym", slug: `preview-theirs-${Date.now()}` },
  });
  const created: string[] = [];

  const proposal = async (
    storeId: string,
    over: { actionType: string; input: unknown; directions?: unknown; status?: string }
  ) => {
    const row = await prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: over.actionType,
        input: over.input as never,
        previousValues: {},
        summary: "A proposal",
        status: over.status ?? "PENDING_APPROVAL",
        directions: (over.directions ?? undefined) as never,
      },
    });
    created.push(row.id);
    return row.id;
  };

  const preview = (proposalId: string | undefined, over: { storeId?: string; viewerIsStaff?: boolean; directionId?: string } = {}) =>
    resolvePreviewTheme({
      storeId: over.storeId ?? mine.id,
      currentTheme: CURRENT,
      proposalId,
      directionId: over.directionId,
      viewerIsStaff: over.viewerIsStaff ?? true,
    });

  try {
    // ========================================================================
    console.log("\n=== 1. A theme proposal previews as itself ===\n");
    // ========================================================================
    // update_theme's input IS the theme — its executable writes
    // `data: { theme: input }` unchanged — so the preview is the input, and
    // there is no transform that could drift between the two.
    const proposed: Theme = { ...CURRENT, presentation: { ...CURRENT_PRESENTATION, cardStyle: "sharp" } };
    const themeId = await proposal(mine.id, { actionType: "update_theme", input: proposed });
    const themePreview = await preview(themeId);
    // Compared field by field rather than by JSON.stringify: the input makes a
    // round trip through a Postgres jsonb column, which does not preserve key
    // order, so a string comparison would fail on a preview that is correct.
    check("a theme proposal renders the proposed theme",
      themePreview?.presentation?.cardStyle === "sharp" &&
        themePreview?.presentation?.buttonStyle === CURRENT_PRESENTATION.buttonStyle &&
        themePreview?.composition?.heroLayout === CURRENT.composition?.heroLayout,
      JSON.stringify(themePreview?.presentation));
    check("which is not the stored one",
      themePreview?.presentation?.cardStyle !== CURRENT_PRESENTATION.cardStyle,
      `${themePreview?.presentation?.cardStyle} vs ${CURRENT_PRESENTATION.cardStyle}`);

    // ========================================================================
    console.log("\n=== 2. A customer never sees a shop that does not exist ===\n");
    // ========================================================================
    // THE ACCESS BOUNDARY. Everything else here is a fallback; this one is the
    // reason the parameter exists.
    check("a non-staff viewer gets no preview", (await preview(themeId, { viewerIsStaff: false })) === null);
    check("even with a real, pending, correctly-scoped proposal id",
      (await preview(themeId, { viewerIsStaff: false })) === null,
      "an unapplied proposal is something the owner has not agreed to");

    // CROSS-STORE. The store id is in the query rather than checked after it.
    check("another store's proposal never renders here",
      (await preview(themeId, { storeId: theirs.id })) === null,
      "one store's pending proposal on another store's page would be a leak between businesses");

    // And the same id genuinely works for its own store, so the check above is
    // testing scoping rather than a broken fixture.
    check("while the same proposal still previews for its own store",
      (await preview(themeId)) !== null);

    // ========================================================================
    console.log("\n=== 3. Only a live proposal previews ===\n");
    // ========================================================================
    check("no proposal id means no preview", (await preview(undefined)) === null);
    check("an id that matches nothing means no preview",
      (await preview("clx0000000000000000000000")) === null);

    for (const status of ["EXECUTED", "REJECTED", "SUPERSEDED"]) {
      const decided = await proposal(mine.id, { actionType: "update_theme", input: proposed, status });
      check(`a ${status} proposal no longer previews`, (await preview(decided)) === null,
        "a decision already made is not a proposal to look at");
    }

    // ========================================================================
    console.log("\n=== 4. A refinement previews through the real transform ===\n");
    // ========================================================================
    // applyRefinementsToTheme is imported rather than reimplemented: "two
    // copies would be a preview that lies, and the lie would only surface after
    // the owner had already approved it."
    const refineId = await proposal(mine.id, {
      actionType: "refine_storefront",
      input: { target: "hero", changes: [{ dimension: "cardStyle", value: "sharp" }] },
    });
    const refined = await preview(refineId);
    check("a refinement applies its change", refined?.presentation?.cardStyle === "sharp",
      JSON.stringify(refined?.presentation?.cardStyle));
    check("and leaves everything it did not name alone",
      refined?.presentation?.buttonStyle === CURRENT_PRESENTATION.buttonStyle,
      "a refinement is one idea, not a redesign");

    // Stored input is read back long after it was written, so it gets the same
    // gate a fresh tool call does — an invented dimension throws inside, and
    // the catch turns that into the real storefront rather than an error page.
    const bogus = await proposal(mine.id, {
      actionType: "refine_storefront",
      input: { target: "hero", changes: [{ dimension: "borderRadiusPx", value: "12" }] },
    });
    check("an unrecognised dimension falls back to the real storefront",
      (await preview(bogus)) === null,
      "the owner is looking at their shop; a stale proposal must not break that view");

    const notAnArray = await proposal(mine.id, {
      actionType: "refine_storefront",
      input: { target: "hero", changes: "sharper" },
    });
    check("and so does input that is not a change list", (await preview(notAnArray)) === null);

    // ========================================================================
    console.log("\n=== 5. A chooser never shows the wrong option ===\n");
    // ========================================================================
    // "An unknown direction id falls back rather than rendering a different
    // direction than the one asked for, which would be the worst possible
    // failure for a chooser."
    const withDirections = await proposal(mine.id, {
      actionType: "refine_storefront",
      input: { target: "hero", changes: [{ dimension: "cardStyle", value: "sharp" }] },
      directions: [
        { id: "warm", label: "Warm editorial", rationale: "r", changes: [{ dimension: "cardStyle", value: "rounded" }] },
        { id: "stark", label: "Stark", rationale: "r", changes: [{ dimension: "cardStyle", value: "sharp" }] },
      ],
    });
    const warm = await preview(withDirections, { directionId: "warm" });
    check("a named direction renders that direction", warm?.presentation?.cardStyle === "rounded",
      JSON.stringify(warm?.presentation?.cardStyle));
    const stark = await preview(withDirections, { directionId: "stark" });
    check("and the other renders the other", stark?.presentation?.cardStyle === "sharp",
      JSON.stringify(stark?.presentation?.cardStyle));
    check("no direction renders the revision's own change set",
      (await preview(withDirections))?.presentation?.cardStyle === "sharp");
    check("an unknown direction id shows nothing rather than the wrong option",
      (await preview(withDirections, { directionId: "not-a-direction" })) === null,
      "showing a different direction than the one asked for is the worst failure a chooser can have");

    // ========================================================================
    console.log("\n=== 6. Anything without a visual preview says so by absence ===\n");
    // ========================================================================
    // "A preview that silently shows the unchanged storefront while claiming to
    // show a proposal is worse than no preview."
    for (const actionType of ["update_hero", "update_seo", "update_section_order", "create_product"]) {
      const other = await proposal(mine.id, { actionType, input: { anything: true } });
      check(`${actionType} has no theme preview`, (await preview(other)) === null,
        "previewed by its own means, deliberately not guessed at here");
    }

    // A theme proposal whose input is not an object falls back rather than
    // rendering a half-themed shop.
    for (const input of [null, "a theme", 42]) {
      const malformed = await proposal(mine.id, { actionType: "update_theme", input });
      check(`a theme proposal whose input is ${JSON.stringify(input)} falls back`,
        (await preview(malformed)) === null);
    }
  } finally {
    // Deleting the stores cascades every ApprovalRequest with them, so there is
    // no separate delete here. An earlier version had one, scoped only by id,
    // and the tenant-isolation guard refused it — correctly: a deleteMany with
    // no store in its where clause is exactly the shape that guard exists to
    // stop, and a verification suite gets no exemption from it.
    void created;
    await prisma.store.deleteMany({ where: { id: { in: [mine.id, theirs.id] } } });
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
