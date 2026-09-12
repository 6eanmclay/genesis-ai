import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { PERMISSIONS, hasPermission, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { buildAuthoritySurface, type AuthorityCapability } from "@/lib/dashboard/authoritySurface";
import { grantAuthority, revokeAuthority } from "../actions";
import { SubmitButton } from "../SubmitButton";

// WHAT J4 MAY DO WITHOUT ASKING — the whole picture, in one place.
//
// ============ WHY THIS SCREEN EXISTS (2026-09-11) ====================
//
// The authority audit found two production paths that execute without the
// owner clicking anything, gated on different things, and exactly one button
// anywhere in the product describing either of them. That button covered the
// delegated path and was captioned, when no grant existed, "Genesis will
// always ask before changing your SEO title or description" — which was not
// true, because SEO is the one action registered at tier "auto" and the chat
// path publishes it on the spot.
//
// So the two warrants get two headings, side by side, and the difference is
// the first thing on the page rather than a footnote.
//
// ============ IT CHANGES NOTHING ====================================
//
// No tier moves, no gate is added, revoking still does exactly what it did.
// This screen reports. Where the product has an unresolved question — whether
// revoking ought to cover the present-owner warrant too — the screen says so
// in the owner's own language instead of quietly implying an answer, because
// the alternative is a UI that settles a product decision by being vague.
//
// ============ AND IT DOES NOT INVENT CONTROLS =======================
//
// Three capabilities are delegable and only one has ever had a button. The
// other two render as informational and say they cannot be turned on here,
// rather than being given a control so the list looks symmetrical. Adding
// those controls would be handing owners new autonomy, which is a product
// decision and not a layout one.

export const metadata = { title: "Genesis's authority" };

function GrantBadge({ capability }: { capability: AuthorityCapability }) {
  const { grantState } = capability;
  const tone =
    grantState === "granted"
      ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
      : "bg-black/[.05] text-zinc-600 dark:bg-white/[.06] dark:text-zinc-400";
  const text =
    grantState === "granted" ? "Granted" : grantState === "revoked" ? "Revoked" : "Not granted";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tone}`}>{text}</span>
  );
}

export async function AuthorityScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store, role } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);
  // Granting is OWNER-only (AUTHORITY_MANAGE). An employee who can reach this
  // page sees the same true picture and no controls — the state is not a
  // secret, the ability to change it is the permission.
  const canManageAuthority = hasPermission(role, PERMISSIONS.AUTHORITY_MANAGE);

  // EVERY grant row, revoked ones included — a revoked grant is a fact about
  // this business worth showing, and "no row" and "a row that was turned off"
  // are different answers to "have I ever given Genesis this?"
  const grants = await prisma.delegatedAuthority.findMany({
    where: { storeId: store.id },
    orderBy: { grantedAt: "desc" },
  });
  const surface = buildAuthoritySurface(
    grants.map((g) => ({ actionType: g.actionType, grantedAt: g.grantedAt, revokedAt: g.revokedAt })),
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Genesis&apos;s authority</h1>
      <p className="mt-2 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
        There are two different situations, and they work differently. Everything not
        described below stops and asks you first.
      </p>

      {/* ---------------- WHILE YOU'RE HERE ---------------- */}
      <section className="mt-8">
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">While you&apos;re here</h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          In a conversation, Genesis can carry out some changes as part of its reply,
          with no separate approval step — you&apos;re present, so there is no second
          place to say yes. Genesis still decides when a change is worth checking with
          you first, and stops to ask when it is.
        </p>
        <p className="mt-2 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          This is not something you have granted, and the controls below do not turn it
          off.
        </p>
        {surface.whileHere.length === 0 ? (
          <p className="mt-3 text-sm text-zinc-500">
            Nothing today. Every change waits for you.
          </p>
        ) : (
          <ul className="mt-3 flex max-w-xl flex-col divide-y divide-black/[.05] rounded-lg border border-black/[.08] dark:divide-white/[.08] dark:border-white/[.145]">
            {surface.whileHere.map((c) => (
              <li key={c.actionType} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="text-sm text-black dark:text-zinc-50">{c.label}</span>
                <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-white/[.06] dark:text-zinc-400">
                  Always on
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- WHILE YOU'RE AWAY ---------------- */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">While you&apos;re away</h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          When you are not here, Genesis acts only on authority you have given it,
          for the specific capability you gave it. You can take it back at any time.
        </p>
        <ul className="mt-3 flex max-w-xl flex-col gap-3">
          {surface.whileAway.map((c) => (
            <li
              key={c.actionType}
              className="rounded-lg border border-black/[.08] p-3 dark:border-white/[.145]"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-black dark:text-zinc-50">{c.label}</span>
                <GrantBadge capability={c} />
              </div>
              <p className="mt-1 text-xs text-zinc-500">
                {c.grantState === "granted"
                  ? `Genesis can do this while you're away. Granted ${c.grantedAt?.toLocaleDateString() ?? ""}.`
                  : c.grantState === "revoked"
                    ? `You turned this off${c.revokedAt ? ` on ${c.revokedAt.toLocaleDateString()}` : ""}. Genesis will not do it while you're away.`
                    : "Genesis will not do this while you're away."}
              </p>
              {c.hasControl && canManageAuthority ? (
                <form
                  action={(c.grantState === "granted" ? revokeAuthority : grantAuthority).bind(null, slug)}
                  className="mt-3"
                >
                  <input type="hidden" name="actionType" value={c.actionType} />
                  <SubmitButton
                    pendingText={c.grantState === "granted" ? "Revoking..." : "Granting..."}
                    className={
                      c.grantState === "granted"
                        ? "rounded-full border border-black/[.08] px-4 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                        : "rounded-full bg-[var(--brand-accent,var(--foreground))] px-4 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-50"
                    }
                  >
                    {c.grantState === "granted"
                      ? "Ask before doing this while I'm away"
                      : "Let Genesis do this while I'm away"}
                  </SubmitButton>
                </form>
              ) : (
                // NO BUTTON, AND THE REASON SAID OUT LOUD. These capabilities are
                // genuinely delegable in the engine; nothing in the product offers
                // them yet, and pretending otherwise would be a control that
                // changes nothing or a new permission nobody decided to give.
                <p className="mt-2 text-xs text-zinc-500">
                  {canManageAuthority
                    ? "Can be delegated, but there's no control for it yet — Genesis asks every time."
                    : "Only the business owner can change this."}
                </p>
              )}
            </li>
          ))}
        </ul>
        {/* THE OPEN QUESTION, IN THE OWNER'S LANGUAGE. Revoking closes the
            away-from-desk path and nothing else. Whether it SHOULD also cover
            what Genesis does in conversation has not been decided, and a
            screen that stayed quiet about it would be answering it by
            implication. */}
        <p className="mt-3 max-w-xl text-xs text-zinc-500">
          Turning one of these off applies to when you&apos;re away. It does not change
          what Genesis does in a conversation with you — see above.
        </p>
      </section>

      {/* ---------------- NOT A PERMISSION ---------------- */}
      {surface.exempt.length > 0 && (
        <section className="mt-10">
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Not a permission</h2>
          <p className="mt-1 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
            Genesis does these without authority because they change nothing about your
            business — they only tell you something. There is nothing to grant or
            revoke.
          </p>
          <ul className="mt-3 flex max-w-xl flex-col divide-y divide-black/[.05] rounded-lg border border-black/[.08] dark:divide-white/[.08] dark:border-white/[.145]">
            {surface.exempt.map((c) => (
              <li key={c.actionType} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <span className="text-sm text-black dark:text-zinc-50">{c.label}</span>
                <span className="rounded-full bg-black/[.05] px-2 py-0.5 text-[11px] font-medium text-zinc-600 dark:bg-white/[.06] dark:text-zinc-400">
                  Informational
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ---------------- EVERYTHING ELSE ---------------- */}
      <section className="mt-10">
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Everything else asks</h2>
        <p className="mt-1 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
          {surface.alwaysAsks.total} other things Genesis can do all wait for you to
          approve them, every time. {surface.alwaysAsks.permanentlyCapped} of those —
          anything involving money or deleting something — can never be delegated at
          all, whatever you or Genesis decide later.
        </p>
        <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          <Link href={`${basePath}/marketing`} className="underline underline-offset-2">
            Recent SEO decisions
          </Link>{" "}
          shows what Genesis has published and lets you revert any of it.
        </p>
      </section>
    </div>
  );
}

// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/authority renders.
export default async function AuthorityPage() {
  return AuthorityScreen({ basePath: LEGACY_BUSINESS_BASE });
}
