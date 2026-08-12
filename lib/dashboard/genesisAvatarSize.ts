// Visual polish (2026-08-08) — Sean's explicit ask: "standardize the
// avatar sizing across the portal, dashboard, J4 workspace, and
// onboarding." Before this, every one of GenesisAvatar's ~25 real mount
// sites invented its own className ad hoc — onboarding alone had eight
// distinct pixel caps (84/100/110/120/150/220/340/440px) with no shared
// scale behind any of them. This is a real, named, deliberately small
// scale instead — each site now points at one of these tokens rather
// than a bespoke value, and a handful of near-duplicate legacy sizes
// (84/110/150px) were consolidated onto their nearest real tier rather
// than preserved as one-off values, since a shared scale is the actual
// point.
//
// These are plain string constants (not computed), exactly like
// GENESIS_ATMOSPHERE — Tailwind's build-time class scanner only finds
// classes that appear as literal text in scanned source, and it scans
// this file same as any other, so `className={GENESIS_AVATAR_SIZE.lg}`
// generates real CSS the same as writing the class inline would.
export const GENESIS_AVATAR_SIZE = {
  // Dense chrome/toolbar icons — small, fixed pixel sizes.
  toolbar: "h-7 w-7 shrink-0", // 28px — DashboardShell rail icon
  header: "h-9 w-9 shrink-0", // 36px — DashboardShell topbar icon
  inline: "h-10 w-10 shrink-0", // 40px — J4 Portal header avatar
  presence: "h-11 w-11", // 44px — MobileGenesisPresence ambient icon
  card: "h-16 w-16", // 64px — a real card-level moment (e.g. CreateBusinessArrival)
  // 76px — the mobile summon control in DashboardShell's tab bar. Its own
  // tier rather than a bespoke value, because it is a genuinely different
  // job from `card`: this is the primary interaction point of the entire
  // mobile product and has to out-weigh four navigation icons sitting beside
  // it without inflating the bar that contains it. Added 2026-08-12 after
  // real-device feedback that 44px, then 64px, both still read as "a fifth
  // nav icon" rather than as the control the bar is arranged around.
  summon: "h-[76px] w-[76px] shrink-0",
  // GenesisDomicile's own ambient orb — sized relative to its own frame,
  // not a fixed pixel value, kept as its own real token rather than
  // forced onto the fixed-pixel scale above. Bumped 78% -> 85% (2026-08-09,
  // real-device feedback): "the recent size increase is better, but
  // increase the avatar one more size step... keep the existing visual
  // treatment/proportions, just give it slightly more presence."
  domicile: "aspect-square w-[85%]",

  // Onboarding/full-screen feature moments — responsive (viewport-relative
  // with a max cap), smallest to largest.
  sm: "aspect-square w-[min(24vw,100px)]",
  md: "aspect-square w-[min(30vw,120px)]",
  lg: "aspect-square w-[min(42vw,220px)]",
  xl: "aspect-square w-[min(58vw,340px)]",
  // The single largest — the full-screen arrival/wake moment.
  arrival: "aspect-square w-[min(72vw,440px)]",
} as const;
