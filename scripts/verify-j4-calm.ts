import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

// THE PERSISTENT J4 IS NOT CALM, AND THIS SAYS SO (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-j4-calm.ts" -OutFile out.txt
//
// ============ WHY THIS SUITE EXISTS RED ================================
//
// Sean, 2026-09-05, on the artwork that sits in the corner of every screen:
// "Think of J4 like a dog when its person comes home. The entrance is the
// excited greeting. Once the greeting is over, J4 settles down and becomes
// calm and present. The black/honeycomb version is his normal working state."
// The rule that came out of it: the persistent J4 has a black ground and a
// subtle honeycomb, with no green energy field. Green belongs to the entrance.
//
// On 2026-09-09 he supplied the new J4 and chose, when asked directly, to keep
// that split - "Keep calm/greeting split; I'll derive a calm variant."
//
// I could not derive one, and this suite is the honest form of that:
//
//   1. The character's shoulders reach the frame edge. The bottom-left corner
//      of the render is white armour, so any background mask cuts into him,
//      and the standing instruction is "Do not modify the canonical source
//      artwork... Preserve the master pixels."
//
//   2. Measured, the new render is not calm. Its surround reads ~76 where the
//      old calm badge read ~26 and the GREETING artwork - the one the rule was
//      written to keep out of the corner - read ~69. The persistent J4 is now
//      brighter than the thing the rule excluded.
//
// So the assertion below fails, deliberately, and it is recorded in
// EXTERNAL_BLOCKERS.md as E27 rather than edited to match what shipped. The
// precedent is this repository's own: verify-rooms.ts was left failing for a
// week rather than rewritten, "because a lock quietly rewritten to match the
// code is not a lock."
//
// IT IS ALONE IN HERE ON PURPOSE. An accepted-red suite hides everything that
// lands behind it - E26's own entry records three further leaks that did
// exactly that. This suite therefore guards ONE fact, so accepting it costs
// exactly one guarantee. verify-j4-artwork keeps the rest and stays green.
//
// TO CLOSE IT: Sean supplies a calm master - the same J4 on a black ground
// with a faint honeycomb and no glow - it replaces the persistent asset, and
// this passes without a line of it changing.

interface Png {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel. */
  data: Buffer;
}

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/** Minimal PNG reader: enough to get real pixels out without a dependency. */
function readPng(file: string): Png {
  const buf = readFileSync(join(process.cwd(), "public", "brand", file));
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) {
    throw new Error(`${file}: unsupported PNG (bitDepth ${bitDepth}, colorType ${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(width * height * 4);
  const line = Buffer.alloc(stride);
  const prev = Buffer.alloc(stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    raw.copy(line, 0, src, src + stride);
    src += stride;
    for (let i = 0; i < stride; i += 1) {
      const a = i >= channels ? line[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      const x = line[i];
      if (filter === 1) line[i] = (x + a) & 0xff;
      else if (filter === 2) line[i] = (x + b) & 0xff;
      else if (filter === 3) line[i] = (x + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        line[i] = (x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < width; x += 1) {
      const s = x * channels;
      const d = (y * width + x) * 4;
      out[d] = line[s];
      out[d + 1] = line[s + 1];
      out[d + 2] = line[s + 2];
      out[d + 3] = channels === 4 ? line[s + 3] : 255;
    }
    line.copy(prev);
  }
  return { width, height, data: out };
}

/**
 * How bright the ground is BESIDE him.
 *
 * The same window the retired check used: the band between his shoulder and
 * the edge, which is ground in every version of this artwork. Measuring the
 * whole frame would average his own white armour in and say nothing about the
 * background.
 */
function surroundBrightness(png: Png): number {
  let total = 0;
  let n = 0;
  for (let y = Math.round(0.30 * png.height); y < Math.round(0.55 * png.height); y += 2) {
    for (let x = Math.round(0.10 * png.width); x < Math.round(0.24 * png.width); x += 2) {
      const i = (y * png.width + x) * 4;
      total += (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
      n += 1;
    }
  }
  return total / n;
}

function main(): void {
  // Read from the component, not from a filename typed here — otherwise this
  // could go on measuring a file nobody renders.
  const characterSrc = readFileSync(join(process.cwd(), "components", "j4", "J4Character.tsx"), "utf8");
  const asset = /"\/brand\/([^"]+)"/.exec(characterSrc)?.[1];
  if (!asset) throw new Error("J4Character: could not find which asset it draws");

  const persistent = readPng(asset);
  const greeting = readPng("j4-off.png");
  const persistentSurround = surroundBrightness(persistent);
  const greetingSurround = surroundBrightness(greeting);

  // 40 is where it has always been, and it was chosen from measurement rather
  // than from a number that sounded dark: the old calm badge read 26, the
  // greeting read 75, so 40 sat between them with headroom on both sides.
  record(
    "the persistent J4 has no energy field around him",
    persistentSurround < 40,
    `${asset} surround ${persistentSurround.toFixed(1)} (threshold 40, greeting ${greetingSurround.toFixed(1)})`,
  );

  record(
    "the persistent J4 is calmer than the greeting",
    persistentSurround < greetingSurround,
    `${persistentSurround.toFixed(1)} vs ${greetingSurround.toFixed(1)}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) {
    console.log("\nEXPECTED WHILE E27 IS OPEN. This suite is accepted-red in");
    console.log("run-all-suites.ts and closes when a calm master replaces the asset.");
  }
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
