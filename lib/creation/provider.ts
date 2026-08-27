import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/integrations/credentials";
import { supplierRequest } from "@/lib/sourcing/sourcingBudget";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { printfulCreationProvider, PRINTFUL_V2_BASE } from "./printfulCreation";
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
  const integration = await prisma.storeIntegration.findUnique({
    where: { storeId_provider: { storeId, provider: "PRINTFUL" } },
    select: { id: true, status: true, credentials: true },
  });
  if (integration?.status !== "CONNECTED" || !integration.credentials) return null;

  return printfulCreationProvider(async (scopedStoreId, operation, path) => {
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
      fetch(`${PRINTFUL_V2_BASE}${path}`, {
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
        signal: AbortSignal.timeout(20_000),
      }),
    );

    if (!response.ok) {
      throw new Error(`Printful ${operation} failed (${response.status})`);
    }
    return response.json();
  });
}
