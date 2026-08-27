import {
  XERO_API_BASE,
  XERO_AUTHORIZE_URL,
  XERO_CONNECTIONS_URL,
  XERO_REVOCATION_URL,
  XERO_SCOPES,
  XERO_TOKEN_URL,
  chooseTenant,
  classifyXeroFailure,
  credentialsAfterFailedRefresh,
  rotatedCredentials,
  shouldRefresh,
  xeroAuthorizeUrl,
  xeroContactToContact,
  xeroDate,
  xeroInvoiceToDocument,
} from "@/lib/integrations/xeroProtocol";
import { xeroConnector, xeroAppCredentials } from "@/lib/integrations/xero";
import { getConnector, getConnectorByName } from "@/lib/integrations/registry";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { ContactSchema, DocumentSchema } from "@/lib/businessModel/entities";
import { squareConnector } from "@/lib/integrations/square";

// XERO, VERIFIED WITHOUT A XERO ACCOUNT.
//
// No live call has been made — there is no Xero application yet.
//
// THE THREE THINGS THIS SUITE EXISTS FOR, all of which would have been wrong if
// carried from memory rather than read from Xero's docs on 2026-08-27:
//
//   1. The SCOPES changed on 2 March 2026, and an app created after that date
//      has NO ACCESS to the old broad ones. Every pre-2026 tutorial names
//      `accounting.transactions`, which would simply fail.
//   2. Refresh tokens ROTATE. Keeping the original is the QuickBooks bug that
//      killed that connector here for eighteen days, and Xero's access token
//      lasts thirty minutes so it would die fast.
//   3. A token names no organisation. Every call needs Xero-Tenant-Id, and a
//      connection stored without one is connected in the database and unable
//      to read anything in fact.

/**
 * Source with comments stripped.
 *
 * The repository's standing rule for source assertions, and this suite needed
 * it: "and holds no credential handling" was matching the English word
 * "authorization" in a paragraph explaining Xero's tenant model. An assertion
 * that fails on prose is one that will later PASS on prose too.
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
  console.log("\n1. Endpoints");
  {
    for (const [name, url] of [
      ["authorize", XERO_AUTHORIZE_URL],
      ["token", XERO_TOKEN_URL],
      ["connections", XERO_CONNECTIONS_URL],
      ["revocation", XERO_REVOCATION_URL],
      ["api base", XERO_API_BASE],
    ] as const) {
      assert(`the ${name} URL is HTTPS`, url.startsWith("https://"), url);
    }
    // Xero splits identity from the API across different hosts, which is easy
    // to get wrong by assuming one origin for everything.
    assert("authorize is on login.xero.com", new URL(XERO_AUTHORIZE_URL).host === "login.xero.com");
    assert("token is on identity.xero.com", new URL(XERO_TOKEN_URL).host === "identity.xero.com");
    assert("connections is on api.xero.com", new URL(XERO_CONNECTIONS_URL).host === "api.xero.com");
  }

  console.log("\n2. The scopes — post-March-2026, which is the only set a new app can use");
  {
    const scopes = [...XERO_SCOPES] as string[];

    // ============ THE BROAD SCOPES ARE UNUSABLE FOR A NEW APP ============
    // Xero replaced them on 2 March 2026. Apps created on or after that date
    // have NO ACCESS to them at all — and Genesis's app does not exist yet.
    assert("the retired broad transactions scope is NOT requested",
      !scopes.includes("accounting.transactions"), scopes.join(" "));
    assert("nor the retired broad reports scope",
      !scopes.includes("accounting.reports.read"), scopes.join(" "));

    // OFFLINE_ACCESS IS NOT OPTIONAL. Without it Xero issues no refresh token,
    // and the access token lasts thirty minutes — a connection that had to be
    // re-consented every half hour is not a connection.
    assert("offline_access is requested", scopes.includes("offline_access"),
      "without it Xero issues no refresh token at all");

    assert("invoices are requested, granularly", scopes.includes("accounting.invoices.read"));
    assert("so are contacts", scopes.includes("accounting.contacts.read"));
    assert("and organisation settings", scopes.includes("accounting.settings.read"));

    // READ-ONLY: every accounting scope ends .read. Genesis explains a
    // business's books; it never writes to them.
    const accounting = scopes.filter((s) => s.startsWith("accounting."));
    assert("every accounting scope is read-only", accounting.every((s) => s.endsWith(".read")), accounting.join(" "));
    assert("and there is at least one", accounting.length > 0);
  }

  console.log("\n3. The authorization URL");
  {
    const url = xeroAuthorizeUrl({
      clientId: "XERO-ID",
      redirectUri: "https://genesis-ai-rho.vercel.app/api/integrations/xero/callback",
      state: "signed-state",
    });
    const parsed = new URL(url);
    check("it points at Xero's authorize endpoint", parsed.origin + parsed.pathname, XERO_AUTHORIZE_URL);
    check("asking for a code", parsed.searchParams.get("response_type"), "code");
    check("with the client id", parsed.searchParams.get("client_id"), "XERO-ID");
    check("the redirect", parsed.searchParams.get("redirect_uri"),
      "https://genesis-ai-rho.vercel.app/api/integrations/xero/callback");
    check("and the signed state", parsed.searchParams.get("state"), "signed-state");

    const scope = parsed.searchParams.get("scope") ?? "";
    assert("scopes are space-separated, per OAuth 2.0", scope.includes(" ") && !scope.includes(","), scope);
    check("and are exactly the set declared", scope.split(" ").sort(), [...XERO_SCOPES].sort());
  }

  console.log("\n4. Failures — and invalid_grant is the important one");
  {
    // ============ WHAT A ROTATED-AWAY REFRESH TOKEN RETURNS ==============
    // invalid_grant is indistinguishable from a merchant revoking access, and
    // both mean the same thing to the owner: reconnect. What must NOT happen
    // is reporting it as a provider outage, which tells them to wait for
    // something that will never fix itself.
    const rotated = classifyXeroFailure(400, { error: "invalid_grant", error_description: "Refresh token is invalid" });
    check("invalid_grant is an auth failure", rotated.kind, "auth");
    assert("not a provider outage", rotated.kind !== "provider");
    assert("carrying Xero's own words", rotated.detail.includes("Refresh token is invalid"));

    check("invalid_client is auth too", classifyXeroFailure(400, { error: "invalid_client" }).kind, "auth");
    check("a bare 401 is auth", classifyXeroFailure(401, null).kind, "auth");
    check("429 is a rate limit", classifyXeroFailure(429, {}).kind, "rate_limit");
    // 403 means authorized but not for THIS organisation or data — a
    // different fix from reconnecting.
    check("403 is a tenant problem, not an auth one", classifyXeroFailure(403, {}).kind, "no_tenant");
    check("anything else is a provider error", classifyXeroFailure(500, { Message: "boom" }).kind, "provider");
    assert("and is never swallowed", classifyXeroFailure(500, { Message: "boom" }).detail === "boom");

    const kinds = new Set([rotated.kind, classifyXeroFailure(429, {}).kind, classifyXeroFailure(403, {}).kind, classifyXeroFailure(500, {}).kind]);
    check("all four kinds are distinguishable", kinds.size, 4);
  }

  console.log("\n5. Choosing an organisation");
  {
    // A token names no organisation, and one authorization can cover several.
    const chosen = chooseTenant([
      { tenantId: "T1", tenantType: "PRACTICE", tenantName: "Practice" },
      { tenantId: "T2", tenantType: "ORGANISATION", tenantName: "Cubit & Coil" },
    ]);
    // ============ FIRST *ORGANISATION*, NOT FIRST CONNECTION =============
    // Reading a non-organisation tenant as if it were the business's books
    // would produce confident nonsense.
    check("it picks the organisation, not merely the first entry", chosen?.tenantId, "T2");
    check("and keeps its name", chosen?.tenantName, "Cubit & Coil");

    check("no organisation means none was chosen", chooseTenant([{ tenantId: "T1", tenantType: "PRACTICE" }]), null);
    check("an empty list means none", chooseTenant([]), null);
    // A connection with no tenantId is unusable — every call needs the header.
    check("an entry without a tenantId is not usable", chooseTenant([{ tenantType: "ORGANISATION" }]), null);
  }

  console.log("\n6. Dates, in both shapes Xero sends");
  {
    // Xero sends ISO 8601 in some payloads and /Date(...)/ in others.
    check("an ISO date parses", xeroDate("2026-03-01T00:00:00Z"), "2026-03-01T00:00:00.000Z");
    check("a .NET date parses", xeroDate("/Date(1772323200000+0000)/"), new Date(1772323200000).toISOString());
    // An unreadable date must be null, not Invalid Date — which poisons every
    // comparison it touches before it ever serialises.
    check("an unreadable date is null", xeroDate("sometime"), null);
    check("an absent one is null", xeroDate(undefined), null);
  }

  console.log("\n7. Contacts");
  {
    const both = xeroContactToContact({
      ContactID: "X1",
      Name: "Cubit & Coil",
      EmailAddress: "hi@example.test",
      IsCustomer: true,
      IsSupplier: true,
      UpdatedDateUTC: "2026-03-01T00:00:00Z",
    });
    // ============ A CONTACT CAN BE BOTH, WHICH IS WHY roles IS A LIST =====
    // A business that buys from you and sells to you is one record with two
    // roles, and collapsing it to one would lose a real relationship.
    check("a customer-and-supplier carries both roles", both?.roles, ["customer", "vendor"]);
    check("with the name", both?.name, "Cubit & Coil");
    assert("and it validates against the real schema", ContactSchema.safeParse(both).success,
      JSON.stringify(ContactSchema.safeParse(both)));

    const neither = xeroContactToContact({ ContactID: "X2", Name: "Nobody", UpdatedDateUTC: "2026-03-01T00:00:00Z" });
    check("a contact that is neither has no roles", neither?.roles, []);
    assert("and still validates", ContactSchema.safeParse(neither).success);

    check("no id means no contact", xeroContactToContact({ Name: "Ghost" }), null);
  }

  console.log("\n8. Invoices — and the unit is the opposite of Square's");
  {
    const invoice = xeroInvoiceToDocument({
      InvoiceID: "I1",
      Type: "ACCREC",
      Total: 42.5,
      Status: "PAID",
      Contact: { ContactID: "X1" },
      DateString: "2026-03-01T00:00:00Z",
      DueDateString: "2026-04-01T00:00:00Z",
    });
    // ============ XERO SENDS MAJOR UNITS, SQUARE SENDS MINOR =============
    // 42.5 means $42.50 here and MUST be multiplied. Doing the same in the
    // Square mapping would inflate every figure a hundredfold. The two
    // connectors sit side by side and the rule is opposite in each.
    check("42.5 becomes 4250 cents", invoice?.amountInCents, 4250);
    check("a paid invoice is paid", invoice?.status, "paid");
    check("it is an invoice", invoice?.type, "invoice");
    check("linked to its contact", invoice?.contactId, "X1");
    assert("and it validates", DocumentSchema.safeParse(invoice).success,
      JSON.stringify(DocumentSchema.safeParse(invoice)));

    // ============ A BILL IS NOT AN INVOICE ===============================
    // ACCPAY is money the business OWES. Recording it as an invoice would
    // count an expense as revenue.
    const bill = xeroInvoiceToDocument({ InvoiceID: "I2", Type: "ACCPAY", Total: 10, Status: "AUTHORISED" });
    check("an ACCPAY is a bill", bill?.type, "bill");
    assert("which is not an invoice", bill?.type !== invoice?.type);

    // AUTHORISED means issued and awaiting payment; whether it is OVERDUE is a
    // fact about the due date, which Xero does not fold into Status.
    const overdue = xeroInvoiceToDocument({
      InvoiceID: "I3", Type: "ACCREC", Total: 10, Status: "AUTHORISED",
      DueDateString: "2020-01-01T00:00:00Z",
    });
    check("an authorised invoice past its due date is overdue", overdue?.status, "overdue");
    const pending = xeroInvoiceToDocument({
      InvoiceID: "I4", Type: "ACCREC", Total: 10, Status: "AUTHORISED",
      DueDateString: "2099-01-01T00:00:00Z",
    });
    check("and one still in date is pending", pending?.status, "pending");
    assert("so the two are told apart", overdue?.status !== pending?.status);

    check("a voided invoice is void", xeroInvoiceToDocument({ InvoiceID: "I5", Total: 1, Status: "VOIDED" })?.status, "void");
    // An unreadable total is unknown, never zero.
    check("an invoice with no total has an unknown amount",
      xeroInvoiceToDocument({ InvoiceID: "I6", Status: "PAID" })?.amountInCents, null);
    check("no id means no document", xeroInvoiceToDocument({ Total: 1 }), null);
  }

  console.log("\n9. The connector, as the framework sees it");
  {
    check("it is registered", getConnector("XERO").provider, "XERO");
    check("and resolvable by name for the callback route", getConnectorByName("xero") === xeroConnector, true);

    const capabilities = xeroConnector.capabilities;
    check("it is OAuth", capabilities.authKind, "oauth");
    check("reading contacts and documents", [...capabilities.reads].sort(), ["contact", "document"]);
    check("and writing nothing", capabilities.writes, []);

    // ============ THE DECLARATION THAT MATTERS ===========================
    // "rotating" is what tokenLifetime exists to express, and it exists
    // because QuickBooks got it wrong here.
    check("its refresh tokens are declared ROTATING", capabilities.tokenLifetime, "rotating");
    assert("which is different from Square's, deliberately",
      capabilities.tokenLifetime !== squareConnector.capabilities.tokenLifetime,
      "Square's refresh tokens neither expire nor rotate; Xero's rotate on every use");

    check("it revokes at Xero on disconnect", capabilities.revokesOnDisconnect, true);

    const fs = await import("fs");
    const source = codeOnly(fs.readFileSync("lib/integrations/xero.ts", "utf8"));
    assert("and really calls the revocation endpoint", source.includes("XERO_REVOCATION_URL"),
      "revokesOnDisconnect: true must not be a claim the code doesn't keep");

    // ============ THE ROTATION IS ACTUALLY IMPLEMENTED ===================
    //
    // These were source greps once, and one of them was matching a COMMENT --
    // it tested prose, and comment-stripping quite rightly broke it. The
    // decision is a pure function now, so this asserts behaviour.
    const before = { accessToken: "old-access", refreshToken: "old-refresh", expiresAt: 1_000 };
    const after = rotatedCredentials(
      { access_token: "new-access", refresh_token: "new-refresh", expires_in: 1800 },
      10_000,
    );
    check("a successful refresh takes the NEW access token", after?.accessToken, "new-access");
    // THE QUICKBOOKS BUG, IN ONE ASSERTION. Keeping the original refresh token
    // works exactly once and then every later refresh fails with invalid_grant.
    check("and the NEW refresh token", after?.refreshToken, "new-refresh");
    assert("never the one it started with", after?.refreshToken !== before.refreshToken);
    check("with the expiry Xero gave", after?.expiresAt, 10_000 + 1800 * 1000);
    // An incomplete response is not a rotation. Storing half of one would
    // leave a connection that cannot refresh again.
    check("an incomplete token response rotates nothing",
      rotatedCredentials({ access_token: "only-access" }, 0), null);

    // A FAILED refresh keeps what it has -- Xero honours the previous token
    // for 30 minutes so a failed round trip can be retried, and discarding
    // would turn a network blip into a connection the owner must redo by hand.
    check("a failed refresh keeps the existing credentials",
      credentialsAfterFailedRefresh(before), before);

    // And when to refresh at all.
    assert("an expired token refreshes", shouldRefresh(1_000, 10_000));
    assert("a token expiring within the minute's margin refreshes", shouldRefresh(10_030_000, 10_000_000));
    assert("a healthy token does not", !shouldRefresh(10_120_000, 10_000_000));
    // UNKNOWN IS NOT FINE. An absent expiry must not be read as "still valid".
    assert("an unknown expiry refreshes rather than assuming", shouldRefresh(null, 10_000));

    // Every call needs the tenant header; without it nothing can be read.
    assert("every API call sends Xero-Tenant-Id", source.includes('"Xero-Tenant-Id"'));
    assert("and a connection with no tenant refuses rather than calling",
      source.includes("no_tenant"), "a token alone cannot read anything");
  }

  console.log("\n10. Availability, catalog, and no secret in client code");
  {
    await withEnv({ XERO_CLIENT_ID: undefined, XERO_CLIENT_SECRET: undefined }, () => {
      check("with no credentials it is unavailable", xeroConnector.configured?.(), false);
      check("and app credentials are null", xeroAppCredentials(), null);
    });
    await withEnv({ XERO_CLIENT_ID: "id", XERO_CLIENT_SECRET: undefined }, () => {
      check("half-configured is still unavailable", xeroConnector.configured?.(), false);
    });
    await withEnv({ XERO_CLIENT_ID: "id", XERO_CLIENT_SECRET: "secret" }, () => {
      check("with both it is available", xeroConnector.configured?.(), true);
    });

    const entry = CONNECTOR_CATALOG.find((e) => e.id === "xero");
    assert("Xero is in the catalog", entry !== undefined);
    check("no longer coming-soon", entry?.connector === null, false);
    check("wired to its provider", entry?.provider, "XERO");
    check("and marked sensitive, being financial data", entry?.sensitivity, "sensitive");

    const fs = await import("fs");
    const protocol = codeOnly(fs.readFileSync("lib/integrations/xeroProtocol.ts", "utf8"));
    const connector = codeOnly(fs.readFileSync("lib/integrations/xero.ts", "utf8"));
    assert("the protocol reads no environment", !protocol.includes("process.env"));
    assert("and holds no credential handling", !/client_secret|Authorization/i.test(protocol));
    assert("the connector encrypts what it stores", connector.includes("encryptCredentials"));
    assert("neither is a client component",
      !protocol.includes('"use client"') && !connector.includes('"use client"'));
    assert("no credential is hard-coded",
      !/XERO_CLIENT_(ID|SECRET)\s*=\s*["'][^"']+["']/.test(connector));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (no Xero application exists): the live OAuth handoff, the\n" +
        "real token rotation, and the shapes Xero actually returns. See\n" +
        "XERO_REQUIREMENTS_VERIFIED.md for what is needed to finish it.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
