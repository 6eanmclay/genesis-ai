import { businessBasePath } from "@/lib/dashboard/navConfig";
import { AnalyticsScreen } from "@/app/dashboard/analytics/page";

// Analytics for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses at once.

export default async function BusinessAnalyticsScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;

} ) {
  const { slug } = await params;
  return AnalyticsScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
