import { prisma } from "@/lib/prisma";
import { shippedBy } from "@/lib/shipping/whoShips";
import { isBrokenConnection } from "@/lib/integrations/paymentBadge";
import type { Store, StoreRole } from "@prisma/client";
import { PERMISSIONS, hasPermission } from "@/lib/permissions";
import { buildCommerceLead } from "@/lib/dashboard/commerceLead";
import { getPreviousBriefingAnchor, getChangeSetSince } from "@/lib/dashboard/genesisBriefingComposer";
import { getOrderSummary } from "@/lib/dashboard/whatHappened";
import { OrderSummaryCard } from "../OrderSummaryCard";
import { OrdersList, type OrderRow } from "../OrdersList";
import { SubmitButton } from "../SubmitButton";
import { submitUspsCredentials, disconnectUsps, recheckUsps, saveReturnAddress } from "../actions";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import type { OrderShippingAddress } from "@/lib/orders/shippingAddress";

interface StoreReturnAddress {
  name: string;
  phone: string;
  line1: string;
  line2: string | null;
  city: string;
  state: string | null;
  postalCode: string;
  country: string;
}

const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

// Owner-experience milestone — real shipping address + a manual fulfillment
// workflow, both now real (see lib/execution/executables/orders.ts). Amount
// is only selected from the DB at all when the viewer has REVENUE_VIEW,
// matching how getOrderSummary/getCustomerSummaries already gate revenue —
// not just hidden in the UI.
//
// Priority 2 (shipping, 2026-08-09) — real USPS label purchase, added
// directly to this page (not the generic /dashboard/connections catalog)
// since it's core commerce infrastructure like Stripe/PayPal, not a
// business-type-recommended integration. Needs two real prerequisites
// before a label can be bought: USPS (EasyPost) connected, and a real
// ship-from address on file — both surfaced here, right where they're
// needed, rather than a separate settings page the owner has to already
// know to visit.
// Orders, for ONE business (2026-08-20, BUSINESS_CONTEXT.md Phase C).
//
// Extracted from the page so both routes render the same screen: /dashboard
// resolves the account's active business, /b/[slug] takes the business from the
// route. The screen itself no longer resolves anything \u2014 the business arrives as
// an argument, which is the whole point of the migration.
//
// `slug` is undefined on the legacy route and bound into every action on the
// business route, so a form submitted from a business's page writes to THAT
// business rather than to whichever one the account was last active in.

export interface OrdersWorkspaceProps {
  store: Store;
  role: StoreRole;
  basePath: string;
  slug?: string;
  integrationError?: string;
  integrationConnected?: string;
}

export async function OrdersWorkspace({
  store,
  role,
  basePath,
  slug,
  integrationError,
  integrationConnected,
}: OrdersWorkspaceProps) {
  const canViewRevenue = hasPermission(role, PERMISSIONS.REVENUE_VIEW);
  const canManage = hasPermission(role, PERMISSIONS.ORDERS_MANAGE);

  // COMMERCE'S LEAD (2026-08-22) — the room architecture's "one line: what
  // changed since you were last here", and the last piece of that decision.
  //
  // Reuses the Daily Operating Rhythm's existing anchor and change-set rather
  // than introducing a second definition of "since you were last here". Two
  // answers to that question would drift, and the one that drifted would be the
  // one nobody was reading.
  //
  // REVENUE_VIEW gates it the same way it gates the summary card directly
  // below: a role that may not see revenue must not read it off the lead
  // instead. getChangeSetSince computes revenue, so a caller without the
  // permission is never given the change-set at all rather than being handed it
  // and trusted to look away.
  const [summary, rawOrders, uspsIntegration, changeSet] = await Promise.all([
    getOrderSummary(store.id, { includeRevenue: canViewRevenue }),
    prisma.order.findMany({
      where: { storeId: store.id },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        productName: true,
        quantity: true,
        buyerEmail: true,
        status: true,
        paymentProvider: true,
        createdAt: true,
        amountInCents: canViewRevenue,
        fulfillmentStatus: true,
        shipmentStatus: true,
        deliveredAt: true,
        shippingAddress: true,
        carrier: true,
        trackingNumber: true,
        trackingUrl: true,
        labelUrl: true,
        // THE PARCEL THE MERCHANT SHOULD NOT HAVE TO RETYPE (2026-08-25).
        //
        // Product has carried weightOz/lengthIn/widthIn/heightIn since
        // 2026-08-20, and the label form asked for the weight anyway — on every
        // order, for a product whose weight is already on file. The executable
        // and the server action both already accept all four; only the form
        // never offered them and nothing ever filled them in.
        product: {
          select: {
            weightOz: true, lengthIn: true, widthIn: true, heightIn: true,
            // Who ships it — see lib/shipping/whoShips.ts. Read here so the row
            // never has to guess from a provider name.
            sourceKind: true,
          },
        },
      },
    }),
    canManage
      ? prisma.storeIntegration.findUnique({ where: { storeId_provider: { storeId: store.id, provider: "EASYPOST" } } })
      : Promise.resolve(null),
    canViewRevenue
      ? getPreviousBriefingAnchor(store.id).then((anchor) => getChangeSetSince(store.id, anchor))
      : Promise.resolve(null),
  ]);
  const lead = changeSet ? buildCommerceLead(changeSet, store.currency) : null;
  const orders: OrderRow[] = rawOrders.map((order) => ({
    id: order.id,
    productName: order.productName,
    quantity: order.quantity,
    buyerEmail: order.buyerEmail,
    amountInCents: canViewRevenue ? ((order.amountInCents as number | null) ?? 0) : null,
    status: order.status,
    paymentProvider: order.paymentProvider,
    createdAt: order.createdAt,
    // Who packs this. A deleted product leaves order.product null, and an order
    // with no product is one this owner has to handle themselves — which is
    // what "OWNER" already means for a null sourceKind.
    shippedBy: shippedBy(order.product?.sourceKind ?? null),
    fulfillmentStatus: order.fulfillmentStatus,
    shipmentStatus: order.shipmentStatus,
    deliveredAt: order.deliveredAt,
    shippingAddress: order.shippingAddress as OrderShippingAddress | null,
    carrier: order.carrier,
    trackingNumber: order.trackingNumber,
    trackingUrl: order.trackingUrl,
    parcel: {
      weightOz: order.product?.weightOz ?? null,
      lengthIn: order.product?.lengthIn ?? null,
      widthIn: order.product?.widthIn ?? null,
      heightIn: order.product?.heightIn ?? null,
    },
    labelUrl: order.labelUrl,
  }));
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  // WORKING, NOT MERELY PRESENT (2026-08-25, Connections).
  //
  // This read `status !== "DISCONNECTED"`, which is the same test the
  // Connections screen carried until C1 removed it: a FAILED connection counted
  // as connected. Here that was worse than a wrong badge — `canBuyLabel` gates
  // an action that SPENDS MONEY, so a store whose EasyPost credentials had
  // stopped verifying was still offered "Buy label", and the purchase would
  // fail at the provider.
  //
  // Strict for the capability, exactly as hasWorkingPaymentMethod already is
  // for "can this store take money": only a verified-working connection counts.
  const uspsWorking = uspsIntegration?.status === "CONNECTED";
  // And broken is its own state, not folded into "not connected" — an owner
  // whose key stopped working needs to be told that, not shown a blank setup
  // form as though they had never connected at all.
  const uspsBroken = isBrokenConnection(uspsIntegration?.status);
  const returnAddress = store.returnAddress as unknown as StoreReturnAddress | null;
  const canBuyLabel = Boolean(uspsWorking && returnAddress);
  // WHY NOT, WHEN NOT (2026-08-25).
  //
  // `canBuyLabel` alone is opaque: when it was false the Buy Label form simply
  // did not render, so an owner looking at a paid order saw no way to ship it
  // and no reason given. That is the R1 defect inverted — there, J4 said what
  // to do with no way to do it; here there is no way to do it and nothing said.
  //
  // Two causes, and they have different remedies, so they are not collapsed
  // into one message. Both remedies happen to live further down this same page.
  const labelBlockedBy: "return_address" | "shipping_provider" | null = canBuyLabel
    ? null
    : !returnAddress
      ? "return_address"
      : "shipping_provider";

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Orders</h1>

      {/* Commerce's lead. Rendered above everything the room holds, because
          that is what a lead is — the first thing the eye lands on, before
          scrolling. Absent entirely when there is no honest line to write
          (see buildCommerceLead: no prior anchor means no period to speak
          about), rather than a placeholder holding its place. */}
      {lead && (
        <p
          className={`mt-3 text-sm ${
            lead.quiet
              ? "text-zinc-500 dark:text-zinc-400"
              : "font-medium text-black dark:text-zinc-50"
          }`}
        >
          {lead.text}
        </p>
      )}

      <div className="mt-6 max-w-md">
        <OrderSummaryCard summary={summary} currency={store.currency} />
      </div>

      {canManage && (
        <div className="mt-8 max-w-md rounded-xl border border-black/[.08] p-4 dark:border-white/[.145]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-black dark:text-zinc-50">USPS Shipping</p>
            {uspsWorking ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                ✓ Connected
              </span>
            ) : uspsBroken ? (
              <span className="inline-flex items-center rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-400">
                Not working
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-black/[.04] px-2.5 py-0.5 text-xs font-medium text-zinc-500 dark:bg-white/[.06] dark:text-zinc-400">
                Not connected
              </span>
            )}
          </div>

          {integrationError === "usps" && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              Couldn&apos;t connect — double check the API key and try again.
            </p>
          )}
          {integrationConnected === "usps" && (
            <p className="mt-2 text-xs text-emerald-600 dark:text-emerald-400">USPS connected.</p>
          )}
          {uspsBroken && (
            <p className="mt-2 text-xs text-red-600 dark:text-red-400">
              This store can&apos;t buy shipping labels right now — EasyPost stopped accepting these
              credentials. Paste a current API key below to fix it.
            </p>
          )}

          {/* The form shows for a broken connection too: pasting a current key
              IS how an api_key connector reconnects, and hiding it would leave
              an owner told what is wrong with no way to fix it. */}
          {!uspsWorking ? (
            <form action={submitUspsCredentials.bind(null, slug)} className="mt-3 flex flex-col gap-2">
              <p className="text-xs text-zinc-500">
                Create a free account at easypost.com — it&apos;s the real service behind USPS label purchases
                here — then paste your API key below.
              </p>
              <input
                name="apiKey"
                type="password"
                placeholder="EasyPost API Key"
                required
                className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <SubmitButton pendingText="Connecting..." className={`self-start px-4 py-1.5 text-xs ${ACCENT_BUTTON}`}>
                Connect USPS
              </SubmitButton>
            </form>
          ) : (
            <div className="mt-3 flex gap-2">
              <form action={recheckUsps.bind(null, slug)}>
                <SubmitButton
                  pendingText="Checking..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                >
                  Recheck
                </SubmitButton>
              </form>
              <form action={disconnectUsps.bind(null, slug)}>
                <SubmitButton
                  pendingText="Disconnecting..."
                  className="rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-red-600 disabled:opacity-50 dark:border-white/[.145] dark:text-red-400"
                >
                  Disconnect
                </SubmitButton>
              </form>
            </div>
          )}
        </div>
      )}

      {canManage && (
        <div className="mt-4 max-w-md rounded-xl border border-black/[.08] p-4 dark:border-white/[.145]">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium text-black dark:text-zinc-50">Ship-from address</p>
            {returnAddress ? (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                ✓ Set
              </span>
            ) : (
              <span className="inline-flex items-center rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                Needed to buy labels
              </span>
            )}
          </div>
          {returnAddress && (
            <p className="mt-1 text-xs text-zinc-500">
              {returnAddress.name} · {returnAddress.line1}
              {returnAddress.line2 ? `, ${returnAddress.line2}` : ""}, {returnAddress.city}
              {returnAddress.state ? `, ${returnAddress.state}` : ""} {returnAddress.postalCode}
            </p>
          )}
          <details className="mt-2 group">
            <summary className="cursor-pointer list-none text-xs text-zinc-500 underline">
              {returnAddress ? "Update address" : "Add your address"}
            </summary>
            <form action={saveReturnAddress.bind(null, slug)} className="mt-3 flex flex-col gap-2">
              <input
                name="name"
                placeholder="Business or your name"
                defaultValue={returnAddress?.name}
                required
                className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <input
                name="phone"
                placeholder="Phone"
                defaultValue={returnAddress?.phone}
                required
                className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <input
                name="line1"
                placeholder="Street address"
                defaultValue={returnAddress?.line1}
                required
                className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <input
                name="line2"
                placeholder="Apt/Suite (optional)"
                defaultValue={returnAddress?.line2 ?? undefined}
                className="rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <div className="flex gap-2">
                <input
                  name="city"
                  placeholder="City"
                  defaultValue={returnAddress?.city}
                  required
                  className="w-1/2 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <input
                  name="state"
                  placeholder="State"
                  defaultValue={returnAddress?.state ?? undefined}
                  className="w-1/4 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <input
                  name="postalCode"
                  placeholder="ZIP"
                  defaultValue={returnAddress?.postalCode}
                  required
                  className="w-1/4 rounded-lg border border-black/[.08] px-3 py-1.5 text-sm dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
              </div>
              <input type="hidden" name="country" value={returnAddress?.country ?? "US"} />
              <SubmitButton pendingText="Saving..." className={`self-start px-4 py-1.5 text-xs ${ACCENT_BUTTON}`}>
                Save address
              </SubmitButton>
            </form>
          </details>
        </div>
      )}

      <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
        All orders
      </h2>
      <OrdersList
        orders={orders}
        currency={store.currency}
        canViewRevenue={canViewRevenue}
        canManage={canManage}
        canBuyLabel={canBuyLabel}
        labelBlockedBy={labelBlockedBy}
        basePath={basePath}
      />
    </div>
  );
}
