import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { readFileSync } from "node:fs";

// TWO KINDS OF IDENTITY, AND THE FORM THAT WROTE TO THE WRONG BUSINESS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts identity-split-db
//
// ============ PHASE 1 OF THE BUSINESS MAP MILESTONE (2026-09-01) =======
//
// Sean: "Identity is mixing basic business facts with the much deeper Brand
// Identity that J4 generates. I want to separate those concepts cleanly."
//
//   Business identity   what the business SAYS IT IS — name, tagline,
//                       description. The owner's, editable, no ceremony.
//   Brand identity      what J4 has MADE OF IT. An interpretation, changed by
//                       agreement, never by overwriting a field.
//
// ============ AND THE DEFECT THE SPLIT UNCOVERED ======================
//
// `EditStoreForm` takes a `slug` and binds it into its action so that "a form
// on one business's page writes to THAT business rather than to whichever one
// the account was last active in" — its own doc comment. The brand screen
// never passed it. `editStore(undefined, …)` falls through
// requireBusinessOrActive to requireStorePermission, which resolves the ACTIVE
// business, so /b/<slug>/brand rendered one business's name and would have
// renamed another.
//
// The wrong-tenant write is executed below rather than argued about: two
// businesses, the second made active, an edit submitted for the first.

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

/** Source with comments stripped. This file and that one both discuss the props by name. */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const page = strip(readFileSync("app/dashboard/brand/page.tsx", "utf8"));
  const form = strip(readFileSync("app/dashboard/EditStoreForm.tsx", "utf8"));

  console.log("\n--- the form is told which business it belongs to ---\n");
  {
    // The fix, asserted on source because the binding is a prop on a client
    // component that no server-side call can observe. The BEHAVIOUR it
    // protects is executed in the next section.
    assert("the brand screen passes its slug to the identity form",
      /<EditStoreForm[\s\S]{0,400}?slug=\{slug\}/.test(page), "no slug prop on EditStoreForm");
    assert("and the form binds it into the action",
      /editStore\.bind\(null,\s*slug\)/.test(form), "action not bound to the slug");
  }

  console.log("\n--- an edit lands on the business it was made for ---\n");
  {
    // ============ WHAT THIS LANE CAN AND CANNOT EXECUTE =============
    //
    // The defect is in RESOLUTION — which storeId the action ends up with —
    // and that runs through requireBusinessOrActive, which needs a session no
    // script has. My first attempt called execute() here; it threw on the
    // permission gate, wrote nothing, and the assertion below caught it
    // rather than passing on a rename that never happened.
    //
    // So this lane proves the half it can reach honestly: the executable
    // writes to the business it is HANDED and to no other. The half it cannot
    // reach — that the screen now hands it the right one — is proven with a
    // real signed-in session in scripts/verify-identity-split-browser.ts,
    // where two businesses exist and the wrong one is active.
    const user = await prisma.user.create({ data: { email: `id-${stamp}@example.test` } });
    const target = await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `id-target-${stamp}`, tagline: "t", description: "d" },
    });
    const other = await prisma.store.create({
      data: { userId: user.id, name: "Iron Gym", slug: `id-other-${stamp}`, tagline: "t", description: "d" },
    });
    // The account is "on" the other business, which is the state the defect
    // needed: looking at one, active in another.
    await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: other.id } });

    const { editStoreExecutable } = await import("@/lib/execution/executables/storeEdit");

    // run() directly, with the target as its context — the shape the fixed
    // screen produces. execute() is the wrapper that resolves and authorises;
    // it is what needs the session, and it is deliberately not used here.
    await editStoreExecutable.run(
      { name: "Cubit & Coil Renamed", tagline: "t", description: "d" },
      { storeId: target.id, userId: user.id } as never);

    const [renamed, untouched] = await Promise.all([
      prismaSystem.store.findUnique({ where: { id: target.id }, select: { name: true, slug: true } }),
      prismaSystem.store.findUnique({ where: { id: other.id }, select: { name: true } }),
    ]);
    eq("the business named in the URL was renamed", renamed?.name, "Cubit & Coil Renamed");
    eq("and the active business was not touched", untouched?.name, "Iron Gym");

    console.log("\n--- renaming never moves the storefront address ---\n");
    eq("the slug is unchanged by a rename", renamed?.slug, `id-target-${stamp}`);
    const source = strip(readFileSync("lib/execution/executables/storeEdit.ts", "utf8"));
    assert("and the executable cannot write a slug at all",
      !/slug/.test(source), "storeEdit mentions slug");

    await prismaSystem.user.deleteMany({ where: { email: `id-${stamp}@example.test` } });
  }

  console.log("\n--- the screen says whose each kind of identity is ---\n");
  {
    // Not a copy test. Each section has to state its AUTHORITY, because that
    // is the only thing distinguishing an editable fact from an
    // interpretation once both are rendered as headed blocks.
    const businessAt = page.indexOf("Business identity");
    const brandAt = page.indexOf("Brand identity");
    assert("business identity comes first", businessAt > 0 && businessAt < brandAt,
      `business=${businessAt} brand=${brandAt}`);
    assert("it is described as the owner's own",
      /What your business says it is/.test(page), "no ownership sentence");
    assert("brand identity is described as J4's interpretation",
      /What J4 has made of your business/.test(page), "no interpretation sentence");
    assert("and no longer merely as generated",
      !/Generated by J4 and refined/.test(page), "old generated-by copy still present");
    assert("the address is stated where the name is edited",
      /Renaming your business does not change its web address/.test(page), "no address line");
    assert("naming the real storefront path",
      /\/store\/\{store\.slug\}/.test(page), "address line does not use the real slug");
  }

  console.log("\n--- brand identity stays read only ---\n");
  {
    // The principle Sean asked to keep real: changing this is a conversation,
    // not a form. If an input ever appears in that section, the "talk with J4
    // first" line becomes decoration.
    const brandSection = page.slice(page.indexOf("Brand identity"));
    assert("there is no input in the brand identity section",
      !/<input|<textarea|<select/.test(brandSection), "an input exists below Brand identity");
    assert("and the conversation-first line is still there",
      /Talk with J4 first/.test(brandSection), "the talk-with-J4 line is gone");
    assert("the nine fields still render from the blueprint",
      /BRAND_IDENTITY_FIELDS\.map/.test(page), "the field list is not rendered");
  }

  console.log("\n--- brand identity reads the same source the approval does ---\n");
  {
    // ============ PHASE 4: THE TWO ANSWERS THAT DISAGREED ==========
    //
    // This screen read all nine fields from blueprint.brandIdentity, while
    // `update_brand_identity.getCurrentValues` reads FOUR of them from the fact
    // lifecycle. Two answers to "what is the current target audience".
    //
    // They agree in production only by accident — the 48 promoted rows are
    // byte-identical copies of the blueprint. The moment an owner states a new
    // audience the fact supersedes, the blueprint is untouched, and the two
    // diverge: the approval diff would show the new answer while the screen
    // kept showing the old one.
    const actions = strip(readFileSync("lib/execution/genesisActions.ts", "utf8"));
    const factBacked = ["targetAudience", "brandPersonality", "brandVoiceAndTone", "uniqueSellingProposition"];

    assert("the screen now reads the fact lifecycle",
      /readOwnerFactsWithProvenance\(/.test(page), "still blueprint-only");
    assert("and declares which fields are fact-backed",
      /FACT_BACKED/.test(page), "no FACT_BACKED map");
    for (const field of factBacked) {
      assert(`${field} is declared fact-backed on the screen`,
        new RegExp(`${field}:`).test(page.slice(page.indexOf("FACT_BACKED"), page.indexOf("FACT_BACKED") + 400)),
        field);
    }
    // The mirror: the action reads exactly these four from claims.
    assert("and the approval reads the same four from claims",
      /brandPersonality: claims\./.test(actions) &&
      /brandVoiceAndTone: claims\./.test(actions) &&
      /targetAudience: claims\./.test(actions) &&
      /uniqueSellingProposition: claims\./.test(actions),
      "the action no longer reads all four from claims");

    // The five narrative fields stay on the blueprint in BOTH.
    for (const field of ["brandStory", "missionStatement", "visionStatement", "brandPromise", "coreValues"]) {
      assert(`${field} still comes from the blueprint in the action`,
        new RegExp(`${field}: blueprint`).test(actions), field);
      assert(`and is not claimed as fact-backed on the screen`,
        !new RegExp(`${field}:`).test(page.slice(page.indexOf("FACT_BACKED"), page.indexOf("FACT_BACKED") + 400)),
        field);
    }

    console.log("\n--- and every field says whose it is ---\n");
    assert("a fact the owner stated reads as theirs",
      /you told J4 this/.test(page), "no owner-origin label");
    assert("one J4 concluded reads as J4's",
      /J4 worked this out/.test(page), "no inference label");
    assert("and the narrative says J4 wrote it",
      /J4 wrote this/.test(page), "no generated label");
    assert("the screen links into the Business Map",
      /Business Map/.test(page), "no link to the map");
  }

  console.log("\n--- the three business facts are all still editable ---\n");
  {
    for (const field of ["name", "tagline", "description"]) {
      assert(`${field} has an input bound to it`,
        new RegExp(`name="${field}"`).test(form), `no input named ${field}`);
    }
    assert("and the form still submits through editStore",
      /editStore/.test(form), "the form no longer calls editStore");
  }

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
