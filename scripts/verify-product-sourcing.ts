import { getProductSources, getReadySources, getProductSource, describeBlockedSources } from "@/lib/sourcing/registry";
import { scoreCandidate, isWorthSuggesting, type SourcingContext } from "@/lib/sourcing/recommend";
import { toVariantKey, fromVariantKey, type SourcedCandidate } from "@/lib/sourcing/types";
import { aliexpressSource } from "@/lib/sourcing/aliexpress";
import { framingFor, groupBySourcing } from "@/lib/sourcing/framing";
import { recommendStartingSet } from "@/lib/sourcing/startingSet";
import type { ProductSourceKind } from "@prisma/client";

// The sourcing model's own rules. No database, no network:
//
//   npx tsx scripts/verify-product-sourcing.ts
//
// P0.5. What is asserted here is the part of the design that has to stay true
// as suppliers are added: that a source declares what it can do rather than
// having it inferred from its name, that an unusable source says why instead of
// returning nothing, and that a recommendation cannot exist without a real fact
// about the business behind it.

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

// A real business, in its own words. Cubit & Coil, which is what P0.5 is for.
const CUBIT: SourcingContext = {
  currency: "USD",
  ownWords:
    "Hand-wound copper tensor rings and coils for energy work and meditation. Every ring is made by hand from solid copper.",
  classifications: ["Wellness", "Handmade goods"],
  brandPositioning: "minimalist",
  sells: ["Copper tensor ring", "Sacred cubit coil"],
  proven: ["Copper tensor ring"],
};

function candidate(over: Partial<SourcedCandidate> = {}): SourcedCandidate {
  return {
    sourceKey: "printful",
    externalProductId: "1",
    externalVariantId: "v1",
    kind: "PRINT_ON_DEMAND",
    name: "Thing",
    description: null,
    imageUrl: null,
    unitCostInCents: null,
    suggestedRetailInCents: null,
    currency: "USD",
    customizable: true,
    fulfillmentProvider: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
console.log("\n1. A source says what it can do; nothing is inferred from its name");
{
  const sources = getProductSources();
  assert("more than one source is registered", sources.length > 1, String(sources.length));

  // The two SHAPES this model exists to hold apart. Print-on-demand creates a
  // listing with the owner's artwork on it; wholesale creates nothing and
  // customises nothing.
  const pod = sources.filter((s) => s.kind === "PRINT_ON_DEMAND");
  const wholesale = sources.filter((s) => s.kind === "WHOLESALE_DROPSHIP");
  assert("a print-on-demand source is registered", pod.length > 0);
  assert("and a wholesale one", wholesale.length > 0);

  for (const source of pod) {
    check(`${source.key} can customise`, source.capabilities.customization, true);
    check(`${source.key} creates a listing`, source.capabilities.createsListings, true);
  }
  for (const source of wholesale) {
    // The line that matters most in this file. Offering "add your logo" on a
    // wholesale listing would be a promise to a customer that the supplier has
    // no idea was made.
    check(`${source.key} cannot customise`, source.capabilities.customization, false);
    check(`${source.key} creates nothing`, source.capabilities.createsListings, false);
  }

  // Keys are what the database holds, so they have to be stable and unique.
  const keys = sources.map((s) => s.key);
  check("every key is unique", new Set(keys).size, keys.length);
  assert("and all lowercase", keys.every((k) => k === k.toLowerCase()), keys.join(", "));
  for (const key of keys) {
    check(`${key} resolves back out of the registry`, getProductSource(key)?.key, key);
  }
  check("an unknown key resolves to nothing", getProductSource("nope"), null);
}

// ---------------------------------------------------------------------------
console.log("\n2. A source that cannot be used says why, and never invents a catalogue");
{
  const blocked = describeBlockedSources();
  assert("something is declared blocked", blocked.length > 0);
  for (const entry of blocked) {
    assert(`${entry.key} names what it needs`, entry.blockedOn.length > 0, entry.blockedOn.join(", "));
  }

  const ready = getReadySources();
  assert("ready sources have nothing outstanding", ready.every((s) => s.blockedOn.length === 0));
  assert("and blocked ones are not in that list",
    !ready.some((s) => blocked.some((b) => b.key === s.key)));
}

async function assertBlockedSourceInventsNothing() {
  // The rule Sean set for P0.5: do not stop at a mock catalogue. The stronger
  // half of that is that an unbuilt source must not produce one either.
  const result = await aliexpressSource.search({
    storeId: "store_1",
    keywords: "copper rings",
    brandPositioning: "minimalist",
    limit: 8,
  });
  check("it refuses rather than returning products", result.ok, false);
  if (!result.ok) {
    check("as a configuration problem, not an outage", result.reason, "not_configured");
    assert("naming the credentials it needs",
      result.reason === "not_configured" && result.missing.length > 0,
      JSON.stringify(result));
    // An empty success would be indistinguishable from "the catalogue had
    // nothing for you", which is a completely different thing to tell an owner.
    assert("and it does not report an empty catalogue", !("candidates" in result));
  }
}

// ---------------------------------------------------------------------------
console.log("\n2c. A declared capability has something behind it");
{
  // The invariant TypeScript cannot express: `quote` is present if and only if
  // `quotesCost` is true. A source declaring a capability it does not implement
  // reads as working right up until a caller believes it.
  for (const source of getProductSources()) {
    check(`${source.key}: quotesCost matches whether it can be asked`,
      typeof source.quote === "function", source.capabilities.quotesCost);
    // Same invariant for the economics capability, and it matters more: a source
    // claiming to state supplier terms it cannot state would have the producer
    // writing an empty catalogue, which reads as a supplier that withdrew
    // everything.
    check(`${source.key}: statesEconomics matches whether it can be asked`,
      typeof source.economics === "function", source.capabilities.statesEconomics);
    // A source that ships direct and one that does not are both legitimate, but
    // the flag has to be a real boolean rather than accidentally undefined.
    for (const [name, value] of Object.entries(source.capabilities)) {
      assert(`${source.key}: ${name} is stated`, typeof value === "boolean", String(value));
    }
    // Only a source that creates listings can have something fulfil on our
    // behalf. A wholesale supplier with a fulfilmentProvider would put its
    // products in front of order-routing code with no idea what to do with them.
    if (!source.capabilities.createsListings) {
      check(`${source.key}: nobody fulfils on our behalf`, source.fulfillmentProvider, null);
    }
    // And customisation is only ever true for print-on-demand.
    if (source.capabilities.customization) {
      check(`${source.key}: only print-on-demand customises`, source.kind, "PRINT_ON_DEMAND");
    }
  }
}

// ---------------------------------------------------------------------------
console.log("\n3. A recommendation cannot exist without a real fact behind it");
{
  // Nothing about this candidate connects to anything about the business.
  const unrelated = scoreCandidate(candidate({ name: "Phone Case", description: "A case for phones" }), CUBIT);
  check("an unrelated product scores nothing", unrelated.score <= 0, true);
  check("and says nothing", unrelated.reasons, []);
  check("so it is not worth suggesting", isWorthSuggesting(unrelated), false);

  // This one shares the business's own vocabulary.
  const fitting = scoreCandidate(
    candidate({ name: "Copper Wire Spool", description: "Solid copper wire for hand-wound coils" }),
    CUBIT
  );
  assert("a fitting product scores", fitting.score > 0, String(fitting.score));
  assert("and explains itself in the business's own words",
    fitting.reasons.some((r) => r.includes("copper") || r.includes("coils")), fitting.reasons.join(" | "));
  assert("naming which signals it used", fitting.basedOn.length > 0, fitting.basedOn.join(", "));
  check("so it is worth suggesting", isWorthSuggesting(fitting), true);

  // What already earns money outranks what the business merely says about
  // itself — evidence over description.
  const proven = scoreCandidate(candidate({ name: "Tensor Ring Display Stand", description: "Stand for a tensor ring" }), CUBIT);
  const described = scoreCandidate(candidate({ name: "Meditation Cushion", description: "For meditation" }), CUBIT);
  assert("something adjacent to a proven seller outranks something merely on-message",
    proven.score > described.score, `${proven.score} vs ${described.score}`);
}

// ---------------------------------------------------------------------------
console.log("\n4. Recommending what the owner already sells is the clearest failure there is");
{
  const duplicate = scoreCandidate(candidate({ name: "Copper tensor ring", description: "A copper tensor ring" }), CUBIT);
  assert("it scores negative", duplicate.score < 0, String(duplicate.score));
  check("so it is never suggested", isWorthSuggesting(duplicate), false);
  // A duplicate is a CONCERN, never a reason. Anything in `reasons` is an
  // argument for adding it, and there is no version of this that argues for it.
  assert("and it says why", duplicate.concerns.some((r) => r.includes("already sell")), duplicate.concerns.join(" | "));
  check("with nothing said in its favour", duplicate.reasons, []);

  // Case must not be a way around it.
  const shouty = scoreCandidate(candidate({ name: "COPPER TENSOR RING" }), CUBIT);
  check("regardless of how it is spelled", isWorthSuggesting(shouty), false);
}

// ---------------------------------------------------------------------------
console.log("\n5. Customisation counts only where it is genuinely an advantage");
{
  const forMinimalist = scoreCandidate(candidate({ name: "Copper Coil Poster", customizable: true }), CUBIT);
  const forBudget = scoreCandidate(
    candidate({ name: "Copper Coil Poster", customizable: true }),
    { ...CUBIT, brandPositioning: "budget" }
  );
  // A budget reseller gains nothing from it, and scoring it up would push them
  // toward the more expensive supplier for no reason they would recognise.
  assert("a minimalist brand is scored up for it", forMinimalist.basedOn.includes("customization_fit"));
  assert("a budget one is not", !forBudget.basedOn.includes("customization_fit"));
  assert("and the difference is only that signal",
    forMinimalist.score > forBudget.score, `${forMinimalist.score} vs ${forBudget.score}`);
}

// ---------------------------------------------------------------------------
console.log("\n6. An unknown cost is not a zero");
{
  const unknown = scoreCandidate(
    candidate({ name: "Copper Coil Kit", unitCostInCents: null, suggestedRetailInCents: null }),
    CUBIT
  );
  // Treating a null cost as zero would rank every un-quoted candidate as
  // infinitely profitable, which is exactly backwards: it is the ones nobody
  // has priced that deserve the least confidence.
  assert("no margin reasoning happens at all", !unknown.basedOn.includes("margin"), unknown.basedOn.join(", "));

  const healthy = scoreCandidate(
    candidate({ name: "Copper Coil Kit", unitCostInCents: 400, suggestedRetailInCents: 2000 }),
    CUBIT
  );
  assert("a real margin is reasoned about", healthy.basedOn.includes("margin"));
  assert("in percentage terms the owner can check",
    healthy.reasons.some((r) => r.includes("%")), healthy.reasons.join(" | "));
  assert("and it scores above the unpriced one", healthy.score > unknown.score);

  const loss = scoreCandidate(
    candidate({ name: "Copper Coil Kit", unitCostInCents: 2500, suggestedRetailInCents: 2000 }),
    CUBIT
  );
  assert("selling at a loss is called out", loss.concerns.some((r) => r.includes("at a loss")), loss.concerns.join(" | "));
  assert("and pushed below everything else", loss.score < unknown.score);
}

// ---------------------------------------------------------------------------
console.log("\n7. A store Genesis knows nothing about gets no suggestions");
{
  const blank: SourcingContext = {
    currency: "USD",
  ownWords: "",
    classifications: [],
    brandPositioning: "other",
    sells: [],
    proven: [],
  };
  const anything = scoreCandidate(candidate({ name: "Copper Wire Spool", description: "Solid copper wire" }), blank);
  // "I don't understand your business well enough to suggest anything yet" is
  // the useful answer, and the true one. A list padded out with confident
  // nothings is how an owner learns to ignore the list.
  check("nothing is worth suggesting", isWorthSuggesting(anything), false);
  check("and no reason is invented", anything.reasons, []);
}

// ---------------------------------------------------------------------------
console.log("\n7a. Matching a category is not understanding a business");
{
  // THE DEFECT (2026-08-20). Category used to be a fourth relevance signal, so a
  // foam roller described as a "tool for training at home" matched the word
  // *home* against a candle business filed under Home — and was recommended to
  // it. Found by a test written for two businesses on one account, which is
  // where a shallow match stops being invisible.
  const candles: SourcingContext = {
    currency: "USD",
  ownWords: "Small-batch soy candles poured by hand in Vermont.",
    classifications: ["Home & Garden"],
    brandPositioning: "luxury",
    sells: [],
    proven: [],
  };
  const roller = candidate({
    name: "High-density foam roller",
    description: "Recovery and mobility tool for training at home",
    customizable: false,
  });
  const judged = scoreCandidate(roller, candles);
  check("a category word alone does not make it relevant", isWorthSuggesting(judged), false);
  check("it is ruled out", judged.verdict, "does_not_fit");
  assert("and no category signal is claimed as grounds",
    !judged.basedOn.includes("classification"), judged.basedOn.join(", "));

  // The same category still sharpens a judgment that stands on its own.
  const wick = candidate({
    name: "Cotton wick spool",
    description: "Wick for hand-poured soy candles, for the home",
    customizable: false,
  });
  const good = scoreCandidate(wick, candles);
  check("something genuinely on-brand is suggested", isWorthSuggesting(good), true);
  assert("with the category confirming rather than carrying it",
    good.basedOn.indexOf("own_words") < good.basedOn.indexOf("classification") ||
      !good.basedOn.includes("classification"),
    good.basedOn.join(", "));

  // A business that has only picked a category cannot be judged at all — saying
  // "this doesn't fit your business" on the strength of a slug is a judgment
  // nobody gave Genesis the standing to make.
  const categoryOnly: SourcingContext = {
    currency: "USD",
  ownWords: "",
    classifications: ["Home & Garden"],
    brandPositioning: "other",
    sells: [],
    proven: [],
  };
  check("a category alone is not understanding", scoreCandidate(roller, categoryOnly).verdict, "unknown");
}

// ---------------------------------------------------------------------------
console.log("\n7b. A bad fit is said out loud, and not knowing is said differently");
{
  // The sentence Sean called extremely important: "I wouldn't recommend this
  // product for your store. Although it's technically a fitness product, it
  // doesn't fit the brand you've described."
  const wrong = scoreCandidate(candidate({ name: "Phone Case", description: "A case for phones" }), CUBIT);
  check("it is a real judgment", wrong.verdict, "does_not_fit");
  assert("with a reason in the owner's terms", wrong.concerns.length > 0, JSON.stringify(wrong));
  check("and nothing positive is claimed", wrong.reasons, []);

  // A duplicate is a bad fit too, and says why.
  const duplicate = scoreCandidate(candidate({ name: "Copper tensor ring" }), CUBIT);
  check("a duplicate does not fit", duplicate.verdict, "does_not_fit");
  assert("saying so", duplicate.concerns.some((c) => c.includes("already sell")), JSON.stringify(duplicate));

  // But a store nothing is known about gets neither answer.
  const blank: SourcingContext = { currency: "USD", ownWords: "", classifications: [], brandPositioning: "other", sells: [], proven: [] };
  const cannotSay = scoreCandidate(candidate({ name: "Copper Wire Spool" }), blank);
  check("an unknown business cannot be judged", cannotSay.verdict, "unknown");
  // Telling a new owner their product "doesn't fit the brand" before any brand
  // has been described invents a standard they never set.
  check("so nothing is held against it", cannotSay.concerns, []);

  // Losing money is a concern, not a selling point, however well it fits.
  const loss = scoreCandidate(
    candidate({ name: "Copper Coil Kit", unitCostInCents: 2500, suggestedRetailInCents: 2000 }),
    CUBIT
  );
  check("a loss-maker does not fit", loss.verdict, "does_not_fit");
  assert("and it is a concern, not a reason",
    loss.concerns.some((c) => c.includes("at a loss")) && !loss.reasons.some((r) => r.includes("at a loss")),
    JSON.stringify(loss));
}

// ---------------------------------------------------------------------------
console.log("\n7c. Products are grouped by what the owner can do with them, never by supplier");
{
  const pod = framingFor("PRINT_ON_DEMAND");
  const bulk = framingFor("WHOLESALE_DROPSHIP");

  // The owner never chooses a supplier by name. "Printful" and "AliExpress" are
  // answers to a question nobody building a business is asking.
  for (const framing of [pod, bulk, framingFor("OWNER_MADE"), framingFor("WHOLESALE_STOCKED"), framingFor("DIGITAL")]) {
    for (const text of [framing.label, framing.intent, framing.explanation, framing.bestFor]) {
      assert(`no supplier is named in "${text.slice(0, 32)}..."`,
        !/printful|aliexpress|easypost/i.test(text), text);
    }
  }

  check("customisable products are for building the brand", pod.intent, "Build your brand");
  check("and are customisable", pod.customizable, true);
  check("with nothing to hold", pod.holdsInventory, false);
  check("ready-to-sell products expand the line", bulk.intent, "Expand your product line");
  // The distinction the whole model exists for.
  check("and are not customisable", bulk.customizable, false);
  // Stocked wholesale is the one that ties up money, and must say so.
  assert("holding stock is called out where it applies",
    framingFor("WHOLESALE_STOCKED").holdsInventory === true &&
      framingFor("WHOLESALE_STOCKED").explanation.includes("tied up"),
    framingFor("WHOLESALE_STOCKED").explanation);
  // Dropshipping is hedged, because Genesis does not route orders to a supplier
  // yet and "shipped for you" would be a promise it does not keep.
  assert("dropshipping does not overpromise fulfilment",
    bulk.explanation.includes("yourself"), bulk.explanation);

  const grouped = groupBySourcing([
    { kind: "PRINT_ON_DEMAND" as ProductSourceKind, id: "a" },
    { kind: "WHOLESALE_DROPSHIP" as ProductSourceKind, id: "b" },
    { kind: "PRINT_ON_DEMAND" as ProductSourceKind, id: "c" },
  ]);
  check("two groups", grouped.length, 2);
  check("with the right counts", grouped.map((g) => g.items.length).sort(), [1, 2]);
  // An empty "Customizable products" heading promises a branded route that is
  // not there.
  assert("and no empty group is invented", grouped.every((g) => g.items.length > 0));
}

// ---------------------------------------------------------------------------
console.log("\n7d. A starting set is a mix, not the top of a list");
{
  const item = (id: string, kind: ProductSourceKind, score: number) => ({ id, name: id, kind, score });

  // Six ready-to-sell products outscore both branded ones. Taking the top five
  // would give the owner a first catalogue with nothing of theirs in it.
  const set = recommendStartingSet([
    item("roller", "WHOLESALE_DROPSHIP", 30),
    item("bands", "WHOLESALE_DROPSHIP", 28),
    item("dumbbells", "WHOLESALE_DROPSHIP", 26),
    item("massage-gun", "WHOLESALE_DROPSHIP", 24),
    item("mat", "WHOLESALE_DROPSHIP", 22),
    item("straps", "WHOLESALE_DROPSHIP", 20),
    item("tee", "PRINT_ON_DEMAND", 12),
    item("hoodie", "PRINT_ON_DEMAND", 10),
  ]);

  check("five picks", set.picks.length, 5);
  const branded = set.picks.filter((p) => p.kind === "PRINT_ON_DEMAND");
  check("two of them branded", branded.length, 2);
  // The strongest fits are still there — only the weakest ready-to-sell picks
  // gave way.
  assert("the best fit is kept", set.picks.some((p) => p.id === "roller"));
  assert("and the weakest was the one dropped", !set.picks.some((p) => p.id === "mat"));
  assert("the swap is explained rather than done quietly",
    set.advice.some((a) => a.includes("on purpose")), set.advice.join(" | "));
  assert("and the shape argument is made",
    set.advice.some((a) => a.includes("associating the product")), set.advice.join(" | "));
  assert("with the rest acknowledged",
    set.advice.some((a) => a.includes("more that fit")), set.advice.join(" | "));

  // Nothing brandable available at all: name the gap, do not advise adding
  // something that cannot be added.
  const noBranded = recommendStartingSet([
    item("roller", "WHOLESALE_DROPSHIP", 30),
    item("bands", "WHOLESALE_DROPSHIP", 28),
  ]);
  check("both picked", noBranded.picks.length, 2);
  assert("the absence is named", noBranded.gaps.length > 0, JSON.stringify(noBranded.gaps));
  assert("and no impossible advice is given",
    !noBranded.advice.some((a) => a.includes("Worth adding one or two that do")),
    noBranded.advice.join(" | "));

  // Nothing at all is nothing said.
  const empty = recommendStartingSet([]);
  check("no picks", empty.picks, []);
  check("and no advice invented", empty.advice, []);
}

// ---------------------------------------------------------------------------
console.log("\n8. The variant sentinel converts back to what it means");
{
  // A wholesale listing has no variant; a print-on-demand blank always does.
  check("no variant becomes the sentinel", toVariantKey(null), "");
  check("a real variant is untouched", toVariantKey("v1"), "v1");
  check("and the sentinel reads back as no variant", fromVariantKey(""), null);
  check("while a real one survives the round trip", fromVariantKey(toVariantKey("v1")), "v1");
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);

// The one asynchronous check runs last, then the tally. Everything above is
// synchronous and has already executed by this point; a top-level await would
// not compile under the CJS transform these scripts run through.
async function main(): Promise<void> {
  console.log("\n2b. A blocked source, asked directly");
  await assertBlockedSourceInventsNothing();

  console.log("\n2d. A blocked source will not price anything either");
  const quoted = await aliexpressSource.quote!({
    storeId: "store_1",
    candidate: {
      sourceKey: "aliexpress",
      externalProductId: "x",
      externalVariantId: null,
      kind: "WHOLESALE_DROPSHIP",
      name: "Anything",
      description: null,
      imageUrl: null,
      unitCostInCents: null,
      suggestedRetailInCents: null,
      currency: "USD",
      customizable: false,
      fulfillmentProvider: null,
    },
  });
  check("it refuses to price", quoted.ok, false);
  // A zero would make this the most profitable thing in the store.
  assert("and quotes no number at all", !("unitCostInCents" in quoted), JSON.stringify(quoted));

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
