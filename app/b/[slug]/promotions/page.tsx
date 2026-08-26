import { businessBasePath } from "@/lib/dashboard/navConfig";
import { PromotionsScreen } from "@/app/dashboard/promotions/page";

// Promotions for the business named in the URL. Same screen, and only where it
// gets its business changes — see the products route it mirrors.

export default async function BusinessPromotionsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return PromotionsScreen({ slug, basePath: businessBasePath(slug) });
}
