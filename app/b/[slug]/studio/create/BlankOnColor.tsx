import { CreatableArt } from "./CreatableArt";

// THE SUPPLIER'S BLANK, IN THE COLOUR THEY MAKE IT.
//
// ============ THE WHOLE ARCHITECTURE, IN THREE LAYERS ====================
//
// Sean: "Real supplier product → transparent blank → actual supplier color
// underneath → artwork on top. No generated garment should be used when
// Printful provides the real blank."
//
// Printful's own documentation for its blank imagery says how: those images
// are "transparent and require the developer to overlay them on top of the
// color defined on the resource". The blank carries the shading, folds, seams,
// highlights and shadows as semi-transparent greys; the COLOUR is painted
// behind it and shows through them.
//
// That is why one image serves every colour the manufacturer actually makes,
// and why a colour choice here can never be a colour Printful does not stock:
// the hex comes off the variant, not off a picker.
//
// ============ WHY THE COLOUR IS A DIV AND NOT A FILTER ==================
//
// Tinting a photograph with a CSS filter would wash the shadows out with it
// and produce a colour nobody can order. A flat fill behind a transparent
// image keeps the garment's own light intact — a navy hoodie is the same
// folds, darker, exactly as the manufacturer photographed it.
//
// ============ AND WHEN THE SUPPLIER HAS NO BLANK ========================
//
// Sean: "don't silently pretend a Genesis drawing is the manufacturer's
// product."
//
// A null blankUrl falls back to the drawn object, which is honest as a
// PICTURE and silent as a CLAIM — nothing in the pixels says whose it is. So
// saying that is the caller's job, next to wherever this is rendered, and
// `usesRealBlank` exists to make that decision explicit rather than inferred
// from a URL being truthy in three different places.

export interface BlankOnColorProps {
  /** Printful's transparent blank for this placement, or null if they have none. */
  blankUrl: string | null;
  /** The hex the supplier declares for the chosen colour. */
  colorHex: string | null;
  /** For the drawn fallback, when there is no blank. */
  creatableId: string;
  className?: string;
  /** Rendered behind everything; the room shows through where the blank does not. */
  transparent?: boolean;
}

/**
 * The same image, served from our own origin.
 *
 * A CSS mask-image from another origin is subject to CORS, and Printful's CDN
 * does not allow it — so the mask silently did nothing and the colour fill
 * kept its rectangle, painting the room instead of the garment. Silently is
 * the point: a failed mask does not error, it just stops masking.
 */
function sameOrigin(url: string): string {
  return `/api/creation/blank?url=${encodeURIComponent(url)}`;
}

/** Whether a blank shown for these inputs is the supplier's or ours. */
export function usesRealBlank(blankUrl: string | null): boolean {
  return blankUrl !== null && blankUrl !== "";
}

export function BlankOnColor({
  blankUrl,
  colorHex,
  creatableId,
  className,
  transparent = true,
}: BlankOnColorProps) {
  if (!usesRealBlank(blankUrl) || blankUrl === null) {
    // NOT the manufacturer's product, and not dressed up as one.
    return <CreatableArt id={creatableId} className={className} />;
  }

  return (
    // ISOLATED, so the multiply below blends with the colour inside this
    // group and NOT with whatever the page is painted. Without this the
    // garment multiplies against the Creation Station's near-black room and
    // disappears — a blend mode is only ever as good as its backdrop.
    <span className={`relative block ${className ?? ""}`} style={{ isolation: "isolate" }}>
      {/* THE COLOUR, BEHIND. Masked to the blank's own alpha so it colours the
          garment and not the rectangle the image arrives in — without this the
          fill is a coloured square, which is the exact thing this replaces.

          The mask is the blank itself: where the image is opaque the colour
          shows, where it is transparent the room does. */}
      {colorHex ? (
        <span
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            backgroundColor: colorHex,
            WebkitMaskImage: `url(${sameOrigin(blankUrl)})`,
            maskImage: `url(${sameOrigin(blankUrl)})`,
            WebkitMaskSize: "contain",
            maskSize: "contain",
            WebkitMaskRepeat: "no-repeat",
            maskRepeat: "no-repeat",
            WebkitMaskPosition: "center",
            maskPosition: "center",
          }}
        />
      ) : null}

      {/* THE BLANK, ON TOP, MULTIPLIED.
          Multiply is chosen because it is correct for both shapes Printful's
          blanks could take, and I have not seen a real one:

            - an opaque white garment carrying grey shading — white multiplied
              by the colour IS the colour, and the greys become its shadows;
            - shading held in the alpha channel — multiply applies only where
              the image is opaque, which is the garment.

          Normal compositing is right for the second and wrong for the first:
          it would paint a white garment whatever colour was chosen, silently,
          for every product. Multiply cannot fail that way. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- supplier CDN, no remotePatterns */}
      <img
        src={sameOrigin(blankUrl)}
        alt=""
        draggable={false}
        className="relative h-full w-full object-contain"
        style={colorHex ? { mixBlendMode: "multiply" } : undefined}
      />

      {/* Nothing is painted where the blank is not: no card, no ground, no
          rectangle. `transparent` exists so a light surface can opt out. */}
      {transparent ? null : <span aria-hidden="true" className="absolute inset-0 -z-10 bg-white" />}
    </span>
  );
}
