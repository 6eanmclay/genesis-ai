import { readFileSync } from "fs";
import { join } from "path";
import {
  printfulUrl,
  printfulHeaders,
  printfulFailure,
  withSellingRegion,
  isStoreScoped,
  PRINTFUL_MAX_LIMIT,
  PRINTFUL_MAX_IMAGE_LIMIT,
  PRINTFUL_SELLING_REGION,
  PRINTFUL_V2_BASE,
} from "@/lib/creation/printfulRequest";
import { printfulCreationProvider } from "@/lib/creation/printfulCreation";
import { productLabel, designableViews, spinViews } from "@/lib/creation/garment";
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
  // A PRODUCT TO FETCH THE REAL BLANK FOR — not a photograph to display.
  // The portal shows the supplier's own transparent blank, which is a second
  // request per intention; the index's job is only to name which product
  // stands for each one.
  assert("naming the blank that stands for the intention",
    !!hoodie?.representativeProductId, String(hoodie?.representativeProductId));
  eq("having spent no further requests to decide that", indexOnly.length, 1);

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
  console.log("\n=== 6. The portal shows the supplier blank, never a photograph ===\n");
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
  // REVISED, DELIBERATELY (2026-08-27). This asserted the portal rendered no
  // image element at all, which was right when the only image available was a
  // catalogue photograph on a white ground. It is wrong now: Printful also
  // publishes TRANSPARENT blanks, and Sean's rule is that the real supplier
  // blank wins wherever there is one. The claim that survives is narrower and
  // truer — never the photograph, always the blank where it exists.
  assert("the portal goes through the layered blank, not a raw image",
    !/<img[\s/>]/.test(portalSrc) && /<BlankOnColor\b/.test(portalSrc),
    "colour behind, transparent blank on top — see BlankOnColor");
  // THE CATALOGUE PHOTOGRAPH IS GONE AT THE SOURCE. PortalItem no longer
  // carries one, so there is nothing for the portal to fall back into.
  assert("CONTROL: and there is no catalogue photograph left to prefer",
    !/item\.imageUrl/.test(portalSrc),
    "that property is what chose a lifestyle shot over the product");

  // AND THE DRAWING IS STILL REACHABLE, through the one component that owns
  // the choice. An assertion that only banned images would pass against a
  // portal with nothing to show when a supplier publishes no blank.
  const blankSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "BlankOnColor.tsx"), "utf8")
  );
  assert("the drawn object remains the fallback when there is no blank",
    /<CreatableArt\b/.test(blankSrc) && /usesRealBlank\(/.test(blankSrc));
  assert("the colour is painted behind, masked to the blank's own shape",
    /maskImage/.test(blankSrc) && /backgroundColor/.test(blankSrc),
    "an unmasked fill is a coloured rectangle, which is the thing being removed");
  assert("and the blend is isolated from the page behind it",
    /isolation:\s*"isolate"/.test(blankSrc),
    "multiply against a near-black room erases the garment");

  // WHOSE PICTURE IT IS, SAID OUT LOUD. The drawing is honest as a picture and
  // silent as a claim; the portal has to speak for it.
  assert("and the portal says when the drawing is ours, not the supplier's",
    /drawn by Genesis/.test(portalSrc),
    "a Genesis outline presented as the manufacturer's product is the failure here");

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

  // ======================================================================
  console.log("\n=== 7. The blank itself, for the design canvas ===\n");
  // ======================================================================
  //
  // Sean: "I do NOT want the product shown on a person or inside a
  // rectangular/white-background product photo. I want the actual blank
  // product itself isolated on the canvas."
  //
  // Printful publishes exactly that, on its own endpoint, and says what it is:
  // blank images are "transparent and require the developer to overlay them on
  // top of the color defined on the resource". The colour is painted BEHIND a
  // transparent blank that carries the shading and folds — which is how one
  // image serves every colour the manufacturer actually makes.
  //
  // Parsed by SHAPE rather than by field name. Printful's reference has been
  // wrong twice today and does not spell this response out at all, so the
  // parser walks what arrives and takes anything carrying a placement and a
  // URL. These fixtures are two plausible nestings, not a claim about which
  // one is real — the point is that either is read correctly.
  const blankPaths: string[] = [];
  const blanksProvider = printfulCreationProvider(async (_s, _o, path) => {
    blankPaths.push(path);
    return {
      data: [
        {
          catalog_variant_id: 4012,
          color: "White",
          color_code: "#ffffff",
          images: [
            { placement: "front", url: "https://files.printful.test/front.png" },
            { placement: "back", url: "https://files.printful.test/back.png" },
          ],
        },
      ],
    };
  });

  const images = await blanksProvider.getBlankImages({
    storeId: "store_harness",
    externalProductId: "71",
  });

  eq("one request fetches the blanks", blankPaths.length, 1);
  assert("against the blank-images endpoint",
    blankPaths[0].startsWith("/catalog-products/71/images?"), blankPaths[0]);
  assert("carrying a selling region, like every other catalogue call",
    blankPaths[0].includes("selling_region_name=worldwide"), blankPaths[0]);

  // ============ THIS ENDPOINT'S OWN CEILING (2026-08-27) ==============
  //
  // Printful, when asked for a hundred:
  //
  //     creation.blanks failed (400): Limit for this endpoint cannot exceed 20
  //     (asked for /catalog-products/146/images?limit=100&...)
  //
  // The catalogue takes 100 and this takes 20. A single shared constant was
  // the assumption that produced the 400, so the ceiling is asserted PER
  // ENDPOINT and the two are asserted to differ — a test that read one
  // constant twice would pass against the bug.
  const blankLimit = Number(new URLSearchParams(blankPaths[0].split("?")[1]).get("limit"));
  eq("asking for at most twenty images", blankLimit, PRINTFUL_MAX_IMAGE_LIMIT);
  assert("which is Printful's stated ceiling here", PRINTFUL_MAX_IMAGE_LIMIT === 20,
    String(PRINTFUL_MAX_IMAGE_LIMIT));
  // Compared through numbers rather than the literals, so this is a claim
  // about the VALUES and not a tautology the compiler folds away.
  const imageCeiling: number = PRINTFUL_MAX_IMAGE_LIMIT;
  const catalogueCeiling: number = PRINTFUL_MAX_LIMIT;
  assert("CONTROL: and not the catalogue's, which is different",
    imageCeiling !== catalogueCeiling,
    "one shared limit is the assumption that earned the 400");

  eq("both placements come back", images.length, 2);
  eq("front and back are named", images.map((i) => i.placement).sort(), ["back", "front"]);
  assert("each with a real URL", images.every((i) => i.url.startsWith("https://")));
  // THE COLOUR THE IMAGE IS FOR, inherited from the variant it sits under —
  // this is what gets painted behind a transparent blank.
  eq("and the colour to paint behind it", images[0].colorCode, "#ffffff");

  // A DIFFERENT NESTING, read the same. Printful may key the URL differently
  // or nest one level deeper; neither should need a code change.
  const flat = printfulCreationProvider(async () => ({
    data: { placements: [{ placement: "front", image_url: "https://files.printful.test/f.png" }] },
  }));
  const flatImages = await flat.getBlankImages({ storeId: "s", externalProductId: "71" });
  eq("a differently nested response is read the same", flatImages.length, 1);
  eq("keeping its placement", flatImages[0].placement, "front");

  // ============ AN EMPTY ANSWER AND AN UNREADABLE ONE DIFFER ==========
  //
  // A supplier may genuinely publish no blank imagery, and that is a real
  // answer. A response we could not parse is NOT, and the two must not look
  // alike — that is how a parsing bug becomes "your supplier has no pictures".
  const empty = printfulCreationProvider(async () => ({ data: [] }));
  eq("no imagery is an empty list, not an error",
    (await empty.getBlankImages({ storeId: "s", externalProductId: "71" })).length, 0);

  let shapeError = "";
  const strange = printfulCreationProvider(async () => ({ result: { pictures: [] } }));
  try {
    await strange.getBlankImages({ storeId: "s", externalProductId: "71" });
  } catch (error) {
    shapeError = error instanceof Error ? error.message : String(error);
  }
  assert("but a shape we cannot read says so",
    /no image in it/.test(shapeError), shapeError);
  assert("naming the keys that came back, never their values",
    /keys: result/.test(shapeError), shapeError);

  // AND THE ONE THAT SLIPPED THROUGH (2026-08-27). A response shaped {data:...}
  // with its URLs somewhere unexpected used to return an empty list, which the
  // screen showed as "your supplier has no pictures" — the exact confusion this
  // check exists to prevent, walking straight past it because the old test only
  // looked at whether the top-level key was `data`.
  let dataShapedError = "";
  const dataShaped = printfulCreationProvider(async () => ({
    data: [{ catalog_variant_id: 1, some_unknown_field: 12 }],
  }));
  try {
    await dataShaped.getBlankImages({ storeId: "s", externalProductId: "71" });
  } catch (error) {
    dataShapedError = error instanceof Error ? error.message : String(error);
  }
  assert("a data-shaped response with no image in it is not silently empty",
    /no image in it/.test(dataShapedError), dataShapedError || "(returned an empty list)");
  assert("and it names what it did find",
    /catalog_variant_id/.test(dataShapedError), dataShapedError);

  // ======================================================================
  console.log("\n=== 8. The supplier's price, and the product's name ===\n");
  // ======================================================================
  //
  // Sean: "Every product is showing $75. That's clearly the test/store selling
  // price, not the supplier price."
  //
  // THE CAUSE WAS UPSTREAM OF THE NUMBER. Printful's catalog-variants response
  // carries no price field — their reference lists id, catalog_product_id,
  // name, size, color, color_code, image and _links. So costInCents was null
  // for every variant, the designer fell back to 2500 cents, tripled it for a
  // starting margin, and printed $75. Forever, for everything.
  const pricePaths: string[] = [];
  const priced = printfulCreationProvider(async (_s, _o, path) => {
    pricePaths.push(path);
    return {
      data: {
        currency: "USD",
        variant: {
          id: 4012,
          techniques: [
            { technique_key: "dtg", price: "28.95" },
            { technique_key: "embroidery", price: "31.50" },
          ],
        },
      },
    };
  });

  const prices = await priced.getSupplierPrices({ storeId: "s", externalProductId: "71" });
  assert("prices come from Printful's own prices endpoint",
    pricePaths[0]?.startsWith("/catalog-products/71/prices"), String(pricePaths[0]));
  assert("carrying a selling region, like every other catalogue call",
    pricePaths[0]?.includes("selling_region_name=worldwide"), String(pricePaths[0]));
  eq("the variant is priced in cents", prices["4012"], 2895);

  // THE CHEAPEST TECHNIQUE, because a technique is a way of DECORATING and the
  // owner has not chosen one. Taking the highest, or adding them, would invent
  // a number for a product nobody has finished designing.
  assert("from the cheapest technique, not the sum of them",
    prices["4012"] === 2895 && prices["4012"] !== 2895 + 3150,
    JSON.stringify(prices));

  // A PRODUCT PRINTFUL DOES NOT PRICE HAS NO PRICE. Not a placeholder.
  const unpriced = printfulCreationProvider(async () => ({ data: { currency: "USD" } }));
  eq("an unpriced product yields nothing rather than a guess",
    Object.keys(await unpriced.getSupplierPrices({ storeId: "s", externalProductId: "71" })).length, 0);

  // ============ AND THE PLACEHOLDER IS GONE FROM THE SCREEN ===========
  //
  // The exact arithmetic that produced $75, asserted absent: a 2500-cent
  // fallback tripled. If this comes back, so does the same price on every
  // product in the catalogue.
  const clientSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationStationClient.tsx"), "utf8")
  );
  assert("CONTROL: no invented cost survives in the designer",
    !/\?\?\s*2500/.test(clientSrc),
    "2500 tripled is the $75 that appeared on every product");
  assert("and an unpriced blank starts with an empty price field",
    /supplierCost === null \? ""/.test(clientSrc),
    "a number nobody can source is worse than a box that must be filled in");

  // ======================================================================
  console.log("\n=== 9. Catalogue data stays in the data ===\n");
  // ======================================================================
  //
  // Sean, on the live screen showing "Unisex Heavy Blend Hoodie | Gildan 18500"
  // over a list of front, back, embroidery_chest_left, sleeve_left, front_dtf:
  // "Users should never see that."
  eq("the catalogue title becomes a product name",
    productLabel("Unisex Heavy Blend Hoodie | Gildan 18500"), "Heavy Blend Hoodie");
  eq("audience qualifiers go, whoever they are for",
    productLabel("Men's Fitted T-Shirt | Bella + Canvas 3001"), "Fitted T-Shirt");
  eq("a title with no maker still works", productLabel("Tote Bag"), "Tote Bag");
  // NOT A BLIND TRIM. A product genuinely called something keeps its name.
  eq("CONTROL: and a name that is only a qualifier is not emptied",
    productLabel("Unisex"), "Unisex");

  // THE PLACEMENT KEYS STAY INTERNAL. Front and back are offered as views;
  // everything else remains in printAreas, where validation still reads it.
  const manyAreas: Parameters<typeof designableViews>[0] = {
    provider: "PRINTFUL",
    externalProductId: "71",
    name: "Unisex Heavy Blend Hoodie | Gildan 18500",
    type: "HOODIE",
    brand: "Gildan",
    description: null,
    imageUrl: null,
    variants: [],
    printAreas: [
      { placement: "front", width: 12, height: 16, unit: "inches" },
      { placement: "embroidery_chest_left", width: 4, height: 4, unit: "inches" },
      { placement: "sleeve_left", width: 3, height: 12, unit: "inches" },
      { placement: "back", width: 12, height: 16, unit: "inches" },
      { placement: "front_dtf", width: 12, height: 16, unit: "inches" },
    ],
  };
  eq("only front and back are offered as views",
    designableViews(manyAreas).map((v) => v.label), ["Front", "Back"]);
  eq("in the order a person thinks of them",
    designableViews(manyAreas).map((v) => v.placement), ["front", "back"]);
  // AND THE REST IS NOT DELETED — the data keeps every placement, because the
  // print-area validation and the eventual order both read them.
  eq("CONTROL: while the data keeps every placement", manyAreas.printAreas.length, 5);

  const stationSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationStation.tsx"), "utf8")
  );
  assert("the screen shows the product name, not the catalogue title",
    /productLabel\(garment\.name\)/.test(stationSrc));
  assert("CONTROL: and never dumps the placement keys into a sentence",
    !/printAreas\.map\(\(a\) => a\.placement\)\.join/.test(stationSrc),
    "that line is what printed front, back, embroidery_chest_left, sleeve_left");

  // ======================================================================
  console.log("\n=== 10. Seven tools, and Spin turns a real product ===\n");
  // ======================================================================
  //
  // Sean: "The existing functionality can be reused where it already exists.
  // This is primarily a better organization of the controls, not a reason to
  // rewrite working behavior."
  const toolbarSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationStation.tsx"), "utf8")
  );
  for (const tool of ["Color", "Add", "Pad", "Edit", "Flip", "Paint", "Spin"]) {
    assert(`${tool} is one of the tools`,
      new RegExp(`label: "${tool}"`).test(toolbarSrc), tool);
  }

  // ============ PAINT IS SHOWN AND SAYS IT IS NOT BUILT ==============
  //
  // A tool that does nothing and admits it is a promise; one that does nothing
  // and pretends is a bug somebody has to discover. `ready: false` is the
  // mechanism, so a future tool cannot join the row without deciding which.
  assert("Paint is present but declared unbuilt",
    /id: "paint"[\s\S]{0,200}ready: false/.test(toolbarSrc),
    "an unbuilt tool must not look finished");
  assert("and every other tool is declared built",
    (toolbarSrc.match(/ready: false/g) ?? []).length === 1,
    "exactly one tool is unbuilt today");

  // ============ THE COLOURS ARE STILL THE SUPPLIER'S =================
  //
  // Sean: "Color — choose only colours the selected supplier actually
  // manufactures." Restructuring the controls must not have introduced a
  // free picker on the way past.
  assert("CONTROL: no free colour input crept in with the toolbar",
    !/type="color"/.test(toolbarSrc),
    "a colour Printful does not stock is a product nobody can order");
  assert("the swatches are still the garment's own colours",
    /colors\.map\(/.test(toolbarSrc) && /c\.colorHex/.test(toolbarSrc));

  // ============ SPIN TURNS THROUGH REAL VIEWS ONLY ===================
  //
  // Sean wants a 360 "if the available supplier imagery supports it". That
  // clause is the constraint: a view needs a photograph, and there is no
  // three-quarter image, so there is no three-quarter view.
  const spinHoodie: Parameters<typeof spinViews>[0] = {
    provider: "PRINTFUL",
    externalProductId: "146",
    name: "Unisex Heavy Blend Hoodie | Gildan 18500",
    type: "HOODIE",
    brand: "Gildan",
    description: null,
    imageUrl: null,
    variants: [],
    printAreas: [
      { placement: "front", width: 12, height: 16, unit: "inches" },
      { placement: "back", width: 12, height: 16, unit: "inches" },
      { placement: "sleeve_left", width: 3, height: 12, unit: "inches" },
    ],
  };

  eq("with front and back photographed, the garment turns between them",
    spinViews(spinHoodie, [
      { placement: "front", colorCode: null, url: "https://x.test/f.png" },
      { placement: "back", colorCode: null, url: "https://x.test/b.png" },
    ]),
    ["front", "back"]);

  // A PRINTABLE PLACEMENT IS NOT A VIEW. sleeve_left has a print area and no
  // picture; Spin is about looking at the product.
  eq("a placement with no photograph is not somewhere to turn to",
    spinViews(spinHoodie, [{ placement: "front", colorCode: null, url: "https://x.test/f.png" }]),
    ["front"]);

  // AND AN EXTRA ANGLE THE SUPPLIER PUBLISHED IS ONE, even though nobody
  // prints on it — which is what makes this grow into a 360 without a rewrite.
  eq("but an extra angle they did photograph is",
    spinViews(spinHoodie, [
      { placement: "front", colorCode: null, url: "https://x.test/f.png" },
      { placement: "back", colorCode: null, url: "https://x.test/b.png" },
      { placement: "left", colorCode: null, url: "https://x.test/l.png" },
    ]),
    ["front", "back", "left"]);

  eq("CONTROL: and no view is invented when there are no pictures at all",
    spinViews(spinHoodie, []), []);

  assert("Spin is disabled rather than spinning nothing",
    /views\.length < 2/.test(toolbarSrc),
    "one view is not something to turn");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
