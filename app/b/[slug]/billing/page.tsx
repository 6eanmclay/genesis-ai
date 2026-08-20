import { businessBasePath } from "@/lib/dashboard/navConfig";
import { BillingScreen } from "@/app/dashboard/billing/page";

// Billing for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business.
// Nothing here reads ambient state, which is what lets two tabs hold two
// businesses at once.

export default async function BusinessBillingScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return BillingScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
