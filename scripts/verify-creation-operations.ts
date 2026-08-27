import { BACK, FRONT, addLayer, emptyDesign, layersOn, type DesignLayer } from "@/lib/creation/design";
import { applyAll, applyOperation, describeOperation, operationsFor } from "@/lib/creation/operations";

// WHAT AN INSTRUCTION MEANS, AND WHAT IT REFUSES TO MEAN.
//
//   npx tsx scripts/verify-creation-operations.ts
//
// The pointer and the instruction box emit the SAME operations, so this proves
// both at once — and the thing worth proving hardest is the refusals. A parser
// that guessed would move somebody's artwork somewhere they did not ask for,
// on a design they are about to sell.
//
// NO MODEL CALL, deliberately. "Make it 20% smaller" is a scale by 0.8; it does
// not need a language model and should not wait on one. What genuinely needs J4
// is judgement — whether this looks right, what else to try — and that is a
// conversation rather than a control.

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

const layer = (over: Partial<DesignLayer> = {}): DesignLayer => ({
  id: "l1",
  assetUrl: "https://images.example.test/logo.png",
  x: 0.2, y: 0.2, width: 0.6, height: 0.6,
  flipX: false, flipY: false, rotation: 0,
  ...over,
});

/** One graphic on the front, one on the back — the common two-sided design. */
function twoSided() {
  let design = emptyDesign("p1");
  design = addLayer(design, FRONT, layer({ id: "front-1" }));
  design = addLayer(design, BACK, layer({ id: "back-1", width: 0.8, height: 0.8 }));
  return design;
}

function main() {
  const front = { activePlacement: FRONT, selectedLayerId: null };

  console.log("\n1. Resizing by instruction");
  {
    const design = twoSided();
    const ops = operationsFor("make it 20% smaller", design, front)!;
    check("a percentage is read as a factor", ops, [
      { kind: "scale", factor: 0.8, placement: FRONT, layerId: "front-1" },
    ]);
    // 20% SMALLER IS 0.8, NOT 0.2. Reading the number as the factor would
    // shrink a logo to a fifth of itself on somebody's chest.
    const applied = applyAll(design, ops);
    check("and applied it is four fifths", layersOn(applied, FRONT)[0].width, 0.48);

    check("bigger goes the other way",
      operationsFor("make it 25% bigger", design, front)![0],
      { kind: "scale", factor: 1.25, placement: FRONT, layerId: "front-1" });
    // A bare "smaller" still means something, and a sensible amount.
    check("a bare smaller has a default", operationsFor("smaller", design, front)![0],
      { kind: "scale", factor: 0.8, placement: FRONT, layerId: "front-1" });
    check("so does bigger", operationsFor("bigger please", design, front)![0],
      { kind: "scale", factor: 1.25, placement: FRONT, layerId: "front-1" });
    check("and 'percent' spelled out reads the same", operationsFor("20 percent smaller", design, front)![0],
      { kind: "scale", factor: 0.8, placement: FRONT, layerId: "front-1" });
  }

  console.log("\n2. Which side an instruction is about");
  {
    const design = twoSided();
    // ============ A NAMED SIDE WINS OVER WHAT IS ON SCREEN ============
    // "Make the back graphic smaller" is about the back even while the front
    // is showing. Acting on the visible side would silently edit the wrong one.
    const ops = operationsFor("make the back graphic 20% smaller", design, front)!;
    check("naming the back targets the back", ops[0].placement, BACK);
    check("and the back's own layer", ops[0].layerId, "back-1");

    check("naming the front targets the front",
      operationsFor("centre the front logo", design, front)![0].placement, FRONT);
    // With nothing named, the side being looked at is the right default.
    check("saying neither uses the side on screen",
      operationsFor("centre it", design, { activePlacement: BACK, selectedLayerId: null })![0].placement, BACK);
  }

  console.log("\n3. Which artwork, and when it refuses to choose");
  {
    let design = emptyDesign("p1");
    design = addLayer(design, FRONT, layer({ id: "a" }));
    check("one layer needs no selection",
      operationsFor("smaller", design, front)![0].layerId, "a");

    design = addLayer(design, FRONT, layer({ id: "b" }));
    // ============ AMBIGUOUS IS NOT A GUESS ===========================
    // Two graphics and nothing selected means "the graphic" names neither.
    // Picking one would be a coin toss on somebody's product.
    check("two layers and no selection refuses", operationsFor("smaller", design, front), null);
    check("but a selection resolves it",
      operationsFor("smaller", design, { activePlacement: FRONT, selectedLayerId: "b" })![0].layerId, "b");
    // A selection on the OTHER side is not a selection on this one.
    check("a selection from another side does not carry over",
      operationsFor("make the back smaller", twoSided(), { activePlacement: FRONT, selectedLayerId: "front-1" })![0]
        .layerId,
      "back-1");
  }

  console.log("\n4. The rest of the direct manipulations");
  {
    const design = twoSided();
    check("centre", operationsFor("centre it", design, front)![0],
      { kind: "centre", axis: "both", placement: FRONT, layerId: "front-1" });
    check("centre horizontally only", operationsFor("centre it horizontally", design, front)![0],
      { kind: "centre", axis: "x", placement: FRONT, layerId: "front-1" });
    check("American spelling works too", operationsFor("center it", design, front)![0].kind, "centre");

    // "Flip it" with no axis means mirrored, which is what everybody who is
    // not thinking in coordinates means.
    check("flip defaults to horizontal", operationsFor("flip it", design, front)![0],
      { kind: "flip", axis: "x", placement: FRONT, layerId: "front-1" });
    {
      // Narrowed rather than asserted through, so a future change of shape is
      // a compile error here instead of a silent undefined.
      const op = operationsFor("flip it vertically", design, front)![0];
      check("flip vertically when asked", op.kind === "flip" && op.axis, "y");
    }

    check("rotate defaults to a quarter turn", operationsFor("rotate it", design, front)![0],
      { kind: "rotate", degrees: 90, placement: FRONT, layerId: "front-1" });
    {
      const op = operationsFor("rotate it 45 degrees", design, front)![0];
      check("a stated angle is used", op.kind === "rotate" && op.degrees, 45);
    }
    {
      const op = operationsFor("rotate it -30 degrees", design, front)![0];
      check("and a negative one", op.kind === "rotate" && op.degrees, -30);
    }

    check("remove", operationsFor("remove it", design, front)![0].kind, "remove");
    check("delete means the same", operationsFor("delete the front logo", design, front)![0].kind, "remove");

    for (const [phrase, dy] of [["move it up", -0.05], ["move it down", 0.05]] as const) {
      const op = operationsFor(phrase, design, front)![0];
      check(`${phrase}`, op.kind === "move" && op.dy, dy);
    }
    const left = operationsFor("nudge it left", design, front)![0];
    check("and left", left.kind === "move" && left.dx, -0.05);
  }

  console.log("\n5. What it refuses to understand");
  {
    const design = twoSided();
    // ============ THE REFUSALS ARE THE POINT ==========================
    // These are questions for J4, not instructions. A parser that answered
    // them by matching a word would be worse than one that declines.
    for (const phrase of [
      "what do you think?",
      "would this look better on a heavyweight hoodie?",
      "give me three variations of this",
      "make it pop",
      "",
      "   ",
    ]) {
      check(`"${phrase}" is not a direct manipulation`, operationsFor(phrase, design, front), null);
    }

    // And an instruction about a side with no artwork has nothing to act on.
    const frontOnly = addLayer(emptyDesign("p1"), FRONT, layer());
    check("an empty side has nothing to resize",
      operationsFor("make the back smaller", frontOnly, front), null);
  }

  console.log("\n6. Operations are total, and never throw");
  {
    const design = twoSided();
    // A layer that is not there is a no-op. A UI can emit one after a delete
    // and must not take the page down with it.
    const gone = applyOperation(design, { kind: "scale", placement: FRONT, layerId: "nope", factor: 0.5 });
    check("an unknown layer changes nothing", JSON.stringify(gone), JSON.stringify(design));
    const noSide = applyOperation(design, { kind: "move", placement: "sleeve", layerId: "x", dx: 1, dy: 1 });
    check("an unknown placement changes nothing", JSON.stringify(noSide), JSON.stringify(design));

    // Applying a list applies them in order.
    const chained = applyAll(design, [
      { kind: "scale", placement: FRONT, layerId: "front-1", factor: 0.5 },
      { kind: "centre", placement: FRONT, layerId: "front-1", axis: "both" },
    ]);
    const l = layersOn(chained, FRONT)[0];
    check("chained operations compose", [l.width, Math.round(l.x * 1000) / 1000], [0.3, 0.35]);
  }

  console.log("\n7. Saying what happened");
  {
    // The owner sees what changed, so an instruction that did the wrong thing
    // is visible rather than mysterious — and undoable.
    check("a shrink is described in percent",
      describeOperation({ kind: "scale", placement: BACK, layerId: "b", factor: 0.8 }),
      "Made the back artwork 20% smaller");
    check("and a grow", describeOperation({ kind: "scale", placement: FRONT, layerId: "f", factor: 1.25 }),
      "Made the front artwork 25% bigger");
    check("a flip names its axis",
      describeOperation({ kind: "flip", placement: FRONT, layerId: "f", axis: "y" }),
      "Flipped the front artwork vertically");
    check("a rotation names its angle",
      describeOperation({ kind: "rotate", placement: BACK, layerId: "b", degrees: 45 }),
      "Rotated the back artwork 45°");
    check("a removal says so",
      describeOperation({ kind: "remove", placement: BACK, layerId: "b" }), "Removed the back artwork");
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
