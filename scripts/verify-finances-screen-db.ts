import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { financialsForStore } from "@/lib/payments/financials";
import {
  MONEY_DISTINCTION, destinationLabel, failureSentence, formatAmounts,
  nextPayoutSentence, scheduleSentence, toneFor, unavailableSentence,
} from "@/lib/payments/financials/presentation";
import type { PayoutRecord } from "@/lib/payments/financials/types";
import { readFileSync } from "node:fs";

// WHAT THE MONEY SCREEN SAYS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts finances-screen-db
//
// ============ THE JUDGEMENT, NOT THE LAYOUT (2026-09-01) ===============
//
// The screen is a server component that calls Stripe, so seeing it render the
// healthy case needs a live connected account — E20, and it stays external.
// Every DECISION the screen makes lives in presentation.ts instead, where it
// can be exercised exhaustively here.
//
// ============ AND THE SENTENCE THAT MUST NEVER APPEAR ==================
//
// A calculated next-payout date. Sean: "Never calculate or invent a 'next
// payout' date." Stripe exposes no such field, so there are exactly two
// truthful answers — a real in-flight payout, or nothing scheduled — and most
// of this suite is about the second one never quietly becoming a guess.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const DAY = 24 * 60 * 60 * 1000;
function payout(over: Partial<PayoutRecord> = {}): PayoutRecord {
  return {
    id: "po_1", amountInCents: 6980, currency: "USD", status: "paid",
    arrivalDate: new Date(Date.now() - 2 * DAY), createdAt: new Date(Date.now() - 4 * DAY),
    method: "standard", automatic: true, destination: null,
    failureCode: null, failureMessage: null, statementDescriptor: null,
    ...over,
  };
}

let seq = 0;
async function makeStore(stamp: number, connect: "STRIPE" | "PAYPAL" | null) {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `fs-${stamp}-${n}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `fs-${stamp}-${n}`, tagline: "t", description: "d" },
  });
  if (connect) {
    await prismaSystem.storeIntegration.create({
      data: { storeId: store.id, provider: connect, status: "CONNECTED", externalAccountId: `acct_${n}` },
    });
  }
  return store;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a next payout is a real one, or nothing ---\n");
  {
    const arriving = new Date(Date.now() + 2 * DAY);
    const withOne = nextPayoutSentence({
      nextPayout: payout({ status: "in_transit", arrivalDate: arriving, amountInCents: 12_000 }),
    });
    assert("a real in-flight payout is named with its amount", /\$120\.00/.test(withOne), withOne);
    assert("and the date the bank expects it", /expected/.test(withOne), withOne);

    // ============ THE SENTENCE THAT MUST NEVER BE A GUESS =====
    const withNone = nextPayoutSentence({ nextPayout: null });
    eq("with nothing in flight it says so plainly",
      withNone, "Stripe has no payout on the way right now.");
    assert("and never invents a date", !/\d{4}|\bMonday\b|\bnext\b/i.test(withNone), withNone);
    assert("nor promises one is coming", !/will|soon|due/i.test(withNone), withNone);
  }

  console.log("\n--- the schedule is described, never turned into a date ---\n");
  {
    const weekly = scheduleSentence({ interval: "weekly", delayDays: 2, weeklyAnchor: "friday", monthlyAnchor: null });
    assert("weekly says which day", /friday/i.test(weekly), weekly);
    assert("and how long funds are held", /2 days/.test(weekly), weekly);
    // The schedule is the ONE place a date could be computed from, so this is
    // where the temptation lives.
    assert("but no actual date appears", !/\d{1,2}\/\d{1,2}|\d{4}-\d{2}/.test(weekly), weekly);

    eq("manual is said plainly, not as a schedule",
      scheduleSentence({ interval: "manual", delayDays: null, weeklyAnchor: null, monthlyAnchor: null }),
      "Payouts are manual — Stripe holds your balance until you ask for it.");
    eq("and an absent schedule is admitted",
      scheduleSentence(null), "Stripe has not told us your payout schedule.");
  }

  console.log("\n--- a destination is a bank and four digits ---\n");
  {
    eq("named when Stripe gave one",
      destinationLabel({ kind: "bank_account", bankName: "STRIPE TEST BANK", last4: "6789", currency: "USD" }),
      "STRIPE TEST BANK ending 6789");
    eq("a card with no bank name still reads",
      destinationLabel({ kind: "card", bankName: null, last4: "4242", currency: "USD" }),
      "Bank account ending 4242");
    eq("and an absent destination is admitted, not invented",
      destinationLabel(null), "Stripe did not say where this went.");
  }

  console.log("\n--- absent is not zero ---\n");
  {
    // An empty array is the provider saying zero. Null is the provider saying
    // nothing, and the screen renders a sentence rather than a number for it —
    // asserted here as the distinction the formatter must preserve.
    eq("an empty balance really is zero", formatAmounts([], "USD"), "$0.00");
    eq("and several currencies are all shown",
      formatAmounts([{ currency: "USD", amountInCents: 1000 }, { currency: "GBP", amountInCents: 500 }], "USD"),
      "$10.00 · £5.00");
  }

  console.log("\n--- a payout's own word is kept, and only emphasised ---\n");
  {
    eq("paid is settled", toneFor("paid"), "settled");
    eq("in_transit is moving", toneFor("in_transit"), "moving");
    eq("pending is moving", toneFor("pending"), "moving");
    eq("failed is failed", toneFor("failed"), "failed");
    eq("canceled is failed", toneFor("canceled"), "failed");
    // An unknown status must not read as success.
    eq("a status nobody anticipated is not called settled", toneFor("something_new"), "moving");

    const failedPayout = payout({ status: "failed", failureMessage: "account_closed" });
    assert("a failure carries Stripe's own reason",
      /account_closed/.test(failureSentence(failedPayout) ?? ""), String(failureSentence(failedPayout)));
    eq("and a healthy payout has no failure sentence", failureSentence(payout()), null);
  }

  console.log("\n--- the three kinds of money are named apart ---\n");
  {
    assert("customer money and Stripe's holding are distinguished",
      /customer paid/.test(MONEY_DISTINCTION) && /Stripe holds/.test(MONEY_DISTINCTION), MONEY_DISTINCTION);
    assert("and Stripe's holding from the bank",
      /reached your bank/.test(MONEY_DISTINCTION), MONEY_DISTINCTION);
  }

  console.log("\n--- the states a real merchant will actually hit ---\n");
  {
    // ============ ALL THREE ARE REACHABLE WITHOUT A DOUBLE =====
    const none = await makeStore(stamp, null);
    const notConnected = await financialsForStore(none.id);
    eq("no provider connected", notConnected.available, false);
    if (!notConnected.available) {
      const said = unavailableSentence(notConnected.reason, notConnected.detail);
      assert("says nothing is connected", /No payment provider is connected/.test(said), said);
      assert("and never implies zero money", !/\$0|zero/i.test(said), said);
    }

    const paypal = await makeStore(stamp, "PAYPAL");
    const unsupported = await financialsForStore(paypal.id);
    eq("a PayPal business is unsupported, not disconnected",
      unsupported.available === false ? unsupported.reason : "", "unsupported");
    if (!unsupported.available) {
      const said = unavailableSentence(unsupported.reason, unsupported.detail);
      assert("and the sentence names the rail it does have", /PAYPAL/.test(said), said);
    }

    // A REAL provider error: a connected Stripe integration whose credentials
    // are absent, so the live SDK genuinely fails. Not a double.
    const broken = await makeStore(stamp, "STRIPE");
    const errored = await financialsForStore(broken.id);
    eq("a Stripe that cannot be reached is a provider error",
      errored.available === false ? errored.reason : "", "provider_error");
    if (!errored.available) {
      const said = unavailableSentence(errored.reason, errored.detail);
      assert("which says the figures are missing rather than zero",
        /missing rather than zero/.test(said), said);
    }
  }

  console.log("\n--- the screen reads, and only reads ---\n");
  {
    const screen = readFileSync("app/dashboard/finances/Finances.tsx", "utf8");
    const code = screen.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
    assert("it goes through financialsForStore", /financialsForStore\(/.test(code));
    // ============ THE IMPORT, NOT JUST THE CONSTRUCTOR ==========
    //
    // This checked only `new Stripe(` and the sabotage run walked straight past
    // it: adding `import Stripe from "stripe"` to the screen left the suite
    // green. A screen that imports the SDK is one call away from being a second
    // Stripe system, which is the thing this architecture exists to prevent —
    // so the import is the line, not the construction.
    assert("and does not even import the Stripe SDK",
      !/from ["']stripe["']|require\(["']stripe["']\)/.test(code), "the screen reaches Stripe directly");
    assert("nor construct a client", !/new Stripe\(/.test(code));
    assert("nor writes to the database", !/prisma\.\w+\.(create|update|delete|upsert)/.test(code));
    assert("nor calls any Stripe write", !/\.(create|update|cancel|reverse)\(/.test(code));
    assert("it hands payout settings back to Stripe",
      /dashboard\.stripe\.com/.test(screen), "no link out for the actions Stripe owns");

    // Both routes gate on a real permission.
    for (const route of ["app/dashboard/finances/page.tsx", "app/b/[slug]/finances/page.tsx"]) {
      const src = readFileSync(route, "utf8");
      assert(`${route.split("/").slice(-2)[0]} requires a permission`,
        /PERMISSIONS\.REVENUE_VIEW/.test(src), "ungated");
    }
    const business = readFileSync("app/b/[slug]/finances/page.tsx", "utf8");
    assert("the business route re-checks access rather than trusting the layout",
      /requireBusinessPage\(/.test(business));
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "fs-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
