import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prismaSystem } from "@/lib/prisma";
import { previewCheckoutPrice } from "@/app/store/[slug]/actions";

// THE PREVIEW CANNOT BE TOLD WHAT SHIPPING COSTS:
//
//   npx tsx scripts/run-db-suites.ts checkout-preview-shipping
//
// ============ THE CONTRACT (2026-09-14) ================================
//
// confirmSelectedRate states it, and it is the boundary the charge already
// crosses: "The browser tells us WHICH option was chosen. It never tells us
// what that option costs. This re-asks the carrier and matches by id, so the
// amount charged is always one the carrier just quoted."
//
// previewCheckoutPrice said the same thing in a comment — "its amount is
// looked up rather than accepted" — and did the opposite:
//
//     const rateId = String(formData.get("rateId") ?? "").trim();
//     const shippingInCents = Number(formData.get("shippingInCents") ?? 0);
//
// The id was a presence flag; the COST came off the form. The client said it
// too ("The AMOUNT is still never submitted") while submitting it.
//
// ============ WHAT THIS CAN AND CANNOT PROVE HERE ======================
//
// A LEGITIMATE rate id cannot be produced in this harness: quoting needs a
// real EasyPost or USPS credential, and verify-checkout-live already records
// that same path as externally blocked rather than faking a carrier. So the
// positive case — a real selected rate yielding its real amount — is NOT
// asserted here and is not claimed to be.
//
// What IS decisive without a carrier is the direction that matters. With no
// rate source configured, confirmSelectedRate cannot confirm anything, so a
// submitted amount must produce an HONEST REFUSAL. Before the fix the same
// call returned ok:true with the submitted number inside the total — which is
// exactly the defect, and exactly what these assertions catch.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  assert(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * Source with comments stripped.
 *
 * Section 5 quotes the OLD line in its own prose to say what went wrong, and a
 * plain regex over the file found that quotation and failed — the instrument
 * reading its own explanation as the defect. Same local helper several suites
 * here already carry.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/** The address the customer typed, as the checkout form carries it. */
function withAddress(data: FormData): FormData {
  data.set("name", "A Buyer");
  data.set("line1", "1 Copper Row");
  data.set("city", "Portland");
  data.set("state", "OR");
  data.set("postalCode", "97201");
  data.set("country", "US");
  return data;
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const user = await prismaSystem.user.create({ data: { email: `cps-${stamp}@example.test` } });
  const store = await prismaSystem.store.create({
    data: { userId: user.id, name: "Copper Works", slug: `cps-${stamp}`, currency: "USD", published: true },
  });
  const product = await prismaSystem.product.create({
    data: {
      storeId: store.id, name: "Copper Ring", description: "d",
      priceInCents: 5000, active: true, weightOz: 4,
    },
  });

  const preview = (data: FormData) =>
    previewCheckoutPrice(store.slug, product.id, { ok: true } as never, data);

  // ==================================================================
  console.log("\n1. CONTROL: no rate chosen prices the product alone\n");
  // ==================================================================
  {
    const result = await preview(new FormData());
    assert("the preview succeeds", result.ok, result.ok ? "" : result.error);
    if (result.ok) {
      eq("  the goods are priced", result.pricing.merchandiseSubtotalInCents, 5000);
      // SHIPPING IS ZERO BECAUSE NONE WAS CHOSEN, not because one was dropped.
      eq("  and no shipping is added", result.pricing.shippingInCents, 0);
      eq("  so the total is the product", result.pricing.totalInCents, 5000);
    }
  }

  // ==================================================================
  console.log("\n2. THE TAMPER: a submitted amount beside a rate id\n");
  // ==================================================================
  //
  // THE ASSERTION THIS SUITE EXISTS FOR. Before the fix this returned ok:true
  // with 1 cent of shipping in the total — a number the caller chose.
  {
    const data = withAddress(new FormData());
    data.set("rateId", "rate_legitimate_looking");
    data.set("shippingInCents", "1");
    const result = await preview(data);

    assert("the preview does NOT price with the submitted amount", !result.ok,
      result.ok ? `priced at ${result.pricing.totalInCents} with shipping ${result.pricing.shippingInCents}` : "");
    if (!result.ok) {
      assert("  and says so rather than silently zeroing it",
        /shipping/i.test(result.error), result.error);
    }
  }

  // ==================================================================
  console.log("\n3. A LARGE tamper is refused the same way\n");
  // ==================================================================
  //
  // The direction matters as much as the fact. A preview that could be talked
  // DOWN understates what the customer will pay; one talked UP is a different
  // lie. Neither may reach the total.
  for (const amount of ["0", "999999", "-500"]) {
    const data = withAddress(new FormData());
    data.set("rateId", "rate_legitimate_looking");
    data.set("shippingInCents", amount);
    const result = await preview(data);
    assert(`shippingInCents=${amount} never reaches a total`, !result.ok,
      result.ok ? `shipping came out at ${result.pricing.shippingInCents}` : "");
  }

  // ==================================================================
  console.log("\n4. A rate id with no address is refused honestly\n");
  // ==================================================================
  {
    // The destination is what makes a lookup possible at all, so a rate id
    // without one cannot be confirmed and must not be priced around.
    const data = new FormData();
    data.set("rateId", "rate_legitimate_looking");
    data.set("shippingInCents", "1");
    const result = await preview(data);
    assert("no address means no priced shipping", !result.ok,
      result.ok ? `priced at ${result.pricing.totalInCents}` : "");
    if (!result.ok) {
      assert("  and the reason names the address", /address/i.test(result.error), result.error);
    }
  }

  // ==================================================================
  console.log("\n5. The form field is gone from the source\n");
  // ==================================================================
  {
    // A SOURCE CHECK, because the positive path needs a carrier this harness
    // does not have. It pins the one line that was wrong: if a later edit reads
    // the amount off the form again, every assertion above still passes while
    // a legitimate rate quietly starts trusting the caller once more.
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "app", "store", "[slug]", "actions.ts"), "utf8");
    const code = codeOnly(src);
    const fn = code.slice(code.indexOf("export async function previewCheckoutPrice"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert("the preview never reads shippingInCents from the form",
      !/formData\.get\("shippingInCents"\)/.test(body),
      body.split("\n").find((l) => l.includes("shippingInCents")) ?? "");
    assert("  and gets the amount from confirmSelectedRate",
      /confirmSelectedRate\(/.test(body) && /confirmed\.selected\.amountInCents/.test(body));
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaSystem.$disconnect();
  });
