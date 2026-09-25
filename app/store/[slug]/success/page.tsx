import Link from "next/link";
import { formatMoney } from "@/lib/money";
import { resolvePurchase } from "@/lib/bag/purchaseCompletion";
import { ClearBagOnConfirmed } from "./ClearBagOnConfirmed";

export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session_id?: string; order_id?: string }>;
}) {
  const { slug } = await params;
  const { session_id: sessionId, order_id: orderId } = await searchParams;

  // ONE OWNER FOR "DID THIS PURCHASE COMPLETE" (2026-09-24).
  //
  // This page used to decide that inline, and the bag clear did not exist at
  // all. Both now call resolvePurchase, so what the customer is told and what
  // happens to their basket can never disagree — a page saying "confirmed"
  // beside a bag that kept its items is exactly the defect a real customer
  // reported. The reasoning behind the three outcomes, and every scoping rule
  // that makes them safe on a public page, lives with the function in
  // lib/bag/purchaseCompletion.ts.
  const { outcome, amountInCents, productName, currency } = await resolvePurchase({
    slug,
    sessionId,
    orderId,
  });

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      {/* THE STRIPE PATH'S ONLY CHANCE TO EMPTY THE BAG.
          Stripe's paid Order row is written by a webhook — a server-to-server
          call with no customer cookie jar anywhere near it — so this page is
          the one place where the buyer's browser and a proven payment meet.
          Cookies cannot be written while a Server Component renders ("Setting
          cookies is not supported during Server Component rendering"), so the
          clear runs as a Server Function.

          PayPal does NOT depend on this: its return route is a Route Handler
          holding the order it just created, and clears there, so that path
          works with JavaScript switched off. */}
      {outcome === "confirmed" && (
        <ClearBagOnConfirmed slug={slug} sessionId={sessionId ?? null} orderId={orderId ?? null} />
      )}

      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50" data-testid="success-heading">
        {outcome === "unknown" ? "We couldn’t find that order" : "Thank you for your purchase!"}
      </h1>
      {productName && (
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          {productName}
          {amountInCents != null && ` — ${formatMoney(amountInCents, currency)}`}
        </p>
      )}
      <p className="mt-2 text-sm text-zinc-500" data-testid="success-status">
        {outcome === "confirmed"
          ? "Your order is confirmed."
          : outcome === "pending"
            ? "We’re confirming your payment. You’ll get an email as soon as it’s complete."
            : "If you have just paid, check the link in your confirmation email."}
      </p>
      <Link
        href={`/store/${slug}`}
        className="mt-6 rounded-full bg-foreground px-5 py-2 text-sm text-background transition-colors hover:bg-[#383838] dark:hover:bg-[#ccc]"
      >
        Back to store
      </Link>
    </div>
  );
}
