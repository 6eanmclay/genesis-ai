import type { IntegrationProvider, IntegrationStatus } from "@prisma/client";

// WHICH SUPPLIER HOSTS THIS BUSINESS'S DESIGNS — the decision, on its own.
//
// ============ WHY THIS IS SEPARATE FROM provider.ts (2026-08-28) ========
//
// provider.ts is `server-only`, because it reads encrypted supplier
// credentials and importing it from a client component should be a build error
// rather than a review comment. That marker also means no suite can import it:
// `server-only` resolves through Next's bundler and throws under plain Node, so
// a test that reached the decision would have to reach the credentials too.
//
// The decision needs no credentials — only which providers CAN make things, and
// which of them this business has connected. So it lives here, pure, and is
// tested exhaustively. provider.ts keeps the part that genuinely needs secrets.
//
// Same split as lib/creation/saveDesign.ts, for the same reason: the rule that
// matters is the one that can be run.

/** The declarative list. Adding a supplier is this array plus a connect entry. */
export const CREATION_SUPPLIER_ORDER: IntegrationProvider[] = ["PRINTFUL"];

/**
 * Can this provider host a design at all?
 *
 * A store can have a dozen integrations. Stripe takes money and Square sells in
 * a shop; neither makes a hoodie. Without this, "the business has a connected
 * integration" and "the business can design something" collapse into the same
 * question, and the wrong one gets answered.
 */
export function isCreationSupplier(provider: IntegrationProvider | null): boolean {
  return provider !== null && CREATION_SUPPLIER_ORDER.includes(provider);
}

/** One store's integration, reduced to what the choice depends on. */
export interface SupplierCandidate {
  provider: IntegrationProvider;
  status: IntegrationStatus;
  /** Whether credentials exist. The credentials themselves never come here. */
  hasCredentials: boolean;
}

export interface SupplierChoice {
  /** The supplier to design through, or null when none can be. */
  supplier: IntegrationProvider | null;
  /** The status worth reporting — the chosen supplier's, or the closest thing. */
  status: IntegrationStatus | null;
}

/**
 * Pick the supplier a business designs through.
 *
 * ============ CREDENTIALS DECIDE, NOT STATUS (2026-08-27) ==============
 *
 * This once required CONNECTED and returned nothing otherwise, so an
 * integration sitting at NEEDS_ATTENTION or FAILED — which still holds real,
 * usually-working credentials — was indistinguishable from having no supplier.
 * The owner got "Connect a print supplier" about a supplier they had already
 * connected, with no way to tell the two apart.
 *
 * A stale status is a fact about the last verification, not about whether the
 * next call will work. So credentials decide, the status travels beside the
 * answer, and the real call is allowed to be the thing that fails.
 *
 * DISCONNECTED needs no special case: disconnecting clears the credentials, so
 * such a row simply has none and cannot be chosen. It is still reported, which
 * is how a screen distinguishes "you disconnected this" from "you never
 * connected anything".
 */
export function chooseCreationSupplier(candidates: SupplierCandidate[]): SupplierChoice {
  // ORDER IS THE TIE-BREAK AND NOTHING MORE. A business with two print
  // suppliers connected designs through whichever comes first in
  // CREATION_SUPPLIER_ORDER — a placeholder for a real choice, not a decision
  // anybody has made. When a second supplier exists the owner picks, and that
  // choice belongs on the store rather than in an array. Said here so the next
  // person does not read the ordering as intent.
  for (const provider of CREATION_SUPPLIER_ORDER) {
    const row = candidates.find((c) => c.provider === provider);
    if (row?.hasCredentials) return { supplier: provider, status: row.status };
  }

  // Nobody can host a design. Report the status of a supplier that could have,
  // so the screen can say "you disconnected Printful" rather than the much less
  // useful "connect a supplier" — but never the status of an integration that
  // was never in the running, which would be a payment processor's health
  // reported as a print supplier's.
  const relevant = candidates.find((c) => isCreationSupplier(c.provider));
  return { supplier: null, status: relevant?.status ?? null };
}
