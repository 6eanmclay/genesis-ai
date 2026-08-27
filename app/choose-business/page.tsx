import Link from "next/link";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { accessibleBusinesses } from "@/lib/businessContext";
import { switchBusiness } from "./actions";

// THE CHOOSER (BUSINESS_CONTEXT.md, Phase D, item 10).
//
// The answer to a question the system could already ask and nowhere could
// answer. `resolveBusiness` returns "ambiguous" when an account reaches more
// than one business and nothing says which — deliberately, because picking
// would be the recency defect all over again. Until this page existed, that
// branch threw "Choose which business this is for before continuing." at
// somebody who had nothing anywhere to choose with.
//
// Reachable, and not only from the dead end: an account working in one business
// arrives here to move to another. That is the same act, and one page for both
// means the switch is always the deliberate thing it has to be.

export const metadata = { title: "Choose a business" };

export default async function ChooseBusinessPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const businesses = await accessibleBusinesses(session.user.id);

  // Nothing to choose between is not a choice. An account with no business
  // belongs in onboarding, and one with a single business has exactly one
  // answer — showing either of them a list would be asking a question that has
  // already been answered.
  if (businesses.length === 0) redirect("/dashboard");
  if (businesses.length === 1) redirect(`/b/${businesses[0].store.slug}`);

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-neutral-900 dark:text-neutral-50">
          Which business are you working in?
        </h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400">
          Everything — your catalog, orders, connections and what J4 understands — belongs to one
          business at a time.
        </p>
      </div>

      <ul className="flex flex-col gap-3">
        {businesses.map(({ store, role }) => (
          <li key={store.id}>
            <form action={switchBusiness}>
              <input type="hidden" name="storeId" value={store.id} />
              <button
                type="submit"
                className="flex w-full items-center justify-between gap-4 rounded-lg border border-neutral-200 bg-white px-5 py-4 text-left transition hover:border-neutral-400 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 dark:border-neutral-800 dark:bg-neutral-950 dark:hover:border-neutral-600"
              >
                <span className="flex flex-col gap-1">
                  <span className="font-medium text-neutral-900 dark:text-neutral-50">
                    {store.name}
                  </span>
                  {store.tagline ? (
                    <span className="text-sm text-neutral-600 dark:text-neutral-400">
                      {store.tagline}
                    </span>
                  ) : null}
                </span>
                {/* Role is shown because it changes what this business will let
                    them do — a member with a narrow role arriving somewhere they
                    have limited reach should know that before they arrive. */}
                <span className="shrink-0 text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-500">
                  {role === "OWNER" ? "Owner" : role.toLowerCase()}
                </span>
              </button>
            </form>
          </li>
        ))}
      </ul>

      {/* Quiet, and below the list on purpose. Somebody who came here to
          switch is choosing between businesses they already have; creating a
          fourth is a different intention and should not compete with that. */}
      <Link
        href="/create-business"
        className="mt-6 inline-block text-sm text-neutral-600 underline-offset-4 hover:underline dark:text-neutral-400"
      >
        Add another business
      </Link>
    </main>
  );
}
