import {
  BACK,
  FRONT,
  MAX_SCALE,
  MIN_SCALE,
  addLayer,
  centreLayer,
  designProblem,
  emptyDesign,
  flipLayer,
  isEmpty,
  layerForAsset,
  layersOn,
  moveLayer,
  removeLayer,
  rotateLayer,
  scaleLayer,
  toProviderPlacements,
  toProviderPosition,
  updateLayer,
  usedPlacements,
  type DesignLayer,
  type PrintArea,
} from "@/lib/creation/design";
import { areaFor, brandFromTitle, colorsOf, hasBack, sizesFor, variantFor, type Garment } from "@/lib/creation/garment";
import { priceToCents, toGarment, toPrintAreas, toVariant } from "@/lib/creation/printfulCreation";

// THE CREATION STATION'S ARITHMETIC, WITHOUT A SUPPLIER.
//
//   npx tsx scripts/verify-creation-design.ts
//
// Everything that decides where artwork ends up on somebody's chest is pure, so
// all of it is provable here — and it needs to be, because the expensive
// failure is not a crash. It is a design that looked right on screen and prints
// two inches off, which nobody discovers until a garment arrives.
//
// THE ASSERTION THIS SUITE EXISTS FOR is §5: the canvas and the print file are
// the same arithmetic. A preview that disagrees with what is submitted is worse
// than no preview, because the owner approved it.

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

const AREA_FRONT: PrintArea = { placement: FRONT, width: 12, height: 16, unit: "in" };
const AREA_BACK: PrintArea = { placement: BACK, width: 12, height: 16, unit: "in" };

const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  id: "l1",
  assetUrl: "https://images.example.test/logo.png",
  x: 0.2,
  y: 0.2,
  width: 0.6,
  height: 0.6,
  flipX: false,
  flipY: false,
  rotation: 0,
  ...over,
});

function main() {
  console.log("\n1. A design starts empty and stays immutable");
  {
    const empty = emptyDesign("p1");
    assert("a new design has nothing on it", isEmpty(empty));
    check("and no placements in use", usedPlacements(empty), []);
    check("asking for a placement gives an empty list, never undefined", layersOn(empty, FRONT), []);

    const withOne = addLayer(empty, FRONT, layer());
    check("adding artwork puts it on the placement", layersOn(withOne, FRONT).length, 1);
    // EVERY OPERATION RETURNS A NEW DESIGN. Undo is then a stack of values,
    // and a value cannot be subtly wrong the way an inverse operation can.
    assert("and the original is untouched", isEmpty(empty));
    assert("which makes them different objects", withOne !== empty);

    const both = addLayer(withOne, BACK, layer({ id: "l2" }));
    check("front and back are independent", usedPlacements(both).sort(), [BACK, FRONT].sort());
    check("the front still has exactly one", layersOn(both, FRONT).length, 1);
    check("and the back its own", layersOn(both, BACK)[0].id, "l2");

    const removed = removeLayer(both, BACK, "l2");
    check("removing the last layer removes the placement", usedPlacements(removed), [FRONT]);
    assert("and does not touch the other side", layersOn(removed, FRONT).length === 1);
  }

  console.log("\n2. Moving artwork");
  {
    const design = addLayer(emptyDesign("p1"), FRONT, layer({ x: 0.2, y: 0.2 }));
    const moved = moveLayer(design, FRONT, "l1", 0.1, -0.05);
    check("a move is a delta, not a destination", [moved.placements[FRONT][0].x, moved.placements[FRONT][0].y],
      [0.30000000000000004, 0.15000000000000002]);

    // ============ IT CANNOT BE FLUNG INTO NOWHERE =====================
    // Artwork may hang off the edge — a bleed is a real design, and the
    // provider has limit_to_print_area: false for exactly that. What must not
    // happen is losing it entirely, because then there is nothing left to grab.
    const far = moveLayer(design, FRONT, "l1", 99, 99);
    const l = far.placements[FRONT][0];
    assert("dragged far right, a quarter of it remains", l.x < 1 && l.x + l.width > 1 - 0.001,
      JSON.stringify(l));
    const farBack = moveLayer(design, FRONT, "l1", -99, -99);
    const lb = farBack.placements[FRONT][0];
    assert("dragged far left, a quarter still remains", lb.x + lb.width > 0, JSON.stringify(lb));
    // AND A BLEED IS STILL ALLOWED — the clamp is not the print area.
    assert("so partial overhang is permitted", lb.x < 0, `x=${lb.x}`);

    // A move never changes the size.
    check("moving never resizes", [far.placements[FRONT][0].width, far.placements[FRONT][0].height], [0.6, 0.6]);
    // NaN is a real input from a broken pointer event.
    const nan = moveLayer(design, FRONT, "l1", Number.NaN, 0);
    assert("a NaN delta cannot corrupt a position", Number.isFinite(nan.placements[FRONT][0].x),
      String(nan.placements[FRONT][0].x));
  }

  console.log("\n3. Resizing, about the centre and in proportion");
  {
    const design = addLayer(emptyDesign("p1"), FRONT, layer({ x: 0.2, y: 0.2, width: 0.6, height: 0.6 }));
    const half = scaleLayer(design, FRONT, "l1", 0.5);
    const l = half.placements[FRONT][0];
    check("it halves both dimensions", [l.width, l.height], [0.3, 0.3]);
    // ============ ABOUT THE CENTRE, NOT THE CORNER =====================
    // Scaling from the top-left slides artwork up and left as it shrinks,
    // which feels like the tool fighting the person using it.
    const centreBefore = 0.2 + 0.6 / 2;
    const centreAfter = l.x + l.width / 2;
    assert("and keeps the centre where it was", Math.abs(centreBefore - centreAfter) < 1e-9,
      `${centreBefore} vs ${centreAfter}`);

    // Aspect is preserved: a wide logo stays wide.
    const wide = addLayer(emptyDesign("p1"), FRONT, layer({ width: 0.8, height: 0.2 }));
    const scaledWide = scaleLayer(wide, FRONT, "l1", 0.5).placements[FRONT][0];
    assert("a wide logo stays wide",
      Math.abs(scaledWide.width / scaledWide.height - 4) < 1e-9,
      `${scaledWide.width} x ${scaledWide.height}`);

    // Bounded, so nothing becomes invisible or absurd.
    const tiny = scaleLayer(design, FRONT, "l1", 0.0001).placements[FRONT][0];
    assert("it cannot shrink to nothing", tiny.width >= MIN_SCALE, String(tiny.width));
    const huge = scaleLayer(design, FRONT, "l1", 999).placements[FRONT][0];
    assert("nor grow without bound", huge.width <= MAX_SCALE, String(huge.width));
  }

  console.log("\n4. Flip, rotate and centre");
  {
    const design = addLayer(emptyDesign("p1"), FRONT, layer());
    const flipped = flipLayer(design, FRONT, "l1", "x");
    check("flipping sets the axis", flipped.placements[FRONT][0].flipX, true);
    check("and leaves the other alone", flipped.placements[FRONT][0].flipY, false);
    check("flipping twice is the original",
      flipLayer(flipped, FRONT, "l1", "x").placements[FRONT][0].flipX, false);
    // A flip is free at print time: it is the same file, mirrored.
    check("and never moves or resizes it",
      [flipped.placements[FRONT][0].x, flipped.placements[FRONT][0].width], [0.2, 0.6]);

    const turned = rotateLayer(design, FRONT, "l1", 90);
    check("rotation accumulates", turned.placements[FRONT][0].rotation, 90);
    // NORMALISED, so two full turns is not a different design from none.
    check("a full turn comes back to zero", rotateLayer(turned, FRONT, "l1", 270).placements[FRONT][0].rotation, 0);
    check("and negative rotation stays positive",
      rotateLayer(design, FRONT, "l1", -90).placements[FRONT][0].rotation, 270);

    const centred = centreLayer(design, FRONT, "l1");
    const c = centred.placements[FRONT][0];
    check("centring puts it in the middle of both axes", [c.x, c.y], [0.2, 0.2]);
    const off = addLayer(emptyDesign("p1"), FRONT, layer({ x: 0.9, y: 0.1, width: 0.4, height: 0.4 }));
    const centredOff = centreLayer(off, FRONT, "l1", "x").placements[FRONT][0];
    check("centring one axis leaves the other", [centredOff.x, centredOff.y], [0.3, 0.1]);
  }

  console.log("\n5. The canvas and the print file are the same arithmetic");
  {
    // ============ THE ASSERTION THIS WHOLE SUITE EXISTS FOR ============
    //
    // Verified against Printful's own docs: (0,0) is the top-left of the print
    // area, and the fields are area_width, area_height, width, height, top,
    // left. A preview that disagreed with this would be worse than no preview,
    // because the owner approved it.
    const l = layer({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 });
    const position = toProviderPosition(l, AREA_FRONT); // 12 x 16
    check("a layer becomes the supplier's own position", position, {
      area_width: 12,
      area_height: 16,
      width: 6,   // 0.5 of 12
      height: 4,  // 0.25 of 16
      top: 8,     // 0.5 of 16
      left: 3,    // 0.25 of 12
      limit_to_print_area: false,
    });

    // A BLEED IS SUBMITTED, NOT REFUSED. Printful returns 400 "Invalid
    // position" when limit_to_print_area is true and artwork crosses the
    // border — and crossing it is a choice somebody made on a preview they
    // approved.
    check("overhang is allowed through", position.limit_to_print_area, false);

    // Centred stays centred at any print area — the whole point of storing
    // fractions rather than inches.
    const centred = centreLayer(addLayer(emptyDesign("p1"), FRONT, layer({ width: 0.5, height: 0.5 })), FRONT, "l1")
      .placements[FRONT][0];
    const small = toProviderPosition(centred, { placement: FRONT, width: 10, height: 10, unit: "in" });
    const large = toProviderPosition(centred, { placement: FRONT, width: 40, height: 40, unit: "in" });
    // WITHIN HALF A UNIT, because centring is exact in fractions and the
    // supplier takes integers — 2.5 inches from the left of a 10-inch area
    // rounds to 3, and demanding exact equality would be asserting that
    // rounding does not happen rather than that centring works.
    assert("centred on a small area",
      Math.abs(small.left - (small.area_width - small.width) / 2) <= 0.5, JSON.stringify(small));
    assert("and centred on a large one",
      Math.abs(large.left - (large.area_width - large.width) / 2) <= 0.5, JSON.stringify(large));

    // Integers, because a supplier takes integers and a fractional pixel is
    // not a position.
    const odd = toProviderPosition(layer({ x: 0.333, y: 0.333, width: 0.333, height: 0.333 }), AREA_FRONT);
    assert("every field is a whole number",
      Object.entries(odd).filter(([k]) => k !== "limit_to_print_area").every(([, v]) => Number.isInteger(v)),
      JSON.stringify(odd));
  }

  console.log("\n6. A whole design, addressed to the supplier");
  {
    let design = emptyDesign("p1");
    design = addLayer(design, FRONT, layer({ id: "front-1" }));
    design = addLayer(design, BACK, layer({ id: "back-1", width: 0.9, height: 0.9, x: 0.05, y: 0.05 }));

    const placements = toProviderPlacements(design, [AREA_FRONT, AREA_BACK]);
    check("both sides are submitted", placements.map((p) => p.placement).sort(), [BACK, FRONT].sort());
    check("each carries its own artwork", placements.find((p) => p.placement === BACK)!.layers.length, 1);
    // FRONT AND BACK ARE INDEPENDENT — different artwork, different size,
    // different position, on the same garment.
    const front = placements.find((p) => p.placement === FRONT)!.layers[0].position;
    const back = placements.find((p) => p.placement === BACK)!.layers[0].position;
    assert("and they are genuinely different placements", front.width !== back.width,
      `${front.width} vs ${back.width}`);

    // ============ A PLACEMENT THE BLANK DOES NOT HAVE IS DROPPED ========
    // There is no honest default print area. Inventing one would submit a real
    // print file positioned against a number nobody supplied.
    const frontOnly = toProviderPlacements(design, [AREA_FRONT]);
    check("a blank with no back gets only the front", frontOnly.map((p) => p.placement), [FRONT]);
    assert("and the back artwork is not silently moved to the front",
      frontOnly[0].layers.length === 1 && frontOnly[0].layers[0].position.width === front.width);
  }

  console.log("\n7. What stops a design being made");
  {
    const areas = [AREA_FRONT, AREA_BACK];
    const empty = emptyDesign("p1");
    assert("an empty design says so", (designProblem(empty, areas) ?? "").includes("Add some artwork"),
      String(designProblem(empty, areas)));

    const art = addLayer(empty, FRONT, layer());
    assert("artwork with no variant chosen says so",
      (designProblem(art, areas) ?? "").includes("colour and size"), String(designProblem(art, areas)));

    const ready = { ...art, externalVariantId: "v1" };
    check("a complete design has no problem", designProblem(ready, areas), null);

    // A placement the blank cannot print is NAMED, because "something is
    // wrong" is not something anybody can act on.
    const onBack = addLayer(ready, BACK, layer({ id: "b" }));
    const problem = designProblem(onBack, [AREA_FRONT]);
    assert("an unsupported placement is named", (problem ?? "").includes("back"), String(problem));
  }

  console.log("\n8. New artwork arrives at a sensible size");
  {
    const square = layerForAsset({ id: "a", assetUrl: "u", naturalWidth: 500, naturalHeight: 500, area: AREA_FRONT });
    assert("it does not fill the whole garment", square.width < 1, String(square.width));
    assert("and is centred horizontally", Math.abs(square.x - (1 - square.width) / 2) < 1e-9, String(square.x));

    // A wide logo stays wide, corrected for the print area's own aspect: a
    // square image on a 12x16 area is NOT square in normalised units.
    const wide = layerForAsset({ id: "a", assetUrl: "u", naturalWidth: 1000, naturalHeight: 250, area: AREA_FRONT });
    assert("a wide image is wider than it is tall", wide.width > wide.height,
      `${wide.width} x ${wide.height}`);
    assert("a square image on a tall area is not square in fractions",
      Math.abs(square.width - square.height) > 0.01, `${square.width} x ${square.height}`);

    // Unknown dimensions must not crash or produce something unusable.
    const unknown = layerForAsset({ id: "a", assetUrl: "u" });
    assert("unknown dimensions still give a usable layer",
      unknown.width > 0 && unknown.height > 0 && Number.isFinite(unknown.height), JSON.stringify(unknown));
  }

  console.log("\n9. What Printful's own responses map to");
  {
    // Recorded from Printful's documented v2 shape — mapping needs no account.
    const variants = [
      { id: 4012, size: "S", color: "Black", color_code: "#14191e", image: "https://f.test/b.jpg", price: "12.50",
        placement_dimensions: [{ placement: "front", width: 12, height: 16 }, { placement: "back", width: 12, height: 16 }] },
      { id: 4013, size: "M", color: "Black", color_code: "#14191e", image: "https://f.test/b.jpg", price: "12.50" },
      { id: 4020, size: "S", color: "White", color_code: "#ffffff", image: "https://f.test/w.jpg", price: "12.50" },
    ];

    const v = toVariant(variants[0])!;
    check("a variant carries its colour", v.color, "Black");
    // A REAL HEX, so the swatch is the garment's actual colour.
    check("and the supplier's own hex", v.colorHex, "#14191e");
    check("its size", v.size, "S");
    check("a photograph of that colour", v.imageUrl, "https://f.test/b.jpg");
    check("and the cost in cents", v.costInCents, 1250);

    // A colour name is not a hex. Painting a swatch from one would be a lie
    // about what the garment looks like.
    check("an unparseable colour code becomes null",
      toVariant({ ...variants[0], color_code: "midnight" })!.colorHex, null);
    check("a variant with no id is not a variant", toVariant({ size: "S", color: "Black" }), null);

    check("print areas come from the variant that states them",
      toPrintAreas(variants).map((a) => a.placement), ["front", "back"]);
    check("and none is invented when nobody states any", toPrintAreas([variants[1]]), []);

    const garment = toGarment(
      { id: 71, name: "Unisex Staple T-Shirt | Bella + Canvas 3001", type: "T-SHIRT", image: "https://f.test/p.jpg" },
      variants,
    )!;
    check("the garment is named", garment.name, "Unisex Staple T-Shirt | Bella + Canvas 3001");
    // THE MANUFACTURER, which Printful has no field for.
    check("its manufacturer is extracted", garment.brand, "Bella + Canvas");
    check("it has both print areas", garment.printAreas.length, 2);
    check("and every variant", garment.variants.length, 3);

    // A blank that cannot be bought or cannot be printed on is not offered.
    check("a garment with no variants is refused", toGarment({ id: 1, name: "x" }, []), null);
    check("and one with no print areas too", toGarment({ id: 1, name: "x" }, [variants[1]]), null);
  }

  console.log("\n10. Reading a garment");
  {
    const garment = toGarment(
      { id: 71, name: "Unisex Staple T-Shirt | Bella + Canvas 3001", type: "T-SHIRT" },
      [
        { id: 1, size: "S", color: "Black", color_code: "#000000", image: "https://f.test/b.jpg",
          placement_dimensions: [{ placement: "front", width: 12, height: 16 }] },
        { id: 2, size: "M", color: "Black", color_code: "#000000", image: "https://f.test/b.jpg" },
        { id: 3, size: "S", color: "White", color_code: "#ffffff", image: "https://f.test/w.jpg" },
      ],
    )! as Garment;

    check("its colours are distinct", colorsOf(garment).map((c) => c.color), ["Black", "White"]);
    // EACH SWATCH IS A PHOTOGRAPH OF THAT COLOUR, not a tinted copy of one.
    check("each with its own photograph",
      colorsOf(garment).map((c) => c.imageUrl), ["https://f.test/b.jpg", "https://f.test/w.jpg"]);
    check("sizes are per colour", sizesFor(garment, "Black"), ["S", "M"]);
    // A COLOUR SOLD OUT IN A SIZE IS A REAL STATE. Substituting would put the
    // wrong thing in somebody's basket.
    check("White only comes in S here", sizesFor(garment, "White"), ["S"]);
    check("an existing combination resolves", variantFor(garment, "Black", "M")?.externalVariantId, "2");
    check("and one that does not exist is null, never a near miss",
      variantFor(garment, "White", "M"), null);

    check("the front area is found", areaFor(garment, FRONT)?.width, 12);
    check("a placement it does not have is null", areaFor(garment, BACK), null);
    check("so it does not claim a back", hasBack(garment), false);
  }

  console.log("\n11. Manufacturer names, and refusing to guess one");
  {
    check("a piped brand is read", brandFromTitle("Unisex Staple T-Shirt | Bella + Canvas 3001"), "Bella + Canvas");
    check("a model number is dropped", brandFromTitle("Hoodie | Gildan 18500"), "Gildan");
    check("a brand with no model survives", brandFromTitle("Tee | Champion"), "Champion");
    // ============ NULL MEANS "WE COULD NOT TELL" ======================
    // Never "unbranded". Guessing from the first word would turn "Unisex
    // Staple T-Shirt" into a manufacturer called Unisex, on a real page.
    check("no pipe means no brand", brandFromTitle("Unisex Staple T-Shirt"), null);
    check("and a numeric fragment is not a brand", brandFromTitle("Tee | 3001"), null);
    check("nor an empty one", brandFromTitle("Tee |"), null);
  }

  console.log("\n12. Prices");
  {
    check("a decimal string becomes cents", priceToCents("12.50"), 1250);
    check("rounding is to the nearest cent", priceToCents("12.345"), 1235);
    // NULL IS UNKNOWN, NOT FREE — the same rule the sourcing layer holds.
    check("an unreadable price is unknown", priceToCents("about twelve"), null);
    check("an absent one is unknown", priceToCents(undefined), null);
    assert("and unknown is never zero", priceToCents("nonsense") !== 0);
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (needs a connected Printful account): the live catalog\n" +
        "call, the real response shapes, and mockup rendering. Mapping is proven\n" +
        "against Printful's documented shapes; the first live call confirms them.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main();
