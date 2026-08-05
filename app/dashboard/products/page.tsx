import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireStorePageAccess } from "@/lib/permissions";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { toggleProductActive, deleteProduct, uploadProductImage } from "../actions";
import { approveGenesisAction, rejectGenesisAction, regenerateApprovalImage, approveGenesisActionGroup } from "../ai-actions";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { compareObservationPriority } from "@/lib/dashboard/genesisState";
import { DeleteProductButton } from "../DeleteProductButton";
import { SubmitButton } from "../SubmitButton";
import { ApprovalRequestsPanel } from "../ApprovalRequestsPanel";
import { ObservationsPanel } from "../ObservationsPanel";
import { CreateProductForm } from "./CreateProductForm";
import { EditProductForm } from "./EditProductForm";

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
  // Contextual deep-linking: see brand/page.tsx for why a match here is
  // already fully validated (store/section/status-scoped) by construction.
  // Same reasoning for productObservations, already scoped to this page.
  const { focus } = await searchParams;
  const highlightId = focus && productApprovals.some((a) => a.id === focus) ? focus : undefined;
  const highlightObservationId =
    focus && productObservations.some((o) => o.dedupeKey === focus) ? focus : undefined;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Products</h1>

      {/* Real GenesisObservation rows (Red/Purple) — separate from the
          approval surface below; observations have no Approve/Reject, they
          resolve automatically when the real condition stops being true. */}
      {productObservations.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-semibold text-black dark:text-zinc-50">
            Genesis noticed ({productObservations.length})
          </h2>
          <ObservationsPanel observations={productObservations} highlightId={highlightObservationId} />
        </>
      )}

      {productApprovals.length > 0 && (
        <>
          <h2 className="mt-6 text-lg font-semibold text-black dark:text-zinc-50">
            Awaiting Your Approval ({productApprovals.length})
          </h2>
          <ApprovalRequestsPanel
            approvals={productApprovals}
            approveAction={approveGenesisAction}
            rejectAction={rejectGenesisAction}
            regenerateAction={regenerateApprovalImage}
            approveGroupAction={approveGenesisActionGroup}
            highlightId={highlightId}
          />
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
                {/* No explicit encType here — React manages it
                    automatically for a function action and errors if it's
                    set manually; file inputs still submit correctly as
                    part of the FormData React builds for the action. */}
                <form
                  action={uploadProductImage.bind(null, product.id)}
                  className="flex flex-col gap-1"
                >
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    {product.imageUrl ? "Change photo" : "Add photo"}
                  </span>
                  <input
                    type="file"
                    name="image"
                    accept="image/png,image/jpeg,image/webp"
                    required
                    className="w-full text-xs text-zinc-500 file:mr-1 file:rounded-full file:border-0 file:bg-black/[.05] file:px-3 file:py-2 file:text-xs file:font-medium file:text-black hover:file:bg-black/[.08] dark:text-zinc-400 dark:file:bg-white/[.1] dark:file:text-zinc-50 dark:hover:file:bg-white/[.15]"
                  />
                  <SubmitButton
                    pendingText="Uploading..."
                    className="w-full rounded-full bg-black/[.05] px-3 py-2 text-xs font-medium text-black hover:bg-black/[.08] disabled:opacity-50 dark:bg-white/[.1] dark:text-zinc-50 dark:hover:bg-white/[.15]"
                  >
                    Upload photo
                  </SubmitButton>
                </form>
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
