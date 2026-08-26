import type { OrderPricing } from "@/lib/pricing/orderPricing";
import type { CodeOutcome } from "./resolve";

// The shape previewCheckoutPrice returns, in its own module because a
// "use server" file may export only async functions — a type declared there is
// erased at build time but still trips the rule.
export type CheckoutPreviewState =
  | { ok: true; pricing: OrderPricing; code: CodeOutcome | null }
  | { ok: false; error: string };
