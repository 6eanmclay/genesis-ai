// THE PRODUCTS THEMSELVES, DRAWN.
//
// ============ WHY THESE EXIST AT ALL ====================================
//
// Sean, on the first portal: "I don't want squares representing products. I
// want the actual products floating there." And the part that decides the
// shape of this file — "the product itself should communicate what it is. The
// text underneath can reinforce it, but I shouldn't have to read T-shirt to
// know I'm looking at a T-shirt."
//
// A supplier photograph is the best answer and is used whenever there is one.
// But the portal deliberately opens before any supplier is connected, because
// what it asks is about intention — so there has to be a real object when no
// photograph exists, and a labelled rectangle is not one.
//
// So: silhouettes. Not icons in a box, not line art at icon weight — solid
// forms at the size a product would occupy, so a hoodie reads as a hoodie from
// across the carousel without anybody reading a word.
//
// ============ WHY THEY ARE DRAWN RATHER THAN FILES ======================
//
// They carry no colour of their own. `currentColor` means the portal decides
// how lit each one is by how close it is to focus, which is what makes depth
// work — an image file would need a second copy per state, and would stop
// being tintable the moment the visual language moved.
//
// UNKNOWN IS A REAL CASE. A creatable with no drawing falls back to a generic
// solid, never to a label in a rectangle: the fallback for "we have not drawn
// this yet" should still look like an object in a space.

export function CreatableArt({ id, className }: { id: string; className?: string }) {
  const Art = ART[id] ?? GenericArt;
  return (
    <svg
      viewBox="0 0 200 200"
      className={className}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <Art />
    </svg>
  );
}

/** Whether this creatable has a drawing of its own, for callers that care. */
export function hasArt(id: string): boolean {
  return id in ART;
}

function TShirtArt() {
  return (
    <path d="M66 34 L84 26 C92 40 108 40 116 26 L134 34 L176 58 L158 92 L140 82 L140 172 C114 178 86 178 60 172 L60 82 L42 92 L24 58 Z" />
  );
}

function HoodieArt() {
  return (
    <>
      {/* Body, cut a little heavier than the tee so the two read differently
          at a glance rather than only up close. */}
      <path d="M64 46 L84 36 C92 52 108 52 116 36 L136 46 L178 70 L160 104 L142 94 L142 176 C114 182 86 182 58 176 L58 94 L40 104 L22 70 Z" />
      {/* The hood, which is the one silhouette difference that matters. */}
      <path d="M82 36 C86 14 114 14 118 36 C110 48 90 48 82 36 Z" />
      {/* Pocket, drawn as a cut-out so it reads on a solid body. */}
      <path
        d="M74 128 L126 128 L126 158 L74 158 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="5"
        opacity="0.45"
      />
      {/* Drawstrings. Small, and the thing that makes it unmistakable. */}
      <path
        d="M92 46 L90 74 M108 46 L110 74"
        stroke="currentColor"
        strokeWidth="5"
        strokeLinecap="round"
        opacity="0.55"
      />
    </>
  );
}

function HatArt() {
  return (
    <>
      {/* Crown. */}
      <path d="M36 130 C36 72 64 46 100 46 C136 46 164 72 164 130 Z" />
      {/* Brim, wider than the crown so the profile reads as a cap rather than
          a dome. */}
      <path d="M28 130 C28 146 60 154 100 154 C140 154 172 146 172 130 C172 122 140 118 100 118 C60 118 28 122 28 130 Z" />
      <circle cx="100" cy="50" r="7" />
    </>
  );
}

function BagArt() {
  return (
    <>
      {/* Handles first, so the body sits over them where they meet. */}
      <path
        d="M74 78 C74 42 126 42 126 78"
        fill="none"
        stroke="currentColor"
        strokeWidth="9"
        strokeLinecap="round"
      />
      {/* A tote, tapering outward — a straight rectangle reads as a box. */}
      <path d="M46 74 L154 74 L166 178 L34 178 Z" />
    </>
  );
}

function MugArt() {
  return (
    <>
      {/* Handle behind the body. */}
      <path
        d="M132 84 C166 84 166 138 132 138"
        fill="none"
        stroke="currentColor"
        strokeWidth="12"
        strokeLinecap="round"
      />
      <path d="M46 60 L134 60 L127 158 C126 166 119 170 110 170 L70 170 C61 170 54 166 53 158 Z" />
      {/* The rim, so it reads as an open vessel rather than a solid block. */}
      <ellipse cx="90" cy="60" rx="44" ry="10" fill="none" stroke="currentColor" strokeWidth="5" opacity="0.5" />
    </>
  );
}

/**
 * Anything not drawn yet.
 *
 * A soft solid rather than a question mark or a label: this is what appears in
 * a space full of objects, and it should look like one of them.
 */
function GenericArt() {
  return <rect x="42" y="42" width="116" height="116" rx="26" />;
}

const ART: Record<string, () => React.ReactElement> = {
  "t-shirt": TShirtArt,
  hoodie: HoodieArt,
  hat: HatArt,
  bag: BagArt,
  mug: MugArt,
};
