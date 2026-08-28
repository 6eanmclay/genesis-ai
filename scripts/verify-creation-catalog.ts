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
import { operationsFor, applyOperation } from "@/lib/creation/operations";
import { emptyDesign, addLayer, layerForAsset, layersOn } from "@/lib/creation/design";
import {
  productLabel,
  designableViews,
  spinViews,
  sameColor,
  blankFor,
  renderableColors,
} from "@/lib/creation/garment";
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
  console.log("\n=== 6. Illustrated in the doorway, photographed in the editor ===\n");
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
  // REVISED TWICE, AND THIS IS THE SETTLED RULE (2026-08-27).
  //
  // First it asserted the portal showed no image at all — right when the only
  // image available was a catalogue photograph on a white ground. Then it
  // asserted the portal showed the supplier's transparent blank — right when
  // the rule was "real blank wherever there is one, everywhere".
  //
  // Sean, having seen both: "The creation carousel should be a Genesis-branded
  // discovery experience, not a supplier catalog... Once the user selects a
  // product and enters the actual design/editor experience, that's where we
  // should switch to the real Printful product photography."
  //
  // So the line is drawn between the two SCREENS rather than applied to both,
  // and each side of it is asserted below.
  assert("the doorway draws, and calls no supplier for a picture",
    !/<img[\s/>]/.test(portalSrc) && /<CreatableArt\b/.test(portalSrc),
    "the carousel is a Genesis room, not a grid of whatever Printful photographed");
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

  // AND NO APOLOGY FOR IT. The old copy read "outline drawn by Genesis, your
  // supplier has no image", which was right while the drawing was standing in
  // for a photograph and is wrong now that it is the intended illustration.
  assert("CONTROL: and does not apologise for drawing",
    !/drawn by Genesis/.test(portalSrc),
    "that caveat existed because the drawing was a fallback; here it is the design");

  // WHAT MUST STILL BE HONEST IS INVENTORY. The picture being ours does not
  // license the COUNT being ours — "3 to choose from" is a claim about the
  // supplier either way.
  assert("the portal still reports the supplier's real count",
    /blankCount/.test(portalSrc));
  assert("and still says when the catalogue could not be read",
    /couldn't read your supplier's catalogue/.test(portalSrc));

  // THE OTHER SIDE OF THE LINE. The editor is where the real product lives,
  // and an assertion that only banned supplier imagery from the portal would
  // pass just as well against a Creation Station that had lost it entirely.
  assert("CONTROL: while the editor still renders the real supplier blank",
    /<BlankOnColor\b/.test(
      codeOnly(readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "CreationCanvas.tsx"), "utf8"))
    ),
    "real colours, real lighting, real front and back begin one step later");

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

  // PAGED. Twenty is the most this endpoint returns at once, not the most
  // there is — see section 14 for the fourteen-colour hoodie that proved it.
  // A second request that adds nothing is how the end is detected.
  eq("it pages until a page adds nothing", blankPaths.length, 2);
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
      { placement: "front", colorCode: null, colorName: null, url: "https://x.test/f.png" },
      { placement: "back", colorCode: null, colorName: null, url: "https://x.test/b.png" },
    ]),
    ["front", "back"]);

  // A PRINTABLE PLACEMENT IS NOT A VIEW. sleeve_left has a print area and no
  // picture; Spin is about looking at the product.
  eq("a placement with no photograph is not somewhere to turn to",
    spinViews(spinHoodie, [{ placement: "front", colorCode: null, colorName: null, url: "https://x.test/f.png" }]),
    ["front"]);

  // AND AN EXTRA ANGLE THE SUPPLIER PUBLISHED IS ONE, even though nobody
  // prints on it — which is what makes this grow into a 360 without a rewrite.
  eq("but an extra angle they did photograph is",
    spinViews(spinHoodie, [
      { placement: "front", colorCode: null, colorName: null, url: "https://x.test/f.png" },
      { placement: "back", colorCode: null, colorName: null, url: "https://x.test/b.png" },
      { placement: "left", colorCode: null, colorName: null, url: "https://x.test/l.png" },
    ]),
    ["front", "back", "left"]);

  eq("CONTROL: and no view is invented when there are no pictures at all",
    spinViews(spinHoodie, []), []);

  assert("Spin is disabled rather than spinning nothing",
    /views\.length < 2/.test(toolbarSrc),
    "one view is not something to turn");

  // ======================================================================
  console.log("\n=== 11. The three interaction bugs ===\n");
  // ======================================================================

  // ---- 1. THE COLOUR PAINTED THE ROOM, NOT THE GARMENT ---------------
  //
  // Sean: "when I select a different garment color, the background changes
  // color while the hoodie itself stays black."
  //
  // Two causes, and both are asserted here.
  //
  // FIRST: a variant's colour is written "#0A0A0A" and its blank image's is
  // written "0a0a0a". Compared as strings those are different colours, so the
  // per-colour blank was never found and the first image was used whatever was
  // selected — a black hoodie, permanently.
  assert("a colour is the same colour however it is written",
    sameColor("#0A0A0A", "0a0a0a") && sameColor("#FFF", "#ffffff"));
  assert("CONTROL: and two different colours still are",
    !sameColor("#0A0A0A", "#ffffff") && !sameColor(null, "#fff"));

  const colourBlanks = [
    { placement: "front", colorCode: "0a0a0a", colorName: null, url: "https://x.test/black-front.png" },
    { placement: "front", colorCode: "7BA4DB", colorName: null, url: "https://x.test/carolina-front.png" },
    { placement: "back", colorCode: "0a0a0a", colorName: null, url: "https://x.test/black-back.png" },
  ];

  // SECOND: a blank that IS the chosen colour must not be tinted. It already
  // carries the manufacturer's own lighting; painting behind it is what put a
  // colour on the room.
  eq("Carolina Blue picks the Carolina Blue blank",
    blankFor(colourBlanks, "front", "#7ba4db").url, "https://x.test/carolina-front.png");
  eq("and nothing is painted behind it",
    blankFor(colourBlanks, "front", "#7ba4db").tintWith, null);
  eq("Black picks the black one", blankFor(colourBlanks, "front", "#0A0A0A").url,
    "https://x.test/black-front.png");
  eq("and the back view picks the back blank",
    blankFor(colourBlanks, "back", "#0A0A0A").url, "https://x.test/black-back.png");

  // A COLOUR-NEUTRAL BLANK IS THE ONE THAT GETS PAINTED. Printful's own
  // instruction — "overlay on top of the color defined on the resource" —
  // applies to these and only these.
  const neutral = [{ placement: "front", colorCode: null, colorName: null, url: "https://x.test/neutral.png" }];
  eq("a colour-neutral blank is tinted", blankFor(neutral, "front", "#FFD700").tintWith, "#FFD700");
  eq("with the neutral image", blankFor(neutral, "front", "#FFD700").url, "https://x.test/neutral.png");

  // AND GOLD, WHEN THE SUPPLIER ONLY PUBLISHES OTHER COLOURS, SHOWS NOTHING.
  // Tinting a navy blank gold produces a garment nobody manufactures.
  eq("Gold with no gold blank and no neutral shows no blank",
    blankFor(colourBlanks, "front", "#FFD700").url, null);
  eq("CONTROL: and does not tint somebody else's colour",
    blankFor(colourBlanks, "front", "#FFD700").tintWith, null);

  // ============ WHICH NOTHING (2026-08-27) ===========================
  //
  // Sean: "I don't want a missing garment simply dismissed as 'no image' until
  // we've confirmed that Printful actually gave us no usable blank for that
  // variant."
  //
  // One sentence covered three situations, and only one of them is the
  // supplier having nothing. Reading "no blank image" when Printful had
  // published a dozen, just not in gold, is how a data problem gets filed as a
  // supplier limitation and stops being investigated.
  eq("nothing at all is its own answer", blankFor([], "front", "#fff").absence, "none");
  eq("blanks that exist but not in this colour is another",
    blankFor(colourBlanks, "front", "#FFD700").absence, "other-colours");
  eq("and blanks for other views is a third",
    blankFor(colourBlanks, "sleeve_left", "#0A0A0A").absence, "other-views");
  eq("CONTROL: while a blank that IS found reports no absence",
    blankFor(colourBlanks, "front", "#0a0a0a").absence, null);

  // A FRONT IMAGE IS NOT A BACK IMAGE. Falling back to another view would show
  // the wrong picture confidently, which is worse than saying so.
  eq("CONTROL: and no other view is substituted for the one asked for",
    blankFor(colourBlanks, "sleeve_left", "#0A0A0A").url, null);

  // THIRD: the mask that shapes the fill is cross-origin, so it silently did
  // nothing and the fill kept its rectangle. It goes through our own origin now.
  const blankOnColorSrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "BlankOnColor.tsx"), "utf8")
  );
  assert("the mask and the image are served from our own origin",
    /sameOrigin\(blankUrl\)/.test(blankOnColorSrc) && /api\/creation\/blank/.test(blankOnColorSrc),
    "a cross-origin mask-image does not error, it just stops masking");
  assert("CONTROL: and the raw supplier URL is not used for either",
    !/url\(\$\{blankUrl\}\)/.test(blankOnColorSrc) && !/src=\{blankUrl\}/.test(blankOnColorSrc));

  // THE PROXY REFUSES ANYTHING THAT IS NOT PRINTFUL. An open image proxy is a
  // way to make a server fetch arbitrary URLs, internal ones included.
  const proxySrc = codeOnly(
    readFileSync(join(process.cwd(), "app", "api", "creation", "blank", "route.ts"), "utf8")
  );
  assert("the proxy allows only Printful's own hosts",
    /ALLOWED_HOSTS\.has\(target\.hostname\)/.test(proxySrc));
  assert("over https only", /target\.protocol !== "https:"/.test(proxySrc));
  assert("and relays images only", /startsWith\("image\/"\)/.test(proxySrc));

  // ---- 2. GO WAS UNDER THE TOOLBAR -----------------------------------
  //
  // The instruction box worked; the button beneath it could not be tapped. The
  // toolbar is sticky at the bottom with a z-index, so it sat on top of
  // whatever the page ended with — on a phone, "Ask for a change" and the
  // add-to-store button.
  assert("the page leaves room beneath the sticky toolbar",
    /pb-40/.test(toolbarSrc),
    "without this the tool row sits on top of the last controls on the page");
  assert("CONTROL: and the toolbar is still the sticky one that needed it",
    /sticky bottom-0/.test(
      codeOnly(readFileSync(join(process.cwd(), "app", "b", "[slug]", "studio", "create", "DesignToolbar.tsx"), "utf8"))
    ));
  // The Go button was never disabled — worth pinning, so a future "fix" does
  // not add a disabled state to a control that was only ever obscured.
  assert("Go is not disabled by anything",
    /onClick=\{ask\}[\s\S]{0,160}>\s*Go/.test(toolbarSrc),
    "the button worked; it was underneath the toolbar");

  // ---- 3. TAPPING ARTWORK LOOKED LIKE NOTHING ------------------------
  //
  // The tap DID add the artwork. Nothing in the panel changed to say so, and
  // the panel covers the canvas where the result appeared — two silences on
  // top of each other, which read as a dead control.
  assert("an artwork already on this side is shown as such",
    /const onGarment = layersOn\(design, placement\)\.some/.test(toolbarSrc),
    "the panel gave no sign that a tap had done anything");
  assert("with a visible selected state",
    /onGarment[\s\S]{0,200}ring-2/.test(toolbarSrc));
  assert("CONTROL: and adding still goes through the same handler as before",
    /onClick=\{\(\) => addArtwork\(asset\)\}/.test(toolbarSrc),
    "this was organisation, not a rewrite of what the tap does");

  // ======================================================================
  console.log("\n=== 12. Blanks labelled by colour NAME ===\n");
  // ======================================================================
  //
  // Sean, on a gold hoodie: "It still is changing the background and not the
  // actual hoodie." The screenshots were the diagnosis — a gold RECTANGLE with
  // a dark brown garment on it.
  //
  // Gold times black is dark brown. Multiply cannot lighten, so whatever was
  // being tinted was the BLACK colourway, for every colour in the row.
  //
  // The cause is one line in the parser. Printful labels these blanks by
  // colour NAME, the walker collapsed name and hex into one string and tested
  // it against a hex pattern, "Black" failed the test and became null — so
  // every image looked colour-neutral, and a colour-neutral blank is exactly
  // the one that gets painted behind.
  const printfulShaped = printfulCreationProvider(async () => ({
    data: [
      {
        catalog_variant_id: 4012,
        color: "Black",
        color_code: "#0a0a0a",
        images: [{ placement: "front", url: "https://x.test/black.png" }],
      },
      {
        catalog_variant_id: 4020,
        color: "Gold",
        images: [{ placement: "front", url: "https://x.test/gold.png" }],
      },
    ],
  }));

  const labelled = await printfulShaped.getBlankImages({ storeId: "s", externalProductId: "146" });
  eq("both blanks come back", labelled.length, 2);
  eq("the one with a hex keeps it", labelled[0].colorCode, "#0a0a0a");
  eq("and its name", labelled[0].colorName, "Black");
  // THE ONE THAT BROKE IT: a blank labelled only by name.
  eq("a blank labelled only by name keeps the name", labelled[1].colorName, "Gold");
  eq("CONTROL: and is NOT recorded as colour-neutral", labelled[1].colorCode, null);
  assert("CONTROL: so it is not treated as a blank canvas for other colours",
    labelled[1].colorName !== null,
    "null name AND null code is what made every colour paint the black hoodie");

  // ============ AND GOLD NOW FINDS THE GOLD ONE ======================
  eq("Gold selects the Gold blank by name",
    blankFor(labelled, "front", null, "Gold").url, "https://x.test/gold.png");
  eq("with nothing painted behind it",
    blankFor(labelled, "front", null, "Gold").tintWith, null);
  eq("Black still selects the black one by hex",
    blankFor(labelled, "front", "#0A0A0A", "Black").url, "https://x.test/black.png");

  // THE REGRESSION, EXACTLY. Before the fix every colour resolved to the first
  // image and tinted it — a gold wash over a black hoodie.
  assert("CONTROL: no colour resolves to another colour's blank",
    blankFor(labelled, "front", null, "Gold").url !== "https://x.test/black.png",
    "gold over black is the brown garment on the gold rectangle");

  // A GENUINELY UNLABELLED BLANK IS STILL THE ONE THAT GETS PAINTED.
  const unlabelled = [
    { placement: "front", colorCode: null, colorName: null, url: "https://x.test/neutral.png" },
  ];
  eq("an unlabelled blank is still tinted",
    blankFor(unlabelled, "front", "#FFD700", "Gold").tintWith, "#FFD700");

  // ======================================================================
  console.log("\n=== 13. Add and Ask, end to end ===\n");
  // ======================================================================
  //
  // Both were reported as dead controls, and neither was: the data paths work.
  // Add was hidden feedback behind a panel; Ask was a button underneath the
  // toolbar. What follows pins the behaviour so a future change to the panel
  // or the row cannot quietly break them again.

  // ---- ASK executes a supported command with nothing selected --------
  //
  // Sean will test "make the artwork bigger". It must EXECUTE, not merely be
  // accepted — and it must work without first tapping the artwork, because
  // nobody selects a thing before describing it.
  let asked = emptyDesign("146");
  asked = addLayer(asked, "front", layerForAsset({ id: "a1", assetUrl: "https://x.test/logo.png" }));
  const widthBefore = layersOn(asked, "front")[0].width;

  const askOps = operationsFor("make the artwork bigger", asked, {
    activePlacement: "front",
    selectedLayerId: null,
  });
  assert("a supported instruction parses with nothing selected", askOps !== null,
    "nobody taps a thing before describing it");
  let afterAsk = asked;
  for (const op of askOps ?? []) afterAsk = applyOperation(afterAsk, op);
  assert("and actually changes the artwork",
    layersOn(afterAsk, "front")[0].width > widthBefore,
    `${widthBefore} -> ${layersOn(afterAsk, "front")[0].width}`);

  // AN UNSUPPORTED ONE IS REFUSED RATHER THAN GUESSED AT.
  eq("CONTROL: an instruction about the garment is not invented",
    operationsFor("make the hoodie white", asked, {
      activePlacement: "front",
      selectedLayerId: null,
    }),
    null);

  // AND "NOTHING TO ACT ON" IS ITS OWN ANSWER. Every instruction here is about
  // artwork, so with none on this side the parser returns null for a reason
  // that has nothing to do with the words — answering "I can move, resize..."
  // to a perfectly reasonable request reads as a broken feature.
  eq("an empty side also parses to nothing",
    operationsFor("make the artwork bigger", emptyDesign("146"), {
      activePlacement: "front",
      selectedLayerId: null,
    }),
    null);
  assert("and the screen says which of the two it is",
    /Add some artwork to the/.test(toolbarSrc),
    "not understanding and having nothing to act on are different answers");

  // ---- ADD places artwork, and the panel gets out of the way ---------
  let added = emptyDesign("146");
  added = addLayer(added, "front", layerForAsset({
    id: "a1",
    assetUrl: "https://x.test/logo.png",
    area: { placement: "front", width: 12, height: 16, unit: "inches" },
  }));
  eq("tapping an asset puts a layer on the garment", layersOn(added, "front").length, 1);
  const placed = layersOn(added, "front")[0];
  assert("at a real size rather than nothing",
    placed.width > 0 && placed.height > 0, JSON.stringify(placed));
  assert("and inside the printable area",
    placed.x >= 0 && placed.y >= 0 && placed.x + placed.width <= 1 && placed.y + placed.height <= 1,
    JSON.stringify(placed));

  assert("adding closes the panel that was covering the canvas",
    /function addArtwork[\s\S]{0,400}setOpenTool\(null\)/.test(toolbarSrc),
    "the artwork lands behind the sheet used to add it");
  assert("CONTROL: and the toolbar is controlled so it can be closed",
    /openId=\{openTool\}/.test(toolbarSrc) && /onOpenChange=\{setOpenTool\}/.test(toolbarSrc));

  // ======================================================================
  console.log("\n=== 14. Fourteen colours do not fit in twenty images ===\n");
  // ======================================================================
  //
  // Sean, on the live build: White, Black and Gold fell back to the Genesis
  // outline while Carolina Blue rendered as a black hoodie with BLUE
  // DRAWSTRINGS.
  //
  // Those two facts together are the diagnosis, and neither is a compositing
  // problem. Blue drawstrings on a black garment is precisely what multiply
  // does — black times blue is black, and the light cords times blue are blue
  // — so the tint path was running on a blank that was not the chosen colour.
  // And most colours having no blank at all is arithmetic: a Gildan 18500 has
  // fourteen colours and two views, which is at least twenty-eight images, and
  // the request asked for twenty.
  //
  // The 400 that set that ceiling said "Limit for this endpoint cannot exceed
  // 20". Twenty is the most that can be fetched AT ONCE, and I read it as the
  // most there is.
  const HOODIE_COLOURS = [
    ["White", "#ffffff"], ["Black", "#0a0a0a"], ["Carolina Blue", "#7ba4db"],
    ["Dark Heather", "#47484d"], ["Gold", "#ffd667"], ["Sport Grey", "#9b969c"],
    ["Forest Green", "#273b33"], ["Maroon", "#5b2b42"], ["Navy", "#263147"],
    ["Red", "#b31217"], ["Royal", "#274d91"], ["Irish Green", "#00a74a"],
    ["Light Blue", "#a3b8cb"], ["Light Pink", "#e5bfd2"],
  ] as const;

  // Printful's real shape: one record per variant, images nested under it, and
  // twenty per page.
  const allRecords = HOODIE_COLOURS.flatMap(([name, hex], i) => [
    {
      catalog_variant_id: 5000 + i,
      color: name,
      color_code: hex,
      images: [{ placement: "front", url: `https://x.test/${i}-front.png` }],
    },
    {
      catalog_variant_id: 5100 + i,
      color: name,
      color_code: hex,
      images: [{ placement: "back", url: `https://x.test/${i}-back.png` }],
    },
  ]);
  assert("the fixture is bigger than one page",
    allRecords.length > 20, String(allRecords.length));

  const pagesAsked: string[] = [];
  const pagedProvider = printfulCreationProvider(async (_s, _o, path) => {
    pagesAsked.push(path);
    const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
    return { data: allRecords.slice(offset, offset + 20) };
  });

  const everyBlank = await pagedProvider.getBlankImages({
    storeId: "s",
    externalProductId: "146",
  });

  assert("more than one page is fetched", pagesAsked.length > 1, String(pagesAsked.length));
  assert("each page asks for the next offset",
    pagesAsked.some((pth) => pth.includes("offset=20")), JSON.stringify(pagesAsked));
  eq("every image arrives, not just the first twenty", everyBlank.length, allRecords.length);

  // ============ AND NOW EVERY COLOUR RESOLVES ========================
  //
  // The four Sean tested, by name and by hex, front and back.
  for (const [name, hex] of [
    ["White", "#ffffff"], ["Black", "#0a0a0a"],
    ["Carolina Blue", "#7ba4db"], ["Gold", "#ffd667"],
  ] as const) {
    const front = blankFor(everyBlank, "front", hex, name);
    const back = blankFor(everyBlank, "back", hex, name);
    assert(`${name} resolves to a real blank`, front.url !== null, JSON.stringify(front));
    assert(`${name} is NOT tinted`, front.tintWith === null,
      "a blank that is already the chosen colour must not be painted over");
    assert(`${name} reports no supplier gap`, front.absence === null, String(front.absence));
    assert(`${name} has its own back view`,
      back.url !== null && back.url !== front.url, `${front.url} / ${back.url}`);
  }

  // ============ THE COLOURS THAT FELL OFF THE FIRST PAGE ==============
  //
  // This is the assertion that ties the arithmetic to what Sean saw. Light
  // Pink is the fourteenth colour, so its images sit past record twenty — it
  // is reachable ONLY if the second page is fetched. Before paging it had no
  // blank at all, which is the Genesis outline he got for most of the row.
  const lateColour = HOODIE_COLOURS[HOODIE_COLOURS.length - 1];
  const lateIndex = allRecords.findIndex((r) => r.color === lateColour[0]);
  assert("the last colour's images are past the first page",
    lateIndex >= 20, `${lateColour[0]} at record ${lateIndex}`);
  const late = blankFor(everyBlank, "front", lateColour[1], lateColour[0]);
  assert(`${lateColour[0]} resolves only because the second page was fetched`,
    late.url !== null && late.absence === null, JSON.stringify(late));

  // And proved the other way: from one page alone it is simply not there.
  const firstPageOnly = everyBlank.slice(0, 20);
  eq("CONTROL: from the first page alone it has no blank",
    blankFor(firstPageOnly, "front", lateColour[1], lateColour[0]).url, null);
  eq("CONTROL: and is reported as a supplier gap it does not have",
    blankFor(firstPageOnly, "front", lateColour[1], lateColour[0]).absence, "other-colours");

  // THE EXACT SYMPTOM, ASSERTED SHUT. Carolina Blue must not land on the black
  // blank — that pairing is the blue drawstrings.
  const carolina = blankFor(everyBlank, "front", "#7ba4db", "Carolina Blue");
  const black = blankFor(everyBlank, "front", "#0a0a0a", "Black");
  assert("CONTROL: Carolina Blue does not resolve to the black blank",
    carolina.url !== black.url,
    "black times blue is black; the light drawstrings times blue are blue");

  // AND THE TRUNCATION THAT CAUSED IT CANNOT RETURN SILENTLY. A supplier that
  // keeps paging forever is an error, not a quiet first-N.
  let runaway = "";
  const endless = printfulCreationProvider(async (_s, _o, path) => {
    const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset") ?? 0);
    return {
      data: Array.from({ length: 20 }, (_, k) => ({
        catalog_variant_id: offset + k,
        color: `Colour ${offset + k}`,
        images: [{ placement: "front", url: `https://x.test/endless-${offset + k}.png` }],
      })),
    };
  });
  try {
    await endless.getBlankImages({ storeId: "s", externalProductId: "146" });
  } catch (error) {
    runaway = error instanceof Error ? error.message : String(error);
  }
  assert("CONTROL: endless paging is reported, never silently truncated",
    /refusing to guess where they end/.test(runaway), runaway || "(returned quietly)");

  // ======================================================================
  console.log("\n=== 15. Only colours that can actually be shown ===\n");
  // ======================================================================
  //
  // Sean: "Only show colors that we can actually render correctly... I'd
  // rather have 8-10 colors that look perfect than 14 colors where some don't
  // work or load slowly."
  //
  // This inverts the problem instead of solving it. Every previous attempt was
  // about what to DO when a colour has no blank — tint a neutral one, tint
  // somebody else's, show an outline and explain — and all of them put a wrong
  // or apologetic garment on screen. Not offering the colour puts nothing
  // wrong on screen at all.
  const fourteen: Parameters<typeof renderableColors>[0] = {
    provider: "PRINTFUL",
    externalProductId: "146",
    name: "Unisex Heavy Blend Hoodie | Gildan 18500",
    type: "HOODIE",
    brand: "Gildan",
    description: null,
    imageUrl: null,
    variants: HOODIE_COLOURS.map(([name, hex], i) => ({
      externalVariantId: String(6000 + i),
      color: name,
      colorHex: hex,
      size: "L",
      imageUrl: null,
      costInCents: null,
    })),
    printAreas: [
      { placement: "front", width: 12, height: 16, unit: "inches" },
      { placement: "back", width: 12, height: 16, unit: "inches" },
    ],
  };

  // Only four of the fourteen have a front blank.
  const someBlanks = [
    { placement: "front", colorCode: "#ffffff", colorName: "White", url: "https://x.test/w.png" },
    { placement: "front", colorCode: "#0a0a0a", colorName: "Black", url: "https://x.test/b.png" },
    { placement: "front", colorCode: "#7ba4db", colorName: "Carolina Blue", url: "https://x.test/c.png" },
    { placement: "front", colorCode: "#ffd667", colorName: "Gold", url: "https://x.test/g.png" },
    // Back has fewer, which is the case that used to strand a selection.
    { placement: "back", colorCode: "#ffffff", colorName: "White", url: "https://x.test/wb.png" },
  ];

  const frontColours = renderableColors(fourteen, someBlanks, "front");
  eq("only the colours with a front blank are offered",
    frontColours.map((c) => c.color), ["White", "Black", "Carolina Blue", "Gold"]);
  eq("CONTROL: not all fourteen", frontColours.length !== fourteen.variants.length, true);

  // AND EVERY OFFERED COLOUR RESOLVES. This is the guarantee the row makes:
  // a swatch on screen has already been proven to draw.
  for (const c of frontColours) {
    const resolved = blankFor(someBlanks, "front", c.colorHex, c.color);
    assert(`${c.color} is offered AND resolves`, resolved.url !== null, JSON.stringify(resolved));
    assert(`${c.color} is offered AND needs no tint`, resolved.tintWith === null,
      "a colour that needs tinting is a colour that cannot be shown correctly");
  }

  // THE VIEW CHANGES WHICH COLOURS EXIST. Turning the garment over is allowed
  // to shorten the row, and a selection that survived that would be a variant
  // the canvas cannot draw.
  eq("the back offers only what the back has",
    renderableColors(fourteen, someBlanks, "back").map((c) => c.color), ["White"]);

  // NO IMAGERY AT ALL IS NOT THE SAME AS NONE MATCHING. With no supplier
  // pictures the editor draws an outline for every colour, so every colour is
  // equally showable — emptying the row there would remove the choice for a
  // reason the owner cannot act on.
  eq("with no supplier imagery every colour stays offered",
    renderableColors(fourteen, [], "front").length, fourteen.variants.length);

  // AND THE EMPTY ROW SAYS SO. Images that could not be attributed to any
  // colour leave nothing offerable, and that is worth seeing immediately
  // rather than as a garment that will not change.
  const unattributable = [
    { placement: "front", colorCode: null, colorName: null, url: "https://x.test/one.png" },
  ];
  eq("images we cannot attribute leave no colour offerable",
    renderableColors(fourteen, unattributable, "front").length, 0);
  assert("and the screen says that plainly",
    /None of this blank's colours have a supplier image/.test(toolbarSrc),
    "an empty row with no sentence is a mystery");

  // CONTROL: the selection follows the row rather than being written during
  // render — setColor in a render body is a loop waiting for two views to
  // disagree about which colours exist.
  assert("CONTROL: the active colour is derived, never set while rendering",
    /const activeColor = colors\.some/.test(toolbarSrc) && !/if \(!offered[\s\S]{0,80}setColor\(/.test(toolbarSrc),
    "a setState during render is a re-render loop");

  console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
