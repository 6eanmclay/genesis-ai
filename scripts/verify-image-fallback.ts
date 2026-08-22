import { resolveProductImage } from "@/lib/imageProviders/resolveProductImage";
import type { ImageProvider, ImageSourceResult } from "@/lib/imageProviders/types";

// WHICH PROVIDER GETS ASKED FOR A PRODUCT PHOTO, AND IN WHAT ORDER:
//
//   npx tsx scripts/verify-image-fallback.ts
//
// The providers themselves are externally blocked — GeneratedImageProvider needs
// a real image-model key and StockSearchProvider needs Unsplash. Recorded, not
// substituted. But the thing that DECIDES between them takes its provider list
// as a parameter, precisely so it can be exercised without either, and that is
// the part carrying the product decision.
//
// GENERATION IS PRIMARY, STOCK IS THE FALLBACK. Per explicit direction: "Genesis
// creates original imagery whenever possible, rather than defaulting to a
// stock-photo search engine." Reverse the order and every product gets a stock
// photo that a thousand other shops also have, while the generator sits unused —
// and nothing about the result would look wrong, because a stock photo IS a
// photo. That is the failure worth an assertion: it is invisible in the output.
//
// AND FALLING BACK IS NOT THE SAME AS TRYING EVERYTHING. The first real result
// wins and the rest are never called — a second provider running after a
// success would spend money on an image nobody sees.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

const REQUEST = {
  prompt: "a copper tensor ring on charcoal",
  name: "Tensor Ring",
  description: "Hand-wound copper",
  excludeUrls: [],
  scope: { userId: "u1" },
} as never;

/** A provider that records being asked, and answers however the test says. */
function provider(name: string, answer: ImageSourceResult | null, calls: string[]): ImageProvider {
  return {
    kind: name,
    source: async () => {
      calls.push(name);
      return answer;
    },
  } as unknown as ImageProvider;
}

const image = (url: string) => ({ url, source: "test", prompt: null }) as unknown as ImageSourceResult;

async function main() {
  // ==========================================================================
  console.log("\n=== 1. The first real answer wins, and stops the chain ===\n");
  // ==========================================================================
  const calls: string[] = [];
  const first = await resolveProductImage(REQUEST, [
    provider("generated", image("https://blob.test/generated.png"), calls),
    provider("stock", image("https://blob.test/stock.png"), calls),
  ]);
  check("the first provider's image is used", first?.url, "https://blob.test/generated.png");
  check("and the second was never asked", calls, ["generated"]);
  assert(
    "so a success never costs a second call",
    calls.length === 1,
    "a provider running after a win spends money on an image nobody sees"
  );

  // ==========================================================================
  console.log("\n=== 2. Falling back is what null is for ===\n");
  // ==========================================================================
  const afterMiss: string[] = [];
  const fell = await resolveProductImage(REQUEST, [
    provider("generated", null, afterMiss),
    provider("stock", image("https://blob.test/stock.png"), afterMiss),
  ]);
  check("a provider that cannot answer hands on", fell?.url, "https://blob.test/stock.png");
  check("and both were tried, in order", afterMiss, ["generated", "stock"]);
  assert(
    "which is how a missing key or a moderation rejection degrades",
    fell !== null,
    "GeneratedImageProvider returns null for a missing/invalid key, a rejection, or a transient failure"
  );

  // Everything failing is an honest null, not a placeholder.
  const allMissed: string[] = [];
  const nothing = await resolveProductImage(REQUEST, [
    provider("generated", null, allMissed),
    provider("stock", null, allMissed),
  ]);
  check("when nobody can answer, the result is null", nothing, null);
  check("after genuinely asking everyone", allMissed, ["generated", "stock"]);
  assert(
    "rather than a stock placeholder standing in for a real photo",
    nothing === null,
    "an invented image is a claim about a product nobody made"
  );

  // An empty provider list is a null, not a crash.
  check("no providers at all is null", await resolveProductImage(REQUEST, []), null);

  // ==========================================================================
  console.log("\n=== 3. Genesis makes images before it searches for them ===\n");
  // ==========================================================================
  // THE ORDER IS THE PRODUCT DECISION, and the one that would be invisible if
  // reversed: a stock photo is still a photo, so the output would look fine
  // while every product carried an image a thousand other shops also use.
  //
  // Read from the SOURCE rather than by calling it. Invoking the real default
  // chain here would make a genuine image-model request — the first run of this
  // file did exactly that and produced an auth error, which is a live call this
  // suite has no business making.
  const { GeneratedImageProvider } = await import("@/lib/imageProviders/generatedImageProvider");
  const { StockSearchProvider } = await import("@/lib/imageProviders/stockSearchProvider");
  const source = await import("fs").then((fs) =>
    fs.readFileSync("lib/imageProviders/resolveProductImage.ts", "utf8")
  );
  const orderLine = source.slice(source.indexOf("DEFAULT_PROVIDER_ORDER"));
  const generatedAt = orderLine.indexOf("GeneratedImageProvider");
  const stockAt = orderLine.indexOf("StockSearchProvider");
  assert("both real providers are in the default order", generatedAt >= 0 && stockAt >= 0,
    orderLine.slice(0, 120));
  assert(
    "and generation comes before stock search",
    generatedAt < stockAt,
    "Genesis creates original imagery whenever possible, rather than defaulting to a stock-photo search engine"
  );
  assert("both are real provider objects with a source()",
    typeof GeneratedImageProvider.source === "function" && typeof StockSearchProvider.source === "function",
    "if either stopped being a provider the chain would break at runtime, not at compile time");

  // ==========================================================================
  console.log("\n=== 4. Every provider is asked the same question ===\n");
  // ==========================================================================
  // The request is passed through untouched — a provider that received a
  // different prompt from the one before it would make the fallback a different
  // product photo rather than the same one sourced another way.
  const seen: unknown[] = [];
  const recording = (name: string, answer: ImageSourceResult | null): ImageProvider =>
    ({
      kind: name,
      source: async (request: unknown) => {
        seen.push(request);
        return answer;
      },
    }) as unknown as ImageProvider;

  await resolveProductImage(REQUEST, [recording("a", null), recording("b", null)]);
  check("both providers saw a request", seen.length, 2);
  assert("and it was the same one, unchanged",
    JSON.stringify(seen[0]) === JSON.stringify(seen[1]),
    "a fallback that altered the prompt would be sourcing a different product");
  assert("carrying the caller's own prompt",
    JSON.stringify(seen[0]).includes("copper tensor ring"),
    JSON.stringify(seen[0]).slice(0, 120));

  console.log(`\n${failures === 0 ? "All image-fallback assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
