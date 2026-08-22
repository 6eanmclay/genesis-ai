import {
  resolveWorkspaceContext,
  describeWorkspaceForJ4,
} from "@/lib/j4/workspaceContext";
import {
  NAV_SECTIONS,
  COMMERCE_SECTIONS,
  STOREFRONT_SECTIONS,
  ROOM_SECTIONS,
  isSentinelHref,
  businessBasePath,
  sectionHref,
} from "@/lib/dashboard/navConfig";

// DOES J4 KNOW WHERE THE OWNER IS STANDING?
//
//   npx tsx scripts/verify-workspace-context.ts
//
// This is what makes "make this bolder" a complete sentence. J4 opens OVER the
// workspace rather than replacing it, so the owner can be looking at something
// while asking about it — and unless J4 is told what that something is, the
// whole arrangement is theatre.
//
// THE BUG THIS FILE WAS WRITTEN FOR, found 2026-08-22 and fixed in the same
// commit. The registry is keyed by `/dashboard/...` and matched exactly.
// Business-in-the-URL shipped 2026-08-20 and moved every owner to
// `/b/<slug>/...`. From that day J4 resolved NOTHING on any route an owner
// actually used. Nothing failed, nothing logged, and no type complained —
// describeWorkspaceForJ4 returning null is a completely ordinary outcome, so
// "J4 has no idea where you are" and "this screen has nothing worth saying"
// were indistinguishable from outside.
//
// Two other rooms were blind for longer: Studio joined the room bar on
// 2026-08-16 and "What you could sell" on 2026-08-17, and neither was ever
// added here.
//
// SECTION 4 IS THE ONE THAT MATTERS MOST, and it is the reason this is a suite
// rather than a fix. It asserts the mirror: every room and section the shell
// can put an owner in resolves to a real workspace. That is the check that
// turns the next omission into a failing test instead of a silence — and this
// registry's own header already claims the property ("kept deliberately in step
// with lib/dashboard/navConfig.ts's own hrefs") without anything enforcing it.
// See ARCHITECTURE.md, "Standing invariant: the mirrored registry".

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

const labelAt = (path: string) => resolveWorkspaceContext(path)?.label ?? null;

// ============================================================================
console.log("\n=== 1. The business in the URL does not cost the owner their context ===\n");
// ============================================================================
check("the legacy path still resolves", labelAt("/dashboard/website"), "Storefront");
check("and so does the same screen inside a business",
  labelAt("/b/copper-and-coil/website"), "Storefront");
assert("the two agree, because the business is not what the screen is",
  labelAt("/dashboard/website") === labelAt("/b/copper-and-coil/website"));

// Every room and section, both ways round. A single missed rewrite is exactly
// how this broke the first time.
for (const path of ["/dashboard", "/dashboard/orders", "/dashboard/products", "/dashboard/brand", "/dashboard/analytics"]) {
  const scoped = sectionHref(path, businessBasePath("iron-gym"));
  check(`${scoped} is the same screen as ${path}`, labelAt(scoped), labelAt(path));
}

// The business root is the business home, not nothing.
check("a business's own root is the home screen", labelAt("/b/iron-gym"), "Your Business");
check("with or without a trailing slash", labelAt("/b/iron-gym/"), "Your Business");

// Slugs are arbitrary strings, and a slug that happens to look like a route
// must not change which screen is resolved.
check("a slug that looks like a section is still just a slug",
  labelAt("/b/products/orders"), "Orders");
check("and a slug with a dash is ordinary", labelAt("/b/a-b-c/customers"), "Customers");

// ============================================================================
console.log("\n=== 2. Exactly as strict as it was ===\n");
// ============================================================================
// THE PROPERTY THE FIX HAD TO PRESERVE. Normalising the business out must not
// become a prefix match — "the owner is viewing the product catalog" when they
// are on one product's own page is a confident wrong answer to "what is this
// product?", and saying nothing leaves J4 to ask.
check("one product's own page resolves to nothing", resolveWorkspaceContext("/dashboard/products/abc"), null);
check("inside a business, the same", resolveWorkspaceContext("/b/iron-gym/products/abc"), null);
check("nor does a deeper order page", resolveWorkspaceContext("/b/iron-gym/orders/ord_123"), null);
assert("so a deep path never inherits its parent's answer",
  resolveWorkspaceContext("/b/iron-gym/products/abc") === null,
  "prefix matching would 'fix' the business path and break this at the same time");

// A non-path, a non-string, and the prototype chain.
check("an unknown route is nothing", resolveWorkspaceContext("/dashboard/nope"), null);
check("a bare /b/ is not a business path", resolveWorkspaceContext("/b/"), null);
check("nor is an empty slug", resolveWorkspaceContext("/b//website"), null);
check("a non-string is nothing", resolveWorkspaceContext(42), null);
check("undefined is nothing", resolveWorkspaceContext(undefined), null);
check("null is nothing", resolveWorkspaceContext(null), null);
// hasOwnProperty rather than `in`, the same discipline as every other closed
// registry here — "constructor" is a string a crafted path could carry.
check("an inherited Object property is not a workspace",
  resolveWorkspaceContext("constructor"), null);
check("nor through a business path", resolveWorkspaceContext("/b/x/../constructor"), null);
check("nor __proto__", resolveWorkspaceContext("__proto__"), null);

// A query string or hash is routine (focusHref) and must not cost the context.
check("a query string is ignored", labelAt("/b/iron-gym/website?focus=hero"), "Storefront");
check("a hash too", labelAt("/b/iron-gym/website#top"), "Storefront");
check("and both together", labelAt("/dashboard/orders?a=1#b"), "Orders");

// ============================================================================
console.log("\n=== 3. J4 says the owner's own word for the place ===\n");
// ============================================================================
// A label the owner cannot see anywhere on their screen is worse than none: it
// describes their business in a vocabulary that is no longer theirs.
check("the room bar says Storefront, so J4 does", labelAt("/dashboard/website"), "Storefront");
check("Commerce calls it Revenue, so J4 does", labelAt("/dashboard/analytics"), "Revenue");
check("Studio is a room the owner can see", labelAt("/dashboard/studio"), "Studio");
check("and so is what they could sell", labelAt("/dashboard/catalog"), "What you could sell");

const line = describeWorkspaceForJ4("/b/iron-gym/studio");
assert("the line names the place", line !== null && line.includes("Studio"), String(line));
assert("and says what is on it", line !== null && line.includes("the piece being made"), String(line));
assert("it tells J4 to resolve 'this' against the screen",
  line !== null && line.includes('"this,"'), String(line));
assert("while refusing to make presence the topic",
  line !== null && line.includes("do not steer the conversation toward this screen"),
  "an owner standing on Orders may be asking about something else entirely");
check("an unknown screen contributes no line at all",
  describeWorkspaceForJ4("/b/iron-gym/products/abc"), null);

// The catalog line must not read as inventory — that confusion is the exact one
// its own section comment exists to prevent.
const catalogLine = describeWorkspaceForJ4("/dashboard/catalog") ?? "";
assert("what you could sell is not described as what you do sell",
  catalogLine.includes("not in the catalog yet"), catalogLine);

// ============================================================================
console.log("\n=== 4. The mirror: every place the shell can put an owner ===\n");
// ============================================================================
// The registry claims to be "kept deliberately in step with navConfig.ts's own
// hrefs". Nothing enforced that, which is how three rooms went blind. This is
// the enforcement.
const everyDestination = [
  ...NAV_SECTIONS,
  ...STOREFRONT_SECTIONS,
  ...COMMERCE_SECTIONS,
  ...ROOM_SECTIONS.flat(),
].filter((section) => !isSentinelHref(section.href));

const blind = everyDestination
  .filter((section) => resolveWorkspaceContext(section.href) === null)
  .map((section) => `${section.label} (${section.href})`);
check("no room or section is a place J4 cannot recognise", [...new Set(blind)], []);

// And the same, addressed inside a business — the form owners actually use.
const blindInBusiness = everyDestination
  .filter((section) => resolveWorkspaceContext(sectionHref(section.href, businessBasePath("iron-gym"))) === null)
  .map((section) => `${section.label} (${section.href})`);
check("nor when the business is in the URL", [...new Set(blindInBusiness)], []);

// The sentinel is excluded above and must stay excluded: Account opens a sheet
// in place rather than navigating, so there is no route to be standing on.
const account = NAV_SECTIONS.find((s) => isSentinelHref(s.href));
assert("the account sentinel is not a route J4 could be on",
  account !== undefined && resolveWorkspaceContext(account.href) === null,
  "prefixing or resolving a sentinel would invent a screen that does not exist");

console.log(`\n${failures === 0 ? "All workspace-context assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
