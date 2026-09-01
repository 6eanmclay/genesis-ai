import type Stripe from "stripe";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { makeStripeFinancialsProvider, type StripeFinancialsClient } from "@/lib/payments/financials/stripeFinancials";
import {
  maskDestination, toPayoutRecord, toBalance, toIdentity, toSchedule,
  firstUnarrived, summariseFees,
} from "@/lib/payments/financials/stripeFinancials";
import { financialsForStore } from "@/lib/payments/financials";
import { readFileSync } from "node:fs";

// WHAT THE MERCHANT IS OWED, AND WHAT ACTUALLY REACHED THEIR BANK:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts merchant-financials-db
//
// ============ PROVIDER-DOUBLE PROVEN. NOT LIVE-STRIPE PROVEN. ==========
//
// Every Stripe response below is a double. That proves the mapping, the
// masking, the tenant scoping and the honesty rules — all of which are ours.
// It proves NOTHING about whether Stripe really returns these shapes for a
// real connected account, which needs Sean's own live account and stays an
// external checkpoint. The two are kept apart on purpose and the split is
// recorded in EXTERNAL_BLOCKERS.md.
//
// ============ THE DISTINCTION UNDER TEST ==============================
//
// Sean: "clearly distinguish 'payment successfully processed' from 'funds
// successfully paid out'." A balance is money Stripe holds. A payout is money
// Stripe sent. An Order is what a customer paid. Three different facts, and
// most of this suite is about not letting them blur.

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

const SEC = (d: Date) => Math.floor(d.getTime() / 1000);
const DAY = 24 * 60 * 60 * 1000;

/** A Stripe double. Every field is one the installed SDK actually declares. */
function makeDouble(over: {
  account?: Partial<Stripe.Account>;
  balance?: Partial<Stripe.Balance>;
  payouts?: Stripe.Payout[];
  transactions?: Stripe.BalanceTransaction[];
  throwOn?: "account" | "balance" | "payouts";
} = {}): { client: StripeFinancialsClient; sawAccount: string[] } {
  const sawAccount: string[] = [];
  const client = {
    accounts: {
      async retrieve(id: string) {
        if (over.throwOn === "account") throw new Error("Stripe is down");
        sawAccount.push(id);
        return {
          id,
          email: "merchant@example.test",
          country: "US",
          default_currency: "usd",
          charges_enabled: true,
          payouts_enabled: true,
          business_profile: { name: "Cubit & Coil LLC" },
          settings: { payouts: { schedule: { interval: "weekly", delay_days: 2, weekly_anchor: "friday" } } },
          ...over.account,
        } as unknown as Stripe.Account;
      },
    },
    balance: {
      async retrieve(_p: undefined, opts: { stripeAccount: string }) {
        if (over.throwOn === "balance") throw new Error("Stripe is down");
        sawAccount.push(opts.stripeAccount);
        return {
          available: [{ amount: 12_000, currency: "usd" }],
          pending: [{ amount: 4_783, currency: "usd" }],
          ...over.balance,
        } as unknown as Stripe.Balance;
      },
    },
    payouts: {
      async list(_p: { limit: number }, opts: { stripeAccount: string }) {
        if (over.throwOn === "payouts") throw new Error("Stripe is down");
        sawAccount.push(opts.stripeAccount);
        return { data: over.payouts ?? [] };
      },
    },
    balanceTransactions: {
      async list(_p: unknown, opts: { stripeAccount: string }) {
        sawAccount.push(opts.stripeAccount);
        return { data: over.transactions ?? [] };
      },
    },
  } as unknown as StripeFinancialsClient;
  return { client, sawAccount };
}

function payout(over: Partial<Stripe.Payout> = {}): Stripe.Payout {
  return {
    id: "po_1", amount: 6_980, currency: "usd", status: "paid",
    arrival_date: SEC(new Date(Date.now() - 2 * DAY)),
    created: SEC(new Date(Date.now() - 4 * DAY)),
    method: "standard", automatic: true, destination: null,
    failure_code: null, failure_message: null, statement_descriptor: null,
    ...over,
  } as unknown as Stripe.Payout;
}

let seq = 0;
async function makeStore(stamp: number, connect: "STRIPE" | "PAYPAL" | null = "STRIPE", accountId = "acct_live_1") {
  const n = ++seq;
  const user = await prisma.user.create({ data: { email: `fin-${stamp}-${n}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `fin-${stamp}-${n}`, tagline: "t", description: "d" },
  });
  if (connect) {
    await prismaSystem.storeIntegration.create({
      data: { storeId: store.id, provider: connect, status: "CONNECTED", externalAccountId: accountId },
    });
  }
  return store;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  console.log("\n--- a balance is money Stripe holds, not money the merchant has ---\n");
  {
    const store = await makeStore(stamp);
    const { client } = makeDouble();
    const result = await makeStripeFinancialsProvider(() => client).financialsFor(store.id);
    assert("it is available", result.available, JSON.stringify(result));
    if (!result.available) return;

    eq("available balance is reported per currency", result.balance.available, [{ currency: "USD", amountInCents: 12_000 }]);
    eq("and pending separately", result.balance.pending, [{ currency: "USD", amountInCents: 4_783 }]);
    // ============ ABSENT IS NOT ZERO ==========================
    eq("instant availability the provider did not report is null, not 0",
      result.balance.instantAvailable, null);
  }

  console.log("\n--- and a payout is money that actually left ---\n");
  {
    const store = await makeStore(stamp);
    const arrival = new Date(Date.now() - 2 * DAY);
    const { client } = makeDouble({
      payouts: [payout({ arrival_date: SEC(arrival), status: "paid", amount: 6_980 })],
    });
    const result = await makeStripeFinancialsProvider(() => client).financialsFor(store.id);
    if (!result.available) return assert("available", false, JSON.stringify(result));

    eq("one payout", result.payouts.length, 1);
    eq("carrying what the bank received", result.payouts[0].amountInCents, 6_980);
    eq("with Stripe's own word for its state", result.payouts[0].status, "paid");
    // Compared at second precision, because that is the precision Stripe HAS:
    // arrival_date is a Unix timestamp in whole seconds, so a round trip
    // legitimately loses milliseconds. The first version of this assertion
    // compared against an unrounded Date and failed on the suite's own bug
    // rather than on anything the mapping did wrong.
    eq("and the date the bank expected it",
      result.payouts[0].arrivalDate.getTime(), SEC(arrival) * 1000);
    assert("a settled payout is not the next one", result.nextPayout === null);
  }

  console.log("\n--- the next payout is a real one in flight, never a projection ---\n");
  {
    const soon = new Date(Date.now() + 2 * DAY);
    const later = new Date(Date.now() + 5 * DAY);
    const records = [
      toPayoutRecord(payout({ id: "po_far", status: "in_transit", arrival_date: SEC(later) })),
      toPayoutRecord(payout({ id: "po_soon", status: "pending", arrival_date: SEC(soon) })),
      toPayoutRecord(payout({ id: "po_done", status: "paid", arrival_date: SEC(new Date(Date.now() - DAY)) })),
    ];
    eq("the soonest unarrived one wins", firstUnarrived(records)?.id, "po_soon");
    eq("and with nothing in flight there is no next payout",
      firstUnarrived([toPayoutRecord(payout({ status: "paid" }))]), null);

    // ============ THE FIELD STRIPE DOES NOT HAVE ==============
    //
    // Checked against the installed SDK, not from memory: nothing declares a
    // next-payout date. A date computed from interval and delay_days would
    // look identical to a fact, be a guess about somebody's money, and be
    // wrong every bank holiday.
    const sdk = readFileSync("node_modules/stripe/cjs/resources/Payouts.d.ts", "utf8");
    assert("and the SDK really has no next-payout field",
      !/next_payout/.test(sdk), "Stripe grew one — this can become a real field");
  }

  console.log("\n--- a destination is a name and four digits, and nothing else ---\n");
  {
    const masked = maskDestination({
      object: "bank_account", bank_name: "STRIPE TEST BANK", last4: "6789",
      routing_number: "110000000", account_holder_name: "Sean McLay", currency: "usd",
      // Fields a real Stripe response carries and this must not pass through.
      id: "ba_123", fingerprint: "abc",
    } as unknown as Stripe.Payout["destination"]);

    eq("the bank is named", masked?.bankName, "STRIPE TEST BANK");
    eq("the last four are shown", masked?.last4, "6789");
    const serialised = JSON.stringify(masked);
    assert("the routing number is NOT carried", !serialised.includes("110000000"), serialised);
    assert("nor the account holder's name", !serialised.includes("Sean McLay"), serialised);
    assert("nor the bank account id", !serialised.includes("ba_123"), serialised);
    assert("nor a fingerprint", !serialised.includes("abc"), serialised);

    eq("an unexpanded destination is null rather than invented",
      maskDestination("ba_123" as unknown as Stripe.Payout["destination"]), null);
  }

  console.log("\n--- the payout schedule is read, not guessed ---\n");
  {
    const schedule = toSchedule({
      settings: { payouts: { schedule: { interval: "weekly", delay_days: 2, weekly_anchor: "friday" } } },
    } as unknown as Stripe.Account);
    eq("interval", schedule?.interval, "weekly");
    eq("delay", schedule?.delayDays, 2);
    eq("anchor", schedule?.weeklyAnchor, "friday");
    eq("an account with no schedule reports none",
      toSchedule({ settings: {} } as unknown as Stripe.Account), null);
  }

  console.log("\n--- taking money and receiving money are different permissions ---\n");
  {
    const identity = toIdentity({
      id: "acct_1", email: "m@example.test", country: "US", default_currency: "usd",
      charges_enabled: true, payouts_enabled: false,
      business_profile: { name: "Cubit & Coil LLC" },
    } as unknown as Stripe.Account);
    eq("it can take money", identity.chargesEnabled, true);
    eq("and cannot receive it", identity.payoutsEnabled, false);
    eq("the business name is Stripe's, not Genesis's", identity.businessName, "Cubit & Coil LLC");
    eq("and the account id is carried for support", identity.externalAccountId, "acct_1");
  }

  console.log("\n--- fees come from balance transactions, and exclude payouts ---\n");
  {
    const since = new Date(Date.now() - 30 * DAY);
    const fees = summariseFees([
      { type: "charge", amount: 6_980, fee: 232, net: 6_748, currency: "usd" },
      { type: "charge", amount: 4_783, fee: 169, net: 4_614, currency: "usd" },
      // A payout's own transaction is money LEAVING. Including it would net a
      // merchant's income against their own withdrawal.
      { type: "payout", amount: -10_000, fee: 0, net: -10_000, currency: "usd" },
    ] as unknown as Stripe.BalanceTransaction[], since);

    eq("only the charges counted", fees?.transactionCount, 2);
    eq("gross", fees?.grossInCents, 11_763);
    eq("fees", fees?.feesInCents, 401);
    eq("net", fees?.netInCents, 11_362);
    eq("and gross minus fees is net", (fees!.grossInCents - fees!.feesInCents), fees!.netInCents);
    eq("a window with no charges reports nothing rather than zero",
      summariseFees([], since), null);
  }

  console.log("\n--- instant availability is passed through when Stripe reports it ---\n");
  {
    const withInstant = toBalance({
      available: [{ amount: 12_000, currency: "usd" }],
      pending: [],
      instant_available: [{ amount: 9_000, currency: "usd" }],
    } as unknown as Stripe.Balance);
    eq("it is reported", withInstant.instantAvailable, [{ currency: "USD", amountInCents: 9_000 }]);
  }

  console.log("\n--- everything is scoped to the business's own connected account ---\n");
  {
    const mine = await makeStore(stamp, "STRIPE", "acct_mine");
    const theirs = await makeStore(stamp, "STRIPE", "acct_theirs");
    const { client, sawAccount } = makeDouble();
    const provider = makeStripeFinancialsProvider(() => client);

    await provider.financialsFor(mine.id);
    assert("Stripe was asked only about this business's account",
      sawAccount.every((a) => a === "acct_mine"), sawAccount.join(","));
    assert("and never about the other's", !sawAccount.includes("acct_theirs"));

    sawAccount.length = 0;
    await provider.financialsFor(theirs.id);
    assert("the other business gets its own account", sawAccount.every((a) => a === "acct_theirs"),
      sawAccount.join(","));
  }

  console.log("\n--- a business with no Stripe is told so, not shown zero ---\n");
  {
    const none = await makeStore(stamp, null);
    const notConnected = await financialsForStore(none.id);
    eq("not connected", notConnected.available, false);
    eq("and says why", notConnected.available === false ? notConnected.reason : "", "not_connected");

    // ============ UNSUPPORTED IS NOT THE SAME AS ABSENT =========
    const paypalOnly = await makeStore(stamp, "PAYPAL", "merchant-1");
    const unsupported = await financialsForStore(paypalOnly.id);
    eq("a PayPal business is not called disconnected", unsupported.available, false);
    eq("it is called unsupported", unsupported.available === false ? unsupported.reason : "", "unsupported");
    assert("and the message names the rail it does have",
      unsupported.available === false && /PAYPAL/.test(unsupported.detail),
      unsupported.available === false ? unsupported.detail : "");
  }

  console.log("\n--- Stripe being down is a value, not a thrown page ---\n");
  {
    const store = await makeStore(stamp);
    const { client } = makeDouble({ throwOn: "balance" });
    const result = await makeStripeFinancialsProvider(() => client).financialsFor(store.id);
    eq("it reports unavailable", result.available, false);
    eq("as a provider error", result.available === false ? result.reason : "", "provider_error");
    assert("carrying Stripe's own wording",
      result.available === false && /Stripe is down/.test(result.detail),
      result.available === false ? result.detail : "");
  }

  console.log("\n--- no bank credential can reach this layer at all ---\n");
  {
    // Source-asserted, apart from the executed evidence above: a statement
    // about what these files may never grow.
    const src = [
      readFileSync("lib/payments/financials/types.ts", "utf8"),
      readFileSync("lib/payments/financials/stripeFinancials.ts", "utf8"),
    ].join("\n").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    assert("routing numbers are never read", !/routing_number/.test(src));
    assert("nor account numbers", !/account_number/.test(src));
    assert("nor the account holder's name", !/account_holder/.test(src));
    assert("and nothing here writes to the database",
      !/prisma\.\w+\.(create|update|delete|upsert)/.test(src));
  }

  await prismaSystem.user.deleteMany({ where: { email: { startsWith: "fin-" } } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
