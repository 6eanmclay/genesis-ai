import * as dotenv from "dotenv";

// SEND ONE RECEIPT THAT WAS NEVER SENT — DELIBERATELY, ONE ORDER AT A TIME.
//
//   npx tsx scripts/send-missed-receipt.ts path/to/production.env <orderId>          # dry run
//   npx tsx scripts/send-missed-receipt.ts path/to/production.env <orderId> --send   # sends
//
// ============ WHY THIS EXISTS AND WHY IT IS NOT A SWEEP ==============
//
// Seven paid orders in production have never had a confirmation. Four are
// @example.test beta rows that can never receive mail; three are real people
// who paid real money — 19 July, 30 August and 31 August — and heard nothing.
//
// The backstop sweep is deliberately unable to reach them: it now only
// considers orders on or after EMAIL_NOTIFICATIONS_START_AT, so turning email
// on cannot replay history. That is the correct default and it leaves exactly
// this gap, which is a decision rather than a job: telling someone about a
// purchase six weeks after the fact is a judgment about what the message
// should say, not a retry.
//
// So this takes ONE order id. There is no --all, no date range and no way to
// pass more than one; a bulk mode is precisely the thing the horizon was added
// to prevent, and putting one here would hand back what that took away.
//
// ============ IT IS THE REAL PATH, NOT A SECOND ONE ==================
//
// Everything goes through sendOrderConfirmation, so the claim column, the
// runOnce ledger, the tenant scoping and the reserved-address refusal are all
// exactly what a live order gets. An order already confirmed comes back
// "already_sent" from the ledger and nothing is sent twice. This script cannot
// send a receipt the ordinary path would refuse.
//
// READ-ONLY WITHOUT --send. The dry run prints who would be written to, what
// the subject line says, and what the platform currently believes about that
// order, and writes nothing.
//
// NOT RUN WITHOUT SEAN'S APPROVAL OF THE SENDING PLAN. See EXTERNAL_BLOCKERS.md
// E19.

dotenv.config({ path: process.argv[2], override: true });

const orderId = process.argv[3];
const doSend = process.argv.includes("--send");

async function main(): Promise<void> {
  if (!process.argv[2] || !orderId || orderId.startsWith("--")) {
    console.error("usage: send-missed-receipt.ts <env-file> <orderId> [--send]");
    process.exitCode = 1;
    return;
  }

  const { prismaSystem } = await import("@/lib/prisma");
  const { buildConfirmationEmail, sendOrderConfirmation } = await import("@/lib/orders/orderConfirmation");
  const { reservedTldOf, isEmailConfigured } = await import("@/lib/email/sendEmail");

  // The store is READ FROM THE ORDER, never supplied. sendOrderConfirmation
  // takes the pair and matches on both, so a mistyped id sends nothing rather
  // than sending one tenant's receipt about another's sale.
  const order = await prismaSystem.order.findUnique({
    where: { id: orderId },
    include: {
      store: { select: { id: true, name: true, slug: true, currency: true } },
      items: { select: { productName: true, quantity: true, subtotalInCents: true }, orderBy: { createdAt: "asc" } },
    },
  });

  if (!order) {
    console.error(`No order ${orderId}. Nothing sent.`);
    process.exitCode = 1;
    return;
  }

  const ageDays = Math.floor((Date.now() - order.createdAt.getTime()) / 86_400_000);
  const reserved = reservedTldOf(order.buyerEmail ?? "");

  console.log("");
  console.log("  order        " + order.id);
  console.log("  business     " + order.store.name + "  (" + order.store.slug + ")");
  console.log("  placed       " + order.createdAt.toISOString().slice(0, 10) + "  — " + ageDays + " days ago");
  console.log("  amount       " + (order.amountInCents / 100).toFixed(2) + " " + order.store.currency);
  console.log("  status       " + order.status);
  console.log("  buyer        " + (order.buyerEmail ?? "(none)") + (reserved ? "   RESERVED ." + reserved + " — undeliverable" : ""));
  console.log("  claimed      confirmationSentAt=" + String(order.confirmationSentAt) + "  ownerNotifiedAt=" + String(order.ownerNotifiedAt));
  console.log("  email config " + (isEmailConfigured() ? "present" : "ABSENT — nothing can send"));

  if (order.confirmationSentAt) {
    console.log("\n  This customer has already been told. Nothing to do.");
    return;
  }
  if (reserved) {
    console.log("\n  Refused: ." + reserved + " is reserved by RFC 2606 and can never receive mail.");
    console.log("  The claim column stays null, which is the truth — nobody was told.");
    return;
  }

  const preview = buildConfirmationEmail({ order, store: order.store });
  console.log("");
  console.log("  would send to  " + preview.to);
  console.log("  from name      " + preview.fromName);
  console.log("  subject        " + preview.subject);
  console.log("  body           " + preview.html.length + " bytes");

  if (!doSend) {
    console.log("\n  DRY RUN. Nothing was sent and nothing was written. Add --send to actually send.");
    return;
  }

  console.log("\n  Sending...");
  const outcome = await sendOrderConfirmation({ orderId: order.id, storeId: order.store.id });
  console.log("  outcome: " + JSON.stringify(outcome));

  const after = await prismaSystem.order.findUnique({
    where: { id: order.id },
    select: { confirmationSentAt: true },
  });
  console.log("  confirmationSentAt is now " + String(after?.confirmationSentAt));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error((error as Error)?.message ?? String(error));
    process.exit(1);
  });
