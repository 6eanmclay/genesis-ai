"use server";

import { redirect, unstable_rethrow } from "next/navigation";
import { revalidatePath } from "next/cache";
import { parsePackagedWeight } from "@/lib/shipping/packagedWeight";
import { auth, signOut } from "@/auth";
import { RecoverableError, toActionState, type ActionState } from "@/lib/actionState";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE, businessBasePath } from "@/lib/dashboard/navConfig";
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
import { attachTrackingExecutable } from "@/lib/execution/executables/attachTracking";
import { purchaseShippingLabelExecutable } from "@/lib/execution/executables/shipping";
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
  provider: "stripe" | "paypal" | "usps",
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

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). These called execute() without a storeId, so execute() resolved the
// account's ACTIVE business itself — the last implicit resolution on the write
// path. An action invoked from one business's page would have run its executable
// against another business entirely.
//
// execute() has always accepted an explicit storeId. What was missing was
// callers supplying one.
export async function createProduct(
  slug: string | undefined,
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
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
    }, { storeId: businessId });
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

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/products`);
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

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). These resolve the store implicitly and pass it as the SCOPE the executable
// runs in — they do not derive it from the entity. So a page rendered for one
// business calling one of these while the account was active in another would
// have handed the executable the wrong scope entirely.
export async function addProductImages(slug: string | undefined, productId: string, urls: string[]) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
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

export async function reorderProductImages(slug: string | undefined, productId: string, orderedImageIds: string[]) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const result = await execute(reorderProductImagesExecutable, { productId, orderedImageIds }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
}

export async function deleteProductImage(slug: string | undefined, imageId: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const result = await execute(deleteProductImageExecutable, { imageId }, { storeId });
  if (result.status === "FAILED") {
    throw new Error(result.message);
  }
}

export async function replaceProductImage(slug: string | undefined, imageId: string, url: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
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
  slug: string | undefined,
  prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.STORE_MANAGE, slug);
  try {
    const name = (formData.get("name") as string)?.trim();
    const tagline = (formData.get("tagline") as string)?.trim();
    const description = (formData.get("description") as string)?.trim();

    if (!name) {
      throw new RecoverableError("Store name is required");
    }

    await execute(editStoreExecutable, { name, tagline: tagline || null, description: description || null }, { storeId: businessId });
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
  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/brand`);
}

export async function toggleStorePublished(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const result = await execute(publishStoreExecutable, undefined, { storeId: businessId });

  redirect(result.status === "FAILED" ? `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/website?publish_error=1` : `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/website`);
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

    // THE PACKAGED SHIPPING WEIGHT (2026-08-25). Product.weightOz has existed
    // since 2026-08-20 and nothing has ever written it — which is why checkout
    // shipping, which is fully built, is unreachable on all 55 production
    // products. Parsed rather than trusted: the merchant types pounds and
    // ounces, and ounces is the stored unit.
    const weight = parsePackagedWeight(
      formData.get("weightLb") as string | null,
      formData.get("weightOz") as string | null
    );
    if (!weight.ok) {
      throw new RecoverableError(weight.error);
    }

    await execute(
      editProductExecutable,
      {
        productId,
        name,
        description: description || null,
        priceInCents,
        weightOz: weight.weightOz,
      },
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

/**
 * Record a tracking number the merchant already has.
 *
 * Same fetch-then-authorize shape as toggleOrderFulfilled below: the lookup
 * exists only to learn which store owns the order, so execute() can re-verify
 * the caller's permission against that store.
 *
 * Returns rather than redirects, because the result carries something the
 * merchant must read — on a deployment with no email configured, the buyer was
 * NOT told, and only the merchant can put that right. Redirecting would throw
 * that sentence away.
 */
export async function attachTrackingNumber(
  orderId: string,
  trackingNumber: string,
  carrier?: string
): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { storeId: true },
  });
  if (!order) return { ok: false, error: "Order not found" };

  const result = await execute(
    attachTrackingExecutable,
    { orderId, trackingNumber, carrier },
    { storeId: order.storeId }
  );
  revalidatePath("/dashboard/orders");
  return result.status === "SUCCESS"
    ? { ok: true, message: result.message }
    : { ok: false, error: result.message };
}

export async function toggleOrderFulfilled(orderId: string) {
  // The lookup is only here to learn WHICH store this order belongs to, so that
  // execute() can re-verify the caller's permission against that store — the
  // confirmed-safe fetch-then-authorize pattern (see ARCHITECTURE.md). It no
  // longer reads the fulfilment state: the executable reads that itself, so a
  // stale page cannot toggle against a status that has since changed.
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { storeId: true },
  });
  if (!order) {
    throw new Error("Order not found");
  }

  await execute(toggleOrderFulfilledExecutable, { orderId }, { storeId: order.storeId });

  redirect("/dashboard/orders");
}

// BOUND TO THE NAMED BUSINESS (2026-08-21, BUSINESS_CONTEXT.md Phase C).
//
// The seven connector actions below already resolved `businessId` from the slug
// — and then called execute() without it, so execute() re-resolved the account's
// ACTIVE business on its own. Permission was checked against the business named
// in the URL while the executable ran against a different one.
//
// Not theoretical, and worse than an ordinary mis-route: these actions write
// real payment and carrier credentials. On /b/copper-coil/payments, connecting
// Stripe would have attached the credentials to whichever business happened to
// be active. BUSINESS_CONTEXT.md's own rule — "a named business the account
// cannot reach is refused, never substituted" — was being broken in the one
// direction nothing checks, because both businesses ARE reachable.
//
// The fix is the argument execute() has always accepted.
export async function connectStripe(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);
  const result = await execute(connectExecutable(getConnector("STRIPE")), {}, { storeId: businessId });
  await logConnectAttempt("stripe", "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl);
  }

  // Reached only when this very first call already failed (e.g. Stripe
  // Connect isn't configured) — no OAuth round-trip ever started, so the
  // callback route's own failure-surfacing never gets a chance to run.
  // Without this flash param, a merchant could click "Connect Stripe" and
  // silently land right back where they started with no explanation.
  redirect(result.status === "FAILED" ? `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments?integration_error=stripe` : `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments`);
}

export async function disconnectStripe(slug?: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);

  await getConnector("STRIPE").disconnect(storeId);

  redirect("/dashboard/payments");
}

export async function recheckStripe(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);
  const result = await execute(verifyExecutable(getConnector("STRIPE")), undefined, { storeId: businessId });
  await logConnectAttempt("stripe", "integration.recheck_attempt", result);

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments`);
}

export async function connectPaypal(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);
  const result = await execute(connectExecutable(getConnector("PAYPAL")), {}, { storeId: businessId });
  await logConnectAttempt("paypal", "integration.connect_attempt", result);
  if (result.redirectUrl) {
    redirect(result.redirectUrl); // never true for PayPal today — kept for structural symmetry with connectStripe
  }

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments`);
}

// The second `connect()` call a form-based connector needs — Stripe's OAuth
// flow never had an equivalent, since the callback route plays this role
// for redirect-based connectors instead.
export async function submitPaypalCredentials(
  slug: string | undefined,formData: FormData) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);
  const clientId = (formData.get("clientId") as string)?.trim();
  const clientSecret = (formData.get("clientSecret") as string)?.trim();
  const environment = (formData.get("environment") as string)?.trim();

  if (!clientId || !clientSecret) {
    throw new Error("Client ID and Secret are required");
  }

  const result = await execute(
    connectExecutable(getConnector("PAYPAL")),
    { params: { clientId, clientSecret, environment } },
    { storeId: businessId }
  );
  await logConnectAttempt("paypal", "integration.connect_attempt", result);

  // PayPal never leaves this app (no OAuth round-trip), so this is the one
  // place a PayPal connect attempt actually resolves — flash param mirrors
  // the Stripe callback route's own for a consistent experience across both
  // providers, on top of the durable "Last attempt failed" line already
  // shown below when no integration exists yet.
  redirect(
    result.status === "FAILED"
      ? `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments?integration_error=paypal`
      : `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments?integration_connected=paypal`
  );
}

export async function disconnectPaypal(slug?: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);

  await getConnector("PAYPAL").disconnect(storeId);

  redirect("/dashboard/payments");
}

export async function recheckPaypal(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.PAYMENTS_MANAGE, slug);
  const result = await execute(verifyExecutable(getConnector("PAYPAL")), undefined, { storeId: businessId });
  await logConnectAttempt("paypal", "integration.recheck_attempt", result);

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/payments`);
}

// Priority 2 (shipping, 2026-08-09) — same form-based connect pattern as
// PayPal (an EasyPost account has no OAuth flow either, just an API key).
export async function submitUspsCredentials(
  slug: string | undefined,formData: FormData) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.ORDERS_MANAGE, slug);
  const apiKey = (formData.get("apiKey") as string)?.trim();
  if (!apiKey) {
    throw new Error("EasyPost API Key is required");
  }

  const result = await execute(
    connectExecutable(getConnector("EASYPOST")),
    { params: { apiKey } },
    { storeId: businessId }
  );
  await logConnectAttempt("usps", "integration.connect_attempt", result);

  redirect(
    result.status === "FAILED" ? `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/orders?integration_error=usps` : `${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/orders?integration_connected=usps`
  );
}

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). `slug` is bound by the page under /b/[slug]; the legacy /dashboard page
// passes nothing and resolves the account's active business exactly as before.
//
// The redirect follows the business too. A slug-bound action that sent the owner
// back to /dashboard/orders would have disconnected the right business and then
// shown them a different one.
export async function disconnectUsps(slug?: string) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.ORDERS_MANAGE, slug);

  await getConnector("EASYPOST").disconnect(storeId);

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/orders`);
}

export async function recheckUsps(slug?: string) {
  const { storeId: businessId } = await requireBusinessOrActive(PERMISSIONS.ORDERS_MANAGE, slug);
  const result = await execute(verifyExecutable(getConnector("EASYPOST")), undefined, { storeId: businessId });
  await logConnectAttempt("usps", "integration.recheck_attempt", result);

  redirect(`${slug ? businessBasePath(slug) : LEGACY_BUSINESS_BASE}/orders`);
}

// Priority 2 (shipping, 2026-08-09) — buys one real USPS label for one
// order, via EasyPost. See purchaseShippingLabelExecutable's own comment
// for why this is deliberately owner-triggered, never automatic.
export async function purchaseShippingLabel(formData: FormData) {
  const orderId = formData.get("orderId") as string;
  const weightOz = Number(formData.get("weightOz"));
  const lengthIn = formData.get("lengthIn") ? Number(formData.get("lengthIn")) : undefined;
  const widthIn = formData.get("widthIn") ? Number(formData.get("widthIn")) : undefined;
  const heightIn = formData.get("heightIn") ? Number(formData.get("heightIn")) : undefined;

  const order = await prisma.order.findUnique({ where: { id: orderId } });
  if (!order) {
    throw new Error("Order not found");
  }

  await execute(
    purchaseShippingLabelExecutable,
    { orderId, weightOz, lengthIn, widthIn, heightIn },
    { storeId: order.storeId }
  );

  redirect("/dashboard/orders");
}

// Priority 2 (shipping, 2026-08-09) — the owner's own ship-from address,
// required before any label can be bought (see purchaseShippingLabelExecutable's
// own honest-error check). A plain field update, not a real Executable —
// no external system call, no verification step, matching how Store.theme
// and other plain-JSON settings fields are already saved elsewhere.
// MIGRATED — see disconnectUsps above. Bound as
// saveReturnAddress.bind(null, slug) by the business-scoped page, so the address
// is written to the business whose page the form was rendered on rather than to
// whichever one the account was last active in.
export async function saveReturnAddress(slug: string | undefined, formData: FormData) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.ORDERS_MANAGE, slug);

  const name = (formData.get("name") as string)?.trim();
  const phone = (formData.get("phone") as string)?.trim();
  const line1 = (formData.get("line1") as string)?.trim();
  const line2 = (formData.get("line2") as string)?.trim() || null;
  const city = (formData.get("city") as string)?.trim();
  const state = (formData.get("state") as string)?.trim() || null;
  const postalCode = (formData.get("postalCode") as string)?.trim();
  const country = (formData.get("country") as string)?.trim() || "US";

  if (!name || !phone || !line1 || !city || !postalCode) {
    throw new Error("Name, phone, address, city, and postal code are required");
  }

  await prisma.store.update({
    where: { id: storeId },
    data: { returnAddress: { name, phone, line1, line2, city, state, postalCode, country } },
  });

  redirect("/dashboard/orders");
}

// Phase 6 — owner-only (AUTHORITY_MANAGE is never granted to EMPLOYEE, see
// lib/permissions.ts), so grantedByUserId is always an owner: an employee
// cannot create, benefit from, or influence a delegation. formData carries
// actionType directly rather than a typed enum since the calling form
// already only ever renders one delegable action's toggle at a time (see
// app/dashboard/marketing/page.tsx) — grantDelegatedAuthority itself throws
// if the actionType turns out not to be delegable, so this can't silently
// grant something it shouldn't.
export async function grantAuthority(slug: string | undefined, formData: FormData) {
  const { storeId, userId } = await requireBusinessOrActive(PERMISSIONS.AUTHORITY_MANAGE, slug);
  const actionType = formData.get("actionType") as string;

  await grantDelegatedAuthority({ storeId, actionType, grantedByUserId: userId });

  redirect("/dashboard/marketing");
}

export async function revokeAuthority(slug: string | undefined, formData: FormData) {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.AUTHORITY_MANAGE, slug);
  const actionType = formData.get("actionType") as string;

  await revokeDelegatedAuthority(storeId, actionType);

  redirect("/dashboard/marketing");
}
