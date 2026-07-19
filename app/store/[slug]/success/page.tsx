import Link from "next/link";
import Stripe from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!);

export default async function CheckoutSuccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ session_id?: string }>;
}) {
  const { slug } = await params;
  const { session_id: sessionId } = await searchParams;

  let amountInCents: number | null = null;
  let productName: string | null = null;

  if (sessionId) {
    try {
      const session = await stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["line_items"],
      });
      amountInCents = session.amount_total;
      productName = session.line_items?.data[0]?.description ?? null;
    } catch {
      // Invalid or missing session id — still show a generic thank-you below.
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-zinc-50 px-8 text-center dark:bg-black">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
        Thank you for your purchase!
      </h1>
      {productName && (
        <p className="mt-3 text-zinc-600 dark:text-zinc-400">
          {productName}
          {amountInCents != null &&
            ` — $${(amountInCents / 100).toFixed(2)}`}
        </p>
      )}
      <p className="mt-2 text-sm text-zinc-500">
        A confirmation has been sent to your email.
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
