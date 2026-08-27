import {
  TWILIO_API_BASE,
  accountReadiness,
  accountUrl,
  classifyFailure,
  isE164,
  messageForm,
  messagesUrl,
  readAccount,
  readSentMessage,
  segmentsFor,
  toE164,
} from "@/lib/integrations/twilioProtocol";
import { twilioConnector } from "@/lib/integrations/twilio";
import { getConnector } from "@/lib/integrations/registry";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";

// TWILIO, VERIFIED WITHOUT A TWILIO ACCOUNT.
//
// No live call has been made. The protocol half is pure, so everything that
// carries real semantics — how a failure is classified, what a message costs,
// whether a number is sendable, whether a trial account is honestly described —
// is provable from here. What is NOT provable from here is named in §9 rather
// than left to be assumed.
//
// THE ASSERTIONS THAT MATTER MOST are the ones about telling failures apart.
// Twilio answers HTTP 400 for both "that is not a phone number" and "your
// account is not upgraded", and those are completely different conversations
// with an owner — one is a typo in a form, the other is a billing decision.

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

async function main() {
  console.log("\n1. URLs, as Twilio's docs actually specify them");
  {
    // The version string looks like a typo every time somebody reads it, and
    // "fixing" it would break every call.
    check("the base URL keeps the 2010-04-01 version string", TWILIO_API_BASE, "https://api.twilio.com/2010-04-01");
    assert("and it is HTTPS", TWILIO_API_BASE.startsWith("https://"), TWILIO_API_BASE);
    check("messages go to the account's own Messages.json",
      messagesUrl("AC123"), "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json");
    check("the account probe is the account resource",
      accountUrl("AC123"), "https://api.twilio.com/2010-04-01/Accounts/AC123.json");
    // An account SID comes from stored credentials, but a path built by
    // concatenation is worth encoding anyway — the cost is nothing and the
    // failure mode is a traversal.
    assert("the SID is URL-encoded", messagesUrl("AC/../x").includes("AC%2F..%2Fx"), messagesUrl("AC/../x"));
  }

  console.log("\n2. Phone numbers");
  {
    assert("a real E.164 number passes", isE164("+15551234567"));
    assert("so does a long international one", isE164("+442071234567"));
    assert("no plus is not E.164", !isE164("15551234567"));
    assert("a country code cannot start with zero", !isE164("+05551234567"));
    assert("letters are not a phone number", !isE164("+1555CALLME"));
    assert("empty is not a phone number", !isE164(""));
    assert("spaces inside are not E.164", !isE164("+1 555 123 4567"));

    // How people actually type numbers.
    check("brackets and dashes are cleaned up", toE164("+1 (555) 123-4567"), "+15551234567");
    check("dots too", toE164("+1.555.123.4567"), "+15551234567");
    check("a 00 international prefix means the same as +", toE164("00442071234567"), "+442071234567");

    // ============ THE ONE THAT MATTERS ====================================
    // A national number with no country code is REFUSED, not repaired.
    // Assuming +1 would send a customer's order notification to whoever holds
    // that number in whichever country the guess landed in.
    check("a number with no country code is refused, not guessed at", toE164("5551234567"), null);
    check("and so is a local one with punctuation", toE164("(555) 123-4567"), null);
    check("blank is refused", toE164("   "), null);
  }

  console.log("\n3. Failures are told apart by Twilio's code, not the HTTP status");
  {
    const auth = classifyFailure(401, { code: 20003, message: "Authenticate" });
    check("20003 is an auth failure", auth.kind, "auth");
    check("carrying Twilio's own words", auth.detail, "Authenticate");

    const limited = classifyFailure(429, { code: 20429, message: "Too many requests" });
    check("20429 is a rate limit", limited.kind, "rate_limit");

    // ============ BOTH OF THESE ARE HTTP 400 ==============================
    // A classifier keyed on the HTTP status could not tell them apart, and the
    // owner-facing consequence is completely different: one is a typo they can
    // fix in a form, the other is a Twilio account they have to upgrade.
    const badNumber = classifyFailure(400, { code: 21211, message: "Invalid 'To' Phone Number" });
    const notUpgraded = classifyFailure(400, { code: 21608, message: "Upgrade to reach unverified numbers" });
    check("21211 is a bad recipient", badNumber.kind, "bad_recipient");
    check("21608 is an account permission problem", notUpgraded.kind, "not_permitted");
    assert("and the two HTTP 400s are NOT the same kind", badNumber.kind !== notUpgraded.kind);

    // An unverified toll-free number is blocked outright, and it is not the
    // owner's phone that is wrong.
    check("30032 is a permission problem too", classifyFailure(400, { code: 30032, message: "unverified" }).kind, "not_permitted");

    // A wrong Account SID with a valid key is a 404 at Twilio and a credentials
    // problem from where the owner is standing.
    check("20404 reads as an auth problem to the owner", classifyFailure(404, { code: 20404, message: "Not Found" }).kind, "auth");

    // No code at all — the status is the only thing left.
    check("a bare 401 is still auth", classifyFailure(401, null).kind, "auth");
    check("a bare 429 is still a rate limit", classifyFailure(429, {}).kind, "rate_limit");
    check("anything else is a provider error", classifyFailure(500, { message: "boom" }).kind, "provider");
    assert("and is never swallowed", classifyFailure(500, { message: "boom" }).detail === "boom");

    // The kinds are genuinely distinct — a mapping that collapsed them would
    // still pass each assertion above on its own.
    const kinds = new Set([auth.kind, limited.kind, badNumber.kind, notUpgraded.kind, classifyFailure(500, {}).kind]);
    check("all five kinds are distinguishable", kinds.size, 5);
  }

  console.log("\n4. A trial account is described honestly");
  {
    // ============ THE QUIET LIE THIS PREVENTS =============================
    // A trial account authenticates perfectly. Reporting that as "connected"
    // without qualification would tell an owner their customers will be
    // notified, when Twilio will refuse every message to anyone the owner has
    // not personally verified.
    const trial = accountReadiness({ sid: "AC1", friendlyName: "My Trial", type: "Trial", status: "active" });
    check("a trial account cannot reach customers", trial.canSendToCustomers, false);
    assert("and is told it is a trial", /trial/i.test(trial.summary), trial.summary);
    assert("with the way out named", /upgrad/i.test(trial.summary), trial.summary);

    const full = accountReadiness({ sid: "AC1", friendlyName: "Cubit & Coil", type: "Full", status: "active" });
    check("a full account can", full.canSendToCustomers, true);
    assert("and is named", full.summary.includes("Cubit & Coil"), full.summary);

    const suspended = accountReadiness({ sid: "AC1", friendlyName: "x", type: "Full", status: "suspended" });
    check("a suspended account cannot send", suspended.canSendToCustomers, false);
    assert("and suspension is said out loud, not called a trial",
      /suspend/i.test(suspended.summary) && !/trial/i.test(suspended.summary), suspended.summary);

    const closed = accountReadiness({ sid: "AC1", friendlyName: "x", type: "Full", status: "closed" });
    check("a closed account cannot send", closed.canSendToCustomers, false);

    // Suspension outranks type: a suspended trial is suspended.
    const both = accountReadiness({ sid: "AC1", friendlyName: "x", type: "Trial", status: "suspended" });
    assert("a suspended trial reports the suspension", /suspend/i.test(both.summary), both.summary);
  }

  console.log("\n5. Reading Twilio's responses");
  {
    const account = readAccount({ sid: "AC9", friendly_name: "Shop", type: "Full", status: "active" });
    check("the account SID comes through", account?.sid, "AC9");
    check("and its type", account?.type, "Full");
    // NEVER THROWS ON SHAPE.
    check("a response with no SID is not an account", readAccount({ friendly_name: "x" }), null);
    check("neither is null", readAccount(null), null);
    check("nor a string", readAccount("nope"), null);

    const sent = readSentMessage({ sid: "SM1", status: "queued", num_segments: "2" });
    check("a sent message's SID comes through", sent?.sid, "SM1");
    check("and its status", sent?.status, "queued");
    // Twilio sends this as a STRING. Left as one it becomes "2" + 1 === "21"
    // somewhere downstream.
    check("num_segments is a number, not the string Twilio sent", sent?.segments, 2);
    assert("and really is a number", typeof sent?.segments === "number");
    check("a response with no SID is not a message", readSentMessage({ status: "queued" }), null);
  }

  console.log("\n6. The message body");
  {
    const form = messageForm({ to: "+15551234567", from: "+15559876543", body: "Your order shipped" });
    check("To is set", form.get("To"), "+15551234567");
    check("From is set for a phone number", form.get("From"), "+15559876543");
    check("and the body", form.get("Body"), "Your order shipped");
    assert("no MessagingServiceSid when sending from a number", !form.has("MessagingServiceSid"));

    // A Messaging Service SID is the other valid shape, and Twilio wants it
    // under a different key.
    const service = messageForm({ to: "+15551234567", from: "MG0123", body: "hi" });
    check("an MG SID goes in MessagingServiceSid", service.get("MessagingServiceSid"), "MG0123");
    assert("and NOT in From — Twilio would reject it there", !service.has("From"));

    // Form-encoded, not JSON. Twilio refuses a JSON body outright.
    assert("it encodes as a form, and the + survives",
      form.toString().includes("To=%2B15551234567"), form.toString());
  }

  console.log("\n7. Segments, because segments are money");
  {
    check("an empty body costs nothing", segmentsFor(""), 0);
    check("a short message is one segment", segmentsFor("Your order shipped"), 1);
    check("exactly 160 GSM characters is still one", segmentsFor("a".repeat(160)), 1);
    // ONE CHARACTER OVER AND IT COSTS DOUBLE.
    check("161 is two", segmentsFor("a".repeat(161)), 2);
    check("and the split is 153 per segment, not 160", segmentsFor("a".repeat(306)), 2);
    check("307 needs a third", segmentsFor("a".repeat(307)), 3);

    // ============ WHAT IS AND ISN'T GSM ==================================
    //
    // THIS PAIR CAUGHT A REAL BUG. The first implementation used "is it
    // Latin-1" as a stand-in for "is it GSM", and the two are not the same set
    // in either direction. Accented vowels ARE in GSM 03.38, so ordinary
    // Spanish or French copy stays at 160 — the approximation called it UCS-2
    // and reported double the real cost. The assertion below disagreed with the
    // implementation and the assertion was right.
    check("accented vowels are GSM, so 160 of them is still one segment",
      segmentsFor("é".repeat(160)), 1);
    check("and 161 is two, not a UCS-2 boundary at 70", segmentsFor("é".repeat(161)), 2);

    // The other direction: Latin-1 but NOT GSM. The old approximation counted
    // these as GSM and would have reported HALF the real cost.
    check("y-diaeresis is Latin-1 but not GSM, so 70 is the limit",
      segmentsFor("ÿ".repeat(70)), 1);
    check("and 71 needs a second segment", segmentsFor("ÿ".repeat(71)), 2);

    // The realistic one: a curly apostrophe pasted from a word processor,
    // invisible in review, switching an entire message to UCS-2.
    check("one curly apostrophe drops the whole message to 70",
      segmentsFor("Your order’s on its way" + "a".repeat(60)), 2);
    check("while the straight-quote version fits in one",
      segmentsFor("Your order's on its way" + "a".repeat(60)), 1);

    // Extension-table characters cost two each, so 80 brackets is 160.
    check("square brackets cost two characters each", segmentsFor("[".repeat(80)), 1);
    check("and 81 of them tips over", segmentsFor("[".repeat(81)), 2);
    assert("one emoji in a long ASCII message more than doubles the cost",
      segmentsFor("a".repeat(100) + "🎉") > segmentsFor("a".repeat(101)),
      `${segmentsFor("a".repeat(100) + "🎉")} vs ${segmentsFor("a".repeat(101))}`);
    // An emoji outside the BMP is a surrogate pair and genuinely occupies two.
    check("an astral emoji counts as two units", segmentsFor("🎉".repeat(35)), 1);
    check("and 36 of them tip into a second segment", segmentsFor("🎉".repeat(36)), 2);
  }

  console.log("\n8. The connector, as the framework sees it");
  {
    check("it is registered under its provider", getConnector("TWILIO").provider, "TWILIO");
    check("with the connector object itself", getConnector("TWILIO") === twilioConnector, true);

    const capabilities = twilioConnector.capabilities;
    check("it authenticates with an API key", capabilities.authKind, "api_key");
    // THE EXCEPTION MUST BE JUSTIFIED, not merely declared — and the
    // justification has to survive the fact that Twilio DOES have OAuth now.
    assert("and the exception is justified", (capabilities.apiKeyExceptionReason ?? "").length > 40);
    assert("acknowledging that Twilio's OAuth exists rather than claiming it doesn't",
      /oauth/i.test(capabilities.apiKeyExceptionReason ?? ""), capabilities.apiKeyExceptionReason);
    check("an api_key connector requests no scopes", capabilities.scopes, []);

    // NOTHING IS READ. Twilio is a way to say something, not a thing to learn
    // from — and the contract allows a connector with no business data.
    check("it reads no business data", capabilities.reads, []);
    check("and implements no sync at all", typeof twilioConnector.sync, "undefined");
    assert("which is consistent: a connector that reads nothing must not claim a sync",
      capabilities.reads.length === 0 && twilioConnector.sync === undefined);

    // IT SPENDS MONEY. That must be declared, the way EasyPost's label purchase is.
    assert("it declares that it spends the merchant's money",
      capabilities.writes.some((w) => /spend|money|balance/i.test(w)), capabilities.writes.join("; "));

    // HONEST FALSE. Genesis cannot delete a key it did not mint.
    check("it does not claim to revoke anything on disconnect", capabilities.revokesOnDisconnect, false);
    check("an API key does not expire on its own", capabilities.tokenLifetime, "permanent");

    // Unlike every OAuth connector here, this one needs no platform credentials,
    // so it is never "unavailable" for want of an environment variable.
    check("it needs nothing from the environment", twilioConnector.configured?.(), true);
  }

  console.log("\n9. The connect form asks for what Twilio actually needs");
  {
    const result = await twilioConnector.connect("store_1", "user_1");
    check("with no params it asks for input", result.kind, "form");
    if (result.kind !== "form") throw new Error("expected a form");

    const names = result.fields.map((f) => f.name);
    check("it asks for the four things a send needs",
      [...names].sort(), ["accountSid", "apiKeySecret", "apiKeySid", "fromNumber"]);

    // ============ THE SECRET IS A PASSWORD FIELD =========================
    // The only field that is actually a credential is the only one masked. An
    // Account SID and an API key SID are identifiers, not secrets.
    const secret = result.fields.find((f) => f.name === "apiKeySecret")!;
    check("the secret is masked", secret.type, "password");
    assert("and it is the ONLY masked field",
      result.fields.filter((f) => f.type === "password").length === 1,
      JSON.stringify(result.fields.map((f) => [f.name, f.type])));

    // It asks for an API KEY, not the account's master Auth Token — Twilio's
    // own preference, and the one the owner can revoke without collateral.
    assert("it asks for an API key rather than the master Auth Token",
      names.includes("apiKeySid") && !names.includes("authToken"), names.join(", "));
    assert("and says where to find it", /API key/i.test(result.fields.find((f) => f.name === "apiKeySid")!.label));
  }

  console.log("\n10. The catalog entry is now real");
  {
    const entry = CONNECTOR_CATALOG.find((e) => e.id === "twilio");
    assert("Twilio is in the catalog", entry !== undefined);
    check("no longer as coming-soon", entry?.connector === null, false);
    check("wired to its provider", entry?.provider, "TWILIO");
    check("and to the connector itself", entry?.connector === twilioConnector, true);
    check("declaring api_key auth, matching the connector", entry?.authMethod, twilioConnector.capabilities.authKind);

    // THE DESCRIPTION MUST NAME THE EXTERNAL GATE. An owner who connects
    // expecting to text customers, and then meets A2P registration, was misled
    // by this string.
    assert("the description names the A2P gate", /A2P/i.test(entry?.description ?? ""), entry?.description);
    assert("and describes the capability, not Twilio's product catalogue",
      /text|sms|order/i.test(entry?.description ?? "") && !/voice|video/i.test(entry?.description ?? ""),
      entry?.description);

    // Every remaining coming-soon entry must still be honest about being one.
    const comingSoon = CONNECTOR_CATALOG.filter((e) => e.connector === null);
    assert("the other unbuilt entries still declare no provider",
      comingSoon.every((e) => e.provider === null), comingSoon.map((e) => e.id).join(", "));
    check("and there are five of them left", comingSoon.length, 5);
  }

  console.log("\n11. No secret reaches a client bundle");
  {
    const fs = await import("fs");
    const protocol = fs.readFileSync("lib/integrations/twilioProtocol.ts", "utf8");
    const connector = fs.readFileSync("lib/integrations/twilio.ts", "utf8");

    // The pure half holds no credential handling at all, which is what makes it
    // safe to import from anywhere and safe to test without an account.
    assert("the protocol never touches a secret",
      !/apiKeySecret|authToken|Authorization/i.test(protocol));
    assert("and reads no environment", !protocol.includes("process.env"));

    // Credentials come from the encrypted store, never from the environment and
    // never from a literal.
    assert("the connector stores credentials encrypted", connector.includes("encryptCredentials"));
    assert("and reads them back through decryptCredentials", connector.includes("decryptCredentials"));
    assert("no credential is hard-coded",
      !/(accountSid|apiKeySid|apiKeySecret)\s*[:=]\s*["'](AC|SK)[A-Za-z0-9]{8}/.test(connector));
    assert("the connector reads no Twilio environment variable",
      !/process\.env\.TWILIO/.test(connector),
      "these are the merchant's own credentials, not the platform's");

    // "use client" would make this file's imports part of a browser bundle.
    assert("neither file is a client component",
      !protocol.includes('"use client"') && !connector.includes('"use client"'));
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed`);
  if (failures === 0) {
    console.log(
      "\nNOT verified here (no Twilio account exists): the live REST call, the real\n" +
        "error codes Twilio returns in practice, and A2P 10DLC registration — see\n" +
        "TWILIO_REQUIREMENTS_VERIFIED.md §5 for what is blocked on whom.\n",
    );
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
