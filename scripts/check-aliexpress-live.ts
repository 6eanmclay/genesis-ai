import fs from "node:fs";

// DOES THE ALIEXPRESS SIGNATURE SURVIVE CONTACT WITH ALIEXPRESS?
//
//   npx tsx scripts/check-aliexpress-live.ts .env.livecheck
//
// A CHECK, NOT A VERIFICATION SUITE, and the distinction is deliberate. It talks
// to a third party over the network against real credentials, so it is not part
// of the regression, is never run by run-db-suites, and is expected to be run by
// a person who has read this comment. scripts/verify-aliexpress.ts is the suite;
// it proves the protocol against its specification and needs no credentials.
//
// ============ THE ONE THING THIS EXISTS TO SETTLE ==========================
//
// The signature is four steps — sort by key, concatenate with no delimiter,
// wrap in the secret on both sides, uppercase MD5 — and getting any of them
// wrong produces a perfectly plausible 32-character string that the gateway
// simply refuses. verify-aliexpress.ts proves the implementation matches the
// algorithm as publicly documented; AliExpress's own reference sits behind a
// developer login. Only a real call settles which is right, and this is it.
//
// STRICTLY READ-ONLY, on both sides. It performs one product search. It writes
// nothing to Genesis and nothing at AliExpress — the search method has no
// side effects, no order is placed, and no store is touched. It does not open a
// database connection at all.
//
// THE SECRET NEVER GOES THROUGH SHELL HISTORY. The env file is named as an
// argument and read from disk, the same rule every other check-*-live.ts here
// follows for the same reason. The secret is never printed, not even truncated.

async function main() {
  const envPath = process.argv[2] ?? ".env.livecheck";
  if (!fs.existsSync(envPath)) {
    console.log(`No env file at ${envPath}. Nothing to check.`);
    console.log("Pass the path as an argument: npx tsx scripts/check-aliexpress-live.ts .env.livecheck");
    process.exit(1);
  }

  const file = fs.readFileSync(envPath, "utf8");
  const read = (name: string) => file.match(new RegExp(`^${name}="?([^"\\n\\r]+)`, "m"))?.[1]?.trim();

  const appKey = read("ALIEXPRESS_APP_KEY");
  const appSecret = read("ALIEXPRESS_APP_SECRET");
  const trackingId = read("ALIEXPRESS_TRACKING_ID");

  if (!appKey || !appSecret) {
    console.log(`\n${envPath} has no ALIEXPRESS_APP_KEY / ALIEXPRESS_APP_SECRET.`);
    console.log("Nothing has been sent. See ALIEXPRESS_REQUIREMENTS_VERIFIED.md for how to get them.\n");
    process.exit(1);
  }

  process.env.ALIEXPRESS_APP_KEY = appKey;
  process.env.ALIEXPRESS_APP_SECRET = appSecret;
  if (trackingId) process.env.ALIEXPRESS_TRACKING_ID = trackingId;

  // Enough to identify the credential in AliExpress's console without being
  // enough to use it. The secret is not printed at all, in any form.
  console.log(`\nApp key ending ${appKey.slice(-4)}. Secret present (${appSecret.length} chars, not shown).`);

  const { searchAliexpress } = await import("@/lib/sourcing/aliexpressClient");
  const keywords = process.argv[3] ?? "copper ring";
  console.log(`Searching AliExpress for "${keywords}"…\n`);

  const result = await searchAliexpress({ keywords, limit: 3 });

  if (!result.ok) {
    // THE KIND IS THE ANSWER, not the fact of failing. Each one means a
    // different next action, and guessing between them is what this avoids.
    const { kind, detail } = result.failure;
    console.log(`FAILED — ${kind}\n  ${detail}\n`);
    console.log(
      {
        auth: "AliExpress rejected the credentials or the SIGNATURE. If the key and secret are\n" +
          "  definitely right, the signature algorithm is wrong — that is the finding this\n" +
          "  script exists for, and lib/sourcing/aliexpressProtocol.ts is where it lives.",
        not_permitted: "The credentials are good but the app is not approved for this method yet.\n" +
          "  That approval is AliExpress's, and nothing in the code changes it.",
        rate_limit: "Credentials and signature are fine — this is throttling. Try again shortly.",
        provider: "AliExpress answered with something unrecognised. The raw message is above.",
      }[kind],
    );
    console.log();
    process.exit(1);
  }

  console.log(`OK — ${result.value.length} product(s) returned.\n`);
  for (const product of result.value) {
    const { priceInCents } = await import("@/lib/sourcing/aliexpressProtocol");
    const cents = priceInCents(product.target_sale_price);
    console.log(`  ${product.product_id} — ${product.product_title}`);
    // "unknown" rather than "$0.00": a price that could not be read is not free,
    // and this is the one place a human sees whether the parsing held up.
    console.log(
      `    ${cents === null ? "price unknown" : `$${(cents / 100).toFixed(2)}`} ` +
        `${product.target_sale_price_currency ?? ""} · image ${product.product_main_image_url ? "yes" : "MISSING"}`,
    );
  }

  console.log("\nThe signature is correct. lib/sourcing/aliexpressProtocol.ts is confirmed against the real gateway.\n");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
