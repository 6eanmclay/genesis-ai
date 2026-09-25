import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { normalizeContactEmail } from "@/lib/store/contactEmail";
import { buildConfirmationEmail } from "@/lib/orders/orderConfirmation";
import { readFileSync } from "node:fs";

// AN ADDRESS THE OWNER CHOSE, OR NONE AT ALL:
//
//   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/run-db-suites.ts store-contact-email" \
//     -OutFile "C:/Users/hyper/AppData/Local/Temp/genesis-contact.txt"
//
// ISOLATED DATABASE ONLY. Nothing is sent; the confirmation builder is pure
// and is called directly.
//
// ============ THE DEFECT THIS EXISTS FOR (2026-09-24) =================
//
// A customer bought twelve items for $285.85, received no confirmation, and
// could find no way to contact the business. The storefront told her to make
// contact in three separate places and named no address in any of them,
// because Store had no contact column at all across sixteen businesses.
//
// ============ THE RULE, AND WHY THE NEGATIVE HALF MATTERS MORE ========
//
// The easy answer was User.email — every store has one. It is the address the
// owner SIGNS IN with, and publishing it on a storefront is a disclosure they
// never agreed to. So the rules that matter most here are the ones about what
// must NOT happen:
//
//   never inferred        no model, upload or connector may supply it
//   never backfilled      the migration writes nothing to existing rows
//   never fallen back to  null means "not chosen", and null stays null
//
// Section 3 is the one that would catch a future edit deciding that a missing
// contact address is "obviously" the account address.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  -- ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

async function main() {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const ownerLogin = `owner-private-${stamp}@example.com`;
  const user = await prisma.user.create({ data: { email: ownerLogin, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `contact-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n=== 1. VALIDATION: what may be published ===\n");
  {
    const good: [string, string][] = [
      ["hello@cubitandcoil.com", "hello@cubitandcoil.com"],
      ["  hello@cubitandcoil.com  ", "hello@cubitandcoil.com"],
      ["Hello@CubitAndCoil.COM", "Hello@cubitandcoil.com"], // domain lowers, local does not
      ["orders+shop@sub.example.co.uk", "orders+shop@sub.example.co.uk"],
    ];
    for (const [input, expected] of good) {
      eq(`accepts ${JSON.stringify(input)}`, normalizeContactEmail(input).value, expected);
    }

    // AN EMPTY BOX IS A CHOICE, NOT AN ERROR. Clearing the field is how an
    // owner withdraws a published address.
    for (const blank of ["", "   ", null, undefined]) {
      eq(`clearing with ${JSON.stringify(blank)} is not an error`,
        normalizeContactEmail(blank as string | null), { value: null, problem: null });
    }
  }

  console.log("\n=== 2. REFUSED: header injection and undeliverable ===\n");
  {
    const bad: [string, string][] = [
      ["a@b.com\nBcc: someone@else.com", "unsafe_characters"],
      ["a@b.com\r\nX-Header: x", "unsafe_characters"],
      ["a@b.com, other@c.com", "unsafe_characters"],
      ["a@b.com; other@c.com", "unsafe_characters"],
      ["Name <a@b.com>", "unsafe_characters"],
      ["two words@b.com", "unsafe_characters"],
      ["a@b@c.com", "unsafe_characters"],
      ["nodomain", "no_at"],
      ["@nolocal.com", "no_local"],
      ["a@", "no_domain"],
      ["a@nodot", "no_dot"],
      ["a@.leading.com", "no_domain"],
      ["a@double..dot.com", "no_domain"],
      ["a@shop.test", "reserved_domain"],
      ["a@shop.invalid", "reserved_domain"],
      [`${"x".repeat(250)}@b.com`, "too_long"],
    ];
    for (const [input, problem] of bad) {
      const r = normalizeContactEmail(input);
      assert(`refuses ${JSON.stringify(input.slice(0, 44))} -> ${problem}`,
        r.value === null && r.problem === problem,
        `got value=${JSON.stringify(r.value)} problem=${r.problem}`);
    }

    // Stated as the rule rather than left implicit across sixteen rows.
    let anyStored = false;
    for (const [input] of bad) if (normalizeContactEmail(input).value !== null) anyStored = true;
    assert("NOT ONE refused value is ever returned for storage", !anyStored,
      "a header value must never be repaired into something the owner did not type");
  }

  console.log("\n=== 3. NEVER THE LOGIN ADDRESS ===\n");
  {
    const fresh = await prisma.store.findUniqueOrThrow({
      where: { id: store.id },
      select: { contactEmail: true, user: { select: { email: true } } },
    });
    eq("a brand-new store has NO contact address", fresh.contactEmail, null);
    assert("  and the owner's login address exists but is not it",
      fresh.user.email === ownerLogin && fresh.contactEmail !== ownerLogin,
      `login=${fresh.user.email} contact=${JSON.stringify(fresh.contactEmail)}`);

    // THE CONFIRMATION CARRIES NO REPLY-TO WHEN NONE WAS PUBLISHED.
    const built = buildConfirmationEmail({
      order: {
        id: "ord_1", productName: "Cuff", quantity: 1, amountInCents: 28585,
        buyerEmail: "buyer@example.com", placedAt: new Date(), items: [], shippingService: null,
      } as never,
      store: { name: store.name, currency: "USD", contactEmail: null },
    });
    assert("an unconfigured store sends no Reply-To at all",
      !("replyTo" in built) || built.replyTo === undefined,
      JSON.stringify(Object.keys(built)));
    assert("  and certainly not the owner's login address",
      JSON.stringify(built).includes(ownerLogin) === false);
  }

  console.log("\n=== 4. WHEN THE OWNER PUBLISHES ONE ===\n");
  {
    const chosen = normalizeContactEmail("hello@cubitandcoil.com").value!;
    await prisma.store.update({ where: { id: store.id }, data: { contactEmail: chosen } });

    const row = await prisma.store.findUniqueOrThrow({
      where: { id: store.id }, select: { contactEmail: true },
    });
    eq("it is stored exactly as normalised", row.contactEmail, chosen);

    const built = buildConfirmationEmail({
      order: {
        id: "ord_2", productName: "Cuff", quantity: 1, amountInCents: 28585,
        buyerEmail: "buyer@example.com", placedAt: new Date(), items: [], shippingService: null,
      } as never,
      store: { name: store.name, currency: "USD", contactEmail: row.contactEmail },
    });
    eq("the confirmation replies to the shop", built.replyTo, chosen);
    assert("  while the From is still the platform's (fromName only)",
      built.fromName === store.name, built.fromName);

    // WITHDRAWING IT WORKS. Clearing the box must genuinely remove it, not
    // leave the previous address published forever.
    await prisma.store.update({
      where: { id: store.id },
      data: { contactEmail: normalizeContactEmail("").value },
    });
    const cleared = await prisma.store.findUniqueOrThrow({
      where: { id: store.id }, select: { contactEmail: true },
    });
    eq("clearing the field withdraws the address", cleared.contactEmail, null);
  }

  console.log("\n=== 5. NEVER BACKFILLED ===\n");
  {
    const migration = readFileSync("prisma/migrations/20260925000000_store_contact_email/migration.sql", "utf8");
    const sql = migration.replace(/--.*$/gm, "");
    assert("the migration only ADDs a nullable column", /ALTER TABLE "Store" ADD COLUMN "contactEmail" TEXT;/.test(sql));
    assert("  and contains no UPDATE at all", !/\bUPDATE\b/i.test(sql),
      "a backfill from User.email is the exact disclosure this design refuses");
    assert("  and no reference to the user table", !/\bUser\b/i.test(sql));
    assert("  and no NOT NULL or DEFAULT", !/NOT NULL/i.test(sql) && !/DEFAULT/i.test(sql));

    // Every store that existed before must still be null.
    const others = await prisma.store.count({ where: { contactEmail: { not: null } } });
    eq("no store in this database has one unless it was set explicitly", others, 0);
  }

  console.log("\n=== 6. SABOTAGE: a fallback to the login address is caught ===\n");
  {
    // What a future edit might plausibly do, and what section 3 exists to
    // stop. Run here so the assertions above are demonstrably sensitive to it.
    const sabotagedStore = { name: store.name, currency: "USD", contactEmail: ownerLogin };
    const built = buildConfirmationEmail({
      order: {
        id: "ord_3", productName: "Cuff", quantity: 1, amountInCents: 28585,
        buyerEmail: "buyer@example.com", placedAt: new Date(), items: [], shippingService: null,
      } as never,
      store: sabotagedStore,
    });
    assert("SABOTAGE CAUGHT: falling back to the login address IS visible here",
      built.replyTo === ownerLogin,
      "so section 3's assertion would fail the moment someone wired that fallback up");

    // And the real code path, re-read from disk, does not do it.
    const src = readFileSync("lib/orders/orderConfirmation.ts", "utf8");
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
    assert("  and orderConfirmation never reaches for user.email",
      !/user\s*:\s*\{\s*select/.test(code) && !/user\.email/.test(code),
      "the confirmation selects name, currency and contactEmail only");
  }

  console.log("\n=== 7. THE STOREFRONT ONLY SHOWS IT WHEN SET ===\n");
  {
    const page = readFileSync("app/store/[slug]/page.tsx", "utf8");
    assert("the footer contact is guarded by the value existing",
      /\{store\.contactEmail && \(/.test(page));
    assert("  and renders a mailto to that address", /mailto:\$\{store\.contactEmail\}/.test(page));
    assert("  with no fallback address anywhere in the file",
      !/user\.email/.test(page),
      "an unconfigured storefront shows no contact rather than the owner's private address");

    const form = readFileSync("app/dashboard/EditStoreForm.tsx", "utf8");
    assert("the owner can set it on the Business Identity page",
      /name="contactEmail"/.test(form));
    assert("  and the box is not prefilled from the account",
      /defaultValue=\{store\.contactEmail \?\? ""\}/.test(form));
  }

  await prisma.$disconnect();
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
