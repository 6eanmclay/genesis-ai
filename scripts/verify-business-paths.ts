import {
  NAV_SECTIONS,
  COMMERCE_SECTIONS,
  STOREFRONT_SECTIONS,
  ROOM_SECTIONS,
  ACCOUNT_SENTINEL_HREF,
  LEGACY_BUSINESS_BASE,
  businessBasePath,
  sectionHref,
  sectionsFor,
  isSentinelHref,
} from "@/lib/dashboard/navConfig";

// Business-scoped navigation paths. No database, no network:
//
//   npx tsx scripts/verify-business-paths.ts
//
// Phase A of BUSINESS_CONTEXT.md. Every section of the dashboard has to be
// addressable inside a business — `/b/<slug>/orders` — without a second list of
// sections existing anywhere, because two lists drift and the one that drifts is
// the one nobody is looking at.
//
// Pure, so the thing every link in the shell depends on is proven without
// rendering anything.

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

// ROOM_SECTIONS is a list OF lists, so it is flattened rather than spread —
// spreading it would put arrays in a list of sections and the type would not
// have caught it at every use site.
const ALL = [...NAV_SECTIONS, ...COMMERCE_SECTIONS, ...STOREFRONT_SECTIONS, ...ROOM_SECTIONS.flat()];

// ---------------------------------------------------------------------------
console.log("\n1. A section moves into a business, and nothing else moves");
{
  const base = businessBasePath("iron-gym");
  check("the base is the business", base, "/b/iron-gym");
  check("a section", sectionHref("/dashboard/orders", base), "/b/iron-gym/orders");
  check("a nested one", sectionHref("/dashboard/products/new", base), "/b/iron-gym/products/new");
  check("the root", sectionHref("/dashboard", base), "/b/iron-gym");

  // A sentinel is a button that opens a sheet, not a route. Prefixing one turns
  // it into a dead link.
  check("a sentinel is untouched", sectionHref(ACCOUNT_SENTINEL_HREF, base), ACCOUNT_SENTINEL_HREF);
  // The storefront is a public URL that has nothing to do with the dashboard.
  check("a storefront link is untouched", sectionHref("/store/iron-gym", base), "/store/iron-gym");
  check("an external link is untouched", sectionHref("https://example.test", base), "https://example.test");
}

// ---------------------------------------------------------------------------
console.log("\n2. The legacy base is exactly what it always was");
{
  // /dashboard has to keep working while the 28 screens migrate one at a time.
  // If rebasing onto it changed a single href, every unmigrated screen would
  // break at once.
  for (const section of ALL) {
    check(`unchanged: ${section.key}`, sectionHref(section.href, LEGACY_BUSINESS_BASE), section.href);
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. Every real section is reachable inside a business");
{
  const base = businessBasePath("copper-and-coil");
  const moved = sectionsFor(ALL, base);

  check("nothing is lost", moved.length, ALL.length);
  for (const section of moved) {
    if (isSentinelHref(section.href)) continue;
    assert(`${section.key} lives in the business`, section.href.startsWith(base), section.href);
    // The old base must not survive inside the new path. "/b/x/dashboard/orders"
    // would render, 404, and look like a routing bug rather than a rebasing one.
    assert(`${section.key} carries no trace of the old base`,
      !section.href.slice(base.length).startsWith(LEGACY_BUSINESS_BASE), section.href);
  }

  // Labels, keys and permissions are untouched — this moves links, not meaning.
  for (let i = 0; i < ALL.length; i++) {
    check(`${ALL[i].key}: label kept`, moved[i].label, ALL[i].label);
    check(`${ALL[i].key}: permission kept`, moved[i].permission, ALL[i].permission);
  }
}

// ---------------------------------------------------------------------------
console.log("\n4. Two businesses produce two different sets of links");
{
  const gym = sectionsFor(ALL, businessBasePath("iron-gym"));
  const coil = sectionsFor(ALL, businessBasePath("copper-and-coil"));

  // The property the whole route change exists for: a link addresses a
  // business. Two tabs on two businesses are two different URLs.
  for (let i = 0; i < gym.length; i++) {
    if (isSentinelHref(gym[i].href)) continue;
    assert(`${gym[i].key} differs between businesses`, gym[i].href !== coil[i].href,
      `${gym[i].href} vs ${coil[i].href}`);
  }

  // And a slug with characters that matter in a URL is not silently mangled.
  const odd = sectionsFor([{ key: "k", label: "l", href: "/dashboard/orders", permission: null }], businessBasePath("a-b-1"));
  check("slugs pass through intact", odd[0].href, "/b/a-b-1/orders");
}

// ---------------------------------------------------------------------------
console.log("\n5. Rebasing is idempotent and reversible");
{
  const base = businessBasePath("iron-gym");
  // Applying it twice must not compound. A shell that rebased an already-rebased
  // href would produce /b/iron-gym/b/iron-gym/orders.
  const once = sectionHref("/dashboard/orders", base);
  check("applying twice changes nothing", sectionHref(once, base), once);
  // And a business href is not dragged back to the legacy base.
  check("legacy rebasing leaves a business href alone", sectionHref(once, LEGACY_BUSINESS_BASE), once);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
