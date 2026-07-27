// Genesis's own visual identity — deliberately fixed, not tied to the
// owner's light/dark toggle (see DashboardShell.tsx/GenesisDomicile.tsx/
// LiveIntelligence.tsx/GenesisLanguageLegend.tsx/GenesisAssistant.tsx,
// lg:+ only). The environment belongs to Genesis; the framed Business TV
// belongs to the business and keeps toggling light/dark as it always has.
// One shared source of truth for these values (consumed via Tailwind
// arbitrary-value classes, e.g. `bg-[${GENESIS_ATMOSPHERE.bg}]`) so every
// component stays in sync — same reasoning as GENESIS_STATE_META in
// genesisState.ts. Restrained on purpose: creational/atmospheric, not a
// literal space theme — `horizon` especially is a sparing warmth accent,
// never a dominant color.
export const GENESIS_ATMOSPHERE = {
  bg: "#07060d",
  bgElevated: "#100d1c",
  violet: "#8b7cf6",
  violetSoft: "rgba(139,124,246,0.35)",
  violetGlow: "rgba(139,124,246,0.14)",
  horizon: "rgba(243,182,160,0.22)",
  text: "#f4f2fb",
  textSecondary: "rgba(244,242,251,0.62)",
  border: "rgba(139,124,246,0.18)",
} as const;
