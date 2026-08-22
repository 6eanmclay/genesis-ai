"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import type { StoreRole } from "@prisma/client";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { businessBasePath, LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { addMember, changeMemberRole, removeMember } from "@/lib/security/members";

// EVERY ONE OF THESE IS GUARDED BY EMPLOYEES_MANAGE, which is OWNER-only in
// the permission table. requireBusinessOrActive throws when the caller does
// not hold it, so an employee cannot grant themselves or anybody else access
// by calling the action directly — the screen not rendering a control is a
// presentation detail, and this is the enforcement.
//
// Business-scoped and slug-bound, following the pattern the rest of the
// dashboard already holds: an action submitted from one business's page must
// act on THAT business, never on whichever one the account last made active.

async function context(slug?: string) {
  const { storeId, userId } = await requireBusinessOrActive(PERMISSIONS.EMPLOYEES_MANAGE, slug);
  const requestHeaders = await headers();
  return { storeId, userId, userAgent: requestHeaders.get("user-agent") };
}

function accessPath(slug?: string) {
  return `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/access`;
}

export async function addMemberAction(formData: FormData, slug?: string) {
  const { storeId, userId, userAgent } = await context(slug);
  const outcome = await addMember({
    storeId,
    actorUserId: userId,
    email: String(formData.get("email") ?? ""),
    role: (String(formData.get("role") ?? "EMPLOYEE") as StoreRole),
    userAgent,
  });
  revalidatePath(accessPath(slug));
  return outcome;
}

export async function changeRoleAction(memberUserId: string, role: StoreRole, slug?: string) {
  const { storeId, userId, userAgent } = await context(slug);
  const outcome = await changeMemberRole({
    storeId,
    actorUserId: userId,
    userId: memberUserId,
    role,
    userAgent,
  });
  revalidatePath(accessPath(slug));
  return outcome;
}

export async function removeMemberAction(memberUserId: string, slug?: string) {
  const { storeId, userId, userAgent } = await context(slug);
  const outcome = await removeMember({
    storeId,
    actorUserId: userId,
    userId: memberUserId,
    userAgent,
  });
  revalidatePath(accessPath(slug));
  return outcome;
}
