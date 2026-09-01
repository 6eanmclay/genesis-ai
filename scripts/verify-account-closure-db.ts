import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { closeAccount, closedEmailFor, isClosed } from "@/lib/account/closure";
import { buildAccountExport, EXPORT_COVERAGE, coverageFor } from "@/lib/account/export";
import { SIGNAL_KINDS } from "@/lib/security/signals";
import { retentionClassOf } from "@/lib/security/retention";
import { readFileSync } from "node:fs";

// CLOSING AN ACCOUNT WITHOUT DESTROYING A BUSINESS'S RECORDS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts account-closure-db
//
// ============ THE CASCADE THAT MADE THIS NECESSARY (2026-08-30) ========
//
// User cascades to Store, and Store cascades to Order. So the obvious
// implementation — `prisma.user.delete()` — would have deleted every business
// the person owns and every order inside them: every payment, every refund,
// every dispute, every customer's transaction.
//
// Sean: "Do not erase the financial/order record wholesale. Anonymize
// personal/customer information while retaining the minimum transaction record
// Genesis legitimately needs."
//
// That cascade is still there. It is a property of the schema, not something
// this work removed, so the first thing below PROVES it — a throwaway user is
// deleted outright and its order is confirmed gone. Every later assertion means
// something only because that one passes: this file demonstrates the loaded
// weapon before demonstrating that closure does not fire it.

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

let seq = 0;
async function makeOwner(stamp: number, opts: { orders?: number } = {}) {
  const n = ++seq;
  const user = await prisma.user.create({
    data: {
      email: `ac-${stamp}-${n}@example.test`,
      name: "Real Person",
      image: "https://example.test/face.png",
      password: "$2a$10$notarealhashbutlongenough",
      totpSecret: "SECRETSECRET",
      totpEnabledAt: new Date(),
      emailVerified: new Date(),
      referralCode: `ref-${stamp}-${n}`,
    },
  });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit", slug: `ac-${stamp}-${n}`, tagline: "t", description: "d" },
  });
  await prisma.user.update({ where: { id: user.id }, data: { activeStoreId: store.id } });
  const orderIds: string[] = [];
  for (let i = 0; i < (opts.orders ?? 0); i++) {
    const order = await prismaSystem.order.create({
      data: {
        storeId: store.id,
        productName: `Widget ${i}`,
        amountInCents: 4999 + i,
        buyerEmail: `customer-${stamp}-${n}-${i}@example.test`,
        paymentProvider: "STRIPE",
        externalOrderId: `ext-${stamp}-${n}-${i}`,
        shippingAddress: { line1: "12 Real Street", city: "Leeds" },
      },
    });
    orderIds.push(order.id);
  }
  return { user, store, orderIds };
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- the cascade this whole design exists to avoid is real ---\n");
  {
    const { user, store, orderIds } = await makeOwner(stamp, { orders: 1 });
    // Deleting the user directly, which is what closure must never do.
    await prisma.user.delete({ where: { id: user.id } });
    eq("deleting a User row takes its Store with it",
      await prismaSystem.store.count({ where: { id: store.id } }), 0);
    eq("and therefore takes the ORDER — the financial record — with it",
      await prismaSystem.order.count({ where: { id: { in: orderIds } } }), 0);
  }

  console.log("\n--- closure keeps the business and the money, and erases the person ---\n");
  const closed = await makeOwner(stamp, { orders: 3 });
  {
    const before = await prismaSystem.order.findMany({
      where: { storeId: closed.store.id },
      select: { id: true, amountInCents: true, buyerEmail: true, externalOrderId: true },
      orderBy: { externalOrderId: "asc" },
    });

    const result = await closeAccount({
      userId: closed.user.id, reason: "requested by the owner", actorId: closed.user.id,
    });
    assert("the closure reports that it acted", result.closed);

    const after = await prisma.user.findUnique({ where: { id: closed.user.id } });
    assert("the User row still exists", !!after);
    assert("the email is gone", after!.email !== closed.user.email, after!.email);
    assert("and is not recoverable from what replaced it",
      !after!.email.includes(closed.user.email!.split("@")[0]), after!.email);
    eq("the email is the deterministic placeholder", after!.email, closedEmailFor(closed.user.id));
    eq("the name is gone", after!.name, null);
    eq("the avatar is gone", after!.image, null);
    eq("the password is gone", after!.password, null);
    eq("the two-factor secret is gone", after!.totpSecret, null);
    eq("the two-factor enrolment is gone", after!.totpEnabledAt, null);
    eq("the verified-email timestamp is gone", after!.emailVerified, null);
    eq("the referral code is released", after!.referralCode, null);
    eq("nothing resolves to a business through the account", after!.activeStoreId, null);
    assert("the closure is stamped", !!after!.closedAt);
    eq("and says why", after!.closureReason, "requested by the owner");

    // ============ THE POINT OF THE WHOLE EXERCISE ==================
    const stores = await prismaSystem.store.count({ where: { id: closed.store.id } });
    eq("the business survives", stores, 1);
    const orders = await prismaSystem.order.findMany({
      where: { storeId: closed.store.id },
      select: { id: true, amountInCents: true, buyerEmail: true, externalOrderId: true },
      orderBy: { externalOrderId: "asc" },
    });
    eq("all three orders survive", orders.length, 3);
    eq("byte for byte — amounts, customer emails and provider ids unchanged", orders, before);
    eq("the result reports what it kept", result.retained.orders, 3);
    assert("and says why it kept it",
      /accounting|tax|refund|dispute/i.test(result.retained.reason), result.retained.reason);
  }

  console.log("\n--- every credential is deleted, not anonymised ---\n");
  {
    const { user } = await makeOwner(stamp);
    await prisma.account.create({
      data: {
        userId: user.id, type: "oauth", provider: "google",
        providerAccountId: `pa-${stamp}`, refresh_token: "a-real-refresh-token",
      },
    });
    await prisma.session.create({
      data: { userId: user.id, sessionToken: `st-${stamp}`, expires: new Date(Date.now() + 8.64e7) },
    });
    await prisma.userSession.create({
      data: { userId: user.id, sessionInstanceId: `si-${stamp}`, device: "Firefox on Windows" },
    });
    await prisma.recoveryCode.create({ data: { userId: user.id, codeHash: `rc-${stamp}` } });
    await prisma.passwordResetToken.create({
      data: { userId: user.id, tokenHash: `prt-${stamp}`, expiresAt: new Date(Date.now() + 8.64e7) },
    });

    const result = await closeAccount({ userId: user.id, reason: "support request", actorId: "operator-1" });

    eq("the OAuth account is deleted", await prisma.account.count({ where: { userId: user.id } }), 0);
    eq("the session is deleted", await prisma.session.count({ where: { userId: user.id } }), 0);
    eq("the device session is deleted", await prisma.userSession.count({ where: { userId: user.id } }), 0);
    eq("the recovery codes are deleted", await prisma.recoveryCode.count({ where: { userId: user.id } }), 0);
    eq("the reset token is deleted", await prisma.passwordResetToken.count({ where: { userId: user.id } }), 0);
    eq("and the counts are reported", result.removed,
      { oauthAccounts: 1, sessions: 1, userSessions: 1, recoveryCodes: 1, passwordResetTokens: 1 });
    assert("the account reads as closed", await isClosed(user.id));
  }

  console.log("\n--- running it twice changes nothing ---\n");
  {
    const first = await prisma.user.findUnique({ where: { id: closed.user.id } });
    const again = await closeAccount({
      userId: closed.user.id, reason: "a different reason entirely", actorId: "operator-2",
    });
    assert("the second call reports it did not act", !again.closed);
    assert("and says when it was already closed",
      again.alreadyClosedAt?.getTime() === first!.closedAt!.getTime());

    const after = await prisma.user.findUnique({ where: { id: closed.user.id } });
    eq("the closure timestamp is untouched", after!.closedAt, first!.closedAt);
    eq("the original reason is NOT overwritten by the retry", after!.closureReason, "requested by the owner");
    eq("and the orders are still there", await prismaSystem.order.count({ where: { storeId: closed.store.id } }), 3);
  }

  console.log("\n--- one account's closure never reaches another's data ---\n");
  {
    const a = await makeOwner(stamp, { orders: 2 });
    const b = await makeOwner(stamp, { orders: 2 });
    await prisma.session.create({
      data: { userId: b.user.id, sessionToken: `keep-${stamp}`, expires: new Date(Date.now() + 8.64e7) },
    });

    await closeAccount({ userId: a.user.id, reason: "requested by the owner", actorId: a.user.id });

    const other = await prisma.user.findUnique({ where: { id: b.user.id } });
    eq("the other owner's email is untouched", other!.email, b.user.email);
    eq("their name is untouched", other!.name, "Real Person");
    eq("their password is untouched", other!.password, b.user.password);
    eq("they are not marked closed", other!.closedAt, null);
    eq("their session survives", await prisma.session.count({ where: { userId: b.user.id } }), 1);
    eq("their business survives", await prismaSystem.store.count({ where: { id: b.store.id } }), 1);
    eq("their orders survive", await prismaSystem.order.count({ where: { storeId: b.store.id } }), 2);
  }

  console.log("\n--- a closure that cannot complete leaves nothing half-done ---\n");
  {
    await assert("closing an account that does not exist throws",
      await closeAccount({ userId: "no-such-user", reason: "r", actorId: "x" })
        .then(() => false).catch(() => true));
  }

  console.log("\n--- the act is recorded, and the record never carries what it erased ---\n");
  {
    const { user } = await makeOwner(stamp);
    const email = user.email;
    await closeAccount({ userId: user.id, reason: "requested by the owner", actorId: user.id });

    const signal = await prismaSystem.securitySignal.findFirst({
      where: { kind: SIGNAL_KINDS.accountClosed, actorId: user.id },
      orderBy: { occurredAt: "desc" },
    });
    assert("a security signal is written", !!signal);
    const body = JSON.stringify(signal?.detail ?? {});
    assert("it names the account", body.includes(user.id));
    assert("it does NOT carry the erased email", !body.includes(email), body.slice(0, 200));
    assert("nor the erased name", !body.includes("Real Person"), body.slice(0, 200));
    eq("and it is classified as a deliberate act, not volume noise",
      retentionClassOf(SIGNAL_KINDS.accountClosed, "warning"), "ACT");
  }

  console.log("\n--- the export declares its own coverage, checked against the schema ---\n");
  {
    // ============ THE MIRRORED-REGISTRY CROSS-CHECK ================
    //
    // Read the relations off Store in schema.prisma rather than trusting a
    // list. A model added next month with nobody deciding whether it belongs in
    // an export fails here, which is the only reason this stays true.
    const schema = readFileSync("prisma/schema.prisma", "utf8");
    const model = schema.slice(schema.indexOf("model Store {"));
    const block = model.slice(0, model.indexOf("\n}"));
    // Scalar lists (`businessCategories String[]`) match the same shape as a
    // relation list and are not relations. Named rather than pattern-guessed,
    // so a new primitive does not silently become a missing export section.
    const SCALARS = ["String", "Int", "Float", "Boolean", "DateTime", "Json", "Decimal", "BigInt", "Bytes"];
    const relations = [...block.matchAll(/^\s+[a-z][A-Za-z]*\s+([A-Z][A-Za-z]*)\[\]/gm)]
      .map((m) => m[1])
      .filter((type) => !SCALARS.includes(type));
    assert("the sweep found Store's relations", relations.length > 25, String(relations.length));
    assert("and did not mistake a scalar list for one", !relations.includes("String"));

    const undeclared = relations.filter((r) => !coverageFor(r));
    eq("every relation on Store is declared included or excluded", undeclared, []);

    const stale = EXPORT_COVERAGE.filter(
      (s) => s.model !== "User" && !relations.includes(s.model),
    ).map((s) => s.model);
    eq("and the coverage table names nothing that no longer exists", stale, []);

    const unexplained = EXPORT_COVERAGE.filter(
      (s) => s.disposition === "excluded" && (s.reason ?? "").length < 30,
    ).map((s) => s.model);
    eq("every exclusion gives a reason", unexplained, []);
  }

  console.log("\n--- the export gives a person their data, and no credentials ---\n");
  {
    const { user, store } = await makeOwner(stamp, { orders: 2 });
    const b = await makeOwner(stamp, { orders: 2 });
    await prismaSystem.storeIntegration.create({
      data: {
        storeId: store.id, provider: "STRIPE", status: "CONNECTED",
        credentials: { secret: "ENCRYPTED-SECRET-MATERIAL" },
      },
    });

    const dump = await buildAccountExport(user.id);
    eq("it contains exactly the person's own businesses", dump.businesses.length, 1);
    eq("and that business is theirs", (dump.businesses[0] as { id: string }).id, store.id);
    eq("their orders are in it", (dump.businesses[0] as { orders: unknown[] }).orders.length, 2);
    eq("the account section carries their email", (dump.account as { email: string }).email, user.email);

    const text = JSON.stringify(dump);
    assert("no other owner's business appears", !text.includes(b.store.id));
    assert("no other owner's order appears", !text.includes(b.orderIds[0]));
    assert("and NO credential material is in the file",
      !text.includes("ENCRYPTED-SECRET-MATERIAL"));
    assert("the connection is reported as a fact instead",
      text.includes("connectedProviders") && text.includes("STRIPE"));
    assert("the file says what it left out",
      dump.notIncluded.some((n) => n.model === "StoreIntegration" && n.reason.length > 30));
  }

  console.log("\n--- a closed account can still be exported ---\n");
  {
    const dump = await buildAccountExport(closed.user.id);
    eq("the account section shows it closed", !!(dump.account as { closedAt: unknown }).closedAt, true);
    eq("and the retained orders are still reported",
      (dump.businesses[0] as { orders: unknown[] }).orders.length, 3);
    assert("but the erased email is not there",
      !JSON.stringify(dump.account).includes(closed.user.email!));
  }

  console.log("\n--- the source never contains a User delete ---\n");
  {
    // Source-asserted deliberately: this is a statement about what the file may
    // never grow, which no runtime test can make. Comments are stripped so the
    // prose above — which discusses `user.delete()` at length — cannot pass it.
    const src = readFileSync("lib/account/closure.ts", "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert("closure.ts calls no user.delete", !/\buser\.delete\s*\(/.test(src));
    assert("nor deleteMany on User", !/\buser\.deleteMany\s*\(/.test(src));
    assert("nor deletes a Store", !/\bstore\.delete/.test(src));
    assert("nor deletes an Order", !/\border\.delete/.test(src));
    // Proof the matcher discriminates: it must fire on text that does contain one.
    assert("and that check would catch one if it appeared",
      /\buser\.delete\s*\(/.test("await prisma.user.delete({ where: { id } });"));
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
