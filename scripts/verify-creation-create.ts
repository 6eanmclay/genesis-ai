import sharp from "sharp";
import { readFileSync } from "fs";
import { join } from "path";
import { composePrintFile } from "@/lib/creation/composePrintFile";
import { composeMockup, tintBlank } from "@/lib/creation/composeMockup";
import { PRINT_AREA_BOX, MOCKUP_SIZE } from "@/lib/creation/mockupGeometry";
import { growthPointCostFor } from "@/lib/growthPoints/catalog";
import type { DesignLayer } from "@/lib/creation/design";

// CREATE — THE PAID HALF:
//
//   npx tsx scripts/verify-creation-create.ts
//
// ============ WHAT MUST BE TRUE BEFORE THE BUTTON EXISTS (2026-08-28) ===
//
// Sean: "Create must actually work end-to-end before the button exists. Don't
// create a fake or partial Create button. Verify the supplier creation and then
// read the resulting product back to confirm it exists and matches what the
// owner created." And: "If the owner puts artwork on front and back, Create
// needs to create the actual two-sided product — not silently reduce it to one
// placement."
//
// Three things are checkable without a supplier, and they are the three that
// decide whether a two-sided design stays two-sided:
//
//   the print file is composed against the RIGHT canvas per placement
//   every placement with artwork produces a file
//   the code refuses when the supplier confirms fewer than were sent
//
// The last one is asserted against the source, because the only way to run it
// is to have a supplier reject something. It is named here so the rule is
// visible rather than buried in a branch nobody reads.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  id: "l1", assetUrl: "art://red",
  x: 0.25, y: 0.25, width: 0.5, height: 0.5,
  flipX: false, flipY: false, rotation: 0, ...over,
});

/** Real PNG bytes, so sharp is actually exercised rather than mocked. */
async function swatch(r: number, g: number, b: number, size = 400): Promise<Buffer> {
  return sharp({ create: { width: size, height: size, channels: 4, background: { r, g, b, alpha: 1 } } })
    .png()
    .toBuffer();
}

async function main() {
  const red = await swatch(220, 40, 40);
  const blue = await swatch(40, 80, 220);
  const images: Record<string, Buffer> = { "art://red": red, "art://blue": blue };
  const fetchImage = async (url: string) => {
    const found = images[url];
    if (!found) throw new Error(`no fixture for ${url}`);
    return found;
  };

  // ======================================================================
  console.log("\n=== 1. The canvas is the supplier's, per placement ===\n");
  // ======================================================================
  //
  // Measured against the live account: product 146 prints front at 2100x2100
  // and back at 1800x2400. Composing both against one canvas would stretch or
  // crop one of them, which is the mistake symmetry invites.

  const front = await composePrintFile([layer()], { width: 2100, height: 2100 }, fetchImage);
  const back = await composePrintFile([layer()], { width: 1800, height: 2400 }, fetchImage);

  const frontMeta = await sharp(front).metadata();
  const backMeta = await sharp(back).metadata();
  eq("the front file is the front's canvas", [frontMeta.width, frontMeta.height], [2100, 2100]);
  eq("the back file is the BACK's canvas", [backMeta.width, backMeta.height], [1800, 2400]);
  assert("CONTROL: which is a different shape, not the same one twice",
    backMeta.width !== backMeta.height,
    "if these matched, a design would print identically on two areas that are not identical");

  // ======================================================================
  console.log("\n=== 2. The artwork lands where it was placed ===\n");
  // ======================================================================

  assert("the print file keeps an alpha channel", frontMeta.hasAlpha === true,
    "a print file without transparency prints a rectangle around the artwork");

  const { data, info } = await sharp(front).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const at = (fx: number, fy: number) => {
    const x = Math.round(fx * info.width);
    const y = Math.round(fy * info.height);
    const i = (y * info.width + x) * info.channels;
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
  };

  const centre = at(0.5, 0.5);
  assert("the middle of the canvas carries the artwork", centre.a > 200 && centre.r > 150,
    `centre was ${JSON.stringify(centre)}`);
  const corner = at(0.03, 0.03);
  eq("and the corner outside it is transparent", corner.a, 0);

  // A layer moved to the other side of the canvas lands on the other side.
  const moved = await composePrintFile([layer({ x: 0.0, y: 0.0, width: 0.3, height: 0.3 })],
    { width: 600, height: 600 }, fetchImage);
  const movedRaw = await sharp(moved).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const pixel = (fx: number, fy: number) => {
    const x = Math.round(fx * movedRaw.info.width);
    const y = Math.round(fy * movedRaw.info.height);
    return movedRaw.data[(y * movedRaw.info.width + x) * movedRaw.info.channels + 3];
  };
  assert("artwork placed top-left is opaque at the top-left", pixel(0.1, 0.1) > 200);
  assert("CONTROL: and transparent at the bottom-right", pixel(0.9, 0.9) === 0);

  // ======================================================================
  console.log("\n=== 3. Several layers on one placement become ONE file ===\n");
  // ======================================================================
  //
  // The editor allows more than one layer per side and the supplier takes one
  // file per placement. Composing is what stops the second layer being
  // silently dropped — the same rule as not dropping the back.

  const two = await composePrintFile(
    [
      layer({ id: "a", assetUrl: "art://red", x: 0.05, y: 0.05, width: 0.3, height: 0.3 }),
      layer({ id: "b", assetUrl: "art://blue", x: 0.6, y: 0.6, width: 0.3, height: 0.3 }),
    ],
    { width: 600, height: 600 },
    fetchImage,
  );
  const twoRaw = await sharp(two).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = (fx: number, fy: number) => {
    const x = Math.round(fx * twoRaw.info.width);
    const y = Math.round(fy * twoRaw.info.height);
    const i = (y * twoRaw.info.width + x) * twoRaw.info.channels;
    return { r: twoRaw.data[i], g: twoRaw.data[i + 1], b: twoRaw.data[i + 2], a: twoRaw.data[i + 3] };
  };
  const first = rgba(0.15, 0.15);
  const second = rgba(0.7, 0.7);
  assert("the first layer is on the file", first.a > 200 && first.r > first.b, JSON.stringify(first));
  assert("AND SO IS THE SECOND", second.a > 200 && second.b > second.r, JSON.stringify(second));

  // ======================================================================
  console.log("\n=== 4. A layer at the edge does not fail the whole creation ===\n");
  // ======================================================================
  //
  // sharp REFUSES a composite whose offset falls outside the canvas — it throws
  // rather than clipping. Without clamping, a layer dragged half off the edge
  // would fail Create instead of printing as it looked on screen.

  let edgeFailed: string | null = null;
  try {
    await composePrintFile([layer({ x: 0.95, y: 0.95, width: 0.3, height: 0.3 })],
      { width: 600, height: 600 }, fetchImage);
  } catch (error) {
    edgeFailed = error instanceof Error ? error.message : String(error);
  }
  eq("a layer hanging off the edge still composes", edgeFailed, null);

  // ======================================================================
  console.log("\n=== 5. Create costs two points, the same as any creation ===\n");
  // ======================================================================

  eq("creating a product from a design costs 2", growthPointCostFor("create_product_from_design"), 2);
  eq("the same as creating one by hand", growthPointCostFor("create_product"), 2);
  eq("and differentiating an image costs 1", growthPointCostFor("update_product_image"), 1);

  // ======================================================================
  console.log("\n=== 6. The rules that only a supplier can exercise ===\n");
  // ======================================================================
  //
  // Asserted against source because running them needs a live rejection. They
  // are the two that decide whether the owner is charged for nothing.

  const src = readFileSync(join(process.cwd(), "lib", "execution", "executables", "productFromDesign.ts"), "utf8");
  assert("the supplier is called BEFORE any product row is written",
    src.indexOf("createProductWithPlacements({") < src.indexOf("prisma.product.create"),
    "creating locally first would leave a storefront product nobody can manufacture");
  assert("a placement the supplier did not confirm refuses the whole creation",
    /const missing = files[\s\S]{0,400}throw new Error\(/.test(src),
    "this is what stops a two-sided design becoming a one-sided product");
  assert("and the design records which product it became",
    /designId: recordId/.test(src) && /supplierProductCreated: true/.test(src));

  const printful = readFileSync(join(process.cwd(), "lib", "fulfillment", "printful.ts"), "utf8");
  assert("the placements returned are READ BACK, not echoed",
    /store\/products\/\$\{externalProductId\}/.test(printful),
    "a call that did not throw is not evidence that a back print exists");

  // ======================================================================
  console.log("\n=== 7. The product arrives with the picture, not the print file ===\n");
  // ======================================================================
  //
  // Sean, after a created product showed "Photos (0/10), No image": "the actual
  // composition the user previewed, not a generic supplier image or a newly
  // generated approximation."
  //
  // A print file is artwork on transparency. A product photo is the garment, in
  // the colour chosen, with the artwork on it. These check that they are
  // different things and that the second is what gets attached.

  // A blank shaped like Printful's, BUILT FROM RAW PIXELS.
  //
  // The first version of this fixture composited a 10%-alpha rectangle over an
  // opaque white background and asserted the garment stayed translucent. It
  // does not: compositing anything over an opaque ground produces an opaque
  // result, so the fixture came out alpha 255 everywhere and proved nothing
  // about the inversion.
  //
  // The real file is not a composite. Alpha is a SHADING CHANNEL: the
  // background sits at 255 and the garment at around 26, which is why masking
  // by alpha selects the background. Reproducing that means writing the bytes.
  const BLANK_W = 600;
  const BLANK_H = 800;
  const blankRaw = Buffer.alloc(BLANK_W * BLANK_H * 4);
  for (let y = 0; y < BLANK_H; y++) {
    for (let x = 0; x < BLANK_W; x++) {
      const i = (y * BLANK_W + x) * 4;
      const inGarment = x >= 150 && x < 450 && y >= 200 && y < 600;
      blankRaw[i] = 210;
      blankRaw[i + 1] = 210;
      blankRaw[i + 2] = 210;
      // 26 inside the garment, 255 outside it — the opaque part is the part to
      // throw away.
      blankRaw[i + 3] = inGarment ? 26 : 255;
    }
  }
  const blank = await sharp(blankRaw, { raw: { width: BLANK_W, height: BLANK_H, channels: 4 } })
    .png()
    .toBuffer();

  const tinted = await tintBlank(blank, "#1e88e5");
  const tintedRaw = await sharp(tinted).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const tintedAt = (fx: number, fy: number) => {
    const x = Math.round(fx * tintedRaw.info.width);
    const y = Math.round(fy * tintedRaw.info.height);
    const i = (y * tintedRaw.info.width + x) * tintedRaw.info.channels;
    return { r: tintedRaw.data[i], g: tintedRaw.data[i + 1], b: tintedRaw.data[i + 2], a: tintedRaw.data[i + 3] };
  };
  const garmentPixel = tintedAt(0.5, 0.5);
  assert("the garment takes the chosen colour", garmentPixel.a > 200 && garmentPixel.b > garmentPixel.r,
    JSON.stringify(garmentPixel));
  eq("CONTROL: and the opaque white background becomes transparent", tintedAt(0.02, 0.02).a, 0);

  const mockup = await composeMockup({
    blank,
    colorHex: "#1e88e5",
    layers: [layer({ assetUrl: "art://red", x: 0.25, y: 0.25, width: 0.5, height: 0.5 })],
    fetchImage,
  });
  const mockMeta = await sharp(mockup).metadata();
  eq("the mockup is the canvas the owner designed on",
    [mockMeta.width, mockMeta.height], [MOCKUP_SIZE.width, MOCKUP_SIZE.height]);

  const mockRaw = await sharp(mockup).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const mockAt = (fx: number, fy: number) => {
    const x = Math.round(fx * mockRaw.info.width);
    const y = Math.round(fy * mockRaw.info.height);
    const i = (y * mockRaw.info.width + x) * mockRaw.info.channels;
    return { r: mockRaw.data[i], g: mockRaw.data[i + 1], b: mockRaw.data[i + 2], a: mockRaw.data[i + 3] };
  };

  // The artwork sits in the middle of the PRINT AREA, which is where the canvas
  // draws it — not the middle of the whole picture.
  const art = mockAt(
    PRINT_AREA_BOX.x + PRINT_AREA_BOX.width / 2,
    PRINT_AREA_BOX.y + PRINT_AREA_BOX.height / 2,
  );
  assert("the artwork is where the canvas draws it", art.r > 150 && art.g < 120,
    `expected the red artwork at the middle of the print area, got ${JSON.stringify(art)}`);

  assert("CONTROL: the mockup has a ground behind it, so it is not a print file",
    mockAt(0.02, 0.02).a === 255,
    "a transparent product photo renders against whatever the storefront puts behind it");

  const printFileCorner = await (async () => {
    const pf = await composePrintFile([layer({ assetUrl: "art://red" })], { width: 400, height: 400 }, fetchImage);
    const rawPf = await sharp(pf).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return rawPf.data[3];
  })();
  eq("CONTROL: while the print file for the same design IS transparent there", printFileCorner, 0);

  // ======================================================================
  console.log("\n=== 8. The gallery gets rows, not just a column ===\n");
  // ======================================================================
  //
  // "Photos (0/10)" is ordered.length in ProductImageGallery, built from
  // ProductImage rows. The old Creation Station write set Product.imageUrl and
  // created none, so the gallery was empty however that column was filled.

  const execSrc = readFileSync(
    join(process.cwd(), "lib", "execution", "executables", "productFromDesign.ts"), "utf8");
  assert("creating a product writes ProductImage rows",
    /prisma\.productImage\.createMany/.test(execSrc),
    "the gallery counts rows; a scalar imageUrl alone shows Photos (0/10)");
  assert("and the scalar column prefers the mockup over the print file",
    /imageUrl: mockups\[0\]\?\.url \?\? files\[0\]\?\.url/.test(execSrc));
  assert("the front is the picture a customer sees first", /mockups\.sort\(/.test(execSrc));
  assert("CONTROL: a blank the supplier will not serve does not fail the product",
    /NON-FATAL, DELIBERATELY/.test(execSrc),
    "a CDN that will not answer is not a reason to refuse a product the supplier already agreed to make");

  const geometry = readFileSync(join(process.cwd(), "lib", "creation", "mockupGeometry.ts"), "utf8");
  const canvasSrc = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationCanvas.tsx"), "utf8");
  assert("the canvas and the composer share ONE print-area rectangle",
    /PRINT_AREA_BOX/.test(canvasSrc) && /export const PRINT_AREA_BOX/.test(geometry),
    "written twice, the preview and the product photograph drift the first time either is adjusted");
  assert("CONTROL: and the shared module pulls no image library into the browser",
    !/from "sharp"/.test(geometry),
    "a client component importing the composer would bundle sharp");

  // ======================================================================
  console.log("\n=== 9. The size designed on is not the size sold ===\n");
  // ======================================================================
  //
  // Sean: "The size selected during design is a reference/design variant, not
  // the only size we sell... Create should still produce one hoodie product
  // with all supported sizes." The line "front and back · Ash · 2XL" read as a
  // 2XL product, and it was creating one.

  const printfulSrc = readFileSync(join(process.cwd(), "lib", "fulfillment", "printful.ts"), "utf8");
  assert("the supplier is asked for every size, not one",
    /sync_variants: externalVariantIds\.map/.test(printfulSrc),
    "one sync variant meant a product that existed only in the size it was drawn on");

  const draftSrc = readFileSync(join(process.cwd(), "lib", "creation", "designDraft.ts"), "utf8");
  assert("the sellable variants are every size of the chosen COLOUR",
    /garment\.variants\.filter\(\(v\) => v\.color === variant\.color\)/.test(draftSrc),
    "read off the supplier's own variants rather than a list of sizes written down");

  const stationSrc = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationStation.tsx"), "utf8");
  assert("CONTROL: the summary no longer reads as a single-size product",
    /Designed on \{size\} · made in/.test(stationSrc),
    "the size belongs in a sentence about the canvas, not in a list of what the product is");

  const execSrc2 = readFileSync(
    join(process.cwd(), "lib", "execution", "executables", "productFromDesign.ts"), "utf8");
  assert("and the product records both, so a size picker needs no rebuild",
    /referenceVariantId: placement\.externalVariantId/.test(execSrc2) &&
      /sellableVariantIds: placement\.sellableVariantIds/.test(execSrc2));

  // ======================================================================
  console.log("\n=== 10. The paid button asks before it charges ===\n");
  // ======================================================================
  //
  // Sean: "I don't want Growth Points screaming at the user every time they
  // look at the Creation Station... The 2 points should only be deducted after
  // the user explicitly confirms."

  // COMMENTS STRIPPED FOR THIS ONE. The file explains WHY the price came off
  // the button, so the old label appears in its own explanation — asserting
  // absence against the raw source fails on the note that records the fix.
  const stationCode = stationSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert("the button is the business action, with no price on it",
    /"Create product"/.test(stationCode) && !/Create product · 2 points/.test(stationCode),
    "a toll attached to every button is not how a growth resource should read");
  // THE CONFIRMATION IS NOT THIS FEATURE'S ANY MORE (2026-08-28). Sean made it
  // a global rule, so the question lives in one component every metered action
  // uses and the Creation Station supplies only its own sentence. What is
  // asserted here is that it DELEGATES — a feature re-rolling its own dialog is
  // the fragmentation the rule exists to prevent.
  assert("and a confirmation states the cost against the real balance",
    /GrowthPointConfirm/.test(stationSrc) && /Ready to create\?/.test(stationSrc),
    "the shared component holds the balance, the cost and the checkbox");
  const confirmSrc = readFileSync(
    join(process.cwd(), "app", "components", "GrowthPointConfirm.tsx"), "utf8");
  assert("the shared question shows what they have and what it costs",
    /You have \{quote\.balance\}/.test(confirmSrc) && /This costs/.test(confirmSrc));
  assert("and offers the standing opt-out",
    /Don&apos;t ask me about Growth Points again/.test(confirmSrc));
  assert("CONTROL: creating only runs from inside that confirmation",
    /onClick=\{\(\) => void openConfirm\(\)\}/.test(stationSrc) &&
      !/onClick=\{createProduct\}\s*\n\s*className="mt-4 w-full/.test(stationSrc),
    "the outer button must open the question, never do the thing");
  assert("and it refuses when the balance cannot cover it",
    /!quote\.affordable/.test(confirmSrc));
  assert("CONTROL: an owner who opted out is not asked at all",
    /if \(decision\.mustAsk\)/.test(stationSrc),
    "the preference has to reach the surface, or it is a setting that does nothing");

  // ======================================================================
  console.log("\n=== 11. A failure says where it stopped, in words ===\n");
  // ======================================================================

  const actionsSrc2 = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "actions.ts"), "utf8");
  assert("the owner is told their points were not used",
    /Your Growth Points were not used/.test(actionsSrc2),
    "the first question after a failed paid action is whether it charged");
  assert("and which stage stopped, in their terms",
    /couldn't finish creating the product with your print supplier/i.test(actionsSrc2));
  assert("CONTROL: and an unconfirmed placement is named honestly",
    /did not confirm every side/i.test(actionsSrc2),
    "a supplier orphan must not read as a store product that exists");

  // ======================================================================
  console.log("\n=== 12. Removing artwork and deleting an upload are different ===\n");
  // ======================================================================
  //
  // Sean tapped the X in the asset panel and it selected the image instead. Not
  // bubbling — a 20px control half outside a large button, so the finger hit
  // the button. And there was no obvious way to take a placed layer off at all.

  const panelSrc = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "AddAssetPanel.tsx"), "utf8");
  assert("the delete control is a real touch target",
    /h-11 w-11/.test(panelSrc),
    "20px half-outside a big button is why the tap landed on the tile");
  assert("and it cannot reach the tile's handler",
    /event\.stopPropagation\(\)/.test(panelSrc));
  assert("deleting an upload asks first",
    /Delete this upload\?/.test(panelSrc));
  assert("and says what it does NOT do",
    /Artwork already saved in a design keeps working/.test(panelSrc),
    "the guarantee is structural, but the owner cannot read assetLibrary.ts");

  const canvasSrc2 = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationCanvas.tsx"), "utf8");
  assert("artwork on the garment has its own remove control",
    /Remove this artwork/.test(canvasSrc2),
    "Remove was three taps away behind Edit");
  assert("CONTROL: which does not start a drag instead",
    /onPointerDown=\{\(event\) => \{\s*\n\s*event\.stopPropagation\(\);/.test(canvasSrc2),
    "without this the gesture is claimed by the move handler and the click never lands");

  // ======================================================================
  console.log("\n=== 13. Save cannot be broken by the supplier ===\n");
  // ======================================================================
  //
  // Sean, testing live: "Save design currently looks correct but does not
  // actually save. Create product currently looks correct but does not
  // actually complete." One cause for both — Save called getBlankImages, which
  // pages Printful's /images endpoint, and Create saves first. A rate limit or
  // a slow answer threw, nothing caught it, and the button just reset.
  //
  // Saving is the thing an owner reaches for when they are NOT finished. It
  // must not depend on a supplier being reachable.

  const actionsSrc3 = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "actions.ts"), "utf8");
  assert("a supplier failure cannot lose the design",
    /catch \{[\s\S]{0,600}The supplier could not be read/.test(actionsSrc3),
    "the blanks are for a future photograph; the design is the work");
  assert("and repeat saves of one colourway do not call the supplier at all",
    /alreadyKnown/.test(actionsSrc3),
    "saving while working has to stay free and instant");

  const stationSrc2 = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationStation.tsx"), "utf8");
  assert("CONTROL: and a thrown action is reported rather than swallowed",
    /catch \(error\) \{[\s\S]{0,200}could not be saved/.test(stationSrc2),
    "a button that resets with no message is how a lost design looks like a saved one");
  assert("the same for creating",
    /Your Growth Points were not used/.test(stationSrc2));

  // ======================================================================
  console.log("\n=== 14. The resize handle looks like one ===\n");
  // ======================================================================

  const canvasSrc3 = readFileSync(
    join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationCanvas.tsx"), "utf8");
  assert("the corner carries a resize arrow, not a bare dot",
    /Drag to resize/.test(canvasSrc3) && /nwse-resize/.test(canvasSrc3));
  assert("CONTROL: and the touch target is a finger, not the icon",
    /HANDLE_HIT = 44/.test(canvasSrc3),
    "it was 14px — a quarter of what a finger needs, the same mistake as the delete X");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
