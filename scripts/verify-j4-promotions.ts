import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// J4 PROPOSES A SALE. J4 NEVER APPLIES ONE:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-j4-promotions.ts" -OutFile out.txt
//
// THE ONE PROPERTY THAT MATTERS MOST: a sentence like "put everything except
// the T-shirt, hoodie and mug 26% off" must produce something the merchant
// ACCEPTS, not a price that has already changed. A model that could move prices
// directly would be one hallucinated product name away from discounting a
// catalogue nobody agreed to discount.
//
// So the handler is exercised for real — the same function the chat turn calls
// — and what it writes is read back out of the database.

let failures = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  -- ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(name, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const uniq = () => Math.random().toString(36).slice(2, 10);

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const { TOOL_HANDLERS } = await import("@/lib/execution/toolHandlers");
  const { GENESIS_ACTIONS } = await import("@/lib/execution/genesisActions");
  const owner = await prisma.user.create({ data: { email: `j4p-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Cubit & Coil", slug: `j4p-${uniq()}`, published: true },
  });

  // The real catalogue shape from Sean's own sentence.
  const names = [
    "Sacred Cubit Copper Tensor Ring",
    "Copper Tensor Ring Cuff Bracelet",
    "177Hz Copper Tensor Ring Pyramid",
    "Cubit & Coil T-Shirt",
    "Cubit & Coil Hoodie",
    "Copper Mug",
  ];
  const products = [];
  for (const [i, name] of names.entries()) {
    products.push(
      await prisma.product.create({
        data: { storeId: store.id, name, priceInCents: 2000 + i * 500, active: true, position: i },
      })
    );
  }
  const turnProducts = products.map((p) => ({ id: p.id, name: p.name }));

  const runTool = async (input: unknown) =>
    TOOL_HANDLERS.request_sale({
      storeId: store.id,
      userId: owner.id,
      userMessage: "put everything except the t-shirt, hoodie and mug 26% off",
      conversationalReply: "",
      input,
      status: () => {},
      products: turnProducts,
    } as never);

  const pending = () =>
    prisma.approvalRequest.findMany({
      where: { storeId: store.id, status: "PENDING_APPROVAL" },
      orderBy: { createdAt: "desc" },
    });

  // ========================================================================
  console.log("\n=== 1. The sentence becomes a proposal, not a price change ===\n");
  // ========================================================================

  const before = await prisma.promotion.count({ where: { storeId: store.id } });
  const result = await runTool({
    intent: "create",
    name: "Back to School Sale!",
    kind: "SALE",
    discountType: "PERCENTAGE",
    percentOff: 26,
    include: "all",
    excludeNames: ["Cubit & Coil T-Shirt", "Cubit & Coil Hoodie", "Copper Mug"],
  });

  // THE HEADLINE PROPERTY.
  eq("no promotion was created", await prisma.promotion.count({ where: { storeId: store.id } }), before);
  eq("and nothing is on sale yet", before, 0);
  eq("the turn reports itself as pending, not done", result.handled && result.executionStatus, "PENDING");

  const proposals = await pending();
  eq("exactly one thing is waiting for the merchant", proposals.length, 1);
  eq("and it is a promotion", proposals[0].actionType, "create_promotion");
  eq("which the registry knows how to execute",
    Object.keys(GENESIS_ACTIONS).includes("create_promotion"), true);

  const input = proposals[0].input as Record<string, unknown>;
  eq("covering the three tensor-ring products", (input.productIds as string[]).length, 3);
  eq("scoped to those products, not the whole store", input.scope, "SELECTED_PRODUCTS");
  eq("at 26%", input.percentOff, 26);
  eq("and not switched on until it is approved",
    await prisma.promotion.findFirst({ where: { storeId: store.id } }), null);

  const excluded = new Set(["Cubit & Coil T-Shirt", "Cubit & Coil Hoodie", "Copper Mug"]);
  const chosen = products.filter((p) => (input.productIds as string[]).includes(p.id));
  assert("and not one of the three named products is in it",
    chosen.every((p) => !excluded.has(p.name)),
    chosen.map((p) => p.name).join(", "));

  // WHAT THE MERCHANT READS comes from the resolved set, not the model's memory
  // of what it asked for.
  // THE SUMMARY DESCRIBES THE RESOLVED SET, and at this size describeSelection
  // names the products rather than counting them — three names are checkable
  // and "3 products" is not. So this asserts the stronger thing: every selected
  // product is named, and not one excluded product is presented as included.
  const summary = proposals[0].summary;
  assert("the summary names every product that will go on sale",
    chosen.every((p) => summary.includes(p.name)), summary);
  assert("and names the three being left at full price",
    /leaving out/i.test(summary) &&
      [...excluded].every((n) => summary.includes(n)),
    summary);
  assert("with the discount it will apply", /26% off/.test(summary), summary);
  assert("the reply says nothing has changed yet",
    result.handled && /nothing has changed yet/i.test(result.reply), result.handled ? result.reply : "");

  // ========================================================================
  console.log("\n=== 2. Accepting it is what changes a price ===\n");
  // ========================================================================

  const { createPromotionExecutable } = await import("@/lib/execution/executables/promotions");
  const runResult = await createPromotionExecutable.run(
    input as never,
    { storeId: store.id } as never
  );
  const created = await prisma.promotion.findFirstOrThrow({ where: { storeId: store.id } });
  eq("now there is a promotion", created.percentOff, 26);
  eq("with the name the merchant approved", created.name, "Back to School Sale!");
  eq("and the read-back verifies it",
    (await createPromotionExecutable.verify(input as never, { storeId: store.id } as never, runResult.metadata)).state,
    "verified");

  const { salePricesFor } = await import("@/lib/promotions/storefrontSales");
  const prices = await salePricesFor({
    storeId: store.id,
    products: products.map((p) => ({ id: p.id, priceInCents: p.priceInCents })),
  });
  const onSale = products.filter((p) => prices.get(p.id)!.saleInCents !== null);
  eq("three products are now on sale on the storefront", onSale.length, 3);
  assert("and the T-shirt, hoodie and mug are not",
    onSale.every((p) => !excluded.has(p.name)));
  eq("at the discount the merchant approved", prices.get(onSale[0].id)!.percentOff, 26);

  // ========================================================================
  console.log("\n=== 3. A name that matches nothing is a question ===\n");
  // ========================================================================

  const beforeCount = (await pending()).length;
  const missing = await runTool({
    intent: "create",
    name: "Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 20,
    include: "all",
    excludeNames: ["Copper Kettle"],
  });
  eq("nothing is proposed", (await pending()).length, beforeCount);
  eq("the turn does not claim to have done anything",
    missing.handled && missing.executionStatus, "WARNING");
  assert("and the merchant is asked about the name that did not resolve",
    missing.handled && /Copper Kettle/.test(missing.reply), missing.handled ? missing.reply : "");
  assert("with the real catalogue named, not their own sentence echoed back",
    missing.handled && /Sacred Cubit Copper Tensor Ring/.test(missing.reply));

  // AMBIGUITY IS A QUESTION TOO, not a guess at the closest match.
  const ambiguous = await runTool({
    intent: "create",
    name: "Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 20,
    include: "named", includeNames: ["Tensor Ring"],
  });
  eq("an ambiguous name proposes nothing", (await pending()).length, beforeCount);
  assert("and asks which was meant",
    ambiguous.handled && /Which did you mean\?/.test(ambiguous.reply));

  // A discount with no amount is refused before it reaches a constraint.
  const noAmount = await runTool({
    intent: "create",
    name: "Sale", kind: "SALE", discountType: "PERCENTAGE", include: "all",
  });
  eq("a discount with no amount proposes nothing", (await pending()).length, beforeCount);
  assert("and asks how much", noAmount.handled && /How much off/i.test(noAmount.reply));

  // ========================================================================
  console.log("\n=== 4. Everything means everything, including what comes later ===\n");
  // ========================================================================

  const everything = await runTool({
    intent: "create",
    name: "Store-wide", kind: "SALE", discountType: "PERCENTAGE", percentOff: 10, include: "all",
  });
  const storewide = (await pending())[0];
  eq("a sale on everything is scoped to the whole store",
    (storewide.input as Record<string, unknown>).scope, "ALL_PRODUCTS");
  eq("with no frozen product list", ((storewide.input as Record<string, unknown>).productIds as string[]).length, 0);
  assert("so a product added tomorrow is covered too",
    (storewide.input as Record<string, unknown>).scope === "ALL_PRODUCTS",
    "a list frozen today would quietly miss next week's product");
  eq("CONTROL: and it is still only a proposal",
    everything.handled && everything.executionStatus, "PENDING");

  // ========================================================================
  console.log("\n=== 5. A price change can never be delegated away ===\n");
  // ========================================================================

  eq("promotions are money, not content", GENESIS_ACTIONS.create_promotion.category, "money");
  eq("and money is capped at always-ask", GENESIS_ACTIONS.create_promotion.maxAuthorityTier, "always_ask");
  eq("so is switching one on or off", GENESIS_ACTIONS.update_promotion.maxAuthorityTier, "always_ask");
  assert("which means no grant can ever let J4 change a price by itself",
    GENESIS_ACTIONS.create_promotion.maxAuthorityTier === "always_ask" &&
      GENESIS_ACTIONS.update_promotion.maxAuthorityTier === "always_ask",
    "the category ceiling enforces this by construction, not by this entry's own choice");

  // ================= ENDING A SALE (P0b) ==========================
  //
  // update_promotion has existed in full the whole time and NOTHING could
  // produce it: requestSale hardcoded create_promotion, and request_sale's
  // description advertised 'take the pyramid off sale' against a schema with
  // no promotionId and no active. So an owner asking to STOP a sale was
  // offered a NEW one, in the money category.

  console.log("");
  console.log("--- ending a sale ---");

  const runningSale = await prisma.promotion.create({
    data: {
      storeId: store.id,
      name: "Spring Sale",
      kind: "SALE",
      discountType: "PERCENTAGE",
      percentOff: 20,
      scope: "ALL_PRODUCTS",
      active: true,
    },
  });

  // 4. AN END REQUEST ACTUALLY REACHES update_promotion.
  const endBefore = (await pending()).length;
  const ended = await runTool({ intent: "end", promotionName: "Spring Sale" });
  eq("ending a sale is proposed, not performed", ended.handled && ended.executionStatus, "PENDING");
  const afterEnd = await pending();
  eq("one proposal was written", afterEnd.length, endBefore + 1);
  const endProposal = afterEnd.find((a) => a.summary === `End ${runningSale.name}`);
  assert("it is an update_promotion, not a create", endProposal?.actionType === "update_promotion",
    `got ${endProposal?.actionType ?? "nothing"}`);
  const endInput = (endProposal?.input ?? {}) as { promotionId?: string; active?: boolean };
  eq("aimed at the promotion that is running", endInput.promotionId, runningSale.id);
  eq("and switches it off", endInput.active, false);

  // 5. APPROVAL IS STILL REQUIRED, by the existing money ceiling.
  eq("ending a sale still needs approval", endProposal?.authorizationTier, "always_ask");
  eq("because the action is money", GENESIS_ACTIONS.update_promotion.category, "money");
  // Nothing executed: the promotion is still running until the owner says so.
  const stillRunning = await prisma.promotion.findFirst({
    where: { id: runningSale.id, storeId: store.id },
    select: { active: true },
  });
  eq("and no price moved without a decision", stillRunning?.active, true);

  // 2. AN AMBIGUOUS OR NONEXISTENT PROMOTION IS REFUSED.
  const nonexistentBefore = (await pending()).length;
  const nonexistent = await runTool({ intent: "end", promotionName: "A Sale That Never Was" });
  eq("a promotion that does not exist proposes nothing", (await pending()).length, nonexistentBefore);
  eq("and says so", nonexistent.handled && nonexistent.kind, "sale_end_unresolved");

  const twin = await prisma.promotion.create({
    data: {
      storeId: store.id, name: "Spring Sale", kind: "SALE", discountType: "PERCENTAGE",
      percentOff: 30, scope: "ALL_PRODUCTS", active: true,
    },
  });
  const ambiguousEnd = await runTool({ intent: "end", promotionName: "Spring Sale" });
  eq("two promotions with one name are not guessed between", ambiguousEnd.handled && ambiguousEnd.kind, "sale_end_ambiguous");
  eq("and nothing is proposed", (await pending()).length, nonexistentBefore);
  await prisma.promotion.deleteMany({ where: { id: twin.id, storeId: store.id } });

  // 1. ANOTHER STORE'S PROMOTION CANNOT BE ENDED FROM HERE.
  const stranger = await prisma.user.create({ data: { email: `j4p-other-${uniq()}@test.local` } });
  const otherStore = await prisma.store.create({
    data: { userId: stranger.id, name: "Someone Else", slug: `j4p-other-${uniq()}`, published: true },
  });
  const theirSale = await prisma.promotion.create({
    data: {
      storeId: otherStore.id, name: "Their Private Sale", kind: "SALE", discountType: "PERCENTAGE",
      percentOff: 90, scope: "ALL_PRODUCTS", active: true,
    },
  });
  const crossBefore = (await pending()).length;
  const cross = await runTool({ intent: "end", promotionName: "Their Private Sale" });
  eq("another store's sale is not found from here", cross.handled && cross.kind, "sale_end_unresolved");
  eq("and nothing is proposed against it", (await pending()).length, crossBefore);
  const theirs = await prisma.promotion.findFirst({
    where: { id: theirSale.id, storeId: otherStore.id },
    select: { active: true },
  });
  eq("their sale is untouched", theirs?.active, true);

  // 3. A CREATE REQUEST CANNOT BECOME AN END, AND AN UNSTATED INTENT IS REFUSED.
  //
  // The second half is the one that matters: defaulting an unstated intent to
  // 'create' is exactly how 'stop the spring sale' produced another sale.
  const unclearBefore = (await pending()).length;
  const unclear = await runTool({
    name: "Sale", kind: "SALE", discountType: "PERCENTAGE", percentOff: 15, include: "all",
  });
  eq("an unstated intent is refused, not assumed", unclear.handled && unclear.kind, "sale_request_intent_unclear");
  eq("and proposes nothing at all", (await pending()).length, unclearBefore);

  const createAgain = await runTool({
    intent: "create", name: "A Real New Sale", kind: "SALE",
    discountType: "PERCENTAGE", percentOff: 15, include: "all",
  });
  eq("a create request still creates", createAgain.handled && createAgain.kind, "sale_request");
  const createdOne = (await pending()).find((a) => a.summary?.includes("15% off"));
  eq("as a create_promotion, never an update", createdOne?.actionType, "create_promotion");

  // 7. THE RESULTING STATE IS REFLECTED BACK INTO J4'S UNDERSTANDING.
  //
  // The loop that makes this usable: J4 names a sale from the understanding,
  // proposes ending it, the owner approves, and J4 must then stop describing
  // it as running. Approval is simulated by the executable's own effect.
  const { getBusinessUnderstanding } = await import("@/lib/businessModel/understanding");
  const seenBefore = await getBusinessUnderstanding(store.id);
  assert("J4 can see the sale it is being asked to end",
    seenBefore.activePromotions.some((promo) => promo.id === runningSale.id));

  const { updatePromotionExecutable } = await import("@/lib/execution/executables/promotions");
  await updatePromotionExecutable.run(
    { promotionId: runningSale.id, active: false },
    // GENESIS, because this stands in for the owner approving what J4
    // proposed — the same actor the approval path records.
    { storeId: store.id, userId: owner.id, actorType: "GENESIS" },
  );
  const seenAfter = await getBusinessUnderstanding(store.id);
  assert("and stops describing it as running once it is ended",
    !seenAfter.activePromotions.some((promo) => promo.id === runningSale.id));

  // 6. EXECUTION VERIFICATION REMAINS ENFORCED.
  //
  // Not a claim that verify() was called here — a claim that this action
  // cannot exist without one. The Executable type requires it, so an action
  // whose executable had no verify() would not compile.
  assert("the executable this routes to can be read back",
    typeof updatePromotionExecutable.verify === "function",
    "an action that cannot be verified must not be reachable from chat");

  await prisma.promotion.deleteMany({ where: { storeId: otherStore.id } });
  await prisma.store.delete({ where: { id: otherStore.id } });
  await prisma.user.delete({ where: { id: stranger.id } });

  // The tool must be reachable from the chat surface, or none of the above runs.
  const tools = codeOnly(readFileSync(join(process.cwd(), "lib", "execution", "genesisTools.ts"), "utf8"));
  assert("the tool is offered to the model", /name: "request_sale"/.test(tools));
  assert("and allowed on the unified chat surface", /"request_sale",/.test(tools));
  const handlers = codeOnly(readFileSync(join(process.cwd(), "lib", "execution", "toolHandlers.ts"), "utf8"));
  assert("with a handler registered against that exact name",
    /request_sale: requestSale,/.test(handlers));
  assert("which writes an approval rather than calling the executable",
    /actionType: "create_promotion"/.test(handlers) &&
      !/createPromotionExecutable\.run/.test(handlers),
    "a handler that executed directly would move prices with no merchant decision");
  assert("and the end path writes one too, against update_promotion",
    /actionType: "update_promotion"/.test(handlers) &&
      !/updatePromotionExecutable\.run/.test(handlers),
    "ending a sale is a pricing change and needs the same decision");

  await prisma.store.delete({ where: { id: store.id } });
  await prisma.user.delete({ where: { id: owner.id } });
  await db.close();

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
