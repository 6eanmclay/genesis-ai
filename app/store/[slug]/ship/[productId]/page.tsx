import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { productSupportsLiveShipping } from "@/lib/shipping/checkoutShipping";
import { ShippingStep } from "./ShippingStep";

// The shipping step's own route (2026-08-20).
//
// Reachable only for a store with its own connected EasyPost account and a
// product that has a real weight. Anything else is redirected back to the
// product rather than shown a form that could never return a rate — a dead
// address form is worse than no address form.

export default async function ShipPage({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}) {
  const { slug, productId } = await params;

  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true, published: true, currency: true } });
  if (!store) notFound();

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: store.id, active: true },
    select: { id: true, name: true, priceInCents: true },
  });
  if (!product) notFound();

  // The same gate the Buy button uses. Checked again here because this URL is
  // public and reachable directly, not only through that button.
  if (!(await productSupportsLiveShipping(store.id, productId))) {
    redirect(`/store/${slug}/products/${productId}`);
  }

  return (
    <ShippingStep
      slug={slug}
      productId={product.id}
      productName={product.name}
      priceInCents={product.priceInCents}
      currency={store.currency}
    />
  );
}
