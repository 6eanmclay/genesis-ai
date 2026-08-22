import { PERMISSIONS, hasPermission, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { listMembers, capabilitiesOf } from "@/lib/security/members";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import { AccessControls } from "./AccessControls";

// WHO CAN REACH THIS BUSINESS.
//
// Business-scoped, unlike /account/security: access is a fact about one
// business, and an account with three of them has three different answers.
// That is the mirror of the reasoning that made account security
// account-scoped.
//
// OWNER-ONLY, through EMPLOYEES_MANAGE — a permission that existed in the
// table and was read by nothing until this screen. An employee seeing the
// full roster and its capabilities is a different product decision from an
// employee being able to change it, and the table already answers it.

export async function AccessScreen({
  slug,
  // Kept in the signature so this screen matches every other one's contract,
  // and unused because nothing here links to another screen — the actions take
  // `slug` directly. Underscored rather than dropped, the same convention
  // sectionLayoutFor's own `_section` uses.
  basePath: _basePath,
}: {
  slug?: string;
  basePath: string;
}) {
  const { store, role } = await requireBusinessPageOrActive(PERMISSIONS.EMPLOYEES_MANAGE, slug);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const members = await listMembers(store.id);
  const canManage = hasPermission(role, PERMISSIONS.EMPLOYEES_MANAGE);

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Who can reach this business</h1>
      <p className="mt-2 max-w-prose text-sm text-zinc-600 dark:text-zinc-400">
        {members.length === 1
          ? "Only you. Anyone you add here can act on this business straight away."
          : `${members.length} people, including you.`}
      </p>

      <div className="mt-6 max-w-2xl">
        <AccessControls members={members} canManage={canManage} slug={slug} />
      </div>

      {/* WHAT EACH ROLE ACTUALLY MEANS, read from the permission table rather
          than described in prose that could drift from it. This is the
          "reviewable answer to who can do what" the milestone asked for, and
          it is generated from the same rows hasPermission enforces. */}
      <div className="mt-10 max-w-2xl">
        <h2 className="text-base font-semibold text-black dark:text-zinc-50">What each role can do</h2>
        <div className="mt-4 grid gap-6 sm:grid-cols-2">
          {(["OWNER", "EMPLOYEE"] as const).map((r) => (
            <div key={r}>
              <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
                {r === "OWNER" ? "Owner" : "Employee"}
              </p>
              <ul className="mt-2 flex flex-col gap-1.5">
                {capabilitiesOf(r).map((capability) => (
                  <li
                    key={capability.permission}
                    className={`flex items-baseline gap-2 text-sm ${
                      capability.granted ? "text-black dark:text-zinc-50" : "text-zinc-400 dark:text-zinc-600"
                    }`}
                  >
                    <span aria-hidden="true">{capability.granted ? "✓" : "—"}</span>
                    <span>{capability.label}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// The legacy route — resolves the account's ACTIVE business and renders the
// same screen /b/<slug>/access renders.
export default async function AccessPage() {
  return AccessScreen({ basePath: LEGACY_BUSINESS_BASE });
}
