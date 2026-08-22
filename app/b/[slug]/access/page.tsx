import { businessBasePath } from "@/lib/dashboard/navConfig";
import { AccessScreen } from "@/app/dashboard/access/page";

// Who can reach the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business
// and every action it renders addresses it. Nothing here reads ambient state,
// which is what lets two tabs hold two businesses.

export default async function BusinessAccessPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return AccessScreen({ slug, basePath: businessBasePath(slug) });
}
