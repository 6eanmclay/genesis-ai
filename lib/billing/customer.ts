import { prisma } from "@/lib/prisma";
import { platformStripe } from "./stripeClient";

// Chapter 5 (Payments) — lazy provisioning: no store gets a Stripe Customer
// at creation time, only at its first real billing interaction (a Growth
// Point purchase or a plan subscription). Idempotent — a store that already
// has one just returns it, never creates a duplicate.
export async function getOrCreateStripeCustomer(storeId: string): Promise<string> {
  const store = await prisma.store.findUniqueOrThrow({
    where: { id: storeId },
    select: {
      id: true,
      stripeCustomerId: true,
      user: { select: { email: true, name: true } },
    },
  });

  if (store.stripeCustomerId) {
    return store.stripeCustomerId;
  }

  const customer = await platformStripe.customers.create({
    email: store.user.email,
    name: store.user.name ?? undefined,
    metadata: { storeId: store.id },
  });

  await prisma.store.update({
    where: { id: storeId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}
