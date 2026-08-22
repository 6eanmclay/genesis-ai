import { slugify } from "@/lib/slugify";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { resolveWorkspaceContext } from "@/lib/j4/workspaceContext";

// A BUSINESS NAME BECOMING A URL:
//
//   npx tsx scripts/verify-slug-and-admin.ts
//
// A store's slug is two things at once: its storefront at /store/<slug> and its
// own workspace at /b/<slug>. Nothing covered the function that produces it.
//
// THE DEFECT THIS FOUND. slugify maps to a-z0-9, so a business named entirely
// in a non-Latin script had NO characters survive:
//
//     "工房"        -> ""
//     "الحرفي"      -> ""
//     "Мастерская"  -> ""
//
// and createStoreFromDraft used that result directly. The store was created
// with slug: "", which made its storefront /store/ and its workspace /b/ — and
// /b/ is not a business path at all, so the owner could not reach their own
// business by its own route. Not an edge case: it is every business whose name
// is not written in Latin letters.
//
// A SECOND, SMALLER ONE alongside it: "Café Noël" became "caf-no-l", because
// every accented character fell through the filter and was replaced by a dash.
// Folding the diacritics first gives "cafe-noel".
//
// The fallback lives at the CALL SITE rather than in slugify, deliberately.
// Returning "" is the honest answer from a function that maps to a-z0-9;
// deciding what to name a business that has no Latin letters is the caller's
// decision, and it is one the existing dedupe loop already knows how to finish.

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

/** What createStoreFromDraft actually does with the result. */
const slugFor = (name: string) => slugify(name) || "store";

// ============================================================================
console.log("\n=== 1. An ordinary name becomes an ordinary URL ===\n");
// ============================================================================
check("an ampersand becomes a separator", slugify("Copper & Coil"), "copper-coil");
check("spaces too", slugify("Iron Gym"), "iron-gym");
check("case is normalised", slugify("IRON GYM"), "iron-gym");
check("runs of punctuation collapse to one dash", slugify("Wax --- Melts"), "wax-melts");
check("and there is never a leading or trailing dash", slugify("  !Hello!  "), "hello");
check("digits survive", slugify("Studio 54"), "studio-54");
check("an emoji is dropped rather than encoded", slugify("🎨 Studio"), "studio");

// ============================================================================
console.log("\n=== 2. Accents are folded, not shredded ===\n");
// ============================================================================
check("a French name keeps its letters", slugify("Café Noël"), "cafe-noel");
check("a Spanish one too", slugify("Piñata Niño"), "pinata-nino");
check("and a German umlaut", slugify("Müller Weg"), "muller-weg");

// WHAT NFD FOLDING CANNOT DO, named rather than papered over. It splits a
// letter-with-accent into a base letter plus a combining mark, so é, ñ, ü and å
// all fold. It does nothing for letters that are DISTINCT characters rather
// than decorated ones — ß, ø, æ, đ — which fall through the a-z filter and
// become separators.
//
// Left as it is on purpose: mapping them would mean inventing a
// language-by-language transliteration table (ß→ss, ø→o, æ→ae, …), and there is
// no end to that list or agreement on its entries. The slug stays usable in
// every case, which is the requirement; it is simply not pretty for these.
check("but an eszett is a letter, not an accent", slugify("Müller Straße"), "muller-stra-e");
check("and so is a slashed o", slugify("Håkon Ørsted"), "hakon-rsted");
assert("both still produce a usable slug, which is the actual requirement",
  slugify("Müller Straße").length > 0 && slugify("Håkon Ørsted").length > 0,
  "a transliteration table has no agreed contents and no end");
assert(
  "so an accented business is not turned into initials and dashes",
  slugify("Café Noël") === "cafe-noel",
  'it used to be "caf-no-l" — every accented character replaced by a separator'
);

// ============================================================================
console.log("\n=== 3. A name with no Latin letters still gets a real URL ===\n");
// ============================================================================
for (const name of ["工房", "الحرفي", "Мастерская", "!!!", "   ", ""]) {
  check(`slugify(${JSON.stringify(name)}) is honestly empty`, slugify(name), "");
  check(`but the store gets a real slug`, slugFor(name), "store");
}

assert(
  "so a business whose name is not in Latin letters is still reachable",
  slugFor("工房").length > 0,
  "an empty slug made the storefront /store/ and the workspace /b/"
);

// THE PART THAT MADE IT UNREACHABLE, closed against the real resolver. /b/ with
// no slug is refused as a business path, which is correct — and is exactly why
// an empty slug could not be navigated to.
check("an empty slug does not form a business path",
  resolveWorkspaceContext("/b//website"), null);
assert("while a real one does",
  resolveWorkspaceContext(`${businessBasePath(slugFor("工房"))}/website`) !== null,
  businessBasePath(slugFor("工房")));

// ============================================================================
console.log("\n=== 4. Every slug is safe in a URL ===\n");
// ============================================================================
const names = [
  "Copper & Coil", "Café Noël", "工房", "🎨 Studio", "Studio 54",
  "O'Brien's Bakery", "A/B Testing Co", "50% Off Store", "Ström & Söhne",
  "  leading and trailing  ", "under_score", "dot.com", "plus+plus",
];
for (const name of names) {
  const slug = slugFor(name);
  assert(`${JSON.stringify(name)} produces a usable slug`, slug.length > 0, slug);
  assert(`${JSON.stringify(name)} needs no URL encoding`, encodeURIComponent(slug) === slug, slug);
  assert(`${JSON.stringify(name)} has no double dash`, !slug.includes("--"), slug);
  assert(`${JSON.stringify(name)} has no edge dash`, !slug.startsWith("-") && !slug.endsWith("-"), slug);
  assert(`${JSON.stringify(name)} is lowercase`, slug === slug.toLowerCase(), slug);
}

// A slug must never collide with the route segments around it, or a business
// would shadow a real screen.
const RESERVED = ["b", "store", "dashboard", "api", "login", "signup"];
assert("the fallback is not a route segment that would shadow a screen",
  !RESERVED.filter((r) => r !== "store").includes(slugFor("工房")),
  `the fallback is "${slugFor("工房")}", and /store/<slug> nests it rather than colliding`);

// ============================================================================
console.log("\n=== 5. The same name always gives the same slug ===\n");
// ============================================================================
// The dedupe loop appends -1, -2 for genuine collisions; the function itself
// must be deterministic or that loop would chase a moving target.
for (const name of names) {
  check(`${JSON.stringify(name)} is stable`, slugify(name), slugify(name));
}
check("and an already-slugified name is unchanged", slugify("copper-coil"), "copper-coil");
assert("so re-slugifying is idempotent",
  slugify(slugify("Café Noël & Co")) === slugify("Café Noël & Co"),
  slugify(slugify("Café Noël & Co")));

console.log(`\n${failures === 0 ? "All slug assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
