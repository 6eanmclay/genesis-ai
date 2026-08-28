import { storefrontRichContent } from "@/lib/storefront/richContent";

// THE STOREFRONT DETAIL PAGE MUST NOT THROW:
//
//   npx tsx scripts/verify-storefront-rich-content.ts
//
// ============ WHAT THIS IS FOR (2026-08-28) ============================
//
// Sean, after creating a product successfully: "when you try to click on
// details, this is the screen that pops up, and I checked all the other ones we
// created this way, like the mug, the t shirt, and the other hoodie, and they
// all came up with this."
//
// Product.richContent is untyped JSON holding EITHER marketing copy or design
// provenance. The page cast it to the first and read `.keyFeatures.length`, so
// every product ever created from a design took the storefront down when a
// customer pressed View Details.
//
// The cases below are the shapes that actually exist in the database plus the
// ones nobody has written yet. The property is totality: there is no input that
// makes this throw, because the alternative is a paying customer seeing an
// error page.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const EMPTY = { keyFeatures: [], benefits: [], specifications: [] };

function main(): void {
  // ======================================================================
  console.log("\n=== 1. The shape that took the storefront down ===\n");
  // ======================================================================

  const provenance = {
    designId: "rec_123",
    placements: ["front", "back"],
    printFileUrls: ["https://blob.test/a.png", "https://blob.test/b.png"],
    referenceVariantId: "v-2xl",
    sellableVariantIds: ["v-s", "v-m"],
    sellableSizes: ["S", "M"],
  };
  eq("a product created from a design renders with no marketing sections",
    storefrontRichContent(provenance), EMPTY);
  assert("CONTROL: and reading its lists cannot throw",
    storefrontRichContent(provenance).keyFeatures.length === 0,
    "this exact read is what returned Something went wrong");

  // The composed J4 path writes a different provenance shape. Same result.
  eq("and so does the composed design path's own shape",
    storefrontRichContent({ designId: "d1", surface: "garment.tshirt", printFileUrl: "https://blob.test/p.png" }),
    EMPTY);

  // ======================================================================
  console.log("\n=== 2. Real marketing copy still renders ===\n");
  // ======================================================================

  const copy = {
    keyFeatures: ["Hand wound", "Solid copper"],
    benefits: ["Looks the part"],
    specifications: [{ label: "Material", value: "Copper" }],
  };
  eq("everything comes through unchanged", storefrontRichContent(copy), copy);

  // A product carrying BOTH — provenance and copy — keeps the copy.
  eq("and copy survives alongside provenance",
    storefrontRichContent({ ...copy, designId: "d1" }), copy);

  // ======================================================================
  console.log("\n=== 3. Nothing is a valid answer ===\n");
  // ======================================================================

  eq("null", storefrontRichContent(null), EMPTY);
  eq("undefined", storefrontRichContent(undefined), EMPTY);
  eq("an owner-entered product with no rich content", storefrontRichContent({}), EMPTY);

  // ======================================================================
  console.log("\n=== 4. Malformed data renders as nothing, never as junk ===\n");
  // ======================================================================
  //
  // A storefront is the one screen a paying customer sees. Half-valid data
  // should lose the half that is wrong, not take the page with it.

  eq("a string where an object was expected", storefrontRichContent("nope"), EMPTY);
  eq("an array", storefrontRichContent([1, 2, 3]), EMPTY);
  eq("a number", storefrontRichContent(42), EMPTY);
  eq("lists that are not lists",
    storefrontRichContent({ keyFeatures: "one", benefits: 5, specifications: {} }), EMPTY);
  eq("non-strings inside a list are dropped, the rest kept",
    storefrontRichContent({ keyFeatures: ["real", 7, null, "also real"] }).keyFeatures,
    ["real", "also real"]);
  eq("a specification missing its value is dropped",
    storefrontRichContent({
      specifications: [{ label: "Material", value: "Copper" }, { label: "Broken" }, null],
    }).specifications,
    [{ label: "Material", value: "Copper" }]);

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
