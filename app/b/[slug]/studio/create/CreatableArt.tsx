// THE PRODUCTS THEMSELVES, RENDERED.
//
// ============ WHY THESE EXIST AT ALL ====================================
//
// Sean, twice. First: "I don't want squares representing products. I want the
// actual products floating there." Then, on the silhouettes that replaced the
// squares: "realistic, generic WHITE product images — they should look like
// actual products someone could choose and customize, not outlines,
// silhouettes, or abstract cards."
//
// So these are white blanks with shading, not filled shapes. Each has a body
// tone, a shadow side, a highlight, and the seams or folds that make the eye
// read cotton rather than a symbol. A T-shirt reads as a T-shirt from across
// the carousel without anybody reading a word — which was the requirement all
// along, and a solid black shape does not meet it.
//
// ============ WHY DRAWN RATHER THAN PHOTOGRAPHS =========================
//
// A supplier photograph is better and is always used when there is one. These
// are for the case that exists before any supplier is connected — the portal
// opens on intention, so there has to be a real object there first.
//
// Drawn also means they are white on any background, tint with the space
// around them, scale to any size, and cost nothing to load. An image file
// would need licensing, a CDN round trip, and a second copy per state.
//
// ============ THE SHADING IS THREE TONES, NOT A GRADIENT MESH ===========
//
// Light from the upper left, as it is everywhere else in this space. Body,
// shade, highlight — enough to give volume, few enough that all five products
// look like they were photographed together rather than drawn by five people.
//
// Each one is judged at carousel size, not at full size, because that is where
// it is read. Two failed that check and were redrawn: a hoodie with short
// sleeves and a small hood is a T-shirt with a pocket, and a cap with a brim
// all the way round is a bucket hat.

const BODY = "#F2F3F5";
const SHADE = "#C9CCD2";
const DEEP = "#A8ADB6";
const LINE = "#8E949E";

export function CreatableArt({ id, className }: { id: string; className?: string }) {
  const Art = ART[id] ?? GenericArt;
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" focusable="false">
      <Art />
    </svg>
  );
}

/** Whether this creatable has a rendering of its own, for callers that care. */
export function hasArt(id: string): boolean {
  return id in ART;
}

function TShirtArt() {
  return (
    <>
      {/* Body and short sleeves in one outline, the way a tee is actually cut. */}
      <path
        d="M66 34 L84 26 C92 40 108 40 116 26 L134 34 L176 58 L158 92 L140 82 L140 172 C114 178 86 178 60 172 L60 82 L42 92 L24 58 Z"
        fill={BODY}
      />
      {/* The shaded half, so it has a lit side and a dark side. */}
      <path d="M100 33 L116 26 L134 34 L176 58 L158 92 L140 82 L140 172 C127 175 113 176 100 176 Z" fill={SHADE} />
      {/* Armhole seams. Straight, following the cut — the curled version of
          these read as hooks under the arms rather than as stitching. */}
      <path d="M60 84 L47 89" stroke={LINE} strokeWidth="1.6" opacity="0.6" />
      <path d="M140 84 L153 89" stroke={LINE} strokeWidth="1.6" opacity="0.6" />
      {/* Collar, drawn as a ribbed band rather than a hole. */}
      <path d="M84 26 C92 40 108 40 116 26 C110 34 90 34 84 26 Z" fill={DEEP} />
      <path d="M82 28 C92 44 108 44 118 28" fill="none" stroke={LINE} strokeWidth="2.4" />
      {/* Hem. */}
      <path d="M60 168 C86 174 114 174 140 168" fill="none" stroke={LINE} strokeWidth="1.6" opacity="0.6" />
      {/* A fold, so the fabric is not flat. */}
      <path d="M92 96 C90 122 94 148 92 168" fill="none" stroke={SHADE} strokeWidth="2" opacity="0.8" />
    </>
  );
}

function HoodieArt() {
  return (
    <>
      {/* THE HOOD, BEHIND EVERYTHING. Big enough to read as a hood at carousel
          size — the first version was a small dome behind the collar, which
          from a distance was just a T-shirt with a pocket. */}
      <path d="M70 62 C66 16 134 16 130 62 C116 74 84 74 70 62 Z" fill={SHADE} />
      <path d="M70 62 C66 16 134 16 130 62" fill="none" stroke={LINE} strokeWidth="2" />
      <path d="M82 60 C84 34 116 34 118 60 C110 68 90 68 82 60 Z" fill={DEEP} />

      {/* LONG SLEEVES, which is the other half of the difference. They hang to
          hip level and end in ribbed cuffs. */}
      <path d="M64 58 L32 82 L26 150 L56 158 L62 104 Z" fill={BODY} />
      <path d="M136 58 L168 82 L174 150 L144 158 L138 104 Z" fill={SHADE} />

      {/* Body. */}
      <path d="M64 58 L136 58 L142 178 L58 178 Z" fill={BODY} />
      <path d="M100 58 L136 58 L142 178 L100 178 Z" fill={SHADE} />

      {/* Cuffs and hem, ribbed — a sleeve that simply stops reads as cut off. */}
      <path d="M27 143 L57 151" stroke={LINE} strokeWidth="2" opacity="0.75" />
      <path d="M173 143 L143 151" stroke={LINE} strokeWidth="2" opacity="0.75" />
      <path d="M58 168 L142 168" stroke={LINE} strokeWidth="2" opacity="0.7" />

      {/* Kangaroo pocket. */}
      <path d="M74 122 L126 122 L126 154 L80 154 Z" fill="none" stroke={LINE} strokeWidth="2.2" />
      <path d="M74 122 L126 122" stroke={DEEP} strokeWidth="2.2" />

      {/* Drawstrings. */}
      <path d="M92 66 L90 100 M108 66 L110 100" stroke={LINE} strokeWidth="3" strokeLinecap="round" />
      <circle cx="90" cy="102" r="2.8" fill={DEEP} />
      <circle cx="110" cy="102" r="2.8" fill={DEEP} />
    </>
  );
}

function HatArt() {
  return (
    // A cap is wide and shallow, so drawn at the same scale as the garments it
    // sits noticeably smaller in the carousel. Scaled about its own centre —
    // which is not the middle of the box, because the brim is all on one side.
    <g transform="translate(100 100) scale(1.14) translate(-94.5 -102)">
      {/* A CAP, SEEN FROM THE SIDE. The brim projects forward rather than all
          the way round: a brim on every side is a bucket hat, which is what
          the first version drew.

          THE BRIM IS DRAWN FIRST, so the crown covers where it joins. Drawn
          the other way round, the brim cut across the crown and the whole
          thing read as a dome sitting behind a separate flap. */}
      <path d="M98 112 C72 108 44 115 32 127 C26 133 30 140 39 141 C63 144 86 133 98 122 Z" fill={BODY} />
      <path d="M32 127 C26 133 30 140 39 141 C63 144 86 133 98 122 C82 134 58 140 32 127 Z" fill={SHADE} />

      {/* Crown, over the join, and wider than the brim is long — a brim that
          rivals the crown for width is a duck bill, not a cap. */}
      <path d="M58 118 C58 60 162 60 162 118 Z" fill={BODY} />
      <path d="M110 61 C142 63 162 86 162 118 L110 118 Z" fill={SHADE} />

      {/* Panel seams, because a cap is made of panels. */}
      <path d="M110 61 L110 118" stroke={LINE} strokeWidth="1.6" opacity="0.7" />
      <path d="M82 68 C87 88 89 106 89 118" fill="none" stroke={LINE} strokeWidth="1.5" opacity="0.5" />
      <path d="M138 68 C133 88 131 106 131 118" fill="none" stroke={LINE} strokeWidth="1.5" opacity="0.5" />
      <circle cx="110" cy="62" r="5.5" fill={DEEP} />

      {/* Sweatband, where the crown meets the brim. */}
      <path d="M58 117 L162 117" stroke={LINE} strokeWidth="2.4" opacity="0.8" />
    </g>
  );
}

function BagArt() {
  return (
    <>
      {/* Handles behind the body. */}
      <path d="M72 80 C72 40 128 40 128 80" fill="none" stroke={SHADE} strokeWidth="10" strokeLinecap="round" />
      <path d="M72 80 C72 45 128 45 128 80" fill="none" stroke={BODY} strokeWidth="4.5" strokeLinecap="round" />

      {/* A TOTE, nearly straight-sided. Flaring outward towards the bottom, as
          the first version did, reads as a bucket rather than a bag. */}
      <path d="M48 76 L152 76 L146 178 L54 178 Z" fill={BODY} />
      <path d="M100 76 L152 76 L146 178 L100 178 Z" fill={SHADE} />

      {/* Top seam and a fold, so the canvas has weight. */}
      <path d="M48 76 L152 76" stroke={LINE} strokeWidth="2.2" />
      <path d="M50 86 L150 86" stroke={LINE} strokeWidth="1.6" opacity="0.6" />
      <path d="M84 94 C82 126 86 154 84 174" fill="none" stroke={DEEP} strokeWidth="1.8" opacity="0.5" />
    </>
  );
}

function MugArt() {
  return (
    <>
      {/* Handle behind the body. */}
      <path d="M132 86 C168 86 168 140 132 140" fill="none" stroke={SHADE} strokeWidth="13" strokeLinecap="round" />
      <path d="M132 90 C160 90 160 136 132 136" fill="none" stroke={BODY} strokeWidth="5" strokeLinecap="round" />
      {/* Body, tapering slightly like a real mug rather than a cylinder. */}
      <path d="M46 62 L134 62 L127 158 C126 166 119 170 110 170 L70 170 C61 170 54 166 53 158 Z" fill={BODY} />
      <path d="M96 62 L134 62 L127 158 C126 166 119 170 110 170 L96 170 Z" fill={SHADE} />
      {/* The rim, which is what makes it an open vessel. */}
      <ellipse cx="90" cy="62" rx="44" ry="10" fill={SHADE} />
      <ellipse cx="90" cy="62" rx="44" ry="10" fill="none" stroke={LINE} strokeWidth="2" />
      <ellipse cx="90" cy="62" rx="35" ry="6.5" fill={DEEP} />
      {/* A highlight down the lit side. */}
      <path d="M64 80 C62 108 63 134 66 156" fill="none" stroke="#FFFFFF" strokeWidth="4" opacity="0.75" />
    </>
  );
}

/**
 * Anything not rendered yet.
 *
 * A soft white solid rather than a question mark or a label: this is what
 * appears in a space full of objects, and it should look like one of them.
 */
function GenericArt() {
  return (
    <>
      <rect x="42" y="42" width="116" height="116" rx="26" fill={BODY} />
      <path d="M100 42 H132 A26 26 0 0 1 158 68 V132 A26 26 0 0 1 132 158 H100 Z" fill={SHADE} />
    </>
  );
}

const ART: Record<string, () => React.ReactElement> = {
  "t-shirt": TShirtArt,
  hoodie: HoodieArt,
  hat: HatArt,
  bag: BagArt,
  mug: MugArt,
};
