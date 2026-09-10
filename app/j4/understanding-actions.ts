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
