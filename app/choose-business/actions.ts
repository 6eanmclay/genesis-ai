"use server";

import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { setActiveBusiness } from "@/lib/businessContext";

// THE SWITCHER (BUSINESS_CONTEXT.md, Phase D).
//
// Its own words: "A switcher that NAVIGATES. It sets the active business (so the
// next landing is right) and then changes the URL. It does not hold state; the
// URL is the state."
//
// Both halves matter and they do different jobs. The URL is what makes two tabs
// able to hold two businesses; the active pointer is only what decides where
// somebody lands when they arrive with no business named. Setting one without
// the other gives either a switcher that forgets, or a switcher that changes an
// invisible pointer and leaves the page showing the business it just left.
//
// `setActiveBusiness` checks access itself — a business id is not a capability,
// and this is exactly the door where that has to be tested rather than trusted.
export async function switchBusiness(formData: FormData): Promise<void> {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const storeId = String(formData.get("storeId") ?? "");
  if (!storeId) redirect("/choose-business");

  const result = await setActiveBusiness(session.user.id, storeId);
  // Deliberately silent about WHY. A business this account cannot reach and a
  // business that does not exist get the same answer, for the reason
  // requireBusiness already records: telling somebody a business exists but is
  // not theirs is an answer they did not have before.
  if (!result.ok) redirect("/choose-business");

  // The URL becomes the state. Landing on the business's own route rather than
  // /dashboard is what stops the next page resolving ambiently all over again.
  redirect(`/b/${result.context.store.slug}`);
}
