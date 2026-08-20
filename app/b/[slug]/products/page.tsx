import { businessBasePath } from "@/lib/dashboard/navConfig";
import { ProductsScreen } from "@/app/dashboard/products/page";

// Products for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses.

export default async function BusinessProductsPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ focus?: string }>;
}) {
  const { slug } = await params;
  return ProductsScreen({ slug, basePath: businessBasePath(slug), searchParams });
}
