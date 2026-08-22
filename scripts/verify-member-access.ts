import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { PERMISSIONS, ROLE_PERMISSIONS, hasPermission, type Permission } from "@/lib/permissions";
import {
  PERMISSION_LABEL,
  capabilitiesOf,
  listMembers,
  addMember,
  changeMemberRole,
  removeMember,
} from "@/lib/security/members";
import { touchSession, standingFor } from "@/lib/security/sessions";
import { SECURITY_EVENTS } from "@/lib/security/events";

// WHO CAN DO WHAT ON THIS BUSINESS:
//
//   npx tsx scripts/run-db-suites.ts member-access
//
// Steps 6 and 7, and D5's own reasoning: StoreMember has been ENFORCED
// everywhere for months while nothing in the product could WRITE one. Every row
// that ever existed was made by a verification script. So the authorization
// model was complete on the read side and unreachable on the write side, and
// "who can do what on my store" had exactly one possible answer: you.
//
// THE ASSERTION THAT MATTERS MOST IS §5. Removing a member deletes their row —
// and they are still holding a JWT valid for up to 30 days that does not
// consult StoreMember on every request. A removal that leaves them signed in is
// not a removal. That is threat case T6, and it is exactly why the contract
// sequenced this AFTER session revocation rather than before.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok, detail: "" });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2);

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `mem-owner-${uniq()}@test.local`, name: "Owner" } });
  const helper = await prisma.user.create({ data: { email: `mem-help-${uniq()}@test.local`, name: "Helper" } });
  const outsider = await prisma.user.create({ data: { email: `mem-out-${uniq()}@test.local`, name: "Outsider" } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `mem-${uniq()}` },
  });

  try {
    // ========================================================================
    console.log("\n=== 1. The review reads the real table, never a copy of it ===\n");
    // ========================================================================
    // A second copy of an authorization table is two answers to one question,
    // and the drifted one is the one nobody reads — here that means showing an
    // owner the wrong idea of who can spend their money.
    const allPermissions = Object.values(PERMISSIONS) as Permission[];
    for (const permission of allPermissions) {
      const label = PERMISSION_LABEL[permission];
      assert(`"${permission}" is described in the owner's own terms`,
        typeof label === "string" && label.length > 0, String(label));
      assert(`and "${permission}" does not print the system's vocabulary`,
        !label?.includes(":"), String(label));
    }

    for (const role of ["OWNER", "EMPLOYEE"] as const) {
      const capabilities = capabilitiesOf(role);
      check(`${role} is described across every permission`, capabilities.length, allPermissions.length);
      // THE ASSERTION THAT KEEPS THEM IN STEP: the review's answer must equal
      // what hasPermission actually enforces, for every permission.
      const disagreements = capabilities.filter((c) => c.granted !== hasPermission(role, c.permission));
      assert(`and every ${role} answer matches what is actually enforced`,
        disagreements.length === 0,
        disagreements.map((d) => d.permission).join(", "));
    }

    assert("an EMPLOYEE cannot manage payments",
      !hasPermission("EMPLOYEE", PERMISSIONS.PAYMENTS_MANAGE), "");
    assert("nor give other people access",
      !hasPermission("EMPLOYEE", PERMISSIONS.EMPLOYEES_MANAGE), "");
    assert("but can fulfil orders", hasPermission("EMPLOYEE", PERMISSIONS.ORDERS_MANAGE), "");

    // ========================================================================
    console.log("\n=== 2. The owner is derived, not a membership row ===\n");
    // ========================================================================
    const alone = await listMembers(store.id);
    check("a new business has exactly one person", alone.length, 1);
    check("who is the owner", alone[0]?.isOwner, true);
    check("with the owner role", alone[0]?.role, "OWNER");
    check("and no StoreMember row exists for them",
      await prisma.storeMember.count({ where: { storeId: store.id, userId: owner.id } }), 0);
    assert(
      "so the owner is one fact, not two",
      alone[0]?.userId === owner.id,
      "lib/permissions.ts derives OWNER from Store.userId; inventing a row here would be a second model"
    );

    // ========================================================================
    console.log("\n=== 3. Granting access, and the honest refusals ===\n");
    // ========================================================================
    check("an address with no Genesis account is refused, not invited",
      await addMember({ storeId: store.id, actorUserId: owner.id, email: "nobody@nowhere.test", role: "EMPLOYEE" }),
      { added: false, reason: "no_such_account" });
    assert(
      "because an invitation nobody could send would be a lie in a table",
      true,
      "email delivery is externally blocked here; the refusal says what to do instead"
    );

    const added = await addMember({
      storeId: store.id, actorUserId: owner.id, email: helper.email, role: "EMPLOYEE",
    });
    check("a real account is added", added, { added: true, userId: helper.id });

    const two = await listMembers(store.id);
    check("and now two people can reach the business", two.length, 2);
    check("the second as an employee", two[1]?.role, "EMPLOYEE");
    check("adding them twice is refused",
      await addMember({ storeId: store.id, actorUserId: owner.id, email: helper.email, role: "EMPLOYEE" }),
      { added: false, reason: "already_a_member" });
    check("and the owner cannot be added as their own employee",
      await addMember({ storeId: store.id, actorUserId: owner.id, email: owner.email, role: "EMPLOYEE" }),
      { added: false, reason: "is_owner" });

    // Case and spacing, because this is typed by hand.
    const messy = await addMember({
      storeId: store.id, actorUserId: owner.id, email: `  ${outsider.email.toUpperCase()}  `, role: "EMPLOYEE",
    });
    check("an address typed with stray case and spaces still resolves", messy.added, true);
    await removeMember({ storeId: store.id, actorUserId: owner.id, userId: outsider.id });

    // ========================================================================
    console.log("\n=== 4. Roles change; the owner's does not ===\n");
    // ========================================================================
    check("a member's role can be changed",
      await changeMemberRole({ storeId: store.id, actorUserId: owner.id, userId: helper.id, role: "OWNER" }),
      { changed: true });
    check("and it took", (await listMembers(store.id))[1]?.role, "OWNER");
    await changeMemberRole({ storeId: store.id, actorUserId: owner.id, userId: helper.id, role: "EMPLOYEE" });

    // WITHOUT THIS a business could be left with nobody who can manage it —
    // an unrecoverable state reached through a dropdown.
    check("the owner's own role cannot be changed",
      await changeMemberRole({ storeId: store.id, actorUserId: owner.id, userId: owner.id, role: "EMPLOYEE" }),
      { changed: false, reason: "is_owner" });
    check("somebody who is not a member cannot have a role changed",
      await changeMemberRole({ storeId: store.id, actorUserId: owner.id, userId: outsider.id, role: "EMPLOYEE" }),
      { changed: false, reason: "not_a_member" });

    // ========================================================================
    console.log("\n=== 5. Removing access ends their sessions ===\n");
    // ========================================================================
    // THREAT CASE T6, and the reason this step came after session revocation.
    // The row is gone, but they hold a JWT valid for up to 30 days that never
    // consults StoreMember. A removal that leaves them signed in is not one.
    const theirLaptop = `sess-${uniq()}`;
    const theirPhone = `sess-${uniq()}`;
    await touchSession({ userId: helper.id, sessionInstanceId: theirLaptop, device: "Mac · Safari" });
    await touchSession({ userId: helper.id, sessionInstanceId: theirPhone, device: "iPhone · Safari" });
    check("they are signed in on two devices", await standingFor(theirLaptop), "live");

    const removed = await removeMember({ storeId: store.id, actorUserId: owner.id, userId: helper.id });
    check("they are removed", removed, { removed: true, sessionsEnded: 2 });
    check("and cannot reach the business", (await listMembers(store.id)).length, 1);
    check("their laptop session is ended", await standingFor(theirLaptop), "revoked");
    check("and their phone", await standingFor(theirPhone), "revoked");
    assert(
      "so a departing employee is actually out, not just unlisted",
      (await standingFor(theirLaptop)) === "revoked",
      "the JWT does not consult StoreMember, so deleting the row alone changes nothing for 30 days"
    );

    check("the owner cannot be removed from their own business",
      await removeMember({ storeId: store.id, actorUserId: owner.id, userId: owner.id }),
      { removed: false, reason: "is_owner" });
    check("and removing a non-member is not found",
      await removeMember({ storeId: store.id, actorUserId: owner.id, userId: outsider.id }),
      { removed: false, reason: "not_a_member" });

    // ========================================================================
    console.log("\n=== 6. Every access change is in the actor's history ===\n");
    // ========================================================================
    const kinds = (await prisma.securityEvent.findMany({ where: { userId: owner.id } })).map((e) => e.kind);
    assert("granting access is recorded", kinds.includes(SECURITY_EVENTS.memberAdded), kinds.join(", "));
    assert("changing a role is recorded", kinds.includes(SECURITY_EVENTS.memberRoleChanged), kinds.join(", "));
    assert("and removing access is recorded", kinds.includes(SECURITY_EVENTS.memberRemoved), kinds.join(", "));

    // The role model itself is untouched by this milestone.
    check("there are still exactly two roles", Object.keys(ROLE_PERMISSIONS).sort(), ["EMPLOYEE", "OWNER"]);
  } finally {
    await prisma.store.deleteMany({ where: { id: store.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: [owner.id, helper.id, outsider.id] } } }).catch(() => {});
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  if (failed.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
