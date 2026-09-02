import type { StoreRole } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, ROLE_PERMISSIONS, type Permission } from "@/lib/permissions";
import { recordSecurityEvent, SECURITY_EVENTS } from "./events";
import { revokeOtherSessions } from "./sessions";
import { normalizeEmail } from "@/lib/auth/normalizeEmail";

// WHO CAN DO WHAT ON THIS BUSINESS (Security & Trust steps 6 and 7, D5: build
// the real capability, not a review screen over an empty model).
//
// THE FINDING THAT SHAPED THIS. StoreMember has existed and been enforced
// everywhere for months — hasPermission is honoured on every action, EMPLOYEE
// grants are real — and NOTHING IN THE PRODUCT COULD WRITE ONE. The only rows
// ever created were made by verification scripts. So the authorization model
// was fully enforced on the read side and completely unreachable on the write
// side, and "who can do what on my store" had exactly one possible answer:
// you. That is why D5 rejected a review screen on its own; it would have been
// a screen answering a question nobody had.
//
// THE ROLE MODEL IS NOT REDESIGNED HERE. OWNER and EMPLOYEE, and the
// permission table in lib/permissions.ts, stay exactly as they are. This
// surfaces that model and makes it reachable; it does not change it.

/** What a role can do, read from the one table rather than restated. */
export interface RoleCapability {
  permission: Permission;
  /** What this permission means to the person granting it. */
  label: string;
  granted: boolean;
}

/**
 * The owner-facing description of each permission.
 *
 * A review screen that printed "orders:manage" would be showing an owner the
 * system's vocabulary and asking them to make a trust decision in it. Every
 * permission the table can grant is asserted to have one of these.
 */
export const PERMISSION_LABEL: Record<Permission, string> = {
  [PERMISSIONS.STORE_MANAGE]: "Change the business and its storefront",
  [PERMISSIONS.PRODUCTS_MANAGE]: "Add and edit products",
  [PERMISSIONS.ORDERS_VIEW]: "See orders and customers",
  [PERMISSIONS.ORDERS_MANAGE]: "Fulfil orders and buy shipping labels",
  [PERMISSIONS.REVENUE_VIEW]: "See revenue and what things sold for",
  [PERMISSIONS.ANALYTICS_VIEW]: "See analytics",
  [PERMISSIONS.PAYMENTS_MANAGE]: "Connect and change payment accounts",
  [PERMISSIONS.EMPLOYEES_MANAGE]: "Give and remove other people's access",
  [PERMISSIONS.GENESIS_CHAT]: "Talk to J4 about this business",
  [PERMISSIONS.AUTHORITY_MANAGE]: "Decide what J4 may do without asking",
  [PERMISSIONS.CONNECTIONS_MANAGE]: "Connect other business software",
  [PERMISSIONS.BILLING_MANAGE]: "Change the plan and billing",
};

/**
 * What a role can do, in the owner's terms.
 *
 * READS ROLE_PERMISSIONS, never restates it. A second copy of an authorization
 * table is two answers to one question, and the drifted one would be the one
 * nobody was reading — the mirrored-registry invariant, applied where being
 * wrong means showing somebody the wrong idea of who can spend their money.
 */
export function capabilitiesOf(role: StoreRole): RoleCapability[] {
  const granted = ROLE_PERMISSIONS[role];
  return (Object.values(PERMISSIONS) as Permission[]).map((permission) => ({
    permission,
    label: PERMISSION_LABEL[permission],
    granted: granted.includes(permission),
  }));
}

export interface MemberRow {
  userId: string;
  email: string;
  name: string | null;
  role: StoreRole;
  /** True for the account that owns the business — never a StoreMember row. */
  isOwner: boolean;
  since: Date;
}

/**
 * Everyone who can reach this business.
 *
 * The owner is DERIVED from Store.userId rather than read from StoreMember,
 * matching lib/permissions.ts exactly: the owner has never had a membership
 * row, and inventing one here would be a second model of the same fact.
 */
export async function listMembers(storeId: string): Promise<MemberRow[]> {
  const store = await prisma.store.findUnique({
    where: { id: storeId },
    select: { userId: true, createdAt: true, user: { select: { email: true, name: true } } },
  });
  if (!store) return [];

  const members = await prisma.storeMember.findMany({
    where: { storeId },
    orderBy: { createdAt: "asc" },
    select: { userId: true, role: true, createdAt: true, user: { select: { email: true, name: true } } },
  });

  return [
    {
      userId: store.userId,
      email: store.user.email,
      name: store.user.name,
      role: "OWNER" as StoreRole,
      isOwner: true,
      since: store.createdAt,
    },
    ...members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
      isOwner: false,
      since: m.createdAt,
    })),
  ];
}

export type AddMemberOutcome =
  | { added: true; userId: string }
  /** No Genesis account with that address. See the note below — not an invitation. */
  | { added: false; reason: "no_such_account" }
  /** They can already reach this business. */
  | { added: false; reason: "already_a_member" }
  /** That is the owner. */
  | { added: false; reason: "is_owner" };

/**
 * Give somebody access to this business.
 *
 * DELIBERATELY NOT AN INVITATION FLOW. Adding an address that has no Genesis
 * account would mean sending an email — and email delivery is externally
 * blocked here with no RESEND_API_KEY, so an "invitation" would be a row that
 * claims somebody was invited when nothing was sent. The honest v1 is: the
 * person makes an account, then the owner grants them access, and the refusal
 * says exactly that. Recorded as the real limitation it is rather than papered
 * over.
 */
export async function addMember(input: {
  storeId: string;
  actorUserId: string;
  email: string;
  role: StoreRole;
  userAgent?: string | null;
}): Promise<AddMemberOutcome> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { userId: true },
  });
  const person = await prisma.user.findUnique({
    // The same normalisation as every other lookup, from the one place
    // that defines it. This path already lowercased by hand — a second,
    // private copy of the rule is how the two drift apart.
    where: { email: normalizeEmail(input.email) },
    select: { id: true },
  });
  if (!person) return { added: false, reason: "no_such_account" };
  if (person.id === store.userId) return { added: false, reason: "is_owner" };

  const existing = await prisma.storeMember.findFirst({
    where: { storeId: input.storeId, userId: person.id },
    select: { id: true },
  });
  if (existing) return { added: false, reason: "already_a_member" };

  await prisma.storeMember.create({
    data: { storeId: input.storeId, userId: person.id, role: input.role },
  });

  // Recorded against the ACTOR's history — it is their account's act — and the
  // detail names the business and the role, because "someone was given access"
  // without saying to what is not something an owner can act on.
  await recordSecurityEvent({
    userId: input.actorUserId,
    kind: SECURITY_EVENTS.memberAdded,
    userAgent: input.userAgent,
    detail: { storeId: input.storeId, role: input.role },
  });
  return { added: true, userId: person.id };
}

export type ChangeRoleOutcome =
  | { changed: true }
  | { changed: false; reason: "not_a_member" }
  | { changed: false; reason: "is_owner" };

/** Change what somebody can do here. The owner's own role is not editable. */
export async function changeMemberRole(input: {
  storeId: string;
  actorUserId: string;
  userId: string;
  role: StoreRole;
  userAgent?: string | null;
}): Promise<ChangeRoleOutcome> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { userId: true },
  });
  // THE OWNER IS NOT A MEMBER AND CANNOT BE DEMOTED. Without this, a business
  // could be left with nobody who can manage it — an unrecoverable state
  // reached by a dropdown.
  if (input.userId === store.userId) return { changed: false, reason: "is_owner" };

  const result = await prisma.storeMember.updateMany({
    where: { storeId: input.storeId, userId: input.userId },
    data: { role: input.role },
  });
  if (result.count === 0) return { changed: false, reason: "not_a_member" };

  await recordSecurityEvent({
    userId: input.actorUserId,
    kind: SECURITY_EVENTS.memberRoleChanged,
    userAgent: input.userAgent,
    detail: { storeId: input.storeId, role: input.role },
  });
  return { changed: true };
}

export type RemoveMemberOutcome =
  | { removed: true; sessionsEnded: number }
  | { removed: false; reason: "not_a_member" }
  | { removed: false; reason: "is_owner" };

/**
 * Take somebody's access away.
 *
 * AND END THEIR SESSIONS. This is threat case T6 — a departing employee — and
 * removing the row alone would not have answered it: they hold a JWT that is
 * valid for up to 30 days and does not consult StoreMember on every request.
 * A removal that leaves them signed in is not a removal, which is exactly why
 * the contract sequenced member management AFTER session revocation.
 */
export async function removeMember(input: {
  storeId: string;
  actorUserId: string;
  userId: string;
  userAgent?: string | null;
}): Promise<RemoveMemberOutcome> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: input.storeId },
    select: { userId: true },
  });
  if (input.userId === store.userId) return { removed: false, reason: "is_owner" };

  const result = await prisma.storeMember.deleteMany({
    where: { storeId: input.storeId, userId: input.userId },
  });
  if (result.count === 0) return { removed: false, reason: "not_a_member" };

  // `currentSessionInstanceId: null` means "end everything" — this is the
  // removed person's account, and none of their sessions is the one asking.
  const ended = await revokeOtherSessions({
    userId: input.userId,
    currentSessionInstanceId: null,
  });

  await recordSecurityEvent({
    userId: input.actorUserId,
    kind: SECURITY_EVENTS.memberRemoved,
    userAgent: input.userAgent,
    detail: { storeId: input.storeId, sessionsEnded: ended.count },
  });
  return { removed: true, sessionsEnded: ended.count };
}
