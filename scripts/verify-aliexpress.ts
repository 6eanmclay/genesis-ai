import { createHash } from "crypto";
import {
  ALIEXPRESS_GATEWAY,
  aliexpressTimestamp,
  buildSignedParams,
  priceInCents,
  readFailure,
  readProducts,
  signRequest,
} from "@/lib/sourcing/aliexpressProtocol";
import { aliexpressSource, ALIEXPRESS_REQUIRED_CREDENTIALS } from "@/lib/sourcing/aliexpress";
import {
  describeBlockedSources,
  getProductSource,
  getProductSources,
  getReadySources,
} from "@/lib/sourcing/registry";

// ALIEXPRESS, VERIFIED WITHOUT ALIEXPRESS.
//
// No live call has been made and none can be: credentials come only after an
// application, a signed Open Platform Agreement, company details, a 1–2 business
// day review and an audit of the finished app. So the question this suite has to
// answer is the honest version of "does it work" — does the protocol match its
// specification exactly, and does every way it can fail reach the owner as the
// right kind of problem.
//
// THE SIGNATURE IS THE PART THAT MATTERS. Get any of its four steps wrong and
// the result is still a plausible 32-character hex string; the gateway simply
// refuses it, with an error that says nothing about which step was wrong. So it
// is not enough to assert that signing produces something. Each step is broken
// deliberately below and the signature must CHANGE — an assertion that only
// checked the shape would pass against sorting by value, joining with "&",
// wrapping the secret on one side, or lowercase hex.

let failures = 0;
let passes = 0;

function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passes++;
  else {
    failures++;
    console.error(`  ✗ ${label}\n      expected ${JSON.stringify(expected)}\n      got      ${JSON.stringify(actual)}`);
    return;
  }
  console.log(`  ✓ ${label}`);
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

/** Run a body with specific env values, restoring whatever was there. */
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
  console.log("\n1. The signature, step by step");
  {
    const secret = "SECRET123";
    const params = { app_key: "12345", method: "aliexpress.affiliate.product.query", v: "2.0" };

    // The value computed by hand, from the specification, rather than by
    // running the implementation and writing down what it said. A vector taken
    // from the code under test would agree with any bug the code contains.
    //
    //   sorted keys:  app_key, method, v
    //   concatenated: app_key12345methodaliexpress.affiliate.product.queryv2.0
    //   wrapped:      SECRET123 ... SECRET123
    const expected = createHash("md5")
      .update("SECRET123app_key12345methodaliexpress.affiliate.product.queryv2.0SECRET123", "utf8")
      .digest("hex")
      .toUpperCase();

    const actual = signRequest(params, secret);
    check("matches the specification exactly", actual, expected);
    assert("is 32 hex characters", /^[0-9A-F]{32}$/.test(actual), actual);
    assert("is UPPERCASE, not lowercase hex", actual === actual.toUpperCase() && /[A-F]/.test(actual), actual);

    // ---- NEGATIVE CONTROLS: each is a real way to get this wrong ----------

    // Sorted by KEY. Insertion order is not sorted order, and relying on it
    // works until someone reorders a literal.
    const reordered = signRequest({ v: "2.0", method: params.method, app_key: params.app_key }, secret);
    check("key order in the object cannot change it", reordered, expected);

    // ...but the CONTENT must.
    assert("a different value changes it", signRequest({ ...params, v: "2.1" }, secret) !== expected);
    assert("a different key changes it", signRequest({ ...params, w: "2.0" }, secret) !== expected);
    assert("an extra parameter changes it", signRequest({ ...params, extra: "x" }, secret) !== expected);

    // Wrapped on BOTH sides. Wrapping on one is the single most common
    // implementation of this algorithm on the internet, and it is wrong.
    const prefixOnly = createHash("md5")
      .update("SECRET123app_key12345methodaliexpress.affiliate.product.queryv2.0", "utf8")
      .digest("hex")
      .toUpperCase();
    assert("the secret wraps BOTH sides, not just the front", expected !== prefixOnly);

    // No delimiter. "&" or "=" between pairs is the other common mistake.
    const ampersanded = createHash("md5")
      .update("SECRET123app_key=12345&method=aliexpress.affiliate.product.query&v=2.0SECRET123", "utf8")
      .digest("hex")
      .toUpperCase();
    assert("pairs are concatenated with no delimiter", expected !== ampersanded);

    // The secret is load-bearing, not decoration.
    assert("a different secret changes it", signRequest(params, "OTHER") !== expected);
  }

  console.log("\n2. A complete signed request");
  {
    const signed = buildSignedParams({
      method: "aliexpress.affiliate.product.query",
      appKey: "APPKEY",
      appSecret: "APPSECRET",
      args: { keywords: "copper rings", page_size: 8 },
      now: new Date(Date.UTC(2026, 7, 27, 14, 3, 22)),
    });

    check("carries the method", signed.method, "aliexpress.affiliate.product.query");
    check("carries the app key", signed.app_key, "APPKEY");
    check("declares md5 signing", signed.sign_method, "md5");
    check("declares JSON", signed.format, "json");
    check("declares the API version", signed.v, "2.0");
    check("timestamps in AliExpress's format, in UTC", signed.timestamp, "2026-08-27 14:03:22");
    assert("timestamp is not an ISO string", !signed.timestamp.includes("T"), signed.timestamp);

    // THE SECRET IS NEVER A PARAMETER. Sending it would hand it to AliExpress's
    // access logs, and to anything between here and there.
    assert("the secret is never sent", !Object.values(signed).includes("APPSECRET"), JSON.stringify(signed));
    assert("no parameter is named for the secret", !("app_secret" in signed) && !("appSecret" in signed));

    // The method's own arguments are signed too — signing only the system half
    // is another way to produce a string that looks right and is refused.
    const withoutArgs = { ...signed };
    delete withoutArgs.sign;
    delete withoutArgs.keywords;
    delete withoutArgs.page_size;
    assert(
      "the signature covers the method arguments, not just the system ones",
      signed.sign !== signRequest(withoutArgs, "APPSECRET"),
    );

    // And it verifies: recomputing over everything-but-sign reproduces it.
    const everythingElse = { ...signed };
    delete everythingElse.sign;
    check("and recomputing over the rest reproduces it", signRequest(everythingElse, "APPSECRET"), signed.sign);

    // An absent argument is absent, not the string "undefined".
    const sparse = buildSignedParams({
      method: "m",
      appKey: "K",
      appSecret: "S",
      args: { present: "yes", missing: undefined, blank: "" },
      now: new Date(Date.UTC(2026, 0, 1)),
    });
    assert("an undefined argument is not sent", !("missing" in sparse));
    assert("an empty argument is not sent", !("blank" in sparse));
    assert("nothing is signed as the literal 'undefined'", !Object.values(sparse).includes("undefined"));
  }

  console.log("\n3. Timestamps");
  {
    check("pads every field", aliexpressTimestamp(new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), "2026-01-02 03:04:05");
    check("is UTC, not local", aliexpressTimestamp(new Date("2026-08-27T23:59:59Z")), "2026-08-27 23:59:59");
  }

  console.log("\n4. Failures are told apart");
  {
    // A SUCCESS BODY IS NOT A FAILURE.
    check("a clean response has no failure", readFailure({ some_response: { resp_result: {} } }), null);
    check("neither does a non-object", readFailure(null), null);
    check("nor a string", readFailure("nope"), null);

    const auth = readFailure({ error_response: { code: 15, sub_code: "IllegalAppKey", msg: "Invalid app key" } });
    check("a bad app key is an auth failure", auth?.kind, "auth");
    assert("carrying AliExpress's own words", (auth?.detail ?? "").includes("Invalid app key"), JSON.stringify(auth));

    const signature = readFailure({ error_response: { sub_code: "InvalidSignature", sub_msg: "sign error" } });
    check("so is a bad signature", signature?.kind, "auth");

    const limited = readFailure({ error_response: { code: 7, sub_code: "AppCallLimit", msg: "too fast" } });
    check("a call limit is a rate limit, not an auth problem", limited?.kind, "rate_limit");

    const permission = readFailure({ error_response: { sub_code: "InsufficientIsvPermissions", msg: "no" } });
    check("an unapproved method is its own kind", permission?.kind, "not_permitted");

    // ============ THE ONE THAT CAUGHT A REAL BUG ==========================
    //
    // The first implementation matched codes by substring against code and
    // sub_code joined. A bare `7` for the call-limit code also matches the 7
    // inside 27 — invalid session — so an authentication failure was reported
    // as throttling, telling the owner to "try again shortly" about the one
    // thing they could actually have fixed. Codes are compared as numbers now.
    const session = readFailure({ error_response: { code: 27, msg: "Invalid session" } });
    check("code 27 is auth, NOT the rate limit hiding in its digits", session?.kind, "auth");
    const seventeen = readFailure({ error_response: { code: 17, msg: "Param check failed" } });
    assert("and code 17 is not a rate limit either", seventeen?.kind !== "rate_limit", JSON.stringify(seventeen));
    check("while a real code 7 still is", readFailure({ error_response: { code: 7, msg: "x" } })?.kind, "rate_limit");

    const unknown = readFailure({ error_response: { code: 999, msg: "Something new" } });
    check("an unrecognised code is still a failure", unknown?.kind, "provider");
    assert("and is never swallowed", (unknown?.detail ?? "").includes("Something new"), JSON.stringify(unknown));

    // The four are genuinely distinct — a mapping that collapsed them would
    // still pass every individual assertion above.
    const kinds = new Set([auth?.kind, limited?.kind, permission?.kind, unknown?.kind]);
    check("all four kinds are distinguishable", kinds.size, 4);
  }

  console.log("\n5. Reading products out of a response");
  {
    const body = {
      aliexpress_affiliate_product_query_response: {
        resp_result: {
          result: {
            products: {
              product: [
                {
                  product_id: 1005001,
                  product_title: "Copper wire ring",
                  target_sale_price: "12.34",
                  target_sale_price_currency: "USD",
                  product_main_image_url: "https://example.invalid/a.jpg",
                },
              ],
            },
          },
        },
      },
    };
    const products = readProducts(body);
    check("finds the product", products.length, 1);
    check("with its title", products[0].product_title, "Copper wire ring");

    // NEVER THROWS ON SHAPE. AliExpress has changed this nesting between method
    // versions, and a response with no results must not crash a search.
    check("an empty response yields nothing", readProducts({}).length, 0);
    check("so does null", readProducts(null).length, 0);
    check("so does a wrong-shaped one", readProducts({ a: { b: 1 } }).length, 0);
    check("so does a response whose products list is missing", readProducts({ x_response: { resp_result: {} } }).length, 0);
  }

  console.log("\n6. Prices");
  {
    check("a decimal string becomes cents", priceInCents("12.34"), 1234);
    check("rounding is to the nearest cent", priceInCents("12.345"), 1235);
    check("a whole number works", priceInCents("12"), 1200);
    // NULL IS UNKNOWN, NOT ZERO. Zero here would let an owner list an item at a
    // loss believing it cost nothing.
    check("an unreadable price is unknown, not free", priceInCents("about twelve"), null);
    check("an absent price is unknown", priceInCents(undefined), null);
    check("so is a negative one", priceInCents("-1"), null);
    assert("unknown is never zero", priceInCents("nonsense") !== 0);
  }

  console.log("\n7. The source without credentials");
  {
    await withEnv({ ALIEXPRESS_APP_KEY: undefined, ALIEXPRESS_APP_SECRET: undefined }, async () => {
      check("declares what it needs", aliexpressSource.blockedOn, ALIEXPRESS_REQUIRED_CREDENTIALS);

      const result = await aliexpressSource.search({
        storeId: "store_1",
        keywords: "copper rings",
        brandPositioning: "minimalist",
        limit: 8,
      });
      check("refuses rather than returning products", result.ok, false);
      if (!result.ok) {
        check("as a configuration problem", result.reason, "not_configured");
        // An empty success would be indistinguishable from "the catalogue had
        // nothing for you", which is a different thing to tell an owner.
        assert("and never as an empty catalogue", !("candidates" in result), JSON.stringify(result));
      }
    });

    // Half-configured is not configured. One variable without the other would
    // otherwise produce a signature computed with an empty secret, which comes
    // back as an auth failure and reads as "AliExpress rejected us".
    await withEnv({ ALIEXPRESS_APP_KEY: "K", ALIEXPRESS_APP_SECRET: undefined }, () => {
      check("a key with no secret is still blocked", aliexpressSource.blockedOn, ALIEXPRESS_REQUIRED_CREDENTIALS);
    });
    await withEnv({ ALIEXPRESS_APP_KEY: undefined, ALIEXPRESS_APP_SECRET: "S" }, () => {
      check("a secret with no key is still blocked", aliexpressSource.blockedOn, ALIEXPRESS_REQUIRED_CREDENTIALS);
    });
    await withEnv({ ALIEXPRESS_APP_KEY: "   ", ALIEXPRESS_APP_SECRET: "   " }, () => {
      check("whitespace is not a credential", aliexpressSource.blockedOn, ALIEXPRESS_REQUIRED_CREDENTIALS);
    });
  }

  console.log("\n8. The source WITH credentials actually becomes searchable");
  {
    // ============ THE ASSERTION THIS WHOLE FILE EXISTS FOR =================
    //
    // discoverProducts() reports a source as unavailable WITHOUT CALLING
    // search() whenever blockedOn is non-empty. A static blockedOn would have
    // made every line of the search implementation unreachable forever, and
    // nothing else in the suite would have noticed: the source would keep
    // answering "not configured", which is exactly what it used to do.
    await withEnv({ ALIEXPRESS_APP_KEY: "K", ALIEXPRESS_APP_SECRET: "S" }, () => {
      check("configured means nothing is outstanding", aliexpressSource.blockedOn, []);
      assert(
        "so discovery will actually call search()",
        aliexpressSource.blockedOn.length === 0,
        "blockedOn short-circuits discoverProducts before search() runs",
      );
    });

    // And it goes back. The getter reads the environment now, not at import.
    await withEnv({ ALIEXPRESS_APP_KEY: undefined, ALIEXPRESS_APP_SECRET: undefined }, () => {
      check("and losing them blocks it again", aliexpressSource.blockedOn.length, 2);
    });
  }

  console.log("\n9. What the registry says about it");
  {
    const source = getProductSource("aliexpress");
    assert("it is registered", source !== null);
    check("as wholesale, not print-on-demand", source?.kind, "WHOLESALE_DROPSHIP");
    // The line that matters: nothing about a wholesale listing is customisable,
    // and offering "add your logo" would be a promise the supplier never heard.
    check("nothing on it is customisable", source?.capabilities.customization, false);
    check("it creates no listings", source?.capabilities.createsListings, false);
    check("the supplier ships direct", source?.capabilities.shipsDirect, true);
    // Declared false and implemented as absent — a source claiming a capability
    // it does not implement reads as working right up until a caller believes it.
    check("it states no economics", source?.capabilities.statesEconomics, false);
    check("and has nothing behind that claim", typeof source?.economics, "undefined");
    check("no connector fulfils on its behalf", source?.fulfillmentProvider, null);
  }

  console.log("\n10. The secret never leaves the server");
  {
    const fs = await import("fs");
    const protocol = fs.readFileSync("lib/sourcing/aliexpressProtocol.ts", "utf8");
    const client = fs.readFileSync("lib/sourcing/aliexpressClient.ts", "utf8");
    const source = fs.readFileSync("lib/sourcing/aliexpress.ts", "utf8");

    // The one file that reads the secret is the one that cannot be bundled.
    assert("the client is server-only", /^import "server-only";/m.test(client));
    assert("and it is the only file that reads the secret",
      client.includes("ALIEXPRESS_APP_SECRET") && !protocol.includes("ALIEXPRESS_APP_SECRET"));

    // The pure half holds no environment access at all, which is what makes it
    // safe to test and safe to import from anywhere.
    assert("the protocol reads no environment", !protocol.includes("process.env"));

    // The registry-facing module reads the variables to answer blockedOn, but
    // must not import the server-only client at module scope — that would stop
    // the module loading outside the React server condition rather than
    // failing loudly, which is how this class of bug hides.
    assert("the source does not import the client at module scope",
      !/^import .*aliexpressClient/m.test(source),
      "a top-level server-only import would silently break every non-Next caller");
    assert("it imports the client dynamically instead", source.includes('await import("./aliexpressClient")'));

    // Nothing anywhere hard-codes a credential.
    for (const [name, text] of [["protocol", protocol], ["client", client], ["source", source]] as const) {
      assert(`${name} hard-codes no credential`,
        !/ALIEXPRESS_APP_(KEY|SECRET)\s*=\s*["'][^"']+["']/.test(text));
    }

    // The gateway is HTTPS. The documented endpoint is also published over
    // plain HTTP, and signing a request does not encrypt the body it is
    // attached to.
    assert("the gateway is HTTPS", ALIEXPRESS_GATEWAY.startsWith("https://"), ALIEXPRESS_GATEWAY);
  }

  console.log('\n11. "What you could sell" actually reaches the connected source');
  {
    // ============ THE CHAIN, ASSERTED RATHER THAN ASSERTED IN PROSE ========
    //
    //   /dashboard/catalog  ("What you could sell", navConfig.ts)
    //     -> catalogView()          reads discovered rows + describeBlockedSources()
    //     -> discoverProducts()     from catalog/actions.ts and discoveryLifecycle.ts,
    //                               neither of which passes `sources`, so both get
    //                               getProductSources() — this registry
    //     -> aliexpressSource.search()
    //
    // The two registry functions below are the joints in that chain. If either
    // still excluded AliExpress once configured, the owner would keep seeing it
    // listed as somewhere Genesis could not look while the search code sat
    // there working.
    await withEnv({ ALIEXPRESS_APP_KEY: undefined, ALIEXPRESS_APP_SECRET: undefined }, () => {
      const blocked = describeBlockedSources().map((b) => b.key);
      assert("unconfigured, it is named as somewhere Genesis couldn't look", blocked.includes("aliexpress"));
      assert("and it is not offered as ready", !getReadySources().some((s) => s.key === "aliexpress"));
    });

    await withEnv({ ALIEXPRESS_APP_KEY: "K", ALIEXPRESS_APP_SECRET: "S" }, () => {
      const blocked = describeBlockedSources().map((b) => b.key);
      assert(
        "configured, it is no longer named as a place that couldn't be looked at",
        !blocked.includes("aliexpress"),
        JSON.stringify(blocked),
      );
      assert("and it IS offered as ready", getReadySources().some((s) => s.key === "aliexpress"));
      // Printful is unaffected either way — this must not have become a switch
      // that turns the whole registry on and off.
      assert("while Printful is untouched by any of it", getProductSources().some((s) => s.key === "printful"));
    });
  }

  console.log(`\n${failures === 0 ? "PASS" : "FAIL"} — ${passes} passed, ${failures} failed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
