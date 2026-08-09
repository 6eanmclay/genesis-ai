import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { toggleProductActive, deleteProduct } from "../actions";
import {
  approveGenesisAction,
  rejectGenesisAction,
  regenerateApprovalImage,
  startIssueConversation,
  startDiscoveryConversation,
  startTaskConversation,
} from "../ai-actions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { buildPageAttentionCards } from "@/lib/dashboard/attentionCards";
import { DeleteProductButton } from "../DeleteProductButton";
import { SubmitButton } from "../SubmitButton";
import { AttentionCard } from "../AttentionCard";
import { CreateProductForm } from "./CreateProductForm";
import { EditProductForm } from "./EditProductForm";
import { ProductPhotoUploadForm } from "./ProductPhotoUploadForm";

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ focus?: string }>;
}) {
  const { store, role } = await requireStorePageAccess(PERMISSIONS.PRODUCTS_MANAGE);
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

  const [products, pendingApprovals, rawObservations] = await Promise.all([
    prisma.product.findMany({
      where: { storeId: store.id },
      orderBy: { position: "asc" },
    }),
    canReviewApprovals ? getPendingApprovals(store.id) : Promise.resolve([]),
    // Real GenesisObservation rows (Red/Purple) whose own actionHref points
    // directly at this page — the same real data Live Intelligence/the nav
    // badges already use, just filtered to this one destination.
    prisma.genesisObservation.findMany({
      where: { storeId: store.id, status: "ACTIVE", actionHref: "/dashboard/products" },
      select: { dedupeKey: true, genesisState: true, summary: true },
    }),
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
    approvals: productApprovals,
    observations: productObservations,
    highlightId: focus,
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
          <div className="mt-3 flex max-w-2xl flex-col gap-2.5">
            {productCards.map((card) => (
              <AttentionCard
                key={card.id}
                card={card}
                approveAction={approveGenesisAction}
                rejectAction={rejectGenesisAction}
                issueAction={startIssueConversation}
                discoveryAction={startDiscoveryConversation}
                taskAction={startTaskConversation}
                highlightId={focus}
                regenerateAction={regenerateApprovalImage}
              />
            ))}
          </div>
        </>
      )}

      {products.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-600 dark:text-zinc-400">
          No products yet. Add your first one below.
        </p>
      ) : (
        <ul className="mt-4 flex max-w-md flex-col gap-4">
          {products.map((product) => (
            <li
              key={product.id}
              className="flex gap-4 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
            >
              <div className="flex w-32 shrink-0 flex-col gap-2">
                {/* Real product photo only — no placeholder/fake image when
                    one hasn't been sourced yet, matching the same honest
                    "No image" treatment the public storefront already uses. */}
                <div className="h-32 w-32 overflow-hidden rounded-lg bg-black/[.03] dark:bg-white/[.05]">
                  {product.imageUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-center text-xs text-zinc-400">
                      No image
                    </div>
                  )}
                </div>

                {/* Upload your own photo — a direct write, no approval step
                    (see uploadProductImage's own comment). Distinct from
                    the Genesis-proposed photos above, which still go
                    through Approve/Reject. Beta readiness fix, 2026-08-05
                    — previously a 96×23px, unlabeled control that a real
                    first-time merchant reliably missed (confirmed via a
                    live test); real label + a real touch-target size now. */}
                {/* Real mobile bug fix (2026-08-08) — moved into a client
                    component so the file can upload directly to Blob from
                    the browser (ProductPhotoUploadForm.tsx's own comment
                    has the real root cause). */}
                <ProductPhotoUploadForm productId={product.id} hasExistingImage={!!product.imageUrl} />
              </div>

              <div className="min-w-0 flex-1">
                <EditProductForm
                  product={{
                    id: product.id,
                    name: product.name,
                    description: product.description,
                    priceInCents: product.priceInCents,
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
      <CreateProductForm />
    </div>
  );
}
