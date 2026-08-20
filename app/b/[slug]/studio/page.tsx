import { businessBasePath } from "@/lib/dashboard/navConfig";
import { StudioScreen } from "@/app/dashboard/studio/page";

// Studio for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link it renders addresses it. Nothing here reads ambient state, which is
// what lets two tabs hold two businesses at once.

export default async function BusinessStudioScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;

} ) {
  const { slug } = await params;
  return StudioScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
