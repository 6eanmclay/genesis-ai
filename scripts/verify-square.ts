import {
  SQUARE_API_VERSION,
  SQUARE_PRODUCTION_HOST,
  SQUARE_SANDBOX_HOST,
  SQUARE_SCOPES,
  catalogObjectToItem,
  classifySquareFailure,
  customerToContact,
  moneyToCents,
  paymentToTransaction,
  squareAuthorizeUrl,
  squareHost,
  squareRevokeUrl,
  squareTokenUrl,
} from "@/lib/integrations/squareProtocol";
import { squareConnector, squareAppCredentials } from "@/lib/integrations/square";
import { getConnector, getConnectorByName } from "@/lib/integrations/registry";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { ContactSchema, ItemSchema, TransactionSchema } from "@/lib/businessModel/entities";

// SQUARE, VERIFIED WITHOUT A SQUARE ACCOUNT.
//
// No live call has been made — there is no Square application yet. What IS
// provable from here is everything that carries real semantics: the OAuth URL
// Square will actually accept, how failures are told apart, and whether every
// record this connector would write validates against the Foundation's own
// schemas. That last one matters most: persistSyncedRecords validates on the
// way in, so a mapping that produced almost-right shapes would look like a
// working sync that silently wrote nothing.

/**
 * Source with comments stripped.
 *
 * The repository's standing rule for source assertions, and this suite needed
 * it: a source assertion that greps for "Authorization" would match the English
 * word in any paragraph that happens to explain an authorization flow. An
 * assertion that can fail on prose is one that will later PASS on prose too.
 */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
  }
}

function assert(label: string, condition: boolean, detail = "") {
  if (condition) {
    passes++;
    console.log(`  ✓ ${label}`);
  } else {
    failures++;
    console.error(`  ✗ ${label}${detail ? `\n      ${detail}` : ""}`);
  }
}

async function withEnv(vars: Record<string, string | undefined>, body: () => Promise<void> | void) {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(vars)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function main() {
  console.log("\n1. The API version is pinned");
  {
    // Square ships a new dated version roughly monthly, and an omitted header
    // does NOT mean "latest" — it means whatever default Square picks, which
    // is not a decision to leave to them.
    assert("it is a dated version, not a number", /^\d{4}-\d{2}-\d{2}$/.test(SQUARE_API_VERSION), SQUARE_API_VERSION);
    assert("and it is a real date", !Number.isNaN(Date.parse(SQUARE_API_VERSION)), SQUARE_API_VERSION);
  }

  console.log("\n2. Hosts, and the sandbox is a different one");
  {
    // A SANDBOX TOKEN AGAINST PRODUCTION IS AN AUTH ERROR that looks exactly
    // like bad credentials, so the two hosts must never be confused.
    // Compared as strings on purpose: TypeScript narrows these to literal
    // types and would prove the comparison true at compile time, which is a
    // vacuous assertion dressed as a real one.
    assert("production and sandbox are different hosts",
      (SQUARE_PRODUCTION_HOST as string) !== (SQUARE_SANDBOX_HOST as string));
    assert("both are HTTPS", SQUARE_PRODUCTION_HOST.startsWith("https://") && SQUARE_SANDBOX_HOST.startsWith("https://"));
    check("squareHost picks production by default", squareHost(false), SQUARE_PRODUCTION_HOST);
    check("and sandbox when asked", squareHost(true), SQUARE_SANDBOX_HOST);
    check("the token URL follows the host", squareTokenUrl(true), `${SQUARE_SANDBOX_HOST}/oauth2/token`);
    check("so does the revoke URL", squareRevokeUrl(false), `${SQUARE_PRODUCTION_HOST}/oauth2/revoke`);
  }

  console.log("\n3. The authorization URL Square will actually accept");
  {
    const url = squareAuthorizeUrl({
      useSandbox: false,
      clientId: "sq0idp-abc",
      state: "signed-state",
      redirectUri: "https://genesis-ai-rho.vercel.app/api/integrations/square/callback",
    });
    const parsed = new URL(url);

    check("it points at Square's authorize endpoint", parsed.origin + parsed.pathname, `${SQUARE_PRODUCTION_HOST}/oauth2/authorize`);
    check("carrying the application id", parsed.searchParams.get("client_id"), "sq0idp-abc");
    check("and the signed state", parsed.searchParams.get("state"), "signed-state");
    check("and the redirect", parsed.searchParams.get("redirect_uri"),
      "https://genesis-ai-rho.vercel.app/api/integrations/square/callback");

    // ============ SPACE-SEPARATED, NOT COMMA =============================
    // A comma-separated list is accepted by URLSearchParams and rejected by
    // Square, which is the worst combination — it looks correct locally.
    const scope = parsed.searchParams.get("scope") ?? "";
    assert("scopes are space-separated", scope.includes(" ") && !scope.includes(","), scope);
    check("and are exactly the five requested", scope.split(" ").sort(), [...SQUARE_SCOPES].sort());

    // EVERY SCOPE IS READ-ONLY. Genesis leaves the merchant's own software
    // responsible for its own workflows; a write scope it never uses would be
    // asking a merchant to grant something on the off-chance.
    assert("every scope is a read scope", SQUARE_SCOPES.every((s) => s.endsWith("_READ")), SQUARE_SCOPES.join(", "));
  }

  console.log("\n4. Failures are told apart");
  {
    const auth = classifySquareFailure(401, { errors: [{ category: "AUTHENTICATION_ERROR", code: "UNAUTHORIZED", detail: "Bad token" }] });
    check("an authentication error is auth", auth.kind, "auth");
    check("carrying Square's own words", auth.detail, "Bad token");

    const limited = classifySquareFailure(429, { errors: [{ category: "RATE_LIMIT_ERROR", code: "RATE_LIMITED", detail: "Slow down" }] });
    check("a rate limit is its own kind", limited.kind, "rate_limit");

    // ============ THE ONE MOST LIKELY TO BE MISREPORTED ==================
    // A merchant who connected but declined a permission is NOT a broken
    // connection. Reporting it as one would tell them to reconnect, which
    // fixes nothing, instead of telling them what they didn't grant.
    const scope = classifySquareFailure(403, { errors: [{ category: "AUTHENTICATION_ERROR", code: "INSUFFICIENT_SCOPES", detail: "Missing ORDERS_READ" }] });
    check("a missing permission is not an auth failure", scope.kind, "insufficient_scope");
    assert("and is distinct from auth", scope.kind !== auth.kind);

    check("anything else is a provider error", classifySquareFailure(500, { errors: [{ detail: "boom" }] }).kind, "provider");
    assert("and is never swallowed", classifySquareFailure(500, { errors: [{ detail: "boom" }] }).detail === "boom");
    // NEVER THROWS on a shape Square didn't document.
    check("a bodiless failure still classifies", classifySquareFailure(401, null).kind, "auth");
    check("so does an empty errors array", classifySquareFailure(500, { errors: [] }).kind, "provider");

    const kinds = new Set([auth.kind, limited.kind, scope.kind, classifySquareFailure(500, {}).kind]);
    check("all four kinds are distinguishable", kinds.size, 4);
  }

  console.log("\n5. Money is already in cents");
  {
    // ============ THE HUNDREDFOLD ERROR ==================================
    // Square's Money.amount is the currency's MINOR unit already. Most APIs
    // send decimals, so the instinct is to multiply by 100 — which would turn
    // $42.50 into $4,250.00 on every figure the owner reads.
    check("4250 means $42.50, unchanged", moneyToCents({ amount: 4250, currency: "USD" }), 4250);
    check("a string amount is still cents", moneyToCents({ amount: "4250" }), 4250);
    check("zero is zero", moneyToCents({ amount: 0 }), 0);
    // NULL IS UNKNOWN, NOT ZERO — a missing amount and a free line are
    // different facts and only one should be summed.
    check("a missing money object is unknown", moneyToCents(null), null);
    check("a money object with no amount is unknown", moneyToCents({ currency: "USD" }), null);
    check("an unreadable amount is unknown", moneyToCents({ amount: "lots" }), null);
    assert("unknown is never zero", moneyToCents(undefined) !== 0);
  }

  console.log("\n6. Customers become Contacts the Foundation accepts");
  {
    const contact = customerToContact({
      id: "C1",
      given_name: "Ada",
      family_name: "Lovelace",
      email_address: "ada@example.test",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-02-01T00:00:00Z",
    });
    check("the name is assembled", contact?.name, "Ada Lovelace");
    check("the email comes through", contact?.email, "ada@example.test");
    check("with the customer role", contact?.roles, ["customer"]);
    // THE ASSERTION THAT MATTERS: persistSyncedRecords validates on the way
    // in, so an almost-right shape is a sync that silently writes nothing.
    assert("and it validates against the real schema", ContactSchema.safeParse(contact).success,
      JSON.stringify(ContactSchema.safeParse(contact)));

    // A company with no contact name is still a real customer.
    const company = customerToContact({ id: "C2", company_name: "Cubit & Coil", created_at: "2026-01-01T00:00:00Z" });
    check("a company name is used when there's no person", company?.name, "Cubit & Coil");
    assert("and still validates", ContactSchema.safeParse(company).success);

    // A nameless customer is a real Square record and must not crash.
    const anonymous = customerToContact({ id: "C3", created_at: "2026-01-01T00:00:00Z" });
    check("a nameless customer is kept, with a null name", anonymous?.name, null);
    assert("and validates", ContactSchema.safeParse(anonymous).success);

    check("but one with no id is not a contact at all", customerToContact({ given_name: "Nobody" }), null);
  }

  console.log("\n7. Payments become Transactions, and a refund is not a sale");
  {
    const sale = paymentToTransaction({
      id: "P1",
      amount_money: { amount: 8500, currency: "USD" },
      status: "COMPLETED",
      created_at: "2026-03-01T00:00:00Z",
      customer_id: "C1",
      order_id: "O1",
    });
    check("the amount is carried in cents", sale?.amountInCents, 8500);
    check("the currency is lowercased", sale?.currency, "usd");
    check("it is a sale", sale?.type, "sale");
    check("linked to the customer", sale?.contactId, "C1");
    check("and to the order", sale?.itemIds, ["O1"]);
    assert("and it validates", TransactionSchema.safeParse(sale).success,
      JSON.stringify(TransactionSchema.safeParse(sale)));

    // ============ COUNTING A REFUND AS A SALE OVERSTATES REVENUE TWICE ====
    // Once by adding it, once by never subtracting it.
    const refund = paymentToTransaction({
      id: "P2",
      amount_money: { amount: 8500, currency: "USD" },
      refunded_money: { amount: 8500, currency: "USD" },
      status: "COMPLETED",
      created_at: "2026-03-02T00:00:00Z",
    });
    check("a refunded payment is a refund", refund?.type, "refund");
    assert("which is not a sale", refund?.type !== sale?.type);

    // A payment with no readable amount would sum as zero and drag every
    // average down, so it is dropped rather than recorded as free.
    check("a payment with no amount is not a transaction", paymentToTransaction({ id: "P3", status: "COMPLETED" }), null);
    check("and one with no id isn't either", paymentToTransaction({ amount_money: { amount: 1 } }), null);
  }

  console.log("\n8. Catalog objects become Items");
  {
    const item = catalogObjectToItem({
      id: "I1",
      type: "ITEM",
      item_data: {
        name: "Copper tensor ring",
        category_id: "CAT1",
        variations: [{ id: "V1", item_variation_data: { sku: "CTR-1", price_money: { amount: 8500, currency: "USD" } } }],
      },
    });
    check("the name comes through", item?.name, "Copper tensor ring");
    // Square puts price and SKU on the VARIATION, not the item — reading them
    // off item_data would silently produce null for every product.
    check("the SKU is read off the variation", item?.sku, "CTR-1");
    check("so is the price", item?.priceInCents, 8500);
    check("it is active", item?.active, true);
    // Inventory needs a scope this connector does not request. Null is honest.
    check("stock is unknown, not zero", item?.quantityAvailable, null);
    assert("and it validates", ItemSchema.safeParse(item).success, JSON.stringify(ItemSchema.safeParse(item)));

    const noVariation = catalogObjectToItem({ id: "I2", type: "ITEM", item_data: { name: "Mystery" } });
    check("an item with no variation has an unknown price", noVariation?.priceInCents, null);
    assert("and still validates", ItemSchema.safeParse(noVariation).success);

    const deleted = catalogObjectToItem({ id: "I3", type: "ITEM", is_deleted: true, item_data: { name: "Gone" } });
    check("a soft-deleted item is inactive", deleted?.active, false);

    // Square's catalog holds categories, taxes, discounts and more under the
    // same endpoint. Mapping one as a product would invent inventory.
    check("a non-ITEM object is not an item", catalogObjectToItem({ id: "X", type: "CATEGORY" }), null);
    check("and neither is a nameless one", catalogObjectToItem({ id: "X", type: "ITEM", item_data: {} }), null);
  }

  console.log("\n9. The connector, as the framework sees it");
  {
    check("it is registered", getConnector("SQUARE").provider, "SQUARE");
    check("and resolvable by name for the callback route", getConnectorByName("square") === squareConnector, true);

    const capabilities = squareConnector.capabilities;
    check("it is OAuth, not an API key", capabilities.authKind, "oauth");
    check("requesting exactly the five scopes", [...capabilities.scopes].sort(), [...SQUARE_SCOPES].sort());
    check("reading contacts, transactions and items", [...capabilities.reads].sort(), ["contact", "item", "transaction"]);
    // EMPTY WRITES IS A CLAIM, and it is checkable: every scope is _READ, so
    // Genesis could not write even if a bug tried to.
    check("and writing nothing", capabilities.writes, []);
    assert("which the scopes back up", capabilities.scopes.every((s) => s.endsWith("_READ")));

    check("its access token expires", capabilities.tokenLifetime, "expires");
    // TRUE, AND EARNED — disconnect() calls Square's revocation endpoint.
    check("it revokes at Square on disconnect", capabilities.revokesOnDisconnect, true);
    assert("and really calls the revoke endpoint",
      codeOnly((await import("fs")).readFileSync("lib/integrations/square.ts", "utf8")).includes("squareRevokeUrl"),
      "revokesOnDisconnect: true must not be a claim the code doesn't keep");

    assert("it declares a sync", typeof squareConnector.sync === "function");
    assert("consistent with reading something", capabilities.reads.length > 0);
  }

  console.log("\n10. Availability is declared, not guessed");
  {
    await withEnv({ SQUARE_CLIENT_ID: undefined, SQUARE_CLIENT_SECRET: undefined }, () => {
      check("with no credentials it is unavailable", squareConnector.configured?.(), false);
      check("and app credentials are null", squareAppCredentials(), null);
    });
    await withEnv({ SQUARE_CLIENT_ID: "id", SQUARE_CLIENT_SECRET: undefined }, () => {
      // Half-configured is not configured — an id with no secret would produce
      // an auth failure that reads as "Square rejected us".
      check("an id with no secret is still unavailable", squareConnector.configured?.(), false);
    });
    await withEnv({ SQUARE_CLIENT_ID: "id", SQUARE_CLIENT_SECRET: "secret", SQUARE_USE_SANDBOX: undefined }, () => {
      check("with both it is available", squareConnector.configured?.(), true);
      check("and defaults to production", squareAppCredentials()?.useSandbox, false);
    });
    await withEnv({ SQUARE_CLIENT_ID: "id", SQUARE_CLIENT_SECRET: "secret", SQUARE_USE_SANDBOX: "1" }, () => {
      check("sandbox is an explicit opt-in", squareAppCredentials()?.useSandbox, true);
    });
  }

  console.log("\n11. The catalog entry is real, and no secret is in client code");
  {
    const entry = CONNECTOR_CATALOG.find((e) => e.id === "square-pos");
    assert("Square is in the catalog", entry !== undefined);
    check("no longer coming-soon", entry?.connector === null, false);
    check("wired to its provider", entry?.provider, "SQUARE");
    check("declaring oauth, matching the connector", entry?.authMethod, squareConnector.capabilities.authKind);
    // Financial data — the catalog's own sensitivity flag must say so.
    check("and marked sensitive", entry?.sensitivity, "sensitive");

    const fs = await import("fs");
    const protocol = codeOnly(fs.readFileSync("lib/integrations/squareProtocol.ts", "utf8"));
    const connector = codeOnly(fs.readFileSync("lib/integrations/square.ts", "utf8"));
    // The pure half never touches a secret, which is what makes it safe to
    // import anywhere and testable without an account.
    assert("the protocol reads no environment", !protocol.includes("process.env"));
    assert("and holds no credential handling", !/client_secret|Authorization/i.test(protocol));
    assert("the connector encrypts what it stores", connector.includes("encryptCredentials"));
    assert("neither is a client component",
      !protocol.includes('"use client"') && !connector.includes('"use client"'));
    assert("no credential is hard-coded",
      !/SQUARE_CLIENT_(ID|SECRET)\s*=\s*["'][^"']+["']/.test(connector));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (no Square application exists): the live OAuth handoff,\n" +
        "the real token exchange, and the shapes Square actually returns. See\n" +
        "SQUARE_REQUIREMENTS_VERIFIED.md for what is needed to finish it.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
