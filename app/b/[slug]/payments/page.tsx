import { businessBasePath } from "@/lib/dashboard/navConfig";
import { PaymentsScreen } from "@/app/dashboard/payments/page";

// Payments for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses at once.

export default async function BusinessPaymentsScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { slug } = await params;
  return PaymentsScreen({ slug, basePath: businessBasePath(slug), searchParams });
}
