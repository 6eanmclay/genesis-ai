import { businessBasePath } from "@/lib/dashboard/navConfig";
import { CustomersScreen } from "@/app/dashboard/customers/page";

// Customers for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses at once.

export default async function BusinessCustomersScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;

} ) {
  const { slug } = await params;
  return CustomersScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
