import type { IntegrationProvider } from "@prisma/client";
import type { CarriageProvider } from "./types";
import { easypostCarriageProvider } from "./easypost";

// THE PLACE A SECOND PROVIDER GETS ADDED.
//
// Same shape as lib/integrations/registry.ts and lib/fulfillment/registry.ts,
// deliberately rather than invented fresh: adding Shippo or a direct carrier
// account is one entry here and nothing else moves.
//
// ONE ENTRY TODAY, AND THAT IS STATED RATHER THAN IMPLIED (S6, approved). An
// interface with a single implementation is a hypothesis about the second one.
// This registry does not make the abstraction general; it makes the second one
// additive when it arrives, and until then the claim stays unproven.

const CARRIAGE_PROVIDERS: CarriageProvider[] = [easypostCarriageProvider];

export function getCarriageProviders(): CarriageProvider[] {
  return CARRIAGE_PROVIDERS;
}

/**
 * The provider behind one integration, or null.
 *
 * A LOOKUP KEYED BY A VALUE FROM OUTSIDE, so it does not use a plain object.
 * `PROVIDERS["constructor"]` on a map literal is a function, which is truthy,
 * which walks straight through `?? null` — the exact defect
 * verify-registry-lookups.ts exists for, found six times in one day. `find`
 * over an array cannot do that.
 */
export function carriageProviderFor(id: IntegrationProvider | string): CarriageProvider | null {
  return CARRIAGE_PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/**
 * Can this provider do the thing we are about to offer an owner?
 *
 * Asked before rendering a control rather than discovered when it fails —
 * "call it and see" is a bad answer when somebody's postage is involved.
 */
export function providerCan(
  id: IntegrationProvider | string,
  capability: keyof CarriageProvider["capabilities"]
): boolean {
  return carriageProviderFor(id)?.capabilities[capability] === true;
}
