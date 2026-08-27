import {
  centreLayer,
  flipLayer,
  moveLayer,
  removeLayer,
  rotateLayer,
  scaleLayer,
  layersOn,
  type PlacementId,
  type ProductDesign,
} from "./design";

// WHAT CAN BE DONE TO A DESIGN, AS DATA.
//
// ============ WHY THE OPERATIONS ARE A LIST AND NOT A SET OF FUNCTIONS ===
//
// The owner drags artwork with a pointer. J4 is asked to make the back graphic
// twenty percent smaller. Both have to end in the same place, or the two are
// separate editors that happen to share a canvas — and the one J4 drives would
// drift from the one the person uses.
//
// So every change is a NAMED OPERATION with a payload. The pointer emits them,
// J4 emits them, undo stores the design they produced. There is one path.
//
// PURE, and deliberately not a model call. "Make it 20% smaller" does not need
// a language model and should not wait on one — it is a scale by 0.8, and
// answering it instantly and identically every time is better than answering it
// eventually and approximately. What genuinely needs J4 is judgement: whether
// this looks right, what else to try, what a heavyweight hoodie would do to it.
// That is a conversation, and it is not this file.

export type DesignOperation =
  | { kind: "move"; placement: PlacementId; layerId: string; dx: number; dy: number }
  | { kind: "scale"; placement: PlacementId; layerId: string; factor: number }
  | { kind: "flip"; placement: PlacementId; layerId: string; axis: "x" | "y" }
  | { kind: "rotate"; placement: PlacementId; layerId: string; degrees: number }
  | { kind: "centre"; placement: PlacementId; layerId: string; axis: "x" | "y" | "both" }
  | { kind: "remove"; placement: PlacementId; layerId: string };

/** Apply one operation. Total: an unknown layer is a no-op, never a throw. */
export function applyOperation(design: ProductDesign, op: DesignOperation): ProductDesign {
  switch (op.kind) {
    case "move":
      return moveLayer(design, op.placement, op.layerId, op.dx, op.dy);
    case "scale":
      return scaleLayer(design, op.placement, op.layerId, op.factor);
    case "flip":
      return flipLayer(design, op.placement, op.layerId, op.axis);
    case "rotate":
      return rotateLayer(design, op.placement, op.layerId, op.degrees);
    case "centre":
      return centreLayer(design, op.placement, op.layerId, op.axis);
    case "remove":
      return removeLayer(design, op.placement, op.layerId);
  }
}

export function applyAll(design: ProductDesign, ops: DesignOperation[]): ProductDesign {
  return ops.reduce(applyOperation, design);
}

// ============ WHAT SOMEBODY TYPED, AS OPERATIONS =========================

/** Which side a phrase is about, or null when it does not say. */
function placementIn(text: string): PlacementId | null {
  if (/\bback\b/i.test(text)) return "back";
  if (/\bfront\b/i.test(text)) return "front";
  return null;
}

/**
 * The operations a plain instruction means, or null when it means none.
 *
 * NULL IS THE IMPORTANT RETURN. This understands a deliberately small set of
 * direct manipulations — smaller, bigger, centre, flip, rotate, remove — and
 * everything else is not its business. "Would this look better on a heavyweight
 * hoodie?" is a question for J4, and a parser that answered it by matching the
 * word "hoodie" would be worse than one that declines.
 *
 * PURE, so every phrasing below is provable, and free, so a direct instruction
 * never waits on a model.
 */
export function operationsFor(
  instruction: string,
  design: ProductDesign,
  context: { activePlacement: PlacementId; selectedLayerId: string | null },
): DesignOperation[] | null {
  const text = instruction.trim().toLowerCase();
  if (!text) return null;

  // Which side, and which artwork on it. A phrase naming a side wins over
  // whatever happens to be on screen — "make the back graphic smaller" is
  // about the back even while the front is showing.
  const placement = placementIn(text) ?? context.activePlacement;
  const layers = layersOn(design, placement);
  if (layers.length === 0) return null;

  // The selected layer when the instruction is about "it" and the selection is
  // on this side; otherwise the only layer there, if there is only one.
  const selected =
    context.selectedLayerId && layers.some((l) => l.id === context.selectedLayerId)
      ? context.selectedLayerId
      : layers.length === 1
        ? layers[0].id
        : null;
  // AMBIGUOUS IS NOT A GUESS. Two graphics on the back and nothing selected
  // means "the back graphic" names neither of them.
  if (!selected) return null;

  // DISTRIBUTIVE, so each member of the union keeps its own payload. A plain
  // Omit over a union collapses to the fields they all share, which is only
  // `kind` — and every operation then looks like it takes no arguments.
  type WithoutTarget<T> = T extends unknown ? Omit<T, "placement" | "layerId"> : never;
  const each = (op: WithoutTarget<DesignOperation>): DesignOperation[] => [
    { ...op, placement, layerId: selected } as DesignOperation,
  ];

  // A percentage, where one was given. "20% smaller" is 0.8, not 0.2.
  const percent = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/);
  const amount = percent ? Number(percent[1]) / 100 : null;

  if (/\b(smaller|shrink|reduce|scale down)\b/.test(text)) {
    return each({ kind: "scale", factor: amount !== null ? 1 - amount : 0.8 });
  }
  if (/\b(bigger|larger|grow|enlarge|scale up)\b/.test(text)) {
    return each({ kind: "scale", factor: amount !== null ? 1 + amount : 1.25 });
  }
  if (/\b(centre|center)\b/.test(text)) {
    const axis = /horizontal/.test(text) ? "x" : /vertical/.test(text) ? "y" : "both";
    return each({ kind: "centre", axis });
  }
  if (/\bflip\b/.test(text)) {
    // "flip it" with no axis means horizontally, which is what a mirrored
    // graphic means to everybody who is not thinking about coordinates.
    const axis = /vertical|upside/.test(text) ? "y" : "x";
    return each({ kind: "flip", axis });
  }
  if (/\b(rotate|turn|spin)\b/.test(text)) {
    const degrees = text.match(/(-?\d+(?:\.\d+)?)\s*(?:deg|degrees|°)/);
    return each({ kind: "rotate", degrees: degrees ? Number(degrees[1]) : 90 });
  }
  if (/\b(remove|delete|get rid of|take off)\b/.test(text)) {
    return each({ kind: "remove" });
  }

  // Nudges, which are the one case where a direction is the whole instruction.
  const nudge = 0.05;
  if (/\b(up|higher|raise)\b/.test(text)) return each({ kind: "move", dx: 0, dy: -nudge });
  if (/\b(down|lower|drop)\b/.test(text)) return each({ kind: "move", dx: 0, dy: nudge });
  if (/\bleft\b/.test(text)) return each({ kind: "move", dx: -nudge, dy: 0 });
  if (/\bright\b/.test(text)) return each({ kind: "move", dx: nudge, dy: 0 });

  return null;
}

/** What an operation did, in words, for the owner to see and undo. */
export function describeOperation(op: DesignOperation): string {
  const side = op.placement === "back" ? "back" : "front";
  switch (op.kind) {
    case "move":
      return `Moved the ${side} artwork`;
    case "scale":
      return op.factor < 1
        ? `Made the ${side} artwork ${Math.round((1 - op.factor) * 100)}% smaller`
        : `Made the ${side} artwork ${Math.round((op.factor - 1) * 100)}% bigger`;
    case "flip":
      return `Flipped the ${side} artwork ${op.axis === "x" ? "horizontally" : "vertically"}`;
    case "rotate":
      return `Rotated the ${side} artwork ${op.degrees}°`;
    case "centre":
      return `Centred the ${side} artwork`;
    case "remove":
      return `Removed the ${side} artwork`;
  }
}
