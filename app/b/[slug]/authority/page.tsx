import { businessBasePath } from "@/lib/dashboard/navConfig";
import { AuthorityScreen } from "@/app/dashboard/authority/page";

// Genesis's authority over the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business and
// every link and grant control it renders addresses it. Nothing here reads
// ambient state, which is what lets two tabs hold two businesses at once — and
// matters more here than on most screens: a grant is per business, and a
// control that acted on whichever business happened to be "active" would be
// giving away authority over the wrong one.

export default async function BusinessAuthorityScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return AuthorityScreen({
    slug,
    basePath: businessBasePath(slug),
  });
}
