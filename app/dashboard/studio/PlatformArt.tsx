// WHAT YOU ARE MAKING, NOT WHOSE LOGO IT IS.
//
// ============ WHY THESE ARE NOT PLATFORM LOGOS (2026-08-28) ============
//
// Sean: "Each platform should have its own visual identity/presentation
// appropriate to what the user is creating there, while still feeling like one
// Genesis system."
//
// The obvious reading is "draw the four logos". Two reasons not to.
//
// The first is the product one, and it is the same argument CreatableArt makes:
// the objects in this room are THE THING BEING MADE. A hoodie floats there
// because you are making a hoodie. What you make for Instagram is not the
// Instagram mark — it is a square post. For TikTok it is a vertical video. For
// X it is a short line of text. For Facebook it is a card people reply to. Draw
// those and the carousel says what you will get; draw the logos and it says
// where it goes, which the label already says.
//
// The second is that redrawing four companies' trademarks into our own SVG is a
// thing to avoid when the design does not need it.
//
// So each object is the CANVAS of that platform, in its real proportions, with
// a single accent colour borrowed for recognition. Same line weights, same
// three-tone shading and same light from the upper left as the garments, so the
// two carousels read as one room.
//
// ============ THE SHADING IS THREE TONES, NOT A GRADIENT MESH =========
//
// Body, shade, highlight — enough to give volume, few enough that everything in
// the Creation Station looks photographed together. Judged at carousel size,
// because that is where it is read.

const BODY = "#F2F3F5";
const SHADE = "#C9CCD2";
const LINE = "#8E949E";

/** The accents. Borrowed for recognition, never as a whole-object fill. */
const ACCENT: Record<string, string> = {
  instagram: "#E1306C",
  facebook: "#1877F2",
  x: "#3A3A3E",
  tiktok: "#25F4EE",
};

function InstagramArt() {
  const a = ACCENT.instagram;
  return (
    <g>
      {/* A SQUARE POST. The 1:1 frame is the whole point — it is the shape the
          artwork has to be cropped to, and the thing an owner is deciding. */}
      <rect x="42" y="38" width="116" height="116" rx="14" fill={BODY} stroke={LINE} strokeWidth="2" />
      {/* The image inside it, with the horizon that reads as a photograph
          rather than a grey box. */}
      <rect x="52" y="48" width="96" height="70" rx="8" fill={SHADE} />
      <path d="M52 104 L78 82 L98 100 L118 86 L148 110 L148 110 L148 118 L52 118 Z" fill={a} opacity="0.55" />
      <circle cx="128" cy="64" r="7" fill={BODY} opacity="0.9" />
      {/* The caption, which is the part J4 actually writes. */}
      <rect x="52" y="126" width="70" height="6" rx="3" fill={SHADE} />
      <rect x="52" y="138" width="44" height="6" rx="3" fill={SHADE} opacity="0.7" />
      <rect x="42" y="38" width="116" height="116" rx="14" fill="none" stroke={a} strokeWidth="2.5" opacity="0.65" />
    </g>
  );
}

function FacebookArt() {
  const a = ACCENT.facebook;
  return (
    <g>
      {/* A FEED CARD — wider than tall, with the reactions underneath, because
          what Facebook is for here is the post people reply to. */}
      <rect x="30" y="52" width="140" height="96" rx="12" fill={BODY} stroke={LINE} strokeWidth="2" />
      {/* Who it is from. */}
      <circle cx="50" cy="72" r="9" fill={a} opacity="0.75" />
      <rect x="66" y="66" width="52" height="6" rx="3" fill={SHADE} />
      <rect x="66" y="77" width="32" height="5" rx="2.5" fill={SHADE} opacity="0.7" />
      {/* The body of the post. */}
      <rect x="40" y="94" width="120" height="6" rx="3" fill={SHADE} />
      <rect x="40" y="106" width="98" height="6" rx="3" fill={SHADE} opacity="0.8" />
      {/* The conversation it starts, which is the reason to post here at all. */}
      <rect x="40" y="126" width="30" height="10" rx="5" fill={a} opacity="0.55" />
      <rect x="78" y="126" width="30" height="10" rx="5" fill={SHADE} />
      <rect x="116" y="126" width="30" height="10" rx="5" fill={SHADE} opacity="0.7" />
    </g>
  );
}

function XArt() {
  const a = ACCENT.x;
  return (
    <g>
      {/* SHORT AND DIRECT. A small card with two lines in it and nothing else —
          the constraint IS the format, so the drawing is mostly empty. */}
      <rect x="38" y="66" width="124" height="68" rx="12" fill={BODY} stroke={LINE} strokeWidth="2" />
      <rect x="52" y="86" width="96" height="7" rx="3.5" fill={a} opacity="0.75" />
      <rect x="52" y="101" width="62" height="7" rx="3.5" fill={SHADE} />
      {/* The tail, so it reads as something said rather than a panel. */}
      <path d="M62 134 L62 148 L76 134 Z" fill={BODY} stroke={LINE} strokeWidth="2" strokeLinejoin="round" />
      <path d="M62 134 L62 147 L75 134 Z" fill={BODY} />
    </g>
  );
}

function TikTokArt() {
  const a = ACCENT.tiktok;
  return (
    <g>
      {/* VERTICAL VIDEO. 9:16 is the single most important fact about making
          anything for TikTok, so it is the silhouette. */}
      <rect x="66" y="26" width="68" height="148" rx="14" fill={BODY} stroke={LINE} strokeWidth="2" />
      <rect x="74" y="38" width="52" height="112" rx="8" fill={SHADE} />
      {/* Play, because this is the one that is not a still image. */}
      <circle cx="100" cy="94" r="17" fill={BODY} opacity="0.92" />
      <path d="M95 85 L112 94 L95 103 Z" fill={a} />
      {/* The caption strip along the bottom, where TikTok puts it. */}
      <rect x="74" y="132" width="36" height="5" rx="2.5" fill={BODY} opacity="0.8" />
      <rect x="74" y="141" width="24" height="5" rx="2.5" fill={BODY} opacity="0.6" />
      <rect x="66" y="26" width="68" height="148" rx="14" fill="none" stroke={a} strokeWidth="2.5" opacity="0.5" />
    </g>
  );
}

const ART: Record<string, () => React.ReactElement> = {
  instagram: InstagramArt,
  facebook: FacebookArt,
  x: XArt,
  tiktok: TikTokArt,
};

function GenericArt() {
  return (
    <g>
      <rect x="46" y="52" width="108" height="96" rx="12" fill={BODY} stroke={LINE} strokeWidth="2" />
      <rect x="58" y="70" width="84" height="6" rx="3" fill={SHADE} />
      <rect x="58" y="84" width="60" height="6" rx="3" fill={SHADE} opacity="0.7" />
    </g>
  );
}

export function PlatformArt({ id, className }: { id: string; className?: string }) {
  const Art = ART[id] ?? GenericArt;
  return (
    <svg viewBox="0 0 200 200" className={className} aria-hidden="true" focusable="false">
      <Art />
    </svg>
  );
}
