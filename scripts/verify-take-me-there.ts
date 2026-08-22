import { TakeMeThereInputSchema } from "@/lib/execution/genesisTools";
import { NAV_SECTIONS, COMMERCE_SECTIONS, STOREFRONT_SECTIONS, businessBasePath, sectionHref } from "@/lib/dashboard/navConfig";
import { resolveWorkspaceContext } from "@/lib/j4/workspaceContext";
import { roomForPath } from "@/lib/dashboard/rooms";
import { readFileSync } from "fs";

// WHERE J4 SAYS IT IS TAKING YOU, AND WHERE IT ACTUALLY GOES:
//
//   npx tsx scripts/verify-take-me-there.ts
//
// take_me_there is the one tool that moves the owner itself, and the only place
// J4 acts on navigation rather than answering. Nothing covered it.
//
// THE DEFECT THIS FOUND. The destination map contained:
//
//     office: { href: "/dashboard/studio", label: "the Office" }
//
// So an owner who asked for the Office got "Taking you to the Office." and
// arrived in Studio. One thing said, another done — the navigation form of the
// rule that Genesis must never claim a change it did not make. It is reachable:
// "office" is a real member of TakeMeThereInputSchema's enum, so the model can
// and does choose it.
//
// There was no correct href to substitute, which is why the fix is not a
// different route. The Office is an overlay opened by the control beneath J4,
// over whichever room the owner is already in, and it deliberately has no route
// of its own — so J4 now answers instead of navigating, which also happens to
// be the more useful reply.
//
// AND THE HREFS WERE LEGACY. Every destination was authored as "/dashboard/…",
// which resolves the ACCOUNT'S ACTIVE business — so J4 navigating an owner who
// is standing in one business could land them in another. Same defect as
// ffa0962's review links, on the one path where J4 does the moving.
//
// This suite reads the DESTINATIONS map out of the route rather than restating
// it, because a second copy in the test is the drift it is meant to catch.

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

const source = readFileSync("app/api/chat/route.ts", "utf8");

/** The destination map as the route actually declares it. */
function destinationsFromRoute(): Record<string, { href: string; label: string }> {
  const block = source.slice(
    source.indexOf("const DESTINATIONS: Record<string, { href: string; label: string }> = {")
  );
  const body = block.slice(block.indexOf("{", block.indexOf("= {")) + 1, block.indexOf("};"));
  const out: Record<string, { href: string; label: string }> = {};
  for (const line of body.split("\n")) {
    const match = line.match(/^\s*"?([\w.]+)"?:\s*\{\s*href:\s*"([^"]+)",\s*label:\s*"([^"]+)"\s*\},?\s*$/);
    if (match) out[match[1]] = { href: match[2], label: match[3] };
  }
  return out;
}

const DESTINATIONS = destinationsFromRoute();
const enumValues: string[] = [...(TakeMeThereInputSchema.shape.destination.options as string[])];
const BASE = businessBasePath("copper-and-coil");

// ============================================================================
console.log("\n=== 1. J4 goes where it says it is going ===\n");
// ============================================================================
assert("the route declares real destinations", Object.keys(DESTINATIONS).length > 0,
  JSON.stringify(Object.keys(DESTINATIONS)));

// THE DEFECT, pinned so it cannot come back: a label naming a room must not
// point at a different room.
const roomOf = (href: string) => roomForPath(sectionHref(href, BASE), BASE);
const mismatches = Object.entries(DESTINATIONS)
  .filter(([key, d]) => {
    const room = roomOf(d.href);
    if (key === "studio" || key === "studio.upload") return room !== "studio";
    if (key === "storefront") return room !== "storefront";
    if (key === "commerce") return room !== "commerce";
    return false;
  })
  .map(([key, d]) => `${key} says "${d.label}" and goes to ${d.href}`);
check("every room destination lands in the room it names", mismatches, []);

assert(
  "and the Office is not among them, because it has no route to go to",
  !("office" in DESTINATIONS),
  'it used to be office -> /dashboard/studio, labelled "the Office" — said one thing, did another'
);

// ============================================================================
console.log("\n=== 2. Every destination the model may pick resolves ===\n");
// ============================================================================
// A mirrored registry: the tool's enum is what the model chooses from, the map
// is what turns that into a place. A value in the enum with no entry falls to
// "I'm not sure where you want to go" — for a destination J4 itself offered.
assert("the tool offers a closed set", enumValues.length > 0, JSON.stringify(enumValues));

// "office" is deliberately handled before the map, so it is expected to be in
// the enum and absent from DESTINATIONS. Named rather than skipped.
const HANDLED_WITHOUT_NAVIGATION = new Set(["office"]);
const unresolvable = enumValues
  .filter((d) => !HANDLED_WITHOUT_NAVIGATION.has(d))
  .filter((d) => !DESTINATIONS[d]);
check("every navigable destination has a target", unresolvable, []);

const orphaned = Object.keys(DESTINATIONS).filter((d) => !enumValues.includes(d));
check("and no target exists for something the model cannot ask for", orphaned, []);

assert("the Office is still offerable, and answered rather than navigated",
  enumValues.includes("office"),
  "removing it from the enum would leave an owner asking for the Office with no reply at all");

// ============================================================================
console.log("\n=== 3. Nowhere J4 sends the owner is a place it cannot describe ===\n");
// ============================================================================
// Closing the loop with the workspace registry: arriving somewhere J4 has
// nothing to say about would make "make this bolder" incomplete the moment the
// owner got there.
const unknownOnArrival = Object.entries(DESTINATIONS)
  .filter(([, d]) => resolveWorkspaceContext(d.href.split("#")[0]) === null)
  .map(([key, d]) => `${key} -> ${d.href}`);
check("every destination is a screen J4 recognises", unknownOnArrival, []);

// And inside a business, which is where owners actually are.
const unknownInBusiness = Object.entries(DESTINATIONS)
  .filter(([, d]) => resolveWorkspaceContext(sectionHref(d.href.split("#")[0], BASE)) === null)
  .map(([key, d]) => `${key} -> ${d.href}`);
check("including once the business is in the URL", unknownInBusiness, []);

// ============================================================================
console.log("\n=== 4. Every destination is a real section ===\n");
// ============================================================================
const everyHref = new Set(
  [...NAV_SECTIONS, ...STOREFRONT_SECTIONS, ...COMMERCE_SECTIONS].map((s) => s.href)
);
const invented = Object.entries(DESTINATIONS)
  .filter(([, d]) => !everyHref.has(d.href.split("#")[0]))
  .map(([key, d]) => `${key} -> ${d.href}`);
check("no destination is a route nothing else links to", invented, []);

// The labels are what J4 says out loud, so they must read as speech.
const entries = Object.entries(DESTINATIONS);
check("no label is a route", entries.filter(([, d]) => d.label.startsWith("/")), []);
check("nor empty", entries.filter(([, d]) => !d.label.trim()), []);
assert("and \"Taking you to X.\" reads as a sentence for every one",
  entries.every(([, d]) => !d.label.endsWith(".") && d.label.trim() === d.label),
  JSON.stringify(entries.map(([, d]) => `Taking you to ${d.label}.`)));

console.log(`\n${failures === 0 ? "All take-me-there assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
