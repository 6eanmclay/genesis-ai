import "server-only";

import type { IntegrationProvider } from "@prisma/client";
import { getConnector } from "@/lib/integrations/registry";
import type { CreationProvider } from "./garment";
import { printfulCreationSupplier } from "./printfulSupplier";
import { CREATION_SUPPLIER_ORDER } from "./supplierChoice";

// WHICH SUPPLIERS A DESIGN CAN BE MADE THROUGH.
//
// ============ THE SAME SHAPE AS THE OTHER TWO REGISTRIES ===============
//
// lib/fulfillment/registry.ts and lib/integrations/registry.ts already hold
// this pattern, and its comment records the lesson this file exists to apply:
//
//   "Read off the row rather than re-derived — the same correction adopt.ts
//    carries: `createsListings ? "PRINTFUL" : null` was right exactly until a
//    second print-on-demand partner existed."
//
// Creation had the same defect in a different place. provider.ts asked the
// database for `provider: "PRINTFUL"`, so a second supplier could be connected,
// hold credentials, implement every method, and still be invisible.
//
// Adding one is a supplier module and one line below.

export interface CreationSupplier {
  provider: IntegrationProvider;
  /**
   * Build the provider for a store whose credentials already exist.
   *
   * NO storeId, deliberately: every CreationProvider method takes the store it
   * is acting for, and the request closure re-reads credentials per call. A
   * captured id would be the staler of the two.
   */
  connect(): CreationProvider;
}

const CREATION_SUPPLIERS: CreationSupplier[] = [printfulCreationSupplier];

// THE TWO LISTS MUST AGREE, AND THIS IS WHERE THAT IS CHECKED.
//
// CREATION_SUPPLIER_ORDER (pure, tested) decides WHICH supplier is chosen;
// CREATION_SUPPLIERS (here, server-only) knows HOW to connect to it. A provider
// named in the first with no entry in the second would be chosen and then fail
// to build — so the mismatch is caught at import time rather than in front of
// an owner.
for (const provider of CREATION_SUPPLIER_ORDER) {
  if (!CREATION_SUPPLIERS.some((s) => s.provider === provider)) {
    throw new Error(
      `${provider} is listed as a creation supplier but has no connector in lib/creation/registry.ts`,
    );
  }
}

/**
 * Every supplier that can host a design, in preference order.
 *
 * ORDER IS THE TIE-BREAK and nothing more. A business with two print suppliers
 * connected designs through the first one here — which is a placeholder for a
 * real choice, not a decision anybody has made. When a second supplier exists,
 * the owner picks, and that choice belongs on the store rather than in this
 * array. Said here so the next person does not read the ordering as intent.
 */
export function getCreationSuppliers(): CreationSupplier[] {
  return CREATION_SUPPLIERS;
}

export function getCreationSupplier(provider: IntegrationProvider | null): CreationSupplier | null {
  if (!provider) return null;
  return CREATION_SUPPLIERS.find((s) => s.provider === provider) ?? null;
}

/**
 * Whether THIS DEPLOYMENT could offer any creation supplier at all.
 *
 * Asked of each connector rather than read from the environment here, so this
 * cannot fall out of step with the variables a supplier actually needs. A
 * deployment missing them shows no Connect button, because pressing it would
 * start an action that fails and dumps the owner on the connections screen —
 * the dead end coming back through the one door left open.
 *
 * `configured` is optional on a connector, and absent means yes: a supplier
 * needing no deployment-level setup is configured everywhere.
 */
export function creationSupplierConfigured(): boolean {
  return CREATION_SUPPLIERS.some((s) => getConnector(s.provider).configured?.() ?? true);
}
