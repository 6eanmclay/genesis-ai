"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { auth } from "@/auth";
import {
  beginTwoFactorSetup,
  enableTwoFactor,
  disableTwoFactor,
  regenerateRecoveryCodes,
} from "@/lib/security/twoFactor";
import { revokeSession, revokeOtherSessions } from "@/lib/security/sessions";
import { confirmPassword, hasFreshConfirmation, clearConfirmation } from "@/lib/security/reauthentication";

// THE SECURITY-SENSITIVE ACTIONS, AND THE ONE GUARD THEY ALL PASS THROUGH.
//
// Every function here that changes the account's defences calls requireOwner()
// and then, where it matters, requireConfirmation(). Both live in this file and
// nowhere else, so there is one answer to "is this person allowed to do this"
// rather than one per action that could drift apart — the same reason
// lib/permissions.ts owns the business-side rule.
//
// WHY CONFIRMATION AND NOT JUST A SESSION. A live session is exactly what an
// attacker who phished a password or stole a laptop is already holding. Threat
// case T3: without this, "turn off two-factor authentication" is one click for
// somebody who is already in.

const SECURITY_PATH = "/account/security";

async function requireOwner() {
  const session = await auth();
  if (!session?.user?.id) throw new Error("Not signed in.");
  const requestHeaders = await headers();
  return {
    userId: session.user.id,
    email: session.user.email ?? "",
    userAgent: requestHeaders.get("user-agent"),
    sessionInstanceId: (session.user as { sessionInstanceId?: string }).sessionInstanceId ?? null,
  };
}

/**
 * Refuse unless the password was confirmed within the window.
 *
 * Throws rather than returning a flag: a caller that forgot to check a returned
 * boolean would silently perform the action, and this is the guard where that
 * mistake is most expensive.
 */
async function requireConfirmation(userId: string) {
  if (!(await hasFreshConfirmation(userId))) {
    throw new Error("Confirm your password before changing your security settings.");
  }
}

export async function confirmPasswordAction(formData: FormData) {
  const { userId, userAgent, sessionInstanceId } = await requireOwner();
  const password = String(formData.get("password") ?? "");
  const outcome = await confirmPassword({ userId, password, userAgent, sessionInstanceId });
  revalidatePath(SECURITY_PATH);
  return outcome;
}

export async function beginSetupAction() {
  const { userId, email } = await requireOwner();
  await requireConfirmation(userId);
  const setup = await beginTwoFactorSetup({ userId, accountEmail: email });
  revalidatePath(SECURITY_PATH);
  // The secret and URI are returned to the caller to be displayed once. They
  // are not persisted anywhere readable and not written to the history.
  return setup;
}

export async function enableAction(formData: FormData) {
  const { userId, userAgent } = await requireOwner();
  await requireConfirmation(userId);
  const outcome = await enableTwoFactor({
    userId,
    token: String(formData.get("token") ?? ""),
    userAgent,
  });
  // SPENT ONLY ON SUCCESS. A wrong code should not cost the owner their
  // confirmation and make them type the password again to try the next code.
  if (outcome.enabled) await clearConfirmation(userId);
  revalidatePath(SECURITY_PATH);
  return outcome;
}

export async function disableAction() {
  const { userId, userAgent } = await requireOwner();
  await requireConfirmation(userId);
  await disableTwoFactor({ userId, userAgent });
  await clearConfirmation(userId);
  revalidatePath(SECURITY_PATH);
}

export async function regenerateAction() {
  const { userId, userAgent } = await requireOwner();
  await requireConfirmation(userId);
  const codes = await regenerateRecoveryCodes({ userId, userAgent });
  await clearConfirmation(userId);
  revalidatePath(SECURITY_PATH);
  return codes;
}

export async function endSessionAction(sessionInstanceId: string) {
  const { userId, userAgent, sessionInstanceId: current } = await requireOwner();
  // Deliberately NOT behind requireConfirmation. Ending a session only ever
  // reduces access, and an owner who has just realised somebody else is signed
  // in should not have to find their password first. Every other action here
  // grants or weakens; this one only takes away.
  const outcome = await revokeSession({
    userId,
    sessionInstanceId,
    currentSessionInstanceId: current,
    userAgent,
  });
  revalidatePath(SECURITY_PATH);
  return outcome;
}

export async function endOtherSessionsAction() {
  const { userId, userAgent, sessionInstanceId: current } = await requireOwner();
  const outcome = await revokeOtherSessions({ userId, currentSessionInstanceId: current, userAgent });
  revalidatePath(SECURITY_PATH);
  return outcome;
}
