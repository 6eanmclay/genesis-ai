import { readFileSync } from "fs";
import { join } from "path";
import { inflateSync } from "zlib";

// J4'S ARTWORK, PROVEN AGAINST THE FILES (2026-09-05).
//
// Sean's rule for J4 is that the artwork is locked: not redrawn, not cropped,
// not reconstructed, not substituted. Two things have broken it before, and
// neither was caught by anything that read the source code:
//
//  1. A face layer registered by one landmark put his eyes closer together than
//     the artist drew them. Nothing failed. Sean saw it.
//  2. An asset was deleted while a component still referenced it. Six icons
//     404'd in production and the browser check still reported them lit,
//     because it counted an attribute the code sets rather than pixels the
//     browser drew.
//
// Both are properties of FILES, so this suite decodes the PNGs and looks at the
// pixels. Reading the component and finding the right filename spelled in it
// would have passed in case 2 while production was broken.
//
// WHY THERE IS A PNG DECODER IN HERE. The project has no image library, and
// adding a dependency to run one check is worse than eighty lines of zlib. The
// brand assets are all 8-bit RGBA and non-interlaced, so the decoder handles
// exactly that and refuses anything else rather than quietly misreading it.

const results: { name: string; ok: boolean; detail: string }[] = [];
function record(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BRAND = join(process.cwd(), "public", "brand");

type Png = { width: number; height: number; data: Buffer };

/** 8-bit RGBA, non-interlaced. Anything else throws rather than being guessed at. */
function readPng(file: string): Png {
  const buf = readFileSync(join(BRAND, file));
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let pos = 8;
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8];
      const colour = body[9];
      const interlace = body[12];
      if (depth !== 8 || colour !== 6 || interlace !== 0) {
        throw new Error(`${file}: expected 8-bit RGBA non-interlaced, got depth ${depth} colour ${colour} interlace ${interlace}`);
      }
    } else if (type === "IDAT") {
      idat.push(body);
    } else if (type === "IEND") {
      break;
    }
    pos += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  let src = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[src];
    src += 1;
    const row = y * stride;
    const prev = row - stride;
    for (let x = 0; x < stride; x += 1) {
      const value = raw[src + x];
      const a = x >= 4 ? out[row + x - 4] : 0;
      const b = y > 0 ? out[prev + x] : 0;
      const c = x >= 4 && y > 0 ? out[prev + x - 4] : 0;
      let recon: number;
      switch (filter) {
        case 0: recon = value; break;
        case 1: recon = value + a; break;
        case 2: recon = value + b; break;
        case 3: recon = value + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          recon = value + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error(`${file}: unknown row filter ${filter}`);
      }
      out[row + x] = recon & 0xff;
    }
    src += stride;
  }
  return { width, height, data: out };
}

/** One image over another, as the browser composites the two <img> layers. */
function composite(base: Png, layer: Png): Buffer {
  const out = Buffer.from(base.data);
  for (let i = 0; i < out.length; i += 4) {
    const alpha = layer.data[i + 3] / 255;
    if (alpha === 0) continue;
    for (let c = 0; c < 3; c += 1) {
      out[i + c] = Math.round(layer.data[i + c] * alpha + out[i + c] * (1 - alpha));
    }
  }
  return out;
}

function main(): void {
  // ---- the two pairs, and which surface each belongs to --------------------
  // Named here so that deleting or renaming a file fails LOUDLY in a suite
  // rather than silently in a browser, which is exactly how the icon layers
  // reached production broken.
  // The geometry numbers are the VERIFIED artwork's own, recorded so that a
  // re-registration cannot quietly move or rescale his face. They are a
  // regression guard, not a claim about what is correct: what makes them
  // correct is that this is the artwork Sean signed off in production.
  // WHICH FILES ARE ACTUALLY SHIPPED, read out of the components rather than
  // typed here. Naming them here would let the pixel checks below go on
  // approving j4-character.png while the corner had been pointed back at the
  // greeting artwork - a suite passing about a file nobody renders. So the
  // components name the assets, and every measurement lands on what a browser
  // would really load.
  const characterSrc = readFileSync(join(process.cwd(), "components", "j4", "J4Character.tsx"), "utf8");
  const bootSrc = readFileSync(join(process.cwd(), "components", "j4", "J4Boot.tsx"), "utf8");

  function referenced(source: string, constant: string, where: string): string {
    const found = new RegExp(`const ${constant} = "/brand/([^"]+)"`).exec(source);
    if (!found) throw new Error(`${where}: could not find which file ${constant} points at`);
    return found[1];
  }

  const pairs = [
    {
      label: "calm (the corner and the workspace)",
      base: referenced(characterSrc, "BASE", "J4Character"),
      face: referenced(characterSrc, "FACE", "J4Character"),
      // A feathered ellipse around his face only, so the shell is untouched
      // exactly - anything above zero here is a bleed onto his armour.
      shellAllowance: 0,
      face_x: [0.443, 0.730],
      face_y: [0.345, 0.534],
    },
    {
      label: "greeting (the entrance)",
      base: referenced(bootSrc, "ART_OFF", "J4Boot"),
      face: referenced(bootSrc, "ART_FACE", "J4Boot"),
      // NOT ZERO, AND NOT ROUNDED UP TO HIDE ANYTHING. This layer lights the
      // whole visor, and its feathered edge clips the visor's top rim in a
      // 1-2px hairline: 1088 shell pixels, about 1% of the shell, all of them
      // on that one seam. It is a real property of the shipped entrance
      // artwork, which Sean has confirmed in production and asked not to be
      // changed. The allowance is set just above the measurement so the seam
      // cannot grow without failing.
      shellAllowance: 1200,
      face_x: [0.361, 0.697],
      face_y: [0.222, 0.568],
    },
  ];

  for (const pair of pairs) {
    let base: Png;
    let face: Png;
    try {
      base = readPng(pair.base);
      face = readPng(pair.face);
    } catch (error) {
      record(`${pair.label}: both files exist and decode`, false, String(error));
      continue;
    }
    record(`${pair.label}: both files exist and decode`, true, `${pair.base} + ${pair.face}`);

    // THE ARTWORK CANNOT MOVE. The component stacks the two images in one box
    // with the same object-contain fit, so identical dimensions is what makes
    // "turn the light on" a change of opacity and not a change of framing.
    record(
      `${pair.label}: the light layer is the same size as the artwork`,
      base.width === face.width && base.height === face.height,
      `${base.width}x${base.height} vs ${face.width}x${face.height}`,
    );

    // HIS ARMOUR DOES NOT CHANGE WHEN HIS FACE LIGHTS UP.
    //
    // This is the property Sean would actually see break, and it needs no
    // notion of where the visor is - which matters, because two earlier
    // versions of this check tried to find the visor by looking for a dark run
    // and ended up measuring the detector instead of the artwork. The badge's
    // background is dark too, and the visor carries a bright sheen, so that
    // test was wrong at both ends.
    //
    // The shell is bright and near-neutral: white armour. Glass, sheen, energy
    // and face are all either dark or coloured, so none of them qualify.
    const lit = composite(base, face);
    let shell = 0;
    let shellChanged = 0;
    let changed = 0;
    let minX = base.width;
    let maxX = 0;
    let minY = base.height;
    let maxY = 0;
    for (let y = 0; y < base.height; y += 1) {
      for (let x = 0; x < base.width; x += 1) {
        const i = (y * base.width + x) * 4;
        const r = base.data[i];
        const g = base.data[i + 1];
        const b = base.data[i + 2];
        const d = Math.max(
          Math.abs(lit[i] - r),
          Math.abs(lit[i + 1] - g),
          Math.abs(lit[i + 2] - b),
        );
        const isShell = (r + g + b) / 3 >= 120
          && Math.max(r, g, b) - Math.min(r, g, b) <= 26;
        if (isShell) {
          shell += 1;
          if (d > 12) shellChanged += 1;
        }
        if (d > 12) {
          changed += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    record(
      `${pair.label}: his armour is untouched when he lights up`,
      shellChanged <= pair.shellAllowance,
      `${shellChanged} of ${shell} shell pixels changed (allowed ${pair.shellAllowance})`,
    );

    // WHERE HIS FACE SITS. A layer shifted or rescaled still lights only the
    // visor and would pass everything above while looking plainly wrong - and
    // "his eyes are too close together" is the defect that got through twice
    // before any of this was checked. Pinning the lit region in the artwork's
    // own coordinates catches a shift and a scale change alike.
    const got = [minX / base.width, maxX / base.width,
                 minY / base.height, maxY / base.height];
    const want = [pair.face_x[0], pair.face_x[1], pair.face_y[0], pair.face_y[1]];
    const drift = Math.max(...got.map((v, i) => Math.abs(v - want[i])));
    record(
      `${pair.label}: his face is where it was signed off`,
      changed > 4000 && drift <= 0.006,
      `lit x ${got[0].toFixed(3)}..${got[1].toFixed(3)} y ${got[2].toFixed(3)}..${got[3].toFixed(3)}`
        + `, drift ${drift.toFixed(4)}`,
    );
  }

  // ---- the calm badge is the calm badge ------------------------------------
  // Sean asked for the persistent J4 to be the black/honeycomb version with
  // none of the green energy around him, and the failure mode is somebody
  // pointing the corner back at the greeting artwork. That is not a filename
  // question - it is measurable in the picture: the greeting badge fills the
  // space around him with a bright green field, and the calm one leaves it
  // near-black. Measured in the band between his shoulder and the ring, where
  // the greeting art has swirls and the calm art has only faint honeycomb.
  const calm = readPng(pairs[0].base);
  const greeting = readPng(pairs[1].base);

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

  const calmSurround = surroundBrightness(calm);
  const greetingSurround = surroundBrightness(greeting);
  // 40 SITS BETWEEN THE TWO MEASURED VALUES, not at a number that sounded dark:
  // the calm badge's honeycomb reads 26 and the greeting's energy field reads
  // 75. Both sides therefore have real headroom, and the control below fails if
  // that gap ever closes.
  record(
    "the persistent badge has no energy field around him",
    calmSurround < 40,
    `calm surround ${calmSurround.toFixed(1)} vs greeting ${greetingSurround.toFixed(1)}`,
  );
  // A CONTROL, so the measurement above cannot pass by being blind. If the two
  // artworks stop differing on the thing being measured, the check is broken
  // rather than satisfied.
  record(
    "that measurement can tell the two artworks apart",
    greetingSurround > calmSurround * 2,
    `${greetingSurround.toFixed(1)} vs ${calmSurround.toFixed(1)}`,
  );

  // ---- the greeting and the working state are different pictures -----------
  // Sean's model for this: J4 is like a dog when its person comes home. The
  // entrance is the excited greeting; then he settles and is calm and present.
  // Collapsing the two back onto one asset is the specific regression - it is
  // how the greeting artwork came to be parked in the corner of every screen.
  record(
    "the entrance and the corner are not the same picture",
    pairs[0].base !== pairs[1].base && pairs[0].face !== pairs[1].face,
    `corner ${pairs[0].base}, entrance ${pairs[1].base}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
