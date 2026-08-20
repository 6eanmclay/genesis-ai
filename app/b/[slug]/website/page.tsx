import { businessBasePath } from "@/lib/dashboard/navConfig";
import { WebsiteScreen } from "@/app/dashboard/website/page";

// Website for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses at once.

export default async function BusinessWebsiteScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ focus?: string; publish_error?: string }>;
}) {
  const { slug } = await params;
  return WebsiteScreen({ slug, basePath: businessBasePath(slug), searchParams });
}
