import {
  verifyPaypalCapture,
  factsFromCapture,
  statusMeansPaid,
  looksLikeCaptureId,
  describeVerification,
  identityFromVerification,
  describeMerchant,
} from "@/lib/payments/paypalVerification";

// J4 NEVER SAYS THE MONEY ARRIVED UNLESS PAYPAL SAYS SO (2026-09-09).
//
//   npx tsx scripts/run-db-suites.ts paypal-verification
//
// Sean, after asking J4 whether a real PayPal order had actually been paid:
//
//   "It must NEVER infer that the money was received simply because an order
//    exists. If it cannot verify the money movement, J4 must explicitly say
//    that it cannot verify it and explain why."
//
// The capture id used below is Sean's REAL one, 74L44930P3583640U, from the
// 2026-09-04 PayPal order. The RESPONSE BODIES are PayPal's documented capture
// shapes - the live call against his account needs the production encryption
// key, which is deliberately unavailable outside production, so what is proven
// here is every branch of the decision rather than one happy path.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const CAPTURE = "74L44930P3583640U";
const CREDS = { clientId: "id", clientSecret: "secret", environment: "live" as const };
const token = async () => "fake-token";

function response(status: number, body: unknown): typeof fetch {
  return (async () =>
    ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }) as unknown as Response) as unknown as typeof fetch;
}

async function main(): Promise<void> {
  console.log("\n=== 1. A completed capture: PayPal said so, so J4 may ===\n");
  {
    const v = await verifyPaypalCapture({
      captureId: CAPTURE, ...CREDS, tokenImpl: token,
      fetchImpl: response(200, {
        id: CAPTURE,
        status: "COMPLETED",
        amount: { value: "38.00", currency_code: "USD" },
        payee: { merchant_id: "9XY7MERCHANT23", email_address: "seller@cubitandcoil.com" },
        create_time: "2026-09-04T18:22:11Z",
      }),
    });
    check("verified", v.kind === "verified");
    check("and reported as paid", v.kind === "verified" && v.paid);
    check("with PayPal's own amount", v.kind === "verified" && v.facts.amount?.value === "38.00",
      v.kind === "verified" ? JSON.stringify(v.facts.amount) : "");
    check("and the MERCHANT IDENTITY comes back with it",
      v.kind === "verified" && v.facts.payeeMerchantId === "9XY7MERCHANT23",
      v.kind === "verified" ? String(v.facts.payeeMerchantId) : "");
    check("the wording states it as PayPal's confirmation",
      /PayPal confirms/.test(describeVerification(v)), describeVerification(v).slice(0, 70));
  }

  console.log("\n=== 2. PENDING is not paid, and says why ===\n");
  {
    const v = await verifyPaypalCapture({
      captureId: CAPTURE, ...CREDS, tokenImpl: token,
      fetchImpl: response(200, {
        id: CAPTURE, status: "PENDING",
        status_details: { reason: "PENDING_REVIEW" },
        amount: { value: "38.00", currency_code: "USD" },
      }),
    });
    check("verified, but not paid", v.kind === "verified" && !v.paid);
    check("the reason is carried, not invented",
      v.kind === "verified" && v.facts.pendingReason === "PENDING_REVIEW");
    const said = describeVerification(v);
    check("and the wording refuses to claim arrival",
      /has not completed/.test(said) && /PayPal's own status/.test(said), said.slice(0, 90));
  }

  console.log("\n=== 3. THE RULE: cannot verify is never 'not paid' ===\n");
  {
    const cases: [string, Awaited<ReturnType<typeof verifyPaypalCapture>>][] = [
      ["PayPal unreachable", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS, tokenImpl: token,
        fetchImpl: (() => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      })],
      ["credentials refused", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS,
        tokenImpl: (async () => { throw new Error("invalid_client"); }) as never,
        fetchImpl: response(200, {}),
      })],
      ["no permission to read transactions", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS, tokenImpl: token, fetchImpl: response(403, {}),
      })],
      ["capture unknown to PayPal", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS, tokenImpl: token, fetchImpl: response(404, {}),
      })],
      ["PayPal errored", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS, tokenImpl: token, fetchImpl: response(500, {}),
      })],
      ["a response with no status", await verifyPaypalCapture({
        captureId: CAPTURE, ...CREDS, tokenImpl: token, fetchImpl: response(200, { id: CAPTURE }),
      })],
    ];
    for (const [label, v] of cases) {
      check(`${label} → unverifiable, not unpaid`, v.kind === "unverifiable",
        v.kind === "unverifiable" ? v.because.slice(0, 60) : "CLAIMED AN ANSWER");
      if (v.kind === "unverifiable") {
        check(`  and it says so out loud`, /could not verify/.test(describeVerification(v)));
      }
    }
    // The shape itself is the guarantee: there is no `paid` field to misread.
    const unreachable = cases[0][1];
    check("an unverifiable result carries NO paid field",
      unreachable.kind === "unverifiable" && !("paid" in unreachable),
      "a caller cannot read 'could not check' as 'not paid'");
  }

  console.log("\n=== 4. Only COMPLETED is paid ===\n");
  {
    for (const s of ["PENDING", "DECLINED", "FAILED", "REFUNDED", "PARTIALLY_REFUNDED", "completed "]) {
      const paid = statusMeansPaid(s);
      const expected = s.trim().toUpperCase() === "COMPLETED";
      check(`${JSON.stringify(s)} → ${expected ? "paid" : "not paid"}`, paid === expected);
    }
  }

  console.log("\n=== 5. An order id is not a capture id ===\n");
  {
    // Sean's order carries BOTH: externalOrderId 4CW51075L02817250 and
    // externalPaymentId 74L44930P3583640U. Sending the wrong one would ask
    // PayPal a question about the wrong object.
    check("the real capture id is accepted", looksLikeCaptureId("74L44930P3583640U"));
    check("an empty value is refused", !looksLikeCaptureId(""));
    check("null is refused", !looksLikeCaptureId(null));
    check("a Stripe id is refused", !looksLikeCaptureId("pi_3UCP4gBsxuQENanJ2dsVcvWt"));
    const v = await verifyPaypalCapture({ captureId: "", ...CREDS, tokenImpl: token, fetchImpl: response(200, {}) });
    check("and a bad id never reaches PayPal", v.kind === "unverifiable");
  }

  console.log("\n=== 6. The parser tolerates PayPal's optional fields ===\n");
  {
    const bare = factsFromCapture(CAPTURE, { status: "COMPLETED" });
    check("a minimal capture still parses", bare !== null && bare.status === "COMPLETED");
    check("missing amount is null, not zero", bare?.amount === null,
      "a zero would be a claim about money");
    check("missing payee is null, not empty string", bare?.payeeMerchantId === null);
    check("a non-object body is refused", factsFromCapture(CAPTURE, "nope") === null);
    check("null body is refused", factsFromCapture(CAPTURE, null) === null);
  }

  console.log("\n=== 7. Merchant identity, recovered from a real transaction ===\n");
  {
    const v = await verifyPaypalCapture({
      captureId: CAPTURE, ...CREDS, tokenImpl: token,
      fetchImpl: response(200, {
        id: CAPTURE, status: "COMPLETED",
        payee: { merchant_id: "9XY7MERCHANT23", email_address: "seller@cubitandcoil.com" },
      }),
    });
    const identity = identityFromVerification(v);
    check("the merchant id is recovered", identity?.merchantId === "9XY7MERCHANT23", String(identity?.merchantId));
    check("and the business email with it", identity?.email === "seller@cubitandcoil.com", String(identity?.email));
    check("traceable to the capture it came from", identity?.fromCaptureId === CAPTURE);
    check("described without inventing a name",
      describeMerchant(identity).includes("seller@cubitandcoil.com"), describeMerchant(identity));

    // A capture with no payee yields NO identity rather than a placeholder.
    const noPayee = await verifyPaypalCapture({
      captureId: CAPTURE, ...CREDS, tokenImpl: token,
      fetchImpl: response(200, { id: CAPTURE, status: "COMPLETED" }),
    });
    check("no payee means no identity claimed", identityFromVerification(noPayee) === null);
    check("and the owner is told that plainly",
      /not yet been able to confirm/.test(describeMerchant(null)), describeMerchant(null).slice(0, 60));
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
