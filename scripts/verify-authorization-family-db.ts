import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission } from "@/lib/permissions";
import { accessTo, resolveBusiness } from "@/lib/businessContext";
import { isAllowedPlatformAdmin } from "@/lib/platformAdminPolicy";
import { readFileSync } from "node:fs";

// THE AUTHORIZATION FAMILY, AND WHETHER IT IS ONE RULE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts authorization-family-db
//
// ============ SIX HELPERS, OR SIX NAMES? (2026-08-30) ==================
//
// lib/permissions.ts exports six require* functions and 144 server actions are
// distributed across them. The question this suite exists to answer is whether
// they enforce ONE model or merely resemble each other.
//
// They are one model, on two deliberate axes:
//
//                       │ action (throws)          │ page (redirects)
//   ────────────────────┼──────────────────────────┼─────────────────────────
//   ambient (account)   │ requireStorePermission   │ requireStorePageAccess
//   explicit (by slug)  │ requireBusiness          │ requireBusinessPage
//
// plus two migration wrappers — requireBusinessOrActive and
// requireBusinessPageOrActive — that CHOOSE between the four and decide
// nothing themselves, and approvalAccessibleTo, which is a different rule on
// purpose: the row names its own business, because a proposal belongs to the
// business it was made for rather than to whichever one the account is in.
//
// ============ WHAT ALL SIX ACTUALLY SHARE =============================
//
// Underneath the four are exactly three decisions, and every one of them is
// exercised here against a real database:
//
//   accessTo(userId, storeId)        may this person reach this business
//   resolveBusiness(userId, id?)     which business, or is the question open
//   hasPermission(role, permission)  may this role do this
//
// If those hold, the helpers differ only in how they REPORT a refusal — throw
// or redirect — which is a routing decision, not an authorization one.
//
// ============ WHAT THIS HARNESS CANNOT DO =============================
//
// Not one of the six can be invoked here: each begins with auth(), and stubbing
// it would replace the thing under test. So the decisions are proven end to
// end, and the wiring around them is asserted against the source and backed by
// sabotage. Stated plainly rather than implied.

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const PERMISSIONS_FILE = "lib/permissions.ts";

/** The body of one exported function, up to the next top-level export. */
function bodyOf(src: string, fn: string): string {
  const at = src.indexOf(`export async function ${fn}(`);
  if (at < 0) throw new Error(`${fn} is no longer exported from ${PERMISSIONS_FILE}`);
  const rest = src.slice(at + 10);
  const next = rest.indexOf("\nexport ");
  return next < 0 ? rest : rest.slice(0, next);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const owner = await prisma.user.create({ data: { email: `af-o-${stamp}@example.test`, name: "Owner" } });
  const employee = await prisma.user.create({ data: { email: `af-e-${stamp}@example.test`, name: "Employee" } });
  const stranger = await prisma.user.create({ data: { email: `af-s-${stamp}@example.test`, name: "Stranger" } });

  const store = await prisma.store.create({
    data: { userId: owner.id, name: "AF", slug: `af-${stamp}`, tagline: "t", description: "d" },
  });
  await prisma.storeMember.create({
    data: { storeId: store.id, userId: employee.id, role: "EMPLOYEE" },
  });

  console.log("\n--- decision 1: who may reach a business ---\n");
  {
    const asOwner = await accessTo(owner.id, store.id);
    eq("the owner reaches it, as OWNER", asOwner?.role, "OWNER");
    // OWNER is derived from Store.userId — an owner never has a StoreMember
    // row — so this is a genuinely different code path from the employee's.
    const asEmployee = await accessTo(employee.id, store.id);
    eq("the employee reaches it, as EMPLOYEE", asEmployee?.role, "EMPLOYEE");
    eq("a stranger reaches nothing", await accessTo(stranger.id, store.id), null);
    eq("and neither does anybody, for a business that does not exist",
      await accessTo(owner.id, `af-nothing-${stamp}`), null);
  }

  console.log("\n--- decision 2: which business, and when the question is open ---\n");
  {
    const resolved = await resolveBusiness(owner.id);
    eq("one business resolves without being asked", resolved.kind, "resolved");

    // ============ THE BRANCH THAT PROTECTS EVERY ACTION ============
    //
    // requireStorePermission(permission, storeId) passes a caller-supplied id
    // straight to this. If it returned a business the caller cannot reach,
    // every ambient action in the codebase would be a cross-store read — the
    // exact defect just closed one layer above.
    const notMine = await resolveBusiness(stranger.id, store.id);
    eq("a named business the caller cannot reach resolves to none", notMine.kind, "none");
    assert("and carries no store with it", !("store" in notMine), JSON.stringify(notMine));

    const nobody = await resolveBusiness(stranger.id);
    eq("an account with no business resolves to none", nobody.kind, "none");

    // Two reachable businesses and nothing saying which is a question, not a
    // guess — the branch that used to silently pick one.
    const second = await prisma.store.create({
      data: { userId: owner.id, name: "AF2", slug: `af2-${stamp}`, tagline: "t", description: "d" },
    });
    const ambiguous = await resolveBusiness(owner.id);
    eq("two businesses and no active pointer is ambiguous", ambiguous.kind, "ambiguous");

    // An active pointer answers it, and a stale one falls through rather than
    // erroring.
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: second.id } });
    const active = await resolveBusiness(owner.id);
    eq("the active business answers it", active.kind === "resolved" && active.store.id, second.id);
    await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: null } });
    await prisma.store.delete({ where: { id: second.id } });
  }

  console.log("\n--- decision 3: what a role may do ---\n");
  {
    // EXHAUSTIVE over the real table rather than a handful of spot checks: a
    // permission added to EMPLOYEE by accident is exactly the drift nobody
    // notices, and a sampled test would not see it.
    const all = Object.values(PERMISSIONS);
    for (const permission of all) {
      assert(`an OWNER may ${permission}`, hasPermission("OWNER", permission));
    }
    eq("an OWNER holds every permission there is",
      ROLE_PERMISSIONS.OWNER.length, all.length);

    // The four an employee holds, named, so widening the role fails here.
    eq("an EMPLOYEE holds exactly four", [...ROLE_PERMISSIONS.EMPLOYEE].sort(),
      ["genesis:chat", "orders:manage", "orders:view", "products:manage"]);

    for (const permission of all) {
      const expected = (ROLE_PERMISSIONS.EMPLOYEE as string[]).includes(permission);
      eq(`an EMPLOYEE ${expected ? "may" : "may not"} ${permission}`,
        hasPermission("EMPLOYEE", permission), expected);
    }

    // The money and governance permissions, called out because they are the
    // ones a widening would matter most for.
    for (const owner_only of [PERMISSIONS.PAYMENTS_MANAGE, PERMISSIONS.BILLING_MANAGE,
      PERMISSIONS.EMPLOYEES_MANAGE, PERMISSIONS.AUTHORITY_MANAGE, PERMISSIONS.CONNECTIONS_MANAGE,
      PERMISSIONS.STORE_MANAGE, PERMISSIONS.REVENUE_VIEW]) {
      eq(`${owner_only} is owner-only`, hasPermission("EMPLOYEE", owner_only), false);
    }
  }

  console.log("\n--- the family: one shape, six entry points ---\n");
  {
    const src = readFileSync(PERMISSIONS_FILE, "utf8");
    const FOUR = ["requireStorePermission", "requireBusiness", "requireBusinessPage", "requireStorePageAccess"];
    const WRAPPERS = ["requireBusinessOrActive", "requireBusinessPageOrActive"];

    for (const fn of [...FOUR, ...WRAPPERS]) {
      assert(`${fn} is still exported`, src.includes(`export async function ${fn}(`));
    }

    for (const fn of FOUR) {
      const body = bodyOf(src, fn);
      // IDENTITY BEFORE ANYTHING. A helper that read a store before knowing
      // who was asking would be answering a question it had not been given
      // the right to answer.
      const authAt = body.indexOf("await auth()");
      const prismaAt = body.indexOf("prisma.");
      const resolveAt = body.indexOf("resolveBusiness(");
      const firstRead = Math.min(...[prismaAt, resolveAt].filter((n) => n > -1));
      assert(`${fn} establishes identity before reading anything`,
        authAt > -1 && (firstRead === Infinity || authAt < firstRead),
        `auth ${authAt}, first read ${firstRead}`);

      // ONE DECISION, NOT A REIMPLEMENTATION. Every one must reach the shared
      // decisions rather than hand-rolling a findFirst ownership check.
      assert(`${fn} uses the shared access decision`,
        /accessTo\(|resolveBusiness\(/.test(body));
      assert(`${fn} never hand-rolls an ownership check`,
        !/findFirst\(\s*\{\s*where:\s*\{[^}]*userId/.test(body), body.slice(0, 200));
    }

    // ============ THE WRAPPERS MUST NOT DECIDE ANYTHING ============
    //
    // Their whole value is that a migrating call site gets the same rule
    // either way. A wrapper that grew its own auth() or its own query would be
    // a seventh rule wearing a sixth name.
    for (const fn of WRAPPERS) {
      const body = bodyOf(src, fn);
      assert(`${fn} delegates rather than deciding`,
        !body.includes("await auth()") && !body.includes("prisma."), body.slice(0, 200));
      assert(`${fn} chooses between the two real helpers`,
        FOUR.some((f) => body.includes(`${f}(`)));
    }
  }

  console.log("\n--- every refusal is recorded, page and action alike ---\n");
  {
    // ============ THE INCONSISTENCY THIS SUITE WAS WRITTEN FOR ======
    //
    // Both action helpers recorded a signal on every denial; both PAGE helpers
    // recorded none. Typing another business's slug into the URL — the most
    // natural way anybody probes this platform — produced nothing at all. The
    // refusals were correct and invisible, which is the difference between a
    // system that is safe and one that can say so.
    const src = readFileSync(PERMISSIONS_FILE, "utf8");

    // Each denial branch must record BEFORE it refuses: notFound() and
    // redirect() throw, so anything after them never runs.
    const branches: [string, RegExp][] = [
      ["requireBusinessPage refuses an unknown slug",
        /if \(!store\) \{[\s\S]{0,600}?await recordSignal\(\{[\s\S]{0,400}?notFound\(\)/],
      ["requireBusinessPage refuses a business that is not yours",
        /if \(!access\) \{[\s\S]{0,600}?await recordSignal\(\{[\s\S]{0,400}?notFound\(\)/],
      ["requireBusinessPage refuses an insufficient role",
        /requireBusinessPage[\s\S]{0,3000}?hasPermission\(access\.role, permission\)\) \{[\s\S]{0,500}?await recordSignal\(\{[\s\S]{0,500}?redirect\(/],
      ["requireStorePageAccess refuses an insufficient role",
        /requireStorePageAccess[\s\S]{0,2000}?hasPermission\(resolution\.role, permission\)\) \{[\s\S]{0,500}?await recordSignal\(\{[\s\S]{0,500}?redirect\("\/dashboard"\)/],
      ["requireBusiness refuses an unknown slug",
        /requireBusiness\(\s*\n?\s*permission: Permission,\s*\n?\s*slug: string[\s\S]{0,1200}?if \(!store\) \{[\s\S]{0,500}?await recordSignal/],
    ];
    for (const [name, pattern] of branches) {
      assert(name, pattern.test(src));
    }

    // Counted, so a branch added later without a signal is visible as a number
    // going out of step rather than as nothing at all.
    const denials = (src.match(/await recordSignal\(\{/g) ?? []).length;
    assert("every refusal branch records one", denials >= 9, `${denials}`);

    // And the kinds are real members of the stream, not free strings.
    const { SIGNAL_KINDS } = await import("@/lib/security/signals");
    eq("authz.denied is a declared kind", SIGNAL_KINDS.authzDenied, "authz.denied");
    eq("authz.unresolved is a declared kind", SIGNAL_KINDS.authzUnresolved, "authz.unresolved");
  }

  console.log("\n--- one rule per question, no second copies ---\n");
  {
    // ============ THE MIRRORED-REGISTRY INVARIANT ==================
    //
    // ARCHITECTURE.md's rule, applied to authorization: two implementations of
    // one decision agree until the day they do not, and the drifted one is the
    // one nobody is reading.
    const { execSync } = await import("node:child_process");
    // ============ NAMING IT IS NOT READING IT (2026-08-30) =======
    //
    // lib/config/registry.ts describes every environment variable this platform
    // uses, so it mentions this one by name — which is the opposite of a second
    // implementation. The invariant is that one module DECIDES who is an
    // administrator, and a catalogue entry decides nothing.
    const readers = execSync('git grep -l "PLATFORM_ADMIN_EMAILS" -- lib app', { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .filter((f) => !f.startsWith("lib/config/"));
    // ============ WHICH MODULE, AND WHY IT MOVED (2026-09-05) ====
    //
    // This named lib/platformAdmin.ts, and the invariant is unchanged:
    // exactly ONE module decides who is an operator. What changed is which,
    // and it moved for a reason this check itself found.
    //
    // The Growth Points ledger needed the same answer about a store's OWNER
    // rather than about whoever is signed in. It could not ask
    // lib/platformAdmin, which begins `import "server-only"` and so does not
    // resolve under tsx, where several suites exercise the ledger. So the
    // ledger read the variable itself and this assertion caught it - working
    // exactly as intended.
    //
    // The answer was not to allow a second reader. One question gets one
    // answer, in the module that already holds the rule and that anything can
    // import; lib/platformAdmin keeps the session, the redirect and the
    // refusal signal, which are genuinely its own. So the count is still one,
    // and it is now the module the next assertion always said the parsing
    // belonged in.
    eq("exactly one module reads the platform-admin allowlist", readers, ["lib/platformAdminPolicy.ts"]);

    const policySrc = readFileSync("lib/platformAdminPolicy.ts", "utf8");
    eq("and it parses it exactly once",
      (policySrc.match(/PLATFORM_ADMIN_EMAILS/g) ?? []).length, 1);
    // The session-reading wrapper must go through the policy rather than
    // keeping a copy of the rule beside it.
    const adminSrc = readFileSync("lib/platformAdmin.ts", "utf8");
    assert("the session wrapper asks the policy rather than restating it",
      adminSrc.includes('from "@/lib/platformAdminPolicy"')
      && !adminSrc.includes("PLATFORM_ADMIN_EMAILS"));
    // And the ledger asks the same one, so a platform action is covered on
    // every rail rather than on whichever one somebody remembered.
    const ledgerSrc = readFileSync("lib/growthPoints/ledger.ts", "utf8");
    assert("the spending rails ask the policy too",
      ledgerSrc.includes('from "@/lib/platformAdminPolicy"')
      && !ledgerSrc.includes("PLATFORM_ADMIN_EMAILS"));

    // The policy still holds — proven here too, so deleting the dead copy
    // cannot have taken the live behaviour with it.
    eq("a listed operator is still admitted",
      isAllowedPlatformAdmin("ops@genesis.test", "ops@genesis.test"), true);
    eq("and an unset allowlist still admits nobody",
      isAllowedPlatformAdmin("ops@genesis.test", ""), false);

    // The role table has one home as well.
    const tables = execSync('git grep -l "ROLE_PERMISSIONS" -- lib app', { encoding: "utf8" })
      .split("\n").filter(Boolean).filter((f) => f !== "lib/permissions.ts");
    for (const f of tables) {
      const s = readFileSync(f, "utf8");
      assert(`${f} reads the role table rather than restating it`,
        !/ROLE_PERMISSIONS\s*[:=]\s*\{/.test(s), "a second copy of the role table");
    }
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
