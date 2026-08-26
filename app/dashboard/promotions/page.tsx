import { prisma } from "@/lib/prisma";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { COMMERCE_LIST, COMMERCE_LIST_MARKER, COMMERCE_ROW } from "@/lib/dashboard/rooms";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { formatMoney } from "@/lib/money";
import { eligibilityOf } from "@/lib/promotions/eligibility";
import { CreatePromotionForm } from "./CreatePromotionForm";
import { PromotionRow } from "./PromotionRow";

// PROMOTIONS — the merchant's own offers.
//
// In the Commerce room beside Products and Orders, because that is what a
// promotion is about. Under PRODUCTS_MANAGE for the same reason: somebody
// trusted to set a price is trusted to discount it.

export async function PromotionsScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const [promotions, products] = await Promise.all([
    prisma.promotion.findMany({
      where: { storeId: store.id },
      orderBy: [{ active: "desc" }, { createdAt: "desc" }],
      include: {
        products: { select: { product: { select: { id: true, name: true } } } },
        // How many real orders used it. The reason a merchant hesitates before
        // deleting one, and the reason deleting is safe anyway: the orders keep
        // their own copy of what was taken off.
        _count: { select: { orders: true } },
      },
    }),
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { position: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  // ONE INSTANT for every row, so a list cannot show two promotions judged
  // against two different "now"s.
  const now = new Date();

  return (
    <div style={themeCssVars(theme)} className="flex flex-col gap-8">
      <section>
        <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">Promotions</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Sales apply on their own. Discount codes apply when a customer types them. Only the best
          single discount is ever applied to an order — they never stack.
        </p>
      </section>

      <section>
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Active and inactive</h2>
        {promotions.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">Nothing yet. Create your first below.</p>
        ) : (
          <ul className={`mt-3 ${COMMERCE_LIST}`} {...COMMERCE_LIST_MARKER}>
            {promotions.map((promotion) => {
              // Judged by the SAME function checkout uses, so this page can
              // never say "running" about something a customer cannot use. The
              // product is irrelevant to the switch-and-window part of that
              // judgment, which is what this row reports.
              const state = eligibilityOf(promotion, {
                productId: "",
                coveredProductIds: [],
                now,
              });
              return (
                <li key={promotion.id} className={COMMERCE_ROW}>
                  <PromotionRow
                    slug={slug}
                    promotion={{
                      id: promotion.id,
                      name: promotion.name,
                      kind: promotion.kind,
                      code: promotion.code,
                      active: promotion.active,
                      startsAt: promotion.startsAt?.toISOString() ?? null,
                      endsAt: promotion.endsAt?.toISOString() ?? null,
                      orderCount: promotion._count.orders,
                      productNames: promotion.products.map((p) => p.product.name),
                      scope: promotion.scope,
                      amountLabel:
                        promotion.discountType === "PERCENTAGE"
                          ? `${promotion.percentOff}% off`
                          : `${formatMoney(promotion.amountOffInCents ?? 0, store.currency)} off`,
                      // "inactive" here means the merchant's switch; the window
                      // states are separate and say something different.
                      status: state.eligible ? "running" : state.reason,
                    }}
                  />
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section>
        <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-50">Create a promotion</h2>
        <div className="mt-3 max-w-xl">
          <CreatePromotionForm slug={slug} products={products} />
        </div>
      </section>

      <p className="text-xs text-zinc-400 dark:text-zinc-500">
        Deleting a promotion never changes an order that already used it — each order keeps its own
        record of what was taken off and why. <span className="sr-only">{basePath}</span>
      </p>
    </div>
  );
}

export default async function PromotionsPage() {
  return PromotionsScreen({ basePath: LEGACY_BUSINESS_BASE });
}
