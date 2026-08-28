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
}

/**
 * The same image, served from our own origin.
 *
 * A CSS mask-image from another origin is subject to CORS, and Printful's CDN
 * does not allow it — so the mask silently did nothing and the colour fill
 * kept its rectangle, painting the room instead of the garment. Silently is
 * the point: a failed mask does not error, it just stops masking.
 */
function sameOrigin(url: string, colorHex: string | null): string {
  const colour = colorHex ? `&color=${encodeURIComponent(colorHex)}` : "";
  return `/api/creation/blank?url=${encodeURIComponent(url)}${colour}`;
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
}: BlankOnColorProps) {
  if (!usesRealBlank(blankUrl) || blankUrl === null) {
    // NOT the manufacturer's product, and not dressed up as one.
    return <CreatableArt id={creatableId} className={className} />;
  }

  return (
    // ============ ONE IMAGE. THE COMPOSITION HAPPENS ON THE SERVER =======
    //
    // This used to be a colour fill masked to the image's alpha with the image
    // multiplied on top — three CSS mechanisms stacked, and every one of them
    // wrong for what these files actually are.
    //
    // The trace settled it: Printful's blank is a SHADING LAYER. Its
    // background is opaque white and its garment is about 10% opaque grey. So
    // masking by alpha selected the background instead of the garment, and
    // multiplying over a 10%-opaque layer could only tint the few bright
    // pixels in it — which is precisely why the drawstrings changed colour and
    // nothing else did.
    //
    // /api/creation/blank composes it properly now: the colour goes under the
    // shading and the opacity is inverted, so what arrives here is the real
    // Gildan blank, whole, in a colour Printful manufactures, on transparency.
    // Nothing is left for CSS to do.
    /* eslint-disable-next-line @next/next/no-img-element -- proxied supplier CDN */
    <img
      src={sameOrigin(blankUrl, colorHex)}
      alt=""
      draggable={false}
      className={`${className ?? ""} object-contain`}
      // ============ SO A BLACK GARMENT IS NOT A BLACK ROOM ==============
      //
      // Sean: "when the garment color is Black, the hoodie essentially
      // disappears against the dark background."
      //
      // The composition is not wrong — a black hoodie composes to rgb(25,25,25)
      // and that is what one looks like. The room is rgb(11,12,14). Fourteen
      // levels of separation, where Charcoal gets 71 and White gets 234.
      //
      // A backdrop cannot fix that: anything light enough to show Black would
      // swallow Charcoal. What separates any colour from any ground is an EDGE,
      // and drop-shadow follows the image's own alpha — so this traces the
      // garment's silhouette rather than drawing a box behind it.
      //
      // Two shadows: a tight one for the edge, a wide one for ambient lift.
      // Invisible against a white garment, which is why it can be unconditional.
      style={{
        filter:
          "drop-shadow(0 0 1px rgba(255,255,255,0.55)) drop-shadow(0 0 16px rgba(255,255,255,0.20))",
      }}
    />
  );
}
