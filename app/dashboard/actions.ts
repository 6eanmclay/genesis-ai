"use server";

import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireStorePermission } from "@/lib/permissions";
import { getConnector } from "@/lib/integrations/registry";
import { execute } from "@/lib/execution/engine";
import type { ExecutionResult } from "@/lib/execution/types";
import { publishStoreExecutable } from "@/lib/execution/executables/storePublish";
import { editStoreExecutable } from "@/lib/execution/executables/storeEdit";
import {
  createProductExecutable,
  editProductExecutable,
  toggleProductActiveExecutable,
  deleteProductExecutable,
} from "@/lib/execution/executables/products";
import { connectExecutable, verifyExecutable } from "@/lib/execution/adapters/integrationExecutable";
import { grantDelegatedAuthority, revokeDelegatedAuthority } from "@/lib/execution/genesisAutonomy";
import { logProductEvent } from "@/lib/telemetry/events";

// Family-beta instrumentation (v20) — one attempt per real connect/recheck
// call already exists as its own ExecutionLog row; this adds the
// `attemptKey`/session correlation ExecutionLog doesn't carry, so a
// sequence of attempts for the same (provider, store) can be reconstructed
// as "entered -> attempt 1 -> attempt 2 -> ... -> recovered/abandoned"
// without inventing a separate retry counter. Never blocks or throws —
// logProductEvent already swallows its own failures.
async function logConnectAttempt(
  provider: "stripe" | "paypal",
  action: string,
  result: ExecutionResult<unknown>
) {
  const session = await auth();
  if (!session?.user || !result.storeId) return;
  await logProductEvent({
    userId: session.user.id,
    storeId: result.storeId,
    sessionInstanceId: session.user.sessionInstanceId,
    name: action,
    category: "integration",
    attemptKey: `${provider}_connect:${result.storeId}`,
    outcome: result.status === "FAILED" ? "failure" : "success",
    metadata: { status: result.status, message: result.message },
  });
}

// JWT session strategy — signing out clears the session cookie itself
// (there's no server-side session row to revoke), which is what actually
// stops the browser Back button from restoring access: the cookie is gone,
// so any subsequent request (including one triggered by Back) has nothing
// for auth() to read. redirectTo lands on the now-public root entry page.
export async function signOutOfGenesis() {
  await signOut({ redirectTo: "/" });
}

export async function createProduct(formData: FormData) {
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const priceInput = formData.get("price") as string;
  const priceInCents = Math.round(parseFloat(priceInput) * 100);

  if (!name) {
    throw new Error("Product name is required");
  }
  if (!Number.isFinite(priceInCents) || priceInCents < 0) {
    throw new Error("Enter a valid price");
  }

  await execute(createProductExecutable, {
    name,
    description: description || null,
    priceInCents,
  });

  redirect("/dashboard/products");
}

export async function editStore(formData: FormData) {
  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();

  if (!name) {
    throw new Error("Store name is required");
  }

  await execute(editStoreExecutable, { name, description: description || null });

  redirect("/dashboard/settings");
}

export async function toggleStorePublished() {
  await execute(publishStoreExecutable, undefined);

  redirect("/dashboard/website");
}

export async function editProduct(productId: string, formData: FormData) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error("Product not found");
  }

  const name = (formData.get("name") as string)?.trim();
  const description = (formData.get("description") as string)?.trim();
  const priceInput = formData.get("price") as string;
  const priceInCents = Math.round(parseFloat(priceInput) * 100);

  if (!name) {
    throw new Error("Product name is required");
  }
  if (!Number.isFinite(priceInCents) || priceInCents < 0) {
    throw new Error("Enter a valid price");
  }

  await execute(
    editProductExecutable,
    { productId, name, description: description || null, priceInCents },
    { storeId: product.storeId }
  );

  redirect("/dashboard/products");
}

export async function toggleProductActive(productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error("Product not found");
  }

  await execute(
    toggleProductActiveExecutable,
    { productId, currentActive: product.active },
    { storeId: product.storeId }
  );

  redirect("/dashboard/products");
}

export async function deleteProduct(productId: string) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product) {
    throw new Error("Product not found");
  }

  await execute(
    deleteProductExecutable,
    { productId, name: product.name },
    { storeId: product.storeId }
  );

  redirect("/dashboard/products");
}

export async function connectStripe() {
  const result = await execute(connectExecutable(getConnector("STRIPE")), {});
  await logConnectAttempt("stripe", "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl);
  }

  redirect("/dashboard/payments");
}

export async function disconnectStripe() {
  const { storeId } = await requireStorePermission(PERMISSIONS.PAYMENTS_MANAGE);

  await getConnector("STRIPE").disconnect(storeId);

  redirect("/dashboard/payments");
}

export async function recheckStripe() {
  const result = await execute(verifyExecutable(getConnector("STRIPE")), undefined);
  await logConnectAttempt("stripe", "integration.recheck_attempt", result);

  redirect("/dashboard/payments");
}

export async function connectPaypal() {
  const result = await execute(connectExecutable(getConnector("PAYPAL")), {});
  await logConnectAttempt("paypal", "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl); // never true for PayPal today — kept for structural symmetry with connectStripe
  }

  redirect("/dashboard/payments");
}

// The second `connect()` call a form-based connector needs — Stripe's OAuth
// flow never had an equivalent, since the callback route plays this role
// for redirect-based connectors instead.
export async function submitPaypalCredentials(formData: FormData) {
  const clientId = (formData.get("clientId") as string)?.trim();
  const clientSecret = (formData.get("clientSecret") as string)?.trim();
  const environment = (formData.get("environment") as string)?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Client ID and Secret are required");
  }

  const result = await execute(connectExecutable(getConnector("PAYPAL")), {
    params: { clientId, clientSecret, environment },
  });
  await logConnectAttempt("paypal", "integration.connect_attempt", result);

  redirect("/dashboard/payments");
}

export async function disconnectPaypal() {
  const { storeId } = await requireStorePermission(PERMISSIONS.PAYMENTS_MANAGE);

  await getConnector("PAYPAL").disconnect(storeId);

  redirect("/dashboard/payments");
}

export async function recheckPaypal() {
  const result = await execute(verifyExecutable(getConnector("PAYPAL")), undefined);
  await logConnectAttempt("paypal", "integration.recheck_attempt", result);

  redirect("/dashboard/payments");
}

// Phase 6 — owner-only (AUTHORITY_MANAGE is never granted to EMPLOYEE, see
// lib/permissions.ts), so grantedByUserId is always an owner: an employee
// cannot create, benefit from, or influence a delegation. formData carries
// actionType directly rather than a typed enum since the calling form
// already only ever renders one delegable action's toggle at a time (see
// app/dashboard/marketing/page.tsx) — grantDelegatedAuthority itself throws
// if the actionType turns out not to be delegable, so this can't silently
// grant something it shouldn't.
export async function grantAuthority(formData: FormData) {
  const { storeId, userId } = await requireStorePermission(PERMISSIONS.AUTHORITY_MANAGE);
  const actionType = formData.get("actionType") as string;

  await grantDelegatedAuthority({ storeId, actionType, grantedByUserId: userId });

  redirect("/dashboard/marketing");
}

export async function revokeAuthority(formData: FormData) {
  const { storeId } = await requireStorePermission(PERMISSIONS.AUTHORITY_MANAGE);
  const actionType = formData.get("actionType") as string;

  await revokeDelegatedAuthority(storeId, actionType);

  redirect("/dashboard/marketing");
}
