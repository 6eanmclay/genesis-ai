import "server-only";

import type { IntegrationProvider } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCreationSupplier } from "./registry";
import { chooseCreationSupplier, CREATION_SUPPLIER_ORDER } from "./supplierChoice";
import type { CreationProvider } from "./garment";

// WHICH SUPPLIER CAN HOST A DESIGN, FOR THIS BUSINESS.
//
// `server-only`: this reads encrypted supplier credentials, so importing it
// from a client component is a build error rather than a review comment.
//
// ============ NOW ACTUALLY NOT HARD-CODED (2026-08-28) ==================
//
// This file used to say "one provider today, and not hard-coded" directly
// above a query for `provider: "PRINTFUL"`. Only the first half was true. A
// second supplier could have been connected, held credentials and implemented
// every method, and this would still have answered "no supplier".
//
// It now walks lib/creation/registry.ts. Printful is the only entry, which is a
// fact about what is built rather than a decision baked in here — and the
// difference is now structural rather than a promise in a comment.
//
// Everything downstream was already agnostic: the Garment carries its own
// provider, Creation Station reads capabilities off it, and saveDesign.ts
// records `fulfillmentProvider: garment.provider`.

/**
 * The creation provider a business can design through, or null.
 *
 * NULL IS A REAL ANSWER, not a failure. A business that has not connected a
 * print supplier cannot design a garment, and saying so is the honest response
 * — the alternative is a catalogue of blanks nobody can actually order.
 */
export async function creationProviderFor(storeId: string): Promise<CreationProvider | null> {
  return (await creationAccessFor(storeId)).provider;
}

/** Whether a supplier can be reached, and what to say when it cannot. */
export interface CreationAccess {
  /** Present whenever credentials exist -- see the note below. */
  provider: CreationProvider | null;
  /** The integration row's own status, or null when there is no row at all. */
  status: "CONNECTED" | "NEEDS_ATTENTION" | "FAILED" | "DISCONNECTED" | null;
  /**
   * WHICH supplier answered, or null when none did.
   *
   * Carried so a caller can name the supplier without guessing at one. Nothing
   * should read this to branch on behaviour — that is what the provider's own
   * methods are for — but a screen that wants to say who it is talking to
   * should say the one that actually answered.
   */
  supplier: IntegrationProvider | null;
}

/**
 * The creation provider a business can design through, and why not.
 *
 * ============ CONNECTED-BUT-TOLD-TO-CONNECT (2026-08-27) ===============
 *
 * This used to require status === "CONNECTED" and return null otherwise, so a
 * Printful integration sitting at NEEDS_ATTENTION or FAILED -- which still
 * holds real, working-in-most-cases credentials -- produced the same answer as
 * having no supplier at all. The owner was then shown "Connect a print
 * supplier" about a supplier they had already connected, with no way to tell
 * the two situations apart.
 *
 * So the provider is built whenever CREDENTIALS EXIST, and the status travels
 * beside it. A stale status is a fact about the last verification, not about
 * whether a catalogue call will work now -- and letting the real call decide is
 * both more honest and more likely to just work. Where it genuinely does not,
 * the caller has the status and can say something true.
 *
 * DISCONNECTED is the one status that really does mean no: disconnecting
 * clears the credentials, so there is nothing to build a provider from.
 */
export async function creationAccessFor(storeId: string): Promise<CreationAccess> {
  // ONE QUERY FOR EVERY SUPPLIER THAT COULD ANSWER, rather than one per
  // supplier in a loop. With a single entry the difference is nothing; the
  // point is that adding suppliers must not add round trips to a page load.
  const rows = await prisma.storeIntegration.findMany({
    where: { storeId, provider: { in: CREATION_SUPPLIER_ORDER } },
    select: { provider: true, status: true, credentials: true },
  });

  // THE DECISION IS MADE BY A PURE FUNCTION, and the credentials do not travel
  // into it — only whether they exist. See lib/creation/supplierChoice.ts,
  // which is where this rule is actually tested.
  const { supplier, status } = chooseCreationSupplier(
    rows.map((r) => ({ provider: r.provider, status: r.status, hasCredentials: r.credentials !== null })),
  );

  const entry = getCreationSupplier(supplier);
  return { provider: entry?.connect() ?? null, status, supplier: entry ? supplier : null };
}
