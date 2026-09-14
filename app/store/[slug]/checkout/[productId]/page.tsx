import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireVisibleStorefront } from "@/lib/storefront/visibility";
import { productSupportsLiveShipping } from "@/lib/shipping/checkoutShipping";
import { canStoreAcceptPayments } from "../../shared";
import { availableProviders } from "@/lib/payments/router";
import { priceCheckout } from "@/lib/promotions/resolve";
import { CheckoutReview } from "./CheckoutReview";

// THE REVIEW STEP (2026-08-26).
//
// Before this, a Genesis customer went from a Buy button straight to a payment
// provider's hosted page, and the first time a total was ever shown to them was
// after the decision to buy. There was nowhere to enter a discount code and
// nowhere to show what a sale had taken off.
//
// Reachable for every product EXCEPT one that goes through the shipping step,
// which is its own review — it has to collect an address and quote real
// carriers first, so the breakdown and the code field live inside it instead.
// Sending a shippable product here would ask the customer to confirm a total
// that does not yet include delivery.

export default async function CheckoutPage({
  params,
}: {
  params: Promise<{ slug: string; productId: string }>;
}) {
  const { slug, productId } = await params;

  const store = await prisma.store.findUnique({
    where: { slug },
    select: { id: true, currency: true, published: true },
  });
  if (!store) notFound();
  // A SHOP THAT IS NOT OPEN CANNOT SELL (2026-09-14). This page re-checks "the
  // same gates the Buy button uses" below, and publication is one of them: the
  // button only ever renders on a storefront that has already passed it.
  // Anonymously, an unpublished store's checkout answered 200 and named the
  // product — so a link shared while a shop was live kept selling after the
  // owner took the shop down.
  await requireVisibleStorefront(store);

  const product = await prisma.product.findFirst({
    where: { id: productId, storeId: store.id, active: true },
    select: { id: true, name: true, priceInCents: true, imageUrl: true },
  });
  if (!product) notFound();

  // The same gates the Buy button uses, checked again because this URL is
  // public and reachable directly. A store that cannot take money must not show
  // a page that ends in a payment button.
  if (!(await canStoreAcceptPayments(store.id))) {
    redirect(`/store/${slug}/products/${productId}`);
  }
  if (await productSupportsLiveShipping(store.id, productId)) {
    redirect(`/store/${slug}/ship/${productId}`);
  }

  // Priced on the server before anything renders, so an automatic sale is
  // already visible on arrival rather than appearing after a round trip.
  const { pricing } = await priceCheckout({
    storeId: store.id,
    productId: product.id,
    unitPriceInCents: product.priceInCents,
  });

  return (
    <CheckoutReview
      slug={slug}
      productId={product.id}
      productName={product.name}
      imageUrl={product.imageUrl}
      providers={await availableProviders(store.id)}
      currency={store.currency}
      initialPricing={pricing}
    />
  );
}
