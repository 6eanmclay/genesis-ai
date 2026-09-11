"use server";

import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { resolveOfficeAccess } from "@/lib/j4/officeAccess";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { toUnderstandingGroups } from "@/lib/j4/understandingGroups";
import { buildContextEntries } from "@/lib/j4/contextTypes";
import type { ContextEntry } from "@/lib/j4/contextTypes";
import type { UnderstandingGroup } from "./J4Workspace";

/**
 * WHAT J4 UNDERSTANDS, FETCHED WHEN THE OWNER ASKS FOR IT.
 *
 * ============ THE 921ms (2026-09-09) ===================================
 *
 * Measured against production, read by read, on the Office path:
 *
 *     conversation             167ms   <- the only thing the shell needs
 *     observations              72ms
 *     explanations              74ms
 *     approvals                185ms
 *     tasks                     66ms
 *     handled / changed        499ms
 *     business understanding   921ms   <- this
 *
 * All of it sat in one awaited Promise.all before the shell rendered, so the
 * floor for first paint was the slowest of them: 921ms. And J4Surface's own
 * comment records that the LAYER renders on every dashboard page, so that cost
 * was paid on every navigation an owner made, not only in the Office.
 *
 * Sean's rule: "Only load what the current surface needs, and don't block the
 * user on data that isn't needed to make the surface usable." Nothing about
 * talking to J4 needs this. The Understanding view does, and only when opened.
 *
 * NOTHING WAS DELETED. The same call, the same mapping, the same groups - the
 * only change is when it is asked for. "Same intelligence + same capabilities
 * + faster usable J4" was the success condition, and a read that moved is not
 * a capability that went missing.
 *
 * ============ IT REPEATS THE AUTHORISATION, DELIBERATELY ===============
 *
 * A server action is a public endpoint. The old read was inside a component
 * that had already resolved the store and checked the role, and moving it out
 * of that component means it has to establish both again for itself - the
 * store:manage gate matching /dashboard/understanding, which has always
 * required it. A role without it gets no groups, exactly as before.
 */
/**
 * Both consumers of the understanding, in one load.
 *
 * The context pane reads the same 921ms call as the Understanding view, and it
 * has an honest empty state - "Nothing recorded yet. As you tell J4 about the
 * business, it shows up here." Handing it an empty array while the real answer
 * was still loading would show the owner that sentence as though it were true.
 * A pane that has not loaded and a business J4 knows nothing about are
 * different facts, so they are returned together and the client can tell
 * "not yet" from "nothing".
 */
export interface DeepKnowledge {
  groups: UnderstandingGroup[];
  contextEntries: ContextEntry[];
}

/**
 * THE OWNER SAYS A BELIEF IS WRONG (2026-09-11).
 *
 * ============ THE SAME MECHANISM, NOT A SECOND ONE ====================
 *
 * This calls `contradictBelief` — the identical function the
 * `contradict_belief` tool calls from chat. Nothing about the belief model,
 * the DISMISSED status, the retirement record or the owner-only rule is
 * re-decided here; this is a second DOOR to one mechanism, not a second
 * mechanism.
 *
 * AND IT IS THE MORE PRECISE DOOR. The chat tool receives a claim as TEXT,
 * because that is all a language model has, so it matches on the wording and
 * refuses outright when two beliefs read alike — `contradict_belief_ambiguous`
 * exists for exactly that case. The Understanding surface already holds the
 * belief's id, so from here there is no matching step and therefore no wrong
 * belief to retire by accident.
 *
 * OWNER ONLY, and not by this file's say-so: contradictBelief checks
 * `store.userId !== params.userId` itself and answers `not_permitted`. The
 * authorisation is repeated here anyway because a server action is a public
 * endpoint, and the two guards answer different questions — may you see this
 * business at all, and are you the person whose beliefs these are.
 */
export async function correctBelief(
  beliefId: string,
  /** The owner's own words for why it is wrong. Stored verbatim, never parsed. */
  note: string | null,
  slug?: string,
): Promise<{ ok: true } | { ok: false; because: string }> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const resolved = await resolveOfficeAccess(session.user.id, slug);
  if (!resolved) return { ok: false, because: "I could not work out which business that belongs to." };
  const { store, role } = resolved;
  if (!hasPermission(role, PERMISSIONS.STORE_MANAGE)) {
    return { ok: false, because: "You do not have permission to change what I believe about this business." };
  }

  const { contradictBelief } = await import("@/lib/intelligence/beliefReview");
  const outcome = await contradictBelief({
    storeId: store.id,
    beliefId,
    userId: session.user.id,
    note: note?.trim() ? note.trim() : undefined,
  });

  if (outcome.ok) return { ok: true };
  // SAID PLAINLY, in the refusal's own terms. The tool description is explicit
  // that a refused write must be reported as refused rather than implied to
  // have worked.
  return {
    ok: false,
    because:
      outcome.refusal === "not_permitted"
        ? "Only the business owner can tell me one of my own conclusions is wrong."
        : "I could not find that belief any more — it may already have been retired.",
  };
}

export async function loadDeepKnowledge(slug?: string): Promise<DeepKnowledge> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  // ONE RESOLVER. Both of these actions originally called
  // accessTo(slug, session.user.id) - a slug where a user id belongs and a
  // user id where a store id belongs. Both are strings, so nothing complained,
  // and every owner on a /b/[slug] route would have silently got an empty
  // business. See lib/j4/officeAccess.ts.
  const resolved = await resolveOfficeAccess(session.user.id, slug);
  if (!resolved) return { groups: [], contextEntries: [] };
  const { store, role } = resolved;

  // Same tier as the page: without store:manage the view says it has nothing
  // rather than showing a half-populated picture.
  if (!hasPermission(role, PERMISSIONS.STORE_MANAGE)) return { groups: [], contextEntries: [] };

  const understanding = await getBusinessUnderstanding(store.id);
  if (!understanding) return { groups: [], contextEntries: [] };
  return {
    groups: toUnderstandingGroups(understanding, store.currency),
    contextEntries: buildContextEntries(understanding),
  };
}
