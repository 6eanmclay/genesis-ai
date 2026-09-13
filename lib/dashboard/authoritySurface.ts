import { GENESIS_ACTIONS, CATEGORY_MAX_TIER } from "@/lib/execution/genesisActions";

// WHAT J4 MAY DO WITHOUT BEING ASKED, ASSEMBLED FROM THE REAL REGISTRY.
//
// ============ TWO WARRANTS, AND THE OWNER COULD SEE NEITHER ==========
//
// The authority audit (2026-09-11) found two production paths that execute
// with nobody clicking Approve, gated on different things:
//
//   PRESENT-OWNER  the owner is signed in and in the conversation. Gated on
//                  the registry's authorizationTier alone. No DelegatedAuthority
//                  is read — so revoking a grant does not touch it.
//   GRANT          the owner is absent. Gated on the action's CAP plus an
//                  explicit, un-revoked DelegatedAuthority row.
//
// The only owner-facing representation of any of it was one button on the
// Marketing page, which described the grant path and said "Genesis will always
// ask before changing your SEO title or description" — false, because SEO is
// the one action registered at tier "auto".
//
// This module derives the whole picture from GENESIS_ACTIONS rather than a
// list kept beside it, so a newly delegable action appears on the owner's
// screen because it was registered, not because somebody remembered.
//
// IT DECIDES NOTHING. Every predicate here is a transcription of a gate that
// lives in production code, and the screen reads them. Authority itself is
// unchanged by anything in this file.

export type GrantState = "granted" | "revoked" | "never_granted";

/** How an action may be authorised without the owner clicking Approve. */
export interface AuthorityCapability {
  actionType: string;
  label: string;
  category: string;
  /**
   * This capability MAY run inside a conversation with no separate approval —
   * the tier half of the gate app/dashboard/ai-actions.ts evaluates.
   *
   * Eligibility, not permission. Since 2026-09-11 the same authorisation the
   * absent-owner path requires applies here too, so a capability can be
   * eligible and still ask every time because the owner has not granted it or
   * has revoked it. `authorized` is the other half.
   */
  chatAuto: boolean;
  /**
   * The owner has authorised this capability to run without them deciding —
   * an active, un-revoked DelegatedAuthority row.
   *
   * ONE ANSWER FOR BOTH CONTEXTS. Presence changes which warrant an execution
   * is recorded under; it does not change whether it is allowed.
   */
  authorized: boolean;
  /**
   * An owner CAN delegate this for when they are away — the literal first
   * gate lib/execution/genesisAutonomy.ts evaluates.
   *
   * Exempt actions are excluded deliberately; see EXEMPT below.
   */
  grantable: boolean;
  /** Authority-exempt additive communication. Not a permission anyone grants. */
  exempt: boolean;
  grantState: GrantState;
  grantedAt: Date | null;
  revokedAt: Date | null;
  /** Does this surface offer a control for it today? */
  hasControl: boolean;
}

export interface AuthoritySurface {
  /** Runs while the owner is present, on the registry tier alone. */
  whileHere: AuthorityCapability[];
  /** Can be delegated for when the owner is away. */
  whileAway: AuthorityCapability[];
  /** Authority-exempt. Informational: nobody grants these. */
  exempt: AuthorityCapability[];
  /** Everything else, counted rather than listed — it always stops and asks. */
  alwaysAsks: { total: number; permanentlyCapped: number };
}

export interface GrantRow {
  actionType: string;
  grantedAt: Date;
  revokedAt: Date | null;
}

/**
 * Owner-facing names.
 *
 * Deliberately NOT exhaustive: anything without an entry falls back to a
 * readable form of its own key, so a newly registered capability appears
 * named rather than not at all. verify-authority-surface-live asserts that
 * everything this surface LISTS has a real entry here — a derived
 * "Update goal status" is an acceptable failsafe and a poor label.
 */
const CAPABILITY_LABELS: Record<string, string> = {
  update_seo: "Publish SEO improvements",
  update_goal_status: "Mark a goal achieved or abandoned",
  resolve_challenge: "Close out a challenge you've dealt with",
  communicate_finding: "Tell you something it noticed",
};

/**
 * One owner-facing name for a GenesisActionType, and a readable fallback —
 * never an invented identifier.
 *
 * EXPORTED 2026-09-13, because a second reader appeared. The Growth Points
 * usage table printed raw keys at owners ("update_seo" under a column headed
 * "Action"), and the honest fix was to use the vocabulary that already exists
 * rather than start a second one beside it.
 *
 * Named for what it labels rather than `labelFor`: that bare name is already
 * taken as a parameter in lib/social/socialPresentation.ts for a different
 * kind of label, and an ambiguous export is how two vocabularies quietly
 * become one confused one.
 *
 * It stays in this file because this is where the names are. If a third
 * consumer ever wants it somewhere neutral, moving it is a relocation, not a
 * new taxonomy — what must not happen is a second map.
 */
export function genesisActionLabel(actionType: string): string {
  const explicit = CAPABILITY_LABELS[actionType];
  if (explicit) return explicit;
  const words = actionType.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The capabilities this SCREEN offers a control for today.
 *
 * Not a claim about what the engine supports — grantDelegatedAuthority accepts
 * any action whose cap allows it. It is a claim about what an owner can
 * currently press, which is a smaller and more honest thing. Everything
 * grantable that is not in here renders as informational and says so, rather
 * than being given a button to make the list look symmetrical.
 */
export const CONTROLLED_CAPABILITIES: readonly string[] = ["update_seo"];

export function buildAuthoritySurface(grants: GrantRow[]): AuthoritySurface {
  const byAction = new Map<string, GrantRow>();
  for (const g of grants) {
    // Newest wins if a store somehow carries more than one row per action —
    // the schema's @@unique([storeId, actionType]) says it cannot, and this
    // costs nothing to be right about anyway.
    const seen = byAction.get(g.actionType);
    if (!seen || g.grantedAt > seen.grantedAt) byAction.set(g.actionType, g);
  }

  const rows: AuthorityCapability[] = [];
  let alwaysAsksTotal = 0;
  let permanentlyCapped = 0;

  for (const [actionType, d] of Object.entries(GENESIS_ACTIONS)) {
    const def = d as unknown as {
      category: string;
      authorizationTier: string;
      maxAuthorityTier: string;
      authorityExempt?: boolean;
    };
    const exempt = !!def.authorityExempt;
    // THE GATES, TRANSCRIBED. Each mirrors a real production expression; see
    // scripts/verify-authority-warrants.ts, which asserts both against the
    // paths that evaluate them.
    const chatAuto = def.authorizationTier === "auto" && !exempt;
    // EXEMPT IS NOT GRANTABLE, even though its cap allows it. communicate_finding
    // reaches execute() through authorityExemptAction, which consults no grant
    // at all — so offering it as a delegable permission would describe a
    // control that changes nothing. It is listed as what it is instead.
    const grantable = def.maxAuthorityTier !== "always_ask" && !exempt;

    if (!chatAuto && !grantable && !exempt) {
      alwaysAsksTotal++;
      if (CATEGORY_MAX_TIER[def.category as keyof typeof CATEGORY_MAX_TIER] === "always_ask") {
        permanentlyCapped++;
      }
      continue;
    }

    const grant = byAction.get(actionType);
    const grantState: GrantState = !grant
      ? "never_granted"
      : grant.revokedAt
        ? "revoked"
        : "granted";

    rows.push({
      actionType,
      label: genesisActionLabel(actionType),
      category: def.category,
      chatAuto,
      authorized: grantState === "granted",
      grantable,
      exempt,
      grantState,
      grantedAt: grant?.grantedAt ?? null,
      revokedAt: grant?.revokedAt ?? null,
      hasControl: CONTROLLED_CAPABILITIES.includes(actionType),
    });
  }

  return {
    whileHere: rows.filter((r) => r.chatAuto),
    whileAway: rows.filter((r) => r.grantable),
    exempt: rows.filter((r) => r.exempt),
    alwaysAsks: { total: alwaysAsksTotal, permanentlyCapped },
  };
}
