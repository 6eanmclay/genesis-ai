import { PERMISSIONS, requireBusinessPage } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { Finances } from "@/app/dashboard/finances/Finances";

// Money for the business named in the URL.
//
// requireBusinessPage re-checks access here rather than trusting the layout,
// and financialsForStore reads the connected account from THAT business's own
// integration row — so a slug the account cannot reach shows nothing, and one
// it can reach shows only its own.
export default async function BusinessFinancesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { store } = await requireBusinessPage(PERMISSIONS.REVENUE_VIEW, slug);
  return <Finances store={store} basePath={businessBasePath(slug)} />;
}
