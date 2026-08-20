import { businessBasePath } from "@/lib/dashboard/navConfig";
import { ConnectionsScreen } from "@/app/dashboard/connections/page";

// Connections for the business named in the URL.
//
// The slug is passed straight through, so the screen resolves THAT business.
// Nothing here reads ambient state, which is what lets two tabs hold two
// businesses at once.

export default async function BusinessConnectionsScreenPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ integration_error?: string; integration_connected?: string }>;
}) {
  const { slug } = await params;
  return ConnectionsScreen({
    slug,
    basePath: businessBasePath(slug),
    searchParams,
  });
}
