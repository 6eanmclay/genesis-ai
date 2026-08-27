import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/integrations/credentials";
import { supplierRequest } from "@/lib/sourcing/sourcingBudget";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { printfulCreationProvider } from "./printfulCreation";
import { printfulUrl, printfulHeaders, printfulFailure, isStoreScoped } from "./printfulRequest";
import type { CreationProvider } from "./garment";

// WHICH SUPPLIER CAN HOST A DESIGN, FOR THIS BUSINESS.
//
// `server-only`: this reads encrypted supplier credentials, so importing it
// from a client component is a build error rather than a review comment.
//
// ============ ONE PROVIDER TODAY, AND NOT HARD-CODED =====================
//
// Printful is the only connector that answers the creation questions today, and
// that is a fact about what is connected rather than a decision baked into the
// Creation Station. Everything upstream is written against CreationProvider, so
// a second supplier is a second entry here and a mapping file — the same shape
// lib/fulfillment/registry.ts and lib/sourcing/registry.ts already hold.
//
// Printify is the obvious second: its catalogue exposes blueprints, print
// providers, variants and print areas, which is the same set of facts under
// different names. It is not built, and nothing here pretends it is.

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
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
    select: { id: true, status: true, credentials: true },
  });
  if (!integration?.credentials) return { provider: null, status: integration?.status ?? null };

  const provider = printfulCreationProvider(async (scopedStoreId, operation, path) => {
    // RESOLVED PER CALL, so a token that expires mid-session is refreshed
    // rather than failing the second request. Same rule the fulfilment
    // connector already follows.
    const row = await prisma.storeIntegration.findUnique({
      where: { storeId_provider: { storeId: scopedStoreId, provider: "PRINTFUL" } },
    });
    if (!row?.credentials) throw new Error("Printful is not connected for this store.");

    const stored = decryptCredentials<PrintfulCredentials>(row.credentials);
    const credentials = await refreshPrintfulToken(stored);
    if (credentials.accessToken !== stored.accessToken) {
      await prisma.storeIntegration.update({
        where: { id: row.id, storeId: scopedStoreId },
        data: { credentials: encryptCredentials(credentials) },
      });
    }

    // THROUGH THE SAME BOUNDARY every other supplier call goes through, so an
    // unattended run's budget is a real ceiling here too rather than a tally.
    const response = await supplierRequest({ sourceKey: "printful", operation, storeId: scopedStoreId }, () =>
      fetch(printfulUrl(path), {
        // Both the URL and the headers come from printfulRequest.ts, which a
        // suite can reach. Building them here is what let a missing store
        // header sit unnoticed until it failed in front of the owner.
        headers: printfulHeaders(credentials.accessToken, credentials.printfulStoreId, isStoreScoped(path)),
        signal: AbortSignal.timeout(20_000),
      }),
    );

    if (!response.ok) {
      // THE PROVIDER'S OWN WORDS, NOT JUST A NUMBER. This threw
      // `Printful creation.catalog failed (400)` and dropped the body.
      throw new Error(
        printfulFailure(operation, response.status, await response.text().catch(() => ""), path),
      );
    }
    return response.json();
  });

  return { provider, status: integration.status };
}
