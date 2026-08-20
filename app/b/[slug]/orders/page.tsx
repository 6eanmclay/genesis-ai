import { PERMISSIONS, requireBusinessPage } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { OrdersWorkspace } from "@/app/dashboard/orders/OrdersWorkspace";

// Orders for the business named in the URL.
//
// The business comes from the route segment, so this page cannot be affected by
// what the account is doing in another tab \u2014 and every action it renders is
// bound to this slug rather than resolving one.
//
// requireBusinessPage re-checks access here rather than trusting the layout.
// Both read the same slug, so this is a second read, not a second source of
// truth; a page that disagreed with its layout would be one that had been handed
// the wrong slug.

export default async function BusinessOrdersPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { slug } = await params;
  const { integration_error: integrationError, integration_connected: integrationConnected } =
    await searchParams;
  const { store, role } = await requireBusinessPage(PERMISSIONS.ORDERS_VIEW, slug);

  return (
    <OrdersWorkspace
      store={store}
      role={role}
      basePath={businessBasePath(slug)}
      slug={slug}
      integrationError={integrationError}
      integrationConnected={integrationConnected}
    />
  );
}
