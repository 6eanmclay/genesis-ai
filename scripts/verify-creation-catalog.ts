import { readFileSync } from "fs";
import { join } from "path";
import {
  printfulUrl,
  printfulHeaders,
  printfulFailure,
  withSellingRegion,
  isStoreScoped,
  PRINTFUL_MAX_LIMIT,
  PRINTFUL_SELLING_REGION,
  PRINTFUL_V2_BASE,
} from "@/lib/creation/printfulRequest";
import { printfulCreationProvider } from "@/lib/creation/printfulCreation";
import { portalItems } from "@/lib/creation/creatables";

// WHAT THE CATALOGUE CALL SENDS, AND WHAT IT SAYS WHEN IT FAILS:
//
//   npx tsx scripts/verify-creation-catalog.ts
//
// ============ WHY THIS SUITE EXISTS =====================================
//
// Sean, on the first real run of the Creation Station against a live Printful
// account: "Printful is connected, but the catalogue could not be read just
// now. It said: Printful creation.catalog failed (400)."
//
// That sentence is itself a defect. Printful sends a body with every 400 saying
// what it objected to, and the call site threw the body away and kept the
// number — so the one fact that diagnoses the problem was read by nobody, and
// the owner was shown a code they can do nothing with.
//
// ============ WHY IT WENT UNNOTICED SO LONG =============================
//
// This is the only Printful v2 caller in the codebase; everything else talks to
// v1 and has run against real accounts since onboarding v2. And it had never
// once executed against a live connection, because the OAuth handoff was broken
// from 19 August until 931de79. Sean's 400 was its first real run.
//
// It was also unreachable by any suite: the request was built inside a closure
// in a `server-only` module. That is why printfulRequest.ts now exists.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
/** Comments are prose, not code — a claim about source must not match a note. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main() {
  // ======================================================================
  console.log("\n=== 1. The request matches Printful's published v2 spec ===\n");
  // ======================================================================
  //
  // developers.printful.com, v2 catalog products:
  //   GET https://api.printful.com/v2/catalog-products
  //   limit  integer [1..100], default 20
  eq("the v2 base is Printful's own", PRINTFUL_V2_BASE, "https://api.printful.com/v2");
  eq("a catalogue path becomes the documented URL",
    printfulUrl("/catalog-products?limit=100"),
    "https://api.printful.com/v2/catalog-products?limit=100");
  eq("and the documented ceiling on limit is recorded", PRINTFUL_MAX_LIMIT, 100);

  // WHAT WE ACTUALLY ASK FOR, read off the provider rather than restated —
  // an assertion that repeats the constant it is checking proves nothing.
  const sent: string[] = [];
  const provider = printfulCreationProvider(async (_storeId, _operation, path) => {
    sent.push(path);
    return { data: [] };
  });
  await provider.listBlanks({ storeId: "store_harness" });
  eq("one catalogue request goes out", sent.length, 1);
  assert("against the catalogue endpoint", sent[0].startsWith("/catalog-products?"), sent[0]);

  const limit = Number(new URLSearchParams(sent[0].split("?")[1]).get("limit"));
  assert("with a limit Printful documents as valid",
    Number.isInteger(limit) && limit >= 1 && limit <= PRINTFUL_MAX_LIMIT, String(limit));

  // ======================================================================
  console.log("\n=== 1b. The selling region, per endpoint ===\n");
  // ======================================================================
  //
  // Printful, once the body was finally surfacing:
  //
  //     Printful creation.catalog failed (400): Selling region not found
  //
  // The parameter is documented as optional with a default of "worldwide" and
  // is not optional in practice.
  //
  // ============ AND THE REFERENCE IS WRONG ABOUT WHERE ==================
  //
  // Printful's v2 reference lists it on /catalog-products and
  // /catalog-products/{id} and NOT on /catalog-products/{id}/catalog-variants.
  // This suite encoded that, and asserted the variants call must NOT send it.
  //
  // The live API disagreed. With the store header gone the first two calls
  // started working, and the third — alone in not sending the parameter —
  // failed with the same message, now carrying its own request:
  //
  //     Printful creation.variants failed (400): Selling region not found
  //     (asked for /catalog-products/1/catalog-variants?limit=100)
  //
  // So the assertion is inverted, and this note is why. A test that encodes a
  // published claim is only ever as right as the claim; when behaviour
  // contradicts it, behaviour wins and the reason gets written down.
  const REGIONS = [
    "worldwide", "north_america", "canada", "europe", "spain", "latvia", "uk",
    "france", "germany", "australia", "japan", "new_zealand", "italy", "brazil",
    "southeast_asia", "republic_of_korea", "all",
  ];
  assert("the region we send is one of Printful's own enum values",
    REGIONS.includes(PRINTFUL_SELLING_REGION), PRINTFUL_SELLING_REGION);
  eq("appended to a path that already has a query",
    withSellingRegion("/catalog-products?limit=100"),
    "/catalog-products?limit=100&selling_region_name=worldwide");
  eq("and to one that does not",
    withSellingRegion("/catalog-products/71"),
    "/catalog-products/71?selling_region_name=worldwide");

  // WHAT THE PROVIDER ACTUALLY SENDS, on all three calls, read off a real run.
  const paths: string[] = [];
  const regionProvider = printfulCreationProvider(async (_s, _o, path) => {
    paths.push(path);
    return path.startsWith("/catalog-products?")
      ? { data: [{ id: 71, name: "Unisex Staple T-Shirt", type: "T-SHIRT" }] }
      : { data: [] };
  });
  await regionProvider.listBlanks({ storeId: "store_harness" });
  await regionProvider.getGarments({ storeId: "store_harness", externalProductIds: ["71"] });

  const listPath = paths.find((p) => p.startsWith("/catalog-products?"));
  const productPath = paths.find((p) => /^\/catalog-products\/\d+(\?|$)/.test(p));
  const variantsPath = paths.find((p) => p.includes("/catalog-variants"));

  assert("the catalogue listing carries a selling region",
    !!listPath && listPath.includes("selling_region_name=worldwide"), String(listPath));
  assert("the single product carries one too",
    !!productPath && productPath.includes("selling_region_name=worldwide"), String(productPath));
  // ALL THREE, including the one the reference says does not take it.
  assert("and the variants call carries one too, because Printful requires it",
    !!variantsPath && variantsPath.includes("selling_region_name=worldwide"), String(variantsPath));
  // NOT A BLANKET APPEND, still: the region goes on exactly the calls that are
  // known to need it, and each is named. A helper that appended to everything
  // would pass this and would also send it to endpoints nobody has tested.
  eq("every catalogue call that goes out carries a region",
    paths.filter((p) => p.includes("selling_region_name=worldwide")).length, paths.length);

  // ======================================================================
  console.log("\n=== 1c. What a screen costs ===\n");
  // ======================================================================
  //
  // Printful, after the catalogue finally worked:
  //
  //     Printful creation.catalog failed (429): Rate limit exceeded. You have
  //     0 out of 120 requests remaining.
  //
  // Both screens here were building FULL garments — two requests per blank —
  // for two dozen candidates. The portal did that to show five photographs;
  // the shelf did it to show two hoodies. The index carries name, type and a
  // photograph, which is all either screen needs.
  const indexOnly: string[] = [];
  const cheap = printfulCreationProvider(async (_s, _o, path) => {
    indexOnly.push(path);
    return {
      data: Array.from({ length: 40 }, (_, i) => ({
        id: i + 1,
        name: `Unisex Heavy Blend Hoodie ${i + 1} | Gildan 18500`,
        type: "HOODIE",
        image: `https://example.test/${i + 1}.png`,
      })),
    };
  });

  const blanks = await cheap.listBlanks({ storeId: "store_harness" });
  eq("forty blanks come back from ONE request", indexOnly.length, 1);
  eq("and all forty are usable without a second call", blanks.length, 40);
  assert("each carrying the supplier's own photograph",
    blanks.every((b) => !!b.imageUrl), JSON.stringify(blanks[0]));
  assert("and enough to match on", blanks.every((b) => !!b.name && !!b.type));

  // THE PORTAL, END TO END, on that one request.
  const items = portalItems(blanks);
  const hoodie = items.find((i) => i.creatable.id === "hoodie");
  assert("the portal finds its hoodies", !!hoodie && hoodie.blankCount === 40, JSON.stringify(hoodie));
  assert("with a real photograph to show", !!hoodie?.imageUrl, String(hoodie?.imageUrl));
  eq("having spent no further requests", indexOnly.length, 1);

  // THE SHELF pays per blank — so it pays only for what it shows.
  const detailPaths: string[] = [];
  const shelf = printfulCreationProvider(async (_s, _o, path) => {
    detailPaths.push(path);
    return path.startsWith("/catalog-products?")
      ? { data: [{ id: 1, name: "Unisex Heavy Blend Hoodie | Gildan 18500", type: "HOODIE" }] }
      : { data: [] };
  });
  await shelf.getGarments({ storeId: "store_harness", externalProductIds: ["1", "2"] });
  eq("two blanks cost two requests each and nothing more", detailPaths.length, 4);
  assert("and no index request is repeated to get them",
    detailPaths.every((p) => !p.startsWith("/catalog-products?")), JSON.stringify(detailPaths));

  // ======================================================================
  console.log("\n=== 2. A catalogue read does not claim store context ===\n");
  // ======================================================================
  //
  // X-PF-Store-Id was added on my reasoning — an OAuth token belongs to an
  // ACCOUNT, and lib/fulfillment/printful.ts sends it on store-scoped calls —
  // and the error that came back named something else: "Selling region not
  // found", unchanged by then sending an explicit selling_region_name=worldwide.
  //
  // Printful documents that header for endpoints REQUIRING store context. The
  // catalogue is the same for every account, so it is not one. Supplying store
  // context plausibly makes Printful resolve the region from the STORE rather
  // than from the query parameter, which is exactly the error seen.
  //
  // Store-scoping is decided from the PATH, so a new catalogue call cannot
  // accidentally opt itself into store context.
  assert("the catalogue listing is not store-scoped",
    !isStoreScoped("/catalog-products?limit=100"));
  assert("nor a single catalogue product", !isStoreScoped("/catalog-products/71"));
  assert("nor its variants", !isStoreScoped("/catalog-products/71/catalog-variants?limit=100"));
  // AND THE CAPABILITY IS STILL THERE for a call that really does act for one
  // store. An assertion that only ever proved the header absent would pass just
  // as well against a function that had lost the ability to send it.
  assert("but a store-scoped path still is", isStoreScoped("/orders"));

  const catalogueHeaders = printfulHeaders("tok_abc", 16543210, isStoreScoped("/catalog-products?limit=100"));
  eq("the bearer token is sent", catalogueHeaders.Authorization, "Bearer tok_abc");
  eq("and no store id rides along on a catalogue read",
    catalogueHeaders["X-PF-Store-Id"], undefined);

  const orderHeaders = printfulHeaders("tok_abc", 16543210, isStoreScoped("/orders"));
  eq("while a store-scoped call names the store", orderHeaders["X-PF-Store-Id"], "16543210");
  assert("as a string, because a header is a string",
    typeof orderHeaders["X-PF-Store-Id"] === "string");

  // ======================================================================
  console.log("\n=== 2b. A failure says what we asked for ===\n");
  // ======================================================================
  //
  // Two rounds were spent not knowing whether a failure came from the build
  // that carried the fix. The provider's answer alone cannot settle that; the
  // request can.
  const withPath = printfulFailure(
    "creation.catalog",
    400,
    JSON.stringify({ error: { message: "Selling region not found" } }),
    "/catalog-products?limit=100&selling_region_name=worldwide",
  );
  assert("the failure carries the path it was made against",
    withPath.includes("asked for /catalog-products?limit=100&selling_region_name=worldwide"), withPath);
  assert("alongside what Printful said", /Selling region not found/.test(withPath), withPath);

  // ======================================================================
  console.log("\n=== 3. A failure says what Printful said ===\n");
  // ======================================================================
  //
  // The shape is real, not imagined: an unauthenticated GET to this endpoint
  // returns {"data":"...","error":{"reason":"...","message":"..."}}.
  const said = printfulFailure(
    "creation.catalog",
    400,
    JSON.stringify({ error: { reason: "Bad Request", message: "Store id is required for this endpoint." } })
  );
  assert("it still names the operation and the status",
    /creation\.catalog failed \(400\)/.test(said), said);
  assert("AND repeats Printful's own explanation",
    /Store id is required/.test(said), said);
  // THE REGRESSION GUARD. This exact string is what Sean was shown.
  assert("CONTROL: it is no longer only a status code",
    said !== "Printful creation.catalog failed (400).", said);

  // A body that is not JSON must not become noise on the owner's screen.
  const html = printfulFailure("creation.catalog", 502, "<html><body>Bad Gateway</body></html>");
  assert("an unparseable body leaves the status standing alone",
    html === "Printful creation.catalog failed (502).", html);

  // ======================================================================
  console.log("\n=== 4. Nothing token-shaped reaches a durable message ===\n");
  // ======================================================================
  //
  // This string lands in ExecutionLog and on the owner's screen. Providers have
  // echoed submitted parameters back inside error text.
  //
  // THE FIXTURE IS DELIBERATELY NOT ANY PROVIDER'S KEY FORMAT. It was written
  // as `sk_live_...` and GitHub push protection rejected the commit, correctly:
  // a scanner cannot tell an invented Stripe key from a real one, and neither
  // can a person skimming a diff. What redactSecrets actually keys on is a long
  // unbroken token-shaped run, so the test needs a long unbroken run and
  // nothing more.
  const leaky = printfulFailure(
    "creation.catalog",
    400,
    JSON.stringify({ error: { message: "Invalid token abcdefghijklmnopqrstuvwxyz0123456789ABCDEF supplied" } })
  );
  assert("the token-shaped run is redacted", !/abcdefghijklmnop/.test(leaky), leaky);
  assert("and the redaction is visible rather than silent", /\[redacted\]/.test(leaky), leaky);

  // ======================================================================
  console.log("\n=== 5. The server-only caller really uses all of it ===\n");
  // ======================================================================
  //
  // provider.ts cannot be imported here — it is `server-only`, which is correct
  // and is exactly why the request escaped testing in the first place. So the
  // claim that it composes these functions rather than hand-rolling the request
  // again is asserted against its source.
  const src = codeOnly(readFileSync(join(process.cwd(), "lib", "creation", "provider.ts"), "utf8"));
  assert("it builds the URL through printfulUrl", /fetch\(\s*printfulUrl\(/.test(src), src.slice(0, 200));
  assert("and the headers through printfulHeaders", /headers:\s*printfulHeaders\(/.test(src));
  assert("and the failure through printfulFailure", /printfulFailure\(/.test(src));
  assert("CONTROL: it no longer hand-builds an Authorization header",
    !/Authorization:\s*`Bearer/.test(src),
    "a second copy of the headers is how the store header went missing once already");
  assert("CONTROL: and no longer throws a bare status",
    !/failed \(\$\{response\.status\}\)/.test(src),
    "that is the message Sean was shown");

  // ======================================================================
  console.log("\n=== 6. The portal draws; it never shows a photograph ===\n");
  // ======================================================================
  //
  // THE REGRESSION THIS EXISTS FOR (2026-08-27). ObjectFace preferred the
  // supplier's own photograph and fell back to a drawing. For weeks that
  // branch was dead — Printful was never connected, so imageUrl was always
  // null — and the hour the catalogue started answering, the portal filled
  // with white rectangles.
  //
  // Printful's catalogue images are photographs on a white ground, and several
  // are LIFESTYLE shots: a person wearing the garment. There is no
  // background-removal that rescues those; you cannot cut a model out and be
  // left with a white hoodie floating in a dark room.
  //
  // Sean: "I do not want a white square behind the product. The Creation
  // Station background should be visible all the way around the product."
  //
  // WHY THIS IS A SOURCE ASSERTION. The failing state needs a supplier whose
  // catalogue returns real image URLs, which the browser harness cannot have —
  // its Printful token is deliberately fake. What can be checked exactly is
  // that the portal has no image element to fall into.
  const portalSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationPortal.tsx"), "utf8")
  );
  assert("the portal renders no image element at all",
    !/<img[\s/>]/.test(portalSrc),
    "a supplier photograph in this room is a white rectangle in a dark space");
  assert("and reaches for the drawn object instead",
    /<CreatableArt\b/.test(portalSrc));
  // CONTROL: the drawing is not merely present alongside a photograph.
  assert("CONTROL: with no imageUrl branch left to prefer",
    !/item\.imageUrl\s*\?/.test(portalSrc),
    "the branch is what chose the photograph over the drawing");

  // AND THE SHELF STILL USES THE REAL ONES. Deliberately the opposite rule:
  // choosing WHICH blank is exactly when a real photograph of that blank is
  // what somebody needs, and there it sits in a card on a light ground where
  // it belongs. An assertion that only banned photographs everywhere would
  // pass against a Creation Station that had lost them entirely.
  const shelfSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "GarmentShelf.tsx"), "utf8")
  );
  assert("the shelf still shows the supplier's own photographs",
    /<img[\s/>]/.test(shelfSrc),
    "picking a specific blank is when a real photograph is the point");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
