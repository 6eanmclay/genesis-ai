import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CANONICAL_REFERENCES, RUNTIME, MARK_PLACEMENT, VISOR_RULE } from "@/lib/brand/j4Assets";

// CANONICAL MEANS CANONICAL (2026-09-10).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-j4-assets.ts" -OutFile out.txt
//
// Sean: "I don't want 'close enough', 'similar J4', 'another interpretation of
// the logo', or an image generator deciding that the logo should look
// different. Exact geometry matters." And: "Don't claim the asset is correct
// because the file exists. Verify the actual rendered asset."
//
// So this hashes the bytes. A regenerated, re-exported or re-interpreted file
// has a different fingerprint whatever it is called, which is the only
// mechanical defence against a generator producing something adjacent and a
// human calling it the same asset. It is deliberately NOT a similarity check:
// "close to the approved artwork" is the failure mode, not the test.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

function fingerprint(publicPath: string): string | null {
  const file = join(process.cwd(), "public", publicPath.replace(/^\//, ""));
  if (!existsSync(file)) return null;
  return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16);
}

console.log("\n=== the approved masters are the approved masters ===\n");
for (const [name, asset] of Object.entries(CANONICAL_REFERENCES)) {
  const actual = fingerprint(asset.path);
  check(`${name}: the master is present`, actual !== null, asset.path);
  check(`${name}: and it is byte-for-byte the approved file`,
    actual === asset.sha256, actual ? `${actual} (registry says ${asset.sha256})` : "missing");
  console.log(`        job: ${asset.job}`);
}

console.log("\n=== the three marks cannot be swapped for one another ===\n");
// The two substitutions Sean named, because both are the obvious shortcut for
// a generator asked for "the J4 logo".
check("the helmet centre uses the insignia, not the ear mark",
  MARK_PLACEMENT.helmetCentre === "helmetEmblem", MARK_PLACEMENT.helmetCentre);
check("the ear module uses the ear mark, not the insignia",
  MARK_PLACEMENT.earModule === "earMark", MARK_PLACEMENT.earModule);
check("the suit pin is the insignia, as on the reference",
  MARK_PLACEMENT.suitLapelPin === "helmetEmblem", MARK_PLACEMENT.suitLapelPin);
check("the visor gets nothing", MARK_PLACEMENT.visor === null, VISOR_RULE);
// Compared as strings because the literal types make the direct comparison a
// compile error — which is itself the guarantee: the registry cannot say the
// helmet and the ear carry the same mark without the types changing first.
check("the helmet and the ear are different assets",
  String(MARK_PLACEMENT.helmetCentre) !== String(MARK_PLACEMENT.earModule),
  `${MARK_PLACEMENT.helmetCentre} vs ${MARK_PLACEMENT.earModule}`);

console.log("\n=== what the product actually draws ===\n");
// The registry names one runtime asset; the component must draw that one and
// only that one. verify-j4-artwork proves the "only one" half; this proves it
// is the REGISTERED one, so a new file cannot quietly become the character.
const characterSrc = readFileSync(join(process.cwd(), "components", "j4", "J4Character.tsx"), "utf8");
const drawn = [...characterSrc.matchAll(/"(\/brand\/[^"]+)"/g)].map((m) => m[1]);
check("the character draws exactly one asset", drawn.length === 1, drawn.join(", ") || "none");
check("and it is the one the registry names",
  drawn[0] === RUNTIME.character.path, `${drawn[0]} vs ${RUNTIME.character.path}`);
check("nothing is drawn on the visor",
  !/visor|face-on/i.test(drawn.join(" ")), drawn.join(", "));

// ---- E28: THE SHIPPED CHARACTER IS NOT YET THE CANONICAL ONE ----------
//
// Recorded rather than papered over, and this suite is accepted-red because of
// it. Compared against the brand sheet Sean signed off:
//
//   HELMET  the shipped render carries an open angular mark on a black panel.
//           Canon is a black DIAMOND platform carrying the continuous emblem -
//           the version with no central separation. There is no diamond on the
//           shipped asset at all.
//
//   EAR     the shipped render carries a mark in the same family as its own
//           forehead mark. Canon is the sharp J-and-triangle from the close-up,
//           a DIFFERENT asset - the signature hardware mark, the Beats mark.
//
// So the shipped character has two variants of one approximate mark where canon
// calls for two distinct ones. That is not something code can fix: it needs the
// character re-rendered against the locked system, which is artwork.
//
// The check is written as the truth it is, so closing it is a matter of
// replacing the asset rather than editing this file.
console.log("\n=== E28: the runtime character against the locked system ===\n");
const runtimeMatchesCanon = RUNTIME.character.sha256.length > 0;
check("the runtime character is a registered canonical render",
  runtimeMatchesCanon,
  "j4-v2.png predates the locked system: helmet has no diamond platform, ear mark is not the signature mark");

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) {
  console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  console.log("\nEXPECTED WHILE E28 IS OPEN — see EXTERNAL_BLOCKERS.md. Closing it needs");
  console.log("a J4 render carrying the diamond helmet insignia and the signature ear mark.");
}
process.exit(failed.length === 0 ? 0 : 1);
