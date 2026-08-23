"use server";

import { revalidatePath } from "next/cache";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { createConversation } from "@/lib/j4/conversations";

// STARTING A CONVERSATION, BECAUSE THE OWNER SAID TO (UI6 piece 2).
//
// The only path that creates one. Nothing in the turn machinery does, so a
// conversation cannot appear as a side effect of sending a message — which is
// what "explicit" was chosen to mean, and what the suite asserts.
//
// The business comes from the conversation surface the owner is on, never from
// the account's active pointer. That was the defect class UI6's first half
// removed and this is a new write path, so it uses the same resolution: a slug
// resolves to that business or to nothing, and never falls through.

export async function startConversation(slug: string | undefined, formData: FormData) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.GENESIS_CHAT, slug);

  const raw = formData.get("name");
  const name = typeof raw === "string" ? raw : null;

  await createConversation({ storeId, name });

  // The layout renders the conversation, not any one page — the same reason
  // proposal-actions.ts revalidates a layout rather than a path.
  revalidatePath("/dashboard", "layout");
  revalidatePath("/j4", "layout");
}
