import { prisma } from "@/lib/prisma";
import { PERMISSIONS } from "@/lib/permissions";
import { isPaymentConnected } from "@/lib/dashboard/needsAttention";
import type { Executable } from "../executable";
import { EXECUTION_ACTIONS } from "../actions";

interface PublishMetadata {
  published: boolean;
}

// Toggles Store.published — the same logic toggleStorePublished always had,
// now reporting through the engine instead of a bare redirect.
//
// Launch-readiness fix — payment routing is now explicit and deterministic
// (see lib/payments/router.ts's own comment): no platform-wide fallback
// exists anymore for a store with nothing connected. That makes an
// unpublished-then-published store with no real payment provider a genuine
// dead end for a customer, not just a warning in the attention panel (see
// lib/dashboard/needsAttention.ts's pre-existing "state.unsellable" check,
// which only ever detected this after the fact). Blocking the transition
// into `published` here closes that gap at the source — unpublishing
// always stays allowed unconditionally, since taking a store offline never
// needs a payment provider.
export const publishStoreExecutable: Executable<void, PublishMetadata> = {
  action: EXECUTION_ACTIONS.STORE_PUBLISH,
  requiredPermission: PERMISSIONS.STORE_MANAGE,
  async run(_input, ctx) {
    const store = await prisma.store.findUniqueOrThrow({ where: { id: ctx.storeId } });
    const aboutToPublish = !store.published;

    if (aboutToPublish) {
      const [stripeIntegration, paypalIntegration] = await Promise.all([
        prisma.storeIntegration.findUnique({
          where: { storeId_provider: { storeId: ctx.storeId, provider: "STRIPE" } },
          select: { status: true },
        }),
        prisma.storeIntegration.findUnique({
          where: { storeId_provider: { storeId: ctx.storeId, provider: "PAYPAL" } },
          select: { status: true },
        }),
      ]);
      if (!isPaymentConnected({ stripeIntegration, paypalIntegration })) {
        throw new Error(
          "Connect Stripe or PayPal before publishing — customers won't be able to check out otherwise."
        );
      }
    }

    const updated = await prisma.store.update({
      where: { id: ctx.storeId },
      data: { published: aboutToPublish },
    });
    return {
      message: updated.published ? "Store published" : "Store unpublished",
      metadata: { published: updated.published },
    };
  },
};
