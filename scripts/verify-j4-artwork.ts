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

  // THE PERSISTENT J4 HAS NO FACE LAYER ANY MORE (2026-09-09, Sean).
  //
  // "Black visor remains completely clean. Never put the symbol on the visor
  // itself." So the calm pair is gone: one render, nothing composited over it,
  // and state carried by a ring on the container instead. The checks that used
  // to prove the face layer stayed inside the visor have nothing left to
  // measure - what needs proving now is the opposite, that NOTHING is drawn on
  // him at all. That is asserted directly below, against the component source,
  // because "there is no second image" is a fact about the code rather than
  // about pixels.
  //
  // The entrance keeps its pair and keeps its checks: J4Boot still lights a
  // visor, and until that sequence is redesigned its invariants still hold.
  // COUNT THE ASSETS HE REFERENCES, not the words in the file.
  //
  // The first version of these checks matched on source text, and both halves
  // were wrong in opposite directions. One regex was written through a shell
  // heredoc, which turned `\b` into a literal backspace byte - so it searched
  // for `<img` followed by 0x08 and matched a tag that was plainly there zero
  // times. The other matched the explanatory COMMENT naming the retired face
  // file, and reported a face layer that does not exist. A test that reads
  // prose is measuring my writing rather than the product.
  //
  // Asset paths are unambiguous and cannot appear in a sentence by accident,
  // so those are what get counted.
  const characterAssets = [...characterSrc.matchAll(/"\/brand\/([^"]+)"/g)].map((m) => m[1]);
  record("the persistent J4 references exactly one asset",
    characterAssets.length === 1, characterAssets.join(", ") || "none");
  record("that one asset is the new render",
    characterAssets[0] === "j4-v2.png", characterAssets[0] ?? "none");
  record("no face layer is composited over the visor",
    !characterAssets.some((a) => /face/.test(a)),
    characterAssets.filter((a) => /face/.test(a)).join(", ") || "nothing is drawn on him");

  const pairs = [
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

  // THE CALM MEASUREMENT MOVED OUT (2026-09-09).
  //
  // It compared the persistent badge against the greeting one and asserted the
  // persistent surround was near-black. There is no calm badge any more: the
  // new J4 is one render, and measured, its surround is 75.8 - BRIGHTER than
  // the greeting artwork it used to be contrasted against (69.4).
  //
  // That is a real, unresolved gap against a rule Sean set, so it is not
  // deleted and it is not quietly relaxed. verify-j4-calm.ts carries it alone
  // and fails, the way verify-rooms was deliberately left failing rather than
  // rewritten to match the code. Keeping it here would have made this whole
  // suite accepted-red, and everything else it guards - the clean visor, the
  // entrance armour - would have stopped protecting anything.
  // ---- the greeting and the working state are different pictures -----------
  // Sean's model for this: J4 is like a dog when its person comes home. The
  // entrance is the excited greeting; then he settles and is calm and present.
  // Collapsing the two back onto one asset is the specific regression - it is
  // how the greeting artwork came to be parked in the corner of every screen.
  //
  // ADDRESSED DIFFERENTLY NOW, and the reason is a crash this suite had. The
  // check read `pairs[0]` against `pairs[1]`, and when the calm pair was
  // removed above, `pairs` held one entry — so it threw
  // `Cannot read properties of undefined` AFTER its last assertion printed.
  // Every PASS line still appeared, and I read those and moved on; what was
  // missing was the "ALL PASS" summary, which is the line that actually says a
  // suite finished. It only surfaced in the full regression.
  //
  // The corner is one asset now, so it is compared directly rather than as a
  // pair, and the comparison no longer depends on how many pairs exist.
  record(
    "the entrance and the corner are not the same picture",
    characterAssets[0] !== pairs[0].base,
    `corner ${characterAssets[0]}, entrance ${pairs[0].base}`,
  );

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
