import "server-only";

import { prisma } from "@/lib/prisma";
import { decryptCredentials, encryptCredentials } from "@/lib/integrations/credentials";
import { supplierRequest } from "@/lib/sourcing/sourcingBudget";
import { refreshPrintfulToken, type PrintfulCredentials } from "@/lib/integrations/printful";
import { printfulCreationProvider } from "./printfulCreation";
import { printfulUrl, printfulHeaders, printfulFailure, isStoreScoped } from "./printfulRequest";
import type { CreationSupplier } from "./registry";

// PRINTFUL, AS ONE ENTRY IN A LIST.
//
// ============ WHY THIS IS ITS OWN FILE (2026-08-28) =====================
//
// This was the body of creationAccessFor(), which asked
// `storeId_provider: { storeId, provider: "PRINTFUL" }` and could therefore
// only ever answer about Printful. The comment above it said "one provider
// today, and not hard-coded", and the first half was true.
//
// Sean: "keep the architecture clean and reusable for additional suppliers."
// So the supplier-specific half — which credentials, how they refresh, which
// URL, which headers, what a failure reads like — lives here, and
// provider.ts now walks a list. Adding Printify is this file again with
// different imports, plus one line in registry.ts.
//
// Everything ABOVE the provider is already agnostic: Creation Station reads
// capabilities off the Garment the supplier returns — print areas, colours,
// sizes, cost — and lib/creation/saveDesign.ts records
// `fulfillmentProvider: garment.provider` rather than a constant. This file is
// the last place a supplier's name legitimately appears.

export const printfulCreationSupplier: CreationSupplier = {
  provider: "PRINTFUL",

  connect() {
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
  },
};
