import Image from "next/image";
import { deriveAssessmentState, GENESIS_STATE_META, isStableAttentionState } from "@/lib/dashboard/genesisState";
import { GENESIS_ATMOSPHERE } from "@/lib/dashboard/genesisAtmosphere";

// Genesis's persistent visual presence in the left rail — lg:+ only (see
// DashboardShell.tsx), always the atmospheric treatment regardless of the
// owner's light/dark toggle (this is Genesis's own identity, not the app's
// dark mode). Not a widget contained inside a card: no border/background
// box around it, just the presence occupying the column's own space.
//
// The animated SVG ring+planet (formerly GenesisOrbitRing, an
// interaction/energy-language placeholder, not final artwork) has been
// replaced with the canonical J4 icon (see
// memory/project_j4_avatar_branding.md) — the same unmodified brand asset
// now also used as the dashboard nav icon. This is explicitly a Phase 1
// stand-in: the outer atmospheric wash still shifts color/intensity with
// real GenesisState (so ambient state-signaling isn't lost), but the icon
// itself is static — a future branding phase will replace it with a fully
// realized 3D Saturn-style avatar with a premium metallic ring, at which
// point per-state ring animation can return.
//
// "working" (a chat request genuinely in flight) is only knowable inside
// GenesisAssistant's own <form>, via useFormStatus — it can't be computed
// once and passed down as a prop the way the other four signals can. Per
// Genesis Language v2 (memory project_genesis_language_model.md), it's also
// no longer a peer assessment state at all — it's a separate, additive
// overlay that never suppresses or replaces the real assessment glow below,
// only adds a pulse on top of it. Every current call site simply doesn't
// pass isWorking yet, which is identical to passing false.
export function GenesisDomicile({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  hasCuriosity,
  isWorking = false,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  hasCuriosity: boolean;
  isWorking?: boolean;
}) {
  const state = deriveAssessmentState({
    hasUrgentIssue,
    hasPendingDecision,
    hasOpportunity,
    hasCuriosity,
  });
  const meta = GENESIS_STATE_META[state];
  // "Stable attention" states (a real decision, opportunity, curiosity, or
  // urgent issue) render the ring at full intensity — categorically equal
  // weight to each other (this mirrors the existing Genesis Language
  // legend's own flat, non-hierarchical treatment), just different hues.
  // Only idle (Peace) gets the calmer, thinner base-ring treatment.
  // Working is a separate, additive pulse layered on top of whichever of
  // these is currently true — it never dims or replaces the real glow.
  const isStableAttention = isStableAttentionState(state);

  return (
    <div className="flex w-full flex-col items-center pt-2 text-center">
      <div className="relative flex w-full items-center justify-center">
        {/* Outer atmospheric wash — large, soft, heavily blurred; brighter
            for a stable attention state, dimmer (but never absent) at idle.
            Always reflects the real assessment; Working never changes this. */}
        <div
          aria-hidden="true"
          className="absolute aspect-square w-[85%] rounded-full blur-3xl transition-colors duration-700"
          style={{
            backgroundColor: meta.glowColor,
            opacity: isStableAttention ? 0.45 : 0.2,
          }}
        />

        {/* Working overlay — a separate, additive pulse (always blue,
            regardless of the real assessment hue above) proving a request
            is genuinely in flight right now. Never replaces or dims the
            wash above it; purely layered on top. */}
        {isWorking && (
          <div
            aria-hidden="true"
            className="absolute aspect-square w-[85%] animate-pulse rounded-full blur-2xl"
            style={{ backgroundColor: "#3b82f6", opacity: 0.25 }}
          />
        )}

        {/* Canonical J4 icon — same footprint (aspect-square, 78% of the
            rail's width) the animated ring+planet previously occupied, so
            spacing/composition around it is unchanged. Unmodified image;
            no per-state recoloring (that's the deferred future-3D-avatar
            capability) — the outer glow wash above is what still carries
            live state today. */}
        <div className="relative aspect-square w-[78%] overflow-hidden rounded-2xl">
          <Image
            src="/brand/genesis-j4-avatar.png"
            alt="Genesis"
            fill
            sizes="(min-width: 1024px) 20vw, 200px"
            className="object-cover"
            priority
          />
        </div>
      </div>
      <p
        className="mt-8 font-[var(--font-heading,inherit)] text-2xl font-semibold"
        style={{ color: GENESIS_ATMOSPHERE.text }}
      >
        Genesis
      </p>
      <p className="mt-1 text-sm" style={{ color: GENESIS_ATMOSPHERE.textSecondary }}>
        {meta.label}
      </p>
    </div>
  );
}
