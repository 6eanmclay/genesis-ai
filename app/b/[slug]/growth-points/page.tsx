import { businessBasePath } from "@/lib/dashboard/navConfig";
import { GrowthPointsScreen } from "@/app/dashboard/growth-points/page";

// Growth points for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business.
// Nothing here reads ambient state, which is what lets two tabs hold two
// businesses at once.

export default async function BusinessGrowthPointsScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return GrowthPointsScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
