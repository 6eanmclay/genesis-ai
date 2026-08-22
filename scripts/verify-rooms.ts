import {
  ROOM_CHARACTER,
  DEFAULT_GROUND,
  roomForPath,
  roomSurface,
  type RoomKey,
} from "@/lib/dashboard/rooms";
import {
  NAV_SECTIONS,
  COMMERCE_SECTIONS,
  STOREFRONT_SECTIONS,
  PRIMARY_TAB_COUNT,
  ACCOUNT_SENTINEL_HREF,
  businessBasePath,
  sectionHref,
  isSentinelHref,
} from "@/lib/dashboard/navConfig";

// WHICH ROOM AM I IN, AND WHAT IS IT MADE OF:
//
//   npx tsx scripts/verify-rooms.ts
//
// Decision 1 of the locked room architecture, Level B. The design question was
// "how the rooms feel different while remaining one Genesis", and it has two
// named failure conditions: rooms that look identical are tabs with better
// names, and rooms that look unrelated are separate products. This suite
// asserts the second one is structurally impossible and the first one is
// actually false.
//
// The properties that carry the architecture, and none of them are cosmetic:
//
//   * ONE PLACE. The ground is resolved here and applied once by DashboardShell.
//     What that buys is only real if the rooms genuinely differ AND the
//     mechanism cannot be bypassed, so both are asserted.
//   * NO ROOM DEPENDS ON HUE. Blue is J4's alone — "a room that glows blue
//     steals the one signal the owner has learned to read." A room that reached
//     for a colour would pass every visual check and break the one signal that
//     matters.
//   * THE NAVIGATION NEVER CHANGES. Nothing here may vary the bar. Asserted by
//     what this module does NOT export as much as by what it does.
//   * ARRIVAL AND ACCOUNT ARE NOT ROOMS. Both fall through to the default, and
//     that is a decision rather than a gap.

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

const BASE = businessBasePath("copper-and-coil");
const at = (path: string) => roomForPath(path, BASE);
const legacyAt = (path: string) => roomForPath(path, "/dashboard");

// ============================================================================
console.log("\n=== 1. Every section lands in the room it belongs to ===\n");
// ============================================================================
for (const section of STOREFRONT_SECTIONS) {
  check(`${section.label} is Storefront`, at(sectionHref(section.href, BASE)), "storefront");
}
for (const section of COMMERCE_SECTIONS) {
  check(`${section.label} is Commerce`, at(sectionHref(section.href, BASE)), "commerce");
}
check("Studio is Studio", at(`${BASE}/studio`), "studio");

// A deeper path stays in its room. This is prefix matching, matching the
// shell's own isActive exactly — one product's page is still Commerce.
check("one product's own page is still Commerce", at(`${BASE}/products/abc`), "commerce");
check("and one order's", at(`${BASE}/orders/ord_123`), "commerce");
assert(
  "which is the OPPOSITE of workspaceContext, deliberately",
  at(`${BASE}/products/abc`) === "commerce",
  "'which room' has a safe wrong answer; 'what is on screen' has one J4 would say out loud"
);

// The same, on the legacy base.
check("the legacy route resolves the same rooms", legacyAt("/dashboard/orders"), "commerce");
check("and the legacy storefront", legacyAt("/dashboard/website"), "storefront");
assert("so a room is a room in both address spaces",
  at(`${BASE}/website`) === legacyAt("/dashboard/website"));

// ============================================================================
console.log("\n=== 2. Arrival and Account are not rooms ===\n");
// ============================================================================
check("the business root is arrival, not a room", at(BASE), null);
check("the legacy root too", legacyAt("/dashboard"), null);
assert("so arrival never inherits a room from a prefix",
  at(BASE) === null,
  "a third kind of surface, neither a room nor a tab");
check("arrival gets the default ground", roomSurface(BASE, BASE), DEFAULT_GROUND);

// Account opens a sheet in place. There is no route, so there is nothing to
// stand in — and the sentinel must never be treated as a path.
const account = NAV_SECTIONS.find((s) => s.href === ACCOUNT_SENTINEL_HREF);
assert("Account is a sentinel, not a route", account !== undefined && isSentinelHref(account.href));
check("and resolves to no room", at(ACCOUNT_SENTINEL_HREF), null);
assert("so a sheet never paints a ground",
  roomSurface(ACCOUNT_SENTINEL_HREF, BASE) === DEFAULT_GROUND,
  "configured, not visited — giving it a character would be inventing work");

// An unknown route is the default rather than a guess.
check("an unknown route has no room", at(`${BASE}/nothing-here`), null);
check("and gets the default ground", roomSurface(`${BASE}/nope`, BASE), DEFAULT_GROUND);

// ============================================================================
console.log("\n=== 3. The rooms are actually different ===\n");
// ============================================================================
// "Rooms that look identical are tabs with better names." Two rooms sharing a
// ground would be exactly that, and it is the kind of thing a careless edit
// produces silently.
const grounds = (Object.keys(ROOM_CHARACTER) as RoomKey[]).map((k) => ROOM_CHARACTER[k].ground);
check("no two rooms share a ground", new Set(grounds).size, grounds.length);
assert("and none of them is the default",
  grounds.every((g) => g !== DEFAULT_GROUND),
  "a room that kept the default ground would be Level A, not the level that was approved");

const surfaces = (Object.keys(ROOM_CHARACTER) as RoomKey[]).map(
  (k) => `${ROOM_CHARACTER[k].ground} ${ROOM_CHARACTER[k].density}`
);
check("nor a whole surface", new Set(surfaces).size, surfaces.length);

// Every room defines both variables. A room with a ground and no density is
// half-built, and half-built is how the level quietly slips back to A.
for (const key of Object.keys(ROOM_CHARACTER) as RoomKey[]) {
  assert(`${key} declares a ground`, ROOM_CHARACTER[key].ground.trim().length > 0);
  assert(`${key} declares a density`, ROOM_CHARACTER[key].density.trim().length > 0);
}

// ============================================================================
console.log("\n=== 4. Blue is J4's, and no room may borrow it ===\n");
// ============================================================================
// The hard constraint, and the one most likely to be broken by someone trying
// to make a room feel special. Every ground must be neutral: zinc, black,
// white, or a plain utility — never a hue, and never J4's own #8b7cf6/#2563eb.
const NEUTRAL = /^(bg-(zinc|neutral|stone|gray|slate)-\d{2,3}|bg-(white|black|transparent)|tabular-nums|dark:bg-(zinc|neutral|stone|gray|slate)-\d{2,3}|dark:bg-(white|black))$/;
for (const key of Object.keys(ROOM_CHARACTER) as RoomKey[]) {
  const offending = ROOM_CHARACTER[key].ground.split(/\s+/).filter((c) => !NEUTRAL.test(c));
  check(`${key}'s ground is neutral`, offending, []);
}
const allClasses = surfaces.join(" ");
assert("no room reaches for J4's blue",
  !allClasses.includes("8b7cf6") && !allClasses.includes("2563eb") && !/\bbg-(blue|indigo|violet|purple)-/.test(allClasses),
  "a room that glows blue steals the one signal the owner has learned to read");

// ============================================================================
console.log("\n=== 5. The bar is untouched ===\n");
// ============================================================================
// "The user should never have to learn a new navigation system just to
// understand where they are." Distinctiveness lives inside the room; getting
// there is always four labels and a tap. Room character must therefore be
// incapable of changing the navigation.
check("still exactly four primary tabs", PRIMARY_TAB_COUNT, 4);
check("and they are the rooms Sean locked",
  NAV_SECTIONS.slice(0, PRIMARY_TAB_COUNT).map((s) => s.label),
  ["Storefront", "Studio", "Commerce", "Account"]);
assert("J4 is not one of them",
  !NAV_SECTIONS.some((s) => /j4|office/i.test(s.key) || /j4|office/i.test(s.label)),
  "the single most likely way to break the architecture");

// Every room with character is reachable from the bar, and nothing in the bar
// is a room nobody can be in.
const roomKeys = Object.keys(ROOM_CHARACTER) as RoomKey[];
const unreachable = roomKeys.filter((key) => {
  const probe = key === "storefront" ? `${BASE}/website` : key === "commerce" ? `${BASE}/orders` : `${BASE}/studio`;
  return at(probe) !== key;
});
check("every room with a character can be stood in", unreachable, []);

console.log(`\n${failures === 0 ? "All room assertions passed." : `${failures} assertion(s) FAILED.`}`);
process.exit(failures === 0 ? 0 : 1);
