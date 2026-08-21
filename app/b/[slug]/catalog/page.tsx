import { businessBasePath } from "@/lib/dashboard/navConfig";
import { CatalogScreen } from "@/app/dashboard/catalog/page";

// The catalog for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every form it renders acts on it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses.

export default async function BusinessCatalogPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return CatalogScreen({ slug, basePath: businessBasePath(slug) });
}
