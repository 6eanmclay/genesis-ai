import { auth } from "@/auth";
import { requireBusinessPage } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { HomeWorkspace } from "@/app/dashboard/HomeWorkspace";

// The root of one business.
//
// No permission is required to be here: the sections inside are filtered by
// role, and a member with a narrow role should land in their business rather
// than be bounced out of it. Access itself is still verified \u2014 requireBusinessPage
// refuses a business this account cannot reach.

export default async function BusinessHomePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { store, role, userId, userName } = await requireBusinessPage(null, slug);
  // The analytics session belongs to the account, not the business.
  const session = await auth();

  return (
    <HomeWorkspace
      store={store}
      role={role}
      userId={userId}
      userName={userName}
      sessionInstanceId={session?.user?.sessionInstanceId}
      basePath={businessBasePath(slug)}
      slug={slug}
    />
  );
}
