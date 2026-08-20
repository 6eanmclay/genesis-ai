import type { ReactNode } from "react";
import { requireBusinessPage } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { BusinessWorkspace } from "@/app/dashboard/BusinessWorkspace";

// One business, named in the URL (BUSINESS_CONTEXT.md Phase A).
//
// The whole point of this file is the two lines that resolve. Everything it
// renders is BusinessWorkspace, the same component /dashboard renders — split
// out rather than copied, because a second four-hundred-line layout is a second
// one that drifts.
//
// WHAT THIS ROUTE MAKES POSSIBLE that /dashboard cannot: the business is carried
// by the request, so two tabs can hold two businesses, a link can address one,
// and nothing an account does in one tab moves the other. /dashboard resolves
// the account's ACTIVE business, which is a per-account fact and therefore
// shared across every tab that account has open.
//
// Resolution happens once, here. Pages beneath take the same slug from their own
// params and re-resolve it through requireBusinessPage, which is a second read
// rather than a second source of truth: both answer from the same slug, and a
// page that disagreed with its layout would be a page that had been given the
// wrong slug.
//
// The 300s maxDuration lives on the legacy layout for the Server Actions still
// mounted there. Re-declared here for the same reason: this segment will host
// those same actions as the 28 screens migrate.
export const maxDuration = 300;

export default async function BusinessLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // notFound() for a business this account cannot reach, not a redirect
  // somewhere that works — a redirect would confirm the business exists.
  // Permission is null because the workspace itself needs none: the sections
  // inside it are filtered by role, and a member with a narrow role should see
  // their business rather than be bounced out of it.
  const { store, role, userName } = await requireBusinessPage(null, slug);

  return (
    <BusinessWorkspace
      store={store}
      role={role}
      userName={userName}
      basePath={businessBasePath(slug)}
      slug={slug}
    >
      {children}
    </BusinessWorkspace>
  );
}
