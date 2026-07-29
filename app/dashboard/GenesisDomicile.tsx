import Image from "next/image";
import { deriveGenesisState, GENESIS_STATE_META } from "@/lib/dashboard/genesisState";
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
// "working" is real (a chat request genuinely in flight) but today it's
// only knowable inside GenesisAssistant's own <form>, via useFormStatus —
// it can't be computed once and passed down as a prop the way the other
// three signals can (see deriveGenesisState's own comment). This component
// accepts isWorking so it's ready the moment that plumbing exists; every
// current call site simply doesn't pass it yet, which is identical to
// passing false — idle/needs_decision/opportunity/urgent are completely
// unaffected by this addition.
export function GenesisDomicile({
  hasUrgentIssue,
  hasPendingDecision,
  hasOpportunity,
  isWorking = false,
}: {
  hasUrgentIssue: boolean;
  hasPendingDecision: boolean;
  hasOpportunity: boolean;
  isWorking?: boolean;
}) {
  const state = deriveGenesisState({
    isWorking,
    hasUrgentIssue,
    hasPendingDecision,
    hasOpportunity,
  });
  const meta = GENESIS_STATE_META[state];
  // "Stable attention" states (a real decision, opportunity, or urgent
  // issue) render the ring at full intensity — categorically equal weight
  // to each other (this mirrors the existing Genesis Language legend's own
  // flat, non-hierarchical treatment of these three), just different hues.
  // idle and working both get the calmer, thinner base-ring treatment;
  // working additionally gets the chasing highlight described above.
  const isStableAttention = state === "needs_decision" || state === "opportunity" || state === "urgent";

  return (
    <div className="flex w-full flex-col items-center pt-2 text-center">
      <div className="relative flex w-full items-center justify-center">
        {/* Outer atmospheric wash — large, soft, heavily blurred; brighter
            for a stable attention state, dimmer (but never absent) at idle. */}
        <div
          aria-hidden="true"
          className="absolute aspect-square w-[85%] rounded-full blur-3xl transition-colors duration-700"
          style={{
            backgroundColor: meta.glowColor,
            opacity: isStableAttention ? 0.45 : state === "working" ? 0.32 : 0.2,
          }}
        />

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
