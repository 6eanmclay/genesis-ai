"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { auth, signOut } from "@/auth";
import { RecoverableError, toActionState, type ActionState } from "@/lib/actionState";
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
import { toggleOrderFulfilledExecutable } from "@/lib/execution/executables/orders";
import {
  addProductImagesExecutable,
  reorderProductImagesExecutable,
  deleteProductImageExecutable,
  replaceProductImageExecutable,
} from "@/lib/execution/executables/productImages";
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

export async function createProduct(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const name = (formData.get("name") as string)?.trim();
    const description = (formData.get("description") as string)?.trim();
    const priceInput = formData.get("price") as string;
    const priceInCents = Math.round(parseFloat(priceInput) * 100);

    if (!name) {
      throw new RecoverableError("Product name is required");
    }
    if (!Number.isFinite(priceInCents) || priceInCents < 0) {
      throw new RecoverableError("Enter a valid price");
    }

    // Real mobile bug fix (2026-08-08) — this used to receive the raw File
    // itself and upload it server-side, which meant a real phone photo's
    // bytes had to survive this Server Action's own request body — hard-
    // capped by Vercel's platform-level 4.5MB Function payload ceiling
    // (confirmed against Vercel's current docs; ExecutionLog showed zero
    // FAILED product.create rows despite a real reported mobile failure,
    // meaning the request was dying before this code ever ran). The
    // browser now uploads directly to Blob (CreateProductForm.tsx, same
    // real mechanism J4's chat uploads already use) and this action only
    // ever receives the resulting URLs — short strings, regardless of the
    // real photos' size. Product media gallery (2026-08-08) — a real JSON
    // array now (multi-select from the start), not a single optional URL.
    let uploadedImageUrls: string[] = [];
    const imageUrlsRaw = formData.get("imageUrls") as string | null;
    if (imageUrlsRaw) {
      try {
        const parsed = JSON.parse(imageUrlsRaw);
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
          uploadedImageUrls = parsed;
        }
      } catch {
        // Malformed input from a tampered client — treated the same as no
        // photos chosen rather than failing the whole product creation.
      }
    }

    const result = await execute(createProductExecutable, {
      name,
      description: description || null,
      priceInCents,
      uploadedImageUrls,
    });
    // Real bug fix (2026-08-08) — execute() never throws for a business-
    // logic failure inside run(); it catches everything internally and
    // returns a FAILED ExecutionResult instead (see engine.ts's own doc
    // comment). This result was previously discarded entirely — ANY
    // failure inside createProductExecutable.run() (an image upload
    // rejected, or anything else) silently redirected to the products list
    // as if the product had been created, with nothing actually saved and
    // no error shown at all.
    if (result.status === "FAILED") {
      throw new RecoverableError(result.message);
    }
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error, formData);
  }

  redirect("/dashboard/products");
}

// Product media gallery (2026-08-08) — plain callable Server Actions
// (never a <form action>/redirect pattern like the actions above), meant
// to be invoked directly from ProductImageGallery.tsx's own client code
// via callGenesisAction, the same real pattern J4's own upload flows
// already use. Each urls/url argument is already a real, final, direct-
// to-Blob-uploaded URL by the time it reaches here — these actions never
// see file bytes, only strings, so none of them can hit the platform body
// ceiling the mobile upload bug was rooted in. No redirect: the gallery
// stays on the same page and re-renders from the real returned/refreshed
// data instead of a full navigation, since a delete/reorder/replace click
// should feel instant, not trigger a page reload.
// Same real behavior uploadProductImage always had (preserved here, not
// dropped, when that single-photo form was replaced by the gallery below)
// — a manual choice about a product's own primary photo supersedes any
// still-pending Genesis-proposed image for that exact product; an old
// proposed candidate left pending would be stale and confusing once the
// owner has already made their own direct decision.
async function supersedePendingImageApproval(storeId: string, productId: string) {
  await prisma.approvalRequest.deleteMany({
    where: {
      storeId,
      actionType: "update_product_image",
      status: "PENDING_APPROVAL",
      input: { path: ["productId"], equals: productId },
    },
  });
}

export async function addProductImages(productId: string, urls: string[]) {
  const { storeId } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE);
  const existingCount = await prisma.productImage.count({ where: { productId } });
  const result = await execute(addProductImagesExecutable, { productId, urls }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
  // Only the first image(s) on a previously-empty product actually change
  // the primary — see addProductImagesExecutable's own identical check.
  if (existingCount === 0) {
    await supersedePendingImageApproval(storeId, productId);
  }
}

export async function reorderProductImages(productId: string, orderedImageIds: string[]) {
  const { storeId } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE);
  const result = await execute(reorderProductImagesExecutable, { productId, orderedImageIds }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
}

export async function deleteProductImage(imageId: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE);
  const result = await execute(deleteProductImageExecutable, { imageId }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
}

export async function replaceProductImage(imageId: string, url: string) {
  const { storeId } = await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE);
  const image = await prisma.productImage.findUnique({ where: { id: imageId }, select: { productId: true, position: true } });
  const result = await execute(replaceProductImageExecutable, { imageId, url }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
  if (image?.position === 0) {
    await supersedePendingImageApproval(storeId, image.productId);
  }
}

export async function editStore(
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const name = (formData.get("name") as string)?.trim();
    const tagline = (formData.get("tagline") as string)?.trim();
    const description = (formData.get("description") as string)?.trim();

    if (!name) {
      throw new RecoverableError("Store name is required");
    }

    await execute(editStoreExecutable, { name, tagline: tagline || null, description: description || null });
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error, formData);
  }

  // Real mobile beta feedback (2026-08-06) — this form only ever renders on
  // /dashboard/brand (EditStoreForm's only real call site); redirecting to
  // Settings was a stale target left over from before "Business Identity"
  // was consolidated onto the Brand page (see brand/page.tsx's own
  // comment). A first-time owner saving their business name got silently
  // navigated away from the page they were just looking at.
  redirect("/dashboard/brand");
}

export async function toggleStorePublished() {
  const result = await execute(publishStoreExecutable, undefined);

  redirect(result.status === "FAILED" ? "/dashboard/website?publish_error=1" : "/dashboard/website");
}

export async function editProduct(
  productId: string,
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const product = await prisma.product.findUnique({ where: { id: productId } });
    if (!product) {
      throw new RecoverableError("Product not found");
    }

    const name = (formData.get("name") as string)?.trim();
    const description = (formData.get("description") as string)?.trim();
    const priceInput = formData.get("price") as string;
    const priceInCents = Math.round(parseFloat(priceInput) * 100);

    if (!name) {
      throw new RecoverableError("Product name is required");
    }
    if (!Number.isFinite(priceInCents) || priceInCents < 0) {
      throw new RecoverableError("Enter a valid price");
    }

    await execute(
      editProductExecutable,
      { productId, name, description: description || null, priceInCents },
      { storeId: product.storeId }
    );
  } catch (error) {
    unstable_rethrow(error);
    return toActionState(error, formData);
  }

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

export async function toggleOrderFulfilled(orderId: string) {
  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new Error("Order not found");
  }

  await execute(
    toggleOrderFulfilledExecutable,
    { orderId, currentlyFulfilled: order.fulfillmentStatus === "fulfilled" },
    { storeId: order.storeId }
  );

  redirect("/dashboard/orders");
}

export async function connectStripe() {
  const result = await execute(connectExecutable(getConnector("STRIPE")), {});
  await logConnectAttempt("stripe", "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl);
  }

  // Reached only when this very first call already failed (e.g. Stripe
  // Connect isn't configured) — no OAuth round-trip ever started, so the
  // callback route's own failure-surfacing never gets a chance to run.
  // Without this flash param, a merchant could click "Connect Stripe" and
  // silently land right back where they started with no explanation.
  redirect(result.status === "FAILED" ? "/dashboard/payments?integration_error=stripe" : "/dashboard/payments");
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

  // PayPal never leaves this app (no OAuth round-trip), so this is the one
  // place a PayPal connect attempt actually resolves — flash param mirrors
  // the Stripe callback route's own for a consistent experience across both
  // providers, on top of the durable "Last attempt failed" line already
  // shown below when no integration exists yet.
  redirect(
    result.status === "FAILED"
      ? "/dashboard/payments?integration_error=paypal"
      : "/dashboard/payments?integration_connected=paypal"
  );
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
