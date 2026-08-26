import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { COMMERCE_LIST, COMMERCE_LIST_MARKER, COMMERCE_ROW } from "@/lib/dashboard/rooms";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { toggleProductActive, deleteProduct } from "../actions";
import {
  approveGenesisAction,
  rejectGenesisAction,
  approveGenesisActionGroup,
  regenerateApprovalImage,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
  dismissAttentionCard,
} from "../ai-actions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { buildPageAttentionCards, getDismissedCardIds } from "@/lib/dashboard/attentionCards";
import { DeleteProductButton } from "../DeleteProductButton";
import { SubmitButton } from "../SubmitButton";
import { AttentionCardList } from "../AttentionCardList";
import { CreateProductForm } from "./CreateProductForm";
import { EditProductForm } from "./EditProductForm";
import { ProductImageGallery } from "./ProductImageGallery";

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged; what changed is where it gets its business.
//
// A `slug` means it was reached at /b/[slug] and that business is
// authoritative. No slug means the legacy /dashboard route, which resolves the
// account's active business exactly as before. `basePath` is what every link
// inside uses, so a page rendered for one business never links into another.
export async function ProductsScreen({
  slug,
  basePath,
  searchParams,
}: {
  slug?: string;
  basePath: string;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { store, role } = await requireBusinessPageOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  // Reliability/polish pass (v22) — this page's own root never applied the
  // store's theme, so --brand-accent (used by ACCENT_BUTTON and several
  // shared components below) was never actually in scope, silently
  // rendering primary buttons as invisible white-on-transparent. Every
  // dashboard page except Home had this gap — see the audit for the full
  // list; this is the same fix applied consistently everywhere.
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  // approveGenesisAction/rejectGenesisAction/regenerateApprovalImage all
  // require ANALYTICS_VIEW (OWNER-only) — Employees have PRODUCTS_MANAGE
  // but not that, so the approval block itself is gated the same way here,
  // rather than rendering working-looking buttons that would throw on click.
  const canReviewApprovals = hasPermission(role, PERMISSIONS.ANALYTICS_VIEW);

  const [products, pendingApprovals, rawObservations, dismissedCardIds] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { position: "asc" },
      // Product media gallery (2026-08-08) — real ordered images, for the
      // admin gallery UI below. Product.imageUrl itself is untouched and
      // stays the primary-image mirror every other reader still uses.
      include: { images: { orderBy: { position: "asc" } } },
    }),
    canReviewApprovals ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Real GenesisObservation rows (Red/Purple) whose own actionHref points
    // directly at this page — the same real data Live Intelligence/the nav
    // badges already use, just filtered to this one destination.
    prisma.genesisObservation.findMany({
      // NOT rebased, deliberately. This is a query against rows already in the
      // database, whose actionHref was written as "/dashboard/products" when
      // they were created. Rebasing the filter would stop it matching any of
      // them. Stored action hrefs are legacy-based and are their own migration
      // — see BUSINESS_CONTEXT.md's remaining-risk list.
      where: { storeId: store.id, status: "ACTIVE", actionHref: "/dashboard/products" },
      select: { dedupeKey: true, genesisState: true, summary: true },
    }),
    getDismissedCardIds(store.id),
  ]);
  const productObservations = [...rawObservations].sort(compareObservationPriority);
  // Meeting with J4 M2 — create_product is this page's second real action
  // type (ACTION_SECTIONS routes it here too), the first CREATE-shaped one
  // ever proposable by Genesis. Renders through the exact same generic
  // ApprovalRequestsPanel/ActionDiffRows as update_product_image, no new
  // UI needed.
  const productApprovals = pendingApprovals.filter(
    (a) => a.actionType === "update_product_image" || a.actionType === "create_product"
  );
  const { focus } = await searchParams;
  // Phase 1 (2026-08-08) — see brand/page.tsx for the same real reasoning:
  // one unified card list instead of two separate sections/components.
  const productCards = buildPageAttentionCards({
    basePath,
    approvals: productApprovals,
    observations: productObservations,
    highlightId: focus,
    dismissedCardIds,
  });

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Products</h1>

      {/* Phase 1 (2026-08-08) — one unified card list, same compact
          language Home's own "J4 Noticed" zone uses — replaces the two
          separate ObservationsPanel/ApprovalRequestsPanel sections this
          page used to render on its own. */}
      {productCards.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis noticed ({productCards.length})
          </h2>
          <div className="mt-3">
            <AttentionCardList
              cards={productCards}
              approveAction={approveGenesisAction}
              rejectAction={rejectGenesisAction}
              approveGroupAction={approveGenesisActionGroup}
              issueAction={startIssueConversation}
              discoveryAction={startDiscoveryConversation}
              taskAction={startTaskConversation}
              highlightId={focus}
              regenerateAction={regenerateApprovalImage}
              dismissAction={dismissAttentionCard}
              currentPath={`${basePath}/products`}
              slug={slug}
            />
          </div>
        </>
      )}

      {products.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          No products yet. Add your first one below.
        </p>
      ) : (
        <ul className={`mt-4 max-w-4xl ${COMMERCE_LIST}`} {...COMMERCE_LIST_MARKER}>
          {products.map((product) => (
            <li
              key={product.id}
              // Responsive layout fix (2026-08-09) — "cuts off the
              // description almost entirely" on mobile, "only a few words
              // visible at a time" on desktop (Sean). The real bug: this
              // was always a row (`flex gap-4`), so a mobile-width gallery
              // column fighting a flex-1 sibling for the same narrow row
              // is exactly what squeezed the description to nothing.
              // flex-col below sm: (Sean's exact order: gallery, name,
              // price, description, save) / sm:flex-row for a real
              // two-column desktop layout, now inside a wide enough <ul>
              // for the description to actually have room.
              className={`flex flex-col gap-4 sm:flex-row ${COMMERCE_ROW}`}
            >
              <div className="flex w-full shrink-0 flex-col gap-2 sm:w-64">
                {/* Product media gallery (2026-08-08) — "a proper product
                    media gallery, not ten separate unrelated upload
                    buttons" (Sean). Replaces the old single-photo
                    thumbnail + upload form; up to 10 ordered images,
                    reorder/replace/delete per image, multi-select add. */}
                <ProductImageGallery
                  slug={slug}
                  productId={product.id}
                  images={product.images.map((img) => ({ id: img.id, url: img.url, position: img.position }))}
                />
              </div>

              <div className="min-w-0 flex-1">
                <EditProductForm
                  product={{
                    id: product.id,
                    name: product.name,
                    description: product.description,
                    priceInCents: product.priceInCents,
                    weightOz: product.weightOz,
                    lengthIn: product.lengthIn,
                    widthIn: product.widthIn,
                    heightIn: product.heightIn,
                  }}
                />

                <div className="mt-3 flex items-center gap-3">
                  <form action={toggleProductActive.bind(null, product.id)}>
                    <SubmitButton
                      pendingText="Updating..."
                      className="text-xs text-zinc-500 underline hover:text-black disabled:opacity-50 dark:hover:text-zinc-50"
                    >
                      {product.active ? "Active — hide" : "Hidden — show"}
                    </SubmitButton>
                  </form>
                  <form action={deleteProduct.bind(null, product.id)}>
                    <DeleteProductButton />
                  </form>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        Add a product
      </h2>
      <CreateProductForm slug={slug} />
    </div>
  );
}


// The legacy route. Resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/products renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  return ProductsScreen({ basePath: LEGACY_BUSINESS_BASE, searchParams });
}
