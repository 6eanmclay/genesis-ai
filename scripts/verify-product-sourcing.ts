import { getProductSources, getReadySources, getProductSource, describeBlockedSources } from "@/lib/sourcing/registry";
import { scoreCandidate, isWorthSuggesting, type SourcingContext } from "@/lib/sourcing/recommend";
import { toVariantKey, fromVariantKey, type SourcedCandidate } from "@/lib/sourcing/types";
import { aliexpressSource } from "@/lib/sourcing/aliexpress";

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
  assert("and it says why", duplicate.reasons.some((r) => r.includes("already sell")), duplicate.reasons.join(" | "));

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
  assert("selling at a loss is called out", loss.reasons.some((r) => r.includes("at a loss")), loss.reasons.join(" | "));
  assert("and pushed below everything else", loss.score < unknown.score);
}

// ---------------------------------------------------------------------------
console.log("\n7. A store Genesis knows nothing about gets no suggestions");
{
  const blank: SourcingContext = {
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

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
