import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { formatMoney } from "@/lib/money";
import { readBag } from "@/lib/bag/bagStore";
import { bagCount } from "@/lib/bag/bagCookie";
import { resolveBag } from "@/lib/bag/resolveBag";
import { displayPriceFor } from "@/lib/pricing/displayPrice";
import { canStoreAcceptPayments, CHECKOUT_UNAVAILABLE_MESSAGE } from "../shared";
import { BagBar } from "../BagBar";
import { Price } from "../Price";
import { BagLine } from "./BagLine";
import { BagCodeField } from "./BagCodeField";
import { CheckoutButton } from "./CheckoutButton";

// THE BAG.
//
// Everything a customer needs before paying: what is in it, what each thing
// costs, what a sale took off, a place to enter a code, and one button out.
//
// STILL NO DATABASE ROW. This page reads a cookie and prices it. A row appears
// only when the button at the bottom is pressed.
//
// EVERY FIGURE COMES FROM resolveBag, which is the same function the charge
// uses. Nothing here adds anything up.

export default async function BagPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;

  const store = await prisma.store.findUnique({
    where: { slug },
    select: { id: true, name: true, currency: true, theme: true },
  });
  if (!store) notFound();

  const bag = await readBag(slug);
  const resolved = await resolveBag({ storeId: store.id, bag });
  const canAcceptPayments = await canStoreAcceptPayments(store.id);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const pricing = resolved.pricing;
  const isEmpty = resolved.lines.length === 0;

  return (
    <div
      style={themeCssVars(theme)}
      className="min-h-screen bg-[var(--brand-background)] font-[var(--font-body)] text-[var(--brand-text)]"
    >
      <BagBar slug={slug} count={bagCount(bag)} canAcceptPayments={canAcceptPayments} />

      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <h1 className="font-[var(--font-heading)] text-2xl font-semibold">Your bag</h1>

        {/* A LINE THAT WENT AWAY IS SAID OUT LOUD. A product deactivated or
            deleted while it sat here simply stops being in the bag; a customer
            who remembers adding it deserves to know why it is gone rather than
            wondering whether the site lost it. */}
        {resolved.droppedProductIds.length > 0 && (
          <p className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[14px]">
            {resolved.droppedProductIds.length === 1
              ? "One item is no longer available and has been removed from your bag."
              : `${resolved.droppedProductIds.length} items are no longer available and have been removed from your bag.`}
          </p>
        )}

        {isEmpty ? (
          <div className="mt-8 flex flex-col items-start gap-4">
            <p className="text-[var(--brand-text-secondary)]">Your bag is empty.</p>
            <Link
              href={`/store/${slug}`}
              className="rounded-full bg-[var(--brand-accent)] px-5 py-2.5 text-[15px] font-medium text-white transition hover:opacity-90"
            >
              Start shopping
            </Link>
          </div>
        ) : (
          <>
            <ul className="mt-6 divide-y divide-[var(--brand-text)]/[.08] border-y border-[var(--brand-text)]/[.08]">
              {resolved.lines.map((line, index) => {
                const priced = pricing.lines[index];
                return (
                  <li key={line.productId} className="py-5">
                    <BagLine
                      slug={slug}
                      productId={line.productId}
                      name={line.name}
                      imageUrl={line.imageUrl}
                      quantity={line.quantity}
                      currency={store.currency}
                      // The per-unit price as the storefront showed it, so the
                      // bag and the card cannot disagree — built from this
                      // line's own discount rather than recomputed.
                      unitPrice={displayPriceFor(
                        line.unitPriceInCents,
                        priced.discount
                          ? [
                              {
                                kind: priced.discount.kind,
                                promotionId: priced.discount.promotionId,
                                label: priced.discount.label,
                                code: priced.discount.code,
                                discountType: "FIXED_AMOUNT",
                                percentOff: null,
                                // This line's discount, per unit.
                                amountOffInCents: Math.round(priced.discountInCents / priced.quantity),
                              },
                            ]
                          : []
                      )}
                      lineSubtotalInCents={priced.subtotalInCents}
                      discountLabel={priced.discount?.label ?? null}
                    />
                  </li>
                );
              })}
            </ul>

            <div className="mt-8 grid gap-8 md:grid-cols-2">
              <div>
                <h2 className="text-[15px] font-semibold">Discount code</h2>
                <div className="mt-3">
                  <BagCodeField
                    slug={slug}
                    typed={bag.code}
                    outcome={resolved.code}
                  />
                </div>
              </div>

              <div>
                <h2 className="text-[15px] font-semibold">Summary</h2>
                <dl className="mt-3 flex flex-col gap-2 text-[15px]">
                  <Row
                    label={`Subtotal (${bagCount(bag)} item${bagCount(bag) === 1 ? "" : "s"})`}
                    value={formatMoney(pricing.listSubtotalInCents, store.currency)}
                  />
                  {pricing.discountInCents > 0 && (
                    <Row
                      label={pricing.discount?.label ?? "Discounts"}
                      value={`−${formatMoney(pricing.discountInCents, store.currency)}`}
                      tone="credit"
                    />
                  )}
                  {/* Shipping is deliberately absent rather than shown as zero.
                      It is chosen at the next step, and a "Shipping $0.00" line
                      reads as free delivery to somebody skimming. */}
                  <div className="mt-1 border-t border-[var(--brand-text)]/[.08] pt-3">
                    <Row
                      label="Total"
                      value={formatMoney(pricing.merchandiseSubtotalInCents, store.currency)}
                      strong
                    />
                  </div>
                </dl>

                <div className="mt-5">
                  {canAcceptPayments ? (
                    <CheckoutButton slug={slug} />
                  ) : (
                    <p className="text-[14px] text-[var(--brand-text-secondary)]">
                      {CHECKOUT_UNAVAILABLE_MESSAGE}
                    </p>
                  )}
                </div>
                <p className="mt-3 text-center text-[12px] text-[var(--brand-text-secondary)]">
                  Shipping is added at the next step. Your total is confirmed again before you pay.
                </p>
              </div>
            </div>

            <div className="mt-8">
              <Link href={`/store/${slug}`} className="text-[14px] underline underline-offset-2">
                Continue shopping
              </Link>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function Row({
  label,
  value,
  strong = false,
  tone = "normal",
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: "normal" | "credit";
}) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt
        className={
          strong
            ? "font-medium"
            : tone === "credit"
              ? "text-emerald-700 dark:text-emerald-400"
              : "text-[var(--brand-text-secondary)]"
        }
      >
        {label}
      </dt>
      <dd
        className={
          strong
            ? "text-[17px] font-semibold tabular-nums"
            : tone === "credit"
              ? "text-emerald-700 tabular-nums dark:text-emerald-400"
              : "tabular-nums"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export { Price };
