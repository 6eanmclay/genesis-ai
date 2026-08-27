import { redirect } from "next/navigation";
import Link from "next/link";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { accessibleBusinesses } from "@/lib/businessContext";
import { CreateStoreForm } from "@/app/dashboard/CreateStoreForm";
import type { OnboardingState } from "@/lib/onboarding/types";

// ANOTHER BUSINESS, WHEN YOU ALREADY HAVE ONE.
//
// BUSINESS_CONTEXT.md Phase B item 5, the one thing that phase left: "a
// 'create another business' entry that works when you already have one."
//
// ============ WHY THERE WAS NO WAY IN ====================================
//
// Everything underneath has worked for a long time. confirmStoreDraftCore
// calls adoptNewBusiness, which makes the new business the active one
// precisely so a second business never lands in the ambiguous state.
// verify-business-context-live proves an account can create, confirm, and
// create again against a real Postgres.
//
// What was missing was a door. app/dashboard/page.tsx offers creation behind
// `if (!store)` — correct when it was written, because an account had one
// business or none. An account WITH a business went straight to its workspace
// and never saw a way to make another. The capability existed and was
// unreachable, which is the same shape as PayPal being connected and never
// offered.
//
// ============ ONE DRAFT AT A TIME, AND THAT IS DELIBERATE ================
//
// StoreDraft.userId is @unique. Phase B considered lifting it and decided not
// to, for a good reason worth repeating here: every findUnique on a draft
// would become "the draft this user is currently working on", and the obvious
// implementation of that is *the most recent one* — the exact recency guess
// Phase 0 removed. A real constraint traded for a recency lookup, to unblock
// creating two businesses simultaneously, which nobody has asked for.
//
// So this page does not work around the constraint. It reads it and says what
// it means: an unfinished creation is resumed, not silently replaced. Starting
// a second one would either fail on the constraint or destroy the first, and
// both are worse than being told.

export default async function CreateBusinessPage() {
  const session = await auth();
  if (!session?.user) redirect("/login");

  const [draft, businesses] = await Promise.all([
    prisma.storeDraft.findUnique({
      where: { userId: session.user.id },
      select: {
        status: true,
        onboardingState: true,
        inputStoreName: true,
        inputProductType: true,
        inputVision: true,
      },
    }),
    accessibleBusinesses(session.user.id),
  ]);

  // ============ AN UNFINISHED CREATION IS RESUMED, NOT REPLACED ==========
  //
  // A "ready" draft is a generated business waiting to be confirmed — real
  // work, and the only place that can confirm it is the review screen on
  // /dashboard. Sending somebody to a blank form here would look like starting
  // over and would hit the unique constraint the moment they submitted.
  if (draft?.status === "ready") {
    redirect("/dashboard");
  }

  // The v2 flow owns its own resume logic and already handles a returning user
  // mid-act. It does not check whether the account already has a business, so
  // it works for the second one exactly as it did for the first.
  const onboardingState = draft?.onboardingState as OnboardingState | null;
  const isOnboardingV2Draft =
    draft !== null && draft.status === "onboarding_discovery" && onboardingState?.step !== "not_ecommerce";
  if ((draft === null || isOnboardingV2Draft) && process.env.ONBOARDING_V2_ENABLED === "true") {
    redirect("/onboarding");
  }

  // Everything else is the classic form. Pre-filled from an interrupted
  // attempt where there was one, blank where there was not — the same two
  // cases /dashboard has always handled, reusing the same component rather
  // than a second copy that drifts.
  const resuming = draft !== null;
  const current = businesses[0]?.store;

  return (
    <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
      {/* A way back that names where it goes. Somebody who opened this by
          accident should not have to use the browser's back button, and
          "Cancel" would imply this page had already started something. */}
      {current && (
        <Link
          href={businesses.length > 1 ? "/choose-business" : `/b/${current.slug}`}
          className="text-[13px] text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
        >
          ← Back to {businesses.length > 1 ? "your businesses" : current.name}
        </Link>
      )}

      <h1 className="mt-4 text-2xl font-semibold text-black dark:text-zinc-50">
        {businesses.length > 0 ? "Add another business" : "Welcome to Genesis"}
      </h1>

      <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
        {resuming
          ? "Looks like your last attempt didn't finish — no problem. Your answers are still here, so just pick up where you left off."
          : businesses.length > 0
            ? // WHAT SEPARATE ACTUALLY MEANS, said plainly. An owner about to
              // create a second business is entitled to know whether it shares
              // anything with the first, and the answer is that it does not.
              "This one is completely separate: its own products, customers, orders, connections and history. J4 will know which business you're working on and reason only from that one."
            : "Tell Genesis what you want to build, in your own words — a real business, not a demo."}
      </p>

      <CreateStoreForm
        resuming={resuming}
        initialStoreName={draft?.inputStoreName ?? ""}
        initialProductType={draft?.inputProductType ?? ""}
        initialVision={draft?.inputVision ?? ""}
        userName={session.user.name ?? null}
      />
    </div>
  );
}
