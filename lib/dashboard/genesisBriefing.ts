// The shared "what is Genesis currently focused on" briefing — extracted
// from LiveIntelligence.tsx so both it (desktop) and MobileGenesisPresence
// (mobile) render the identical real sentence from one source of truth,
// never two independently hand-copied merge/priority implementations (the
// same discipline already applied to GENESIS_STATE_META and
// COGNITIVE_OUTPUT_KIND_LABEL).

export interface FocusableApprovalBrief {
  id: string;
  section: string;
  href: string;
  summary: string;
  noticedSummary: string | null;
}

export interface LiveObservationBrief {
  dedupeKey: string;
  genesisState: string;
  summary: string;
  actionHref: string | null;
}

export interface CuriosityBrief {
  id: string;
  summary: string;
}

type MergedItem =
  | { kind: "approval"; key: string; summary: string; href: string }
  | { kind: "observation"; key: string; summary: string; href: string | null; genesisState: string }
  // Genesis Language v2 — Curiosity (explanation-kind CognitiveOutput, see
  // layout.tsx). No href: explanation-kind outputs carry no actionHref by
  // design (nothing to route to), so this renders as plain text, never a
  // fabricated link — same convention an hrefless observation already uses.
  | { kind: "curiosity"; key: string; summary: string; href: null };

// Real priority, not list order — an urgent observation outranks a pending
// decision, which outranks an opportunity, which outranks mere curiosity.
// Matches deriveAssessmentState's own priority order in
// lib/dashboard/genesisState.ts. GenesisObservation rows are only ever
// "urgent" or "opportunity", so these buckets are exhaustive.
function priorityRank(item: MergedItem): number {
  if (item.kind === "observation" && item.genesisState === "urgent") return 0;
  if (item.kind === "approval") return 1;
  if (item.kind === "observation") return 2; // opportunity
  return 3; // curiosity
}

export interface Briefing {
  lead: string;
  ctaLabel: string;
  ctaHref: string | null;
}

// A short, count-based briefing line rather than echoing the real
// proposal/observation text into this ambient surface — the full detail
// already lives on its real, appropriate review page (Website/Brand/
// Products, via the existing "?focus=" chain the caller's link uses).
function leadCopy(topItem: MergedItem, count: number): { lead: string; cta: string } {
  const plural = count > 1;
  const cta = plural ? "start here" : "review it";
  if (topItem.kind === "approval") {
    return { lead: `Genesis needs your decision on ${plural ? `${count} things` : "one thing"} today`, cta };
  }
  if (topItem.kind === "observation" && topItem.genesisState === "urgent") {
    return { lead: `Genesis needs your attention on ${plural ? `${count} things` : "one thing"} today`, cta };
  }
  if (topItem.kind === "curiosity") {
    return {
      lead: `Genesis is curious about ${plural ? `${count} things` : "something"} today`,
      cta: plural ? "start here" : "take a look",
    };
  }
  return {
    lead: `Genesis found ${plural ? `${count} things` : "something"} worth considering today`,
    cta: plural ? "start here" : "take a look",
  };
}

// Returns null when there's nothing pending, letting the caller render its
// own calm idle line instead — never a fabricated "nothing here" sentence.
export function buildBriefing(input: {
  focusableApprovals: FocusableApprovalBrief[];
  liveObservations: LiveObservationBrief[];
  curiosityItems: CuriosityBrief[];
}): Briefing | null {
  const merged: MergedItem[] = [
    ...input.focusableApprovals.map(
      (a): MergedItem => ({ kind: "approval", key: a.id, summary: a.summary, href: `${a.href}?focus=${a.id}` })
    ),
    ...input.liveObservations.map(
      (o): MergedItem => ({
        kind: "observation",
        key: o.dedupeKey,
        summary: o.summary,
        href: o.actionHref,
        genesisState: o.genesisState,
      })
    ),
    ...input.curiosityItems.map(
      (c): MergedItem => ({ kind: "curiosity", key: c.id, summary: c.summary, href: null })
    ),
  ].sort((a, b) => priorityRank(a) - priorityRank(b));

  const [topItem] = merged;
  if (!topItem) return null;
  const copy = leadCopy(topItem, merged.length);
  return { lead: copy.lead, ctaLabel: copy.cta, ctaHref: topItem.href };
}
