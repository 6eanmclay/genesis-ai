import { readFileSync } from "fs";
import { join } from "path";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  TOOL_HANDLERS,
  MIGRATED_TOOLS,
  handlerFor,
  makeApprovePendingChanges,
  makeTakeMeThere,
  makeAnswerSupplierEconomics,
  makePlanCampaign,
  makeCreateComposition,
  makeApproveComposition,
  makeApproveDesignAsProduct,
  makeCreateDesign,
  makeGenerateBrandLogo,
  makeImproveStorefront,
  makeManageBusinessAsset,
  makeRequestImageChange,
  makeRequestProductContentChange,
  makeRefineStorefront,
  isLogoRoleName,
  isHeroRoleName,
  NAV_DESTINATIONS,
  OFFICE_REPLY,
  resolveScopedProducts,
  SCOPE_QUESTION,
  routeToolHandlers,
  type ToolTurnContext,
} from "@/lib/execution/toolHandlers";
import type Anthropic from "@anthropic-ai/sdk";
import type { StoreRole } from "@prisma/client";
import {
  runPlannedTools,
  persistToolTurn,
  revalidationPaths,
  turnOutcome,
  turnKind,
  lastAssistantContent,
} from "@/lib/dashboard/runToolTurn";
import { TakeMeThereInputSchema } from "@/lib/execution/genesisTools";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";
import { queryRecords } from "@/lib/businessModel/reasoning";

// WHAT A TOOL ACTUALLY DOES, TESTED FOR THE FIRST TIME:
//
//   npx tsx scripts/run-db-suites.ts tool-handlers
//
// Every tool branch used to live inline in the chat route and end by writing
// messages, emitting and closing the stream itself. That made them unreachable
// except through a model — so nineteen capabilities, including
// approve_pending_changes, which EXECUTES approved changes to a live store, had
// no test of any kind.
//
// Three have moved into handlers that return what they did instead of ending
// the turn. This file is what that bought: real invocations, against a real
// database, with no model in the loop.
//
// WHAT IT DELIBERATELY DOES NOT TEST. Whether the model chooses the right tool
// — that is scripts/verify-j4-routing.ts and needs a key. This is about what
// happens once one is chosen, which is the half that touches data.

const results: { name: string; ok: boolean }[] = [];
function check(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}
function assert(name: string, ok: boolean, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const uniq = () => Math.random().toString(36).slice(2);

/** A context with the status line captured rather than emitted. */
function contextFor(
  storeId: string,
  userId: string,
  input: unknown,
  conversationalReply = "",
  products: { id: string; name: string }[] = [],
  previousAssistantMessage?: string
): ToolTurnContext & { statuses: string[] } {
  const statuses: string[] = [];
  return {
    storeId,
    userId,
    userMessage: "whatever the merchant said",
    conversationalReply,
    input,
    status: (text: string) => statuses.push(text),
    products,
    previousAssistantMessage,
    statuses,
  };
}

async function main() {
  await requireTestDatabase(prismaSystem);

  const owner = await prisma.user.create({ data: { email: `th-${uniq()}@test.local` } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Copper & Coil", slug: `th-${uniq()}` },
  });
  const other = await prisma.store.create({
    data: { userId: owner.id, name: "Iron Gym", slug: `th-other-${uniq()}` },
  });

  // ==========================================================================
  console.log("\n=== 1. A handler returns what it did, and ends nothing ===\n");
  // ==========================================================================
  // The property the whole extraction turns on: a handler that closed the
  // stream itself could never be the first of two.
  const upload = await handlerFor("show_upload_options")!(contextFor(store.id, owner.id, {}));
  assert("it reports that it handled the turn", upload.handled);
  if (!upload.handled) throw new Error("unreachable");
  assert("with something to say", upload.reply.length > 20, upload.reply);
  check("and a kind the log can identify it by", upload.kind, "upload_intent");

  // NOTHING WAS PERSISTED BY THE HANDLER. The turn owns that, once, however
  // many handlers ran — which is what stops two handlers writing two copies of
  // the merchant's own message.
  check("the handler wrote no chat message",
    await prisma.storeMessage.count({ where: { storeId: store.id } }), 0);

  // The model's own words win when it wrote any: it read the actual message.
  const withOwnWords = await handlerFor("show_upload_options")!(
    contextFor(store.id, owner.id, {}, "Go ahead and drop them in.")
  );
  check("the model's own wording is preferred",
    withOwnWords.handled && withOwnWords.reply, "Go ahead and drop them in.");

  // ==========================================================================
  console.log("\n=== 2. Capturing a fact really records one ===\n");
  // ==========================================================================
  const capture = handlerFor("capture_business_fact")!;
  const goalCtx = contextFor(store.id, owner.id, {
    entityType: "goal",
    data: {
      description: "Open a second workshop",
      category: "expansion",
      priority: "high",
      targetDate: null,
      targetValueInCents: null,
    },
  });
  const captured = await capture(goalCtx);
  assert("the capture is handled", captured.handled, JSON.stringify(captured));

  const goals = await queryRecords(store.id, "goal");
  check("a real goal exists afterwards", goals.length, 1);
  check("with the owner's words", goals[0]?.data.description, "Open a second workshop");

  // THE PROVENANCE PAIR, which is the whole reason this handler is not a
  // one-liner. OWNER because the owner is the author; modelExtracted because
  // the sentence stored is a model's reading of what they typed. A reader that
  // saw only OWNER would quote a paraphrase back as their own words.
  check("recorded as the owner's own", goals[0]?.provenance, "OWNER");
  check("attributed to them", goals[0]?.statedById, owner.id);
  check("and marked as J4's reading of it", goals[0]?.modelExtracted, true);
  assert("with a progress line while it worked",
    goalCtx.statuses.length > 0, goalCtx.statuses.join(" | "));

  // ==========================================================================
  console.log("\n=== 3. Nonsense from the model is refused, not stored ===\n");
  // ==========================================================================
  // `input` is whatever the model emitted — a cast, never a parse. A bare
  // registry lookup on an unknown entityType threw and took the whole turn
  // down; confirming a capture that never happened would be worse still.
  const unknownType = await capture(contextFor(store.id, owner.id, { entityType: "invoice", data: {} }));
  check("an unregistered entity type is refused",
    unknownType.handled ? "handled" : unknownType.reason, "invalid_input");

  // The registry-lookup sibling rule: `"constructor" in ENTITY_REGISTRY` is
  // true, and this codebase has shipped that defect before.
  const prototypeKey = await capture(contextFor(store.id, owner.id, { entityType: "constructor", data: {} }));
  check("a prototype key is refused the same way",
    prototypeKey.handled ? "handled" : prototypeKey.reason, "invalid_input");

  const malformed = await capture(contextFor(store.id, owner.id, { entityType: "goal", data: { description: 42 } }));
  check("a malformed goal is refused",
    malformed.handled ? "handled" : malformed.reason, "invalid_input");

  const missingInput = await capture(contextFor(store.id, owner.id, undefined));
  check("no input at all is refused rather than crashing",
    missingInput.handled ? "handled" : missingInput.reason, "invalid_input");

  check("and none of them wrote anything", (await queryRecords(store.id, "goal")).length, 1);

  // ==========================================================================
  console.log("\n=== 4. A serious challenge becomes something J4 watches ===\n");
  // ==========================================================================
  const challengeCtx = contextFor(store.id, owner.id, {
    entityType: "challenge",
    data: {
      description: "The lease on the current unit ends in December",
      category: "operations",
      severity: "high",
    },
  });
  assert("the challenge is captured", (await capture(challengeCtx)).handled);

  const challenges = await queryRecords(store.id, "challenge");
  check("it is on file", challenges.length, 1);
  const watched = await prisma.genesisObservation.findMany({ where: { storeId: store.id } });
  assert("and J4 is watching it", watched.length > 0, `${watched.length} observations`);
  check("as something urgent", watched[0]?.genesisState, "urgent");
  const finding = await prisma.cognitiveOutput.findMany({
    where: { storeId: store.id, status: "ACTIVE" },
  });
  assert("with a real finding behind it", finding.length > 0, `${finding.length} outputs`);

  // A LOW-SEVERITY ONE IS NOT. Watching everything is the same as watching
  // nothing, and a stale urgent card is something the owner has to dismiss.
  const quietCtx = contextFor(store.id, owner.id, {
    entityType: "challenge",
    data: { description: "The website copy could be tighter", category: "marketing", severity: "low" },
  });
  assert("a minor challenge is captured too", (await capture(quietCtx)).handled);
  check("but does not raise anything urgent for itself",
    (await prisma.genesisObservation.count({ where: { storeId: store.id } })), watched.length);

  // ==========================================================================
  console.log("\n=== 5. Approving changes reports what really happened ===\n");
  // ==========================================================================
  // The handler that moves real state, and the one that had no test at all.
  // `execute` is injectable precisely so the failure branches are reachable —
  // they are the ones that decide whether J4 claims something it did not do.
  const succeeding = makeApprovePendingChanges(async () => ({ ok: true, summary: "Applied 2 changes." }));
  const applied = await succeeding(contextFor(store.id, owner.id, {}));
  check("a successful run reports the real summary",
    applied.handled && applied.reply, "Applied 2 changes.");

  // A PERMISSION FAILURE IS NOT A CRASH AND NOT A SUCCESS. ANALYTICS_VIEW is
  // stricter than the tool's own store:manage, so a member who passed the tool
  // check can still legitimately land here.
  const refused = makeApprovePendingChanges(async () => {
    throw new Error("You don't have permission to do this.");
  });
  const refusedResult = await refused(contextFor(store.id, owner.id, {}));
  assert("a permission failure still produces a reply", refusedResult.handled);
  if (!refusedResult.handled) throw new Error("unreachable");
  assert("that says who can do it",
    refusedResult.reply.includes("store owner"), refusedResult.reply);
  assert("and does not claim anything was applied",
    !/applied|done|changed/i.test(refusedResult.reply), refusedResult.reply);

  const broke = makeApprovePendingChanges(async () => {
    throw new Error("connection reset");
  });
  const brokeResult = await broke(contextFor(store.id, owner.id, {}));
  assert("an unexpected failure produces a reply too", brokeResult.handled);
  if (!brokeResult.handled) throw new Error("unreachable");
  // THE ASSERTION THAT MATTERS MOST IN THIS FILE. Reporting success on a throw
  // is exactly the failure the standing rule against claiming a change that did
  // not happen exists to prevent — and nothing checked it until now.
  assert("and says the changes are still pending rather than applied",
    brokeResult.reply.includes("still pending"), brokeResult.reply);
  assert("never claiming the work was done",
    !/applied \d|all set|done/i.test(brokeResult.reply), brokeResult.reply);

  // ==========================================================================
  console.log("\n=== 5b. Taking somebody somewhere goes where it says ===\n");
  // ==========================================================================
  // The rule this branch exists to keep: J4 must never say one place and go to
  // another. It broke exactly that way once — "office" mapped to Studio, so J4
  // said "Taking you to the Office" and took the owner to Studio instead.
  const takeMeThere = makeTakeMeThere((href) => `/b/copper-and-coil${href.replace("/dashboard", "")}`);

  const toCommerce = await takeMeThere(contextFor(store.id, owner.id, { destination: "commerce", intent: null }));
  assert("a real destination is handled", toCommerce.handled);
  if (!toCommerce.handled) throw new Error("unreachable");
  assert("it says where it is going", toCommerce.reply.includes("Commerce"), toCommerce.reply);
  // AND GOES THERE. Said and done must match.
  assert("and goes to the place it named",
    (toCommerce.navigate ?? "").includes("/orders"), String(toCommerce.navigate));
  // ADDRESSED AT THIS BUSINESS. The raw hrefs are the legacy /dashboard/...
  // spelling, which resolves the ACCOUNT'S ACTIVE business — so an owner in one
  // business could be navigated into another.
  assert("addressed at the business the owner is in",
    (toCommerce.navigate ?? "").startsWith("/b/copper-and-coil"), String(toCommerce.navigate));
  assert("never the ambient legacy path",
    !(toCommerce.navigate ?? "").startsWith("/dashboard"), String(toCommerce.navigate));

  // THE OFFICE IS ANSWERED, NOT NAVIGATED, because it has no route of its own.
  const office = await takeMeThere(contextFor(store.id, owner.id, { destination: "office", intent: null }));
  assert("the Office is handled", office.handled);
  if (!office.handled) throw new Error("unreachable");
  check("without moving anybody", office.navigate, undefined);
  assert("and says where the door actually is", office.reply === OFFICE_REPLY, office.reply);

  // Asked to go somewhere and unable to work out where: honest, and logged as a
  // failure so it stays visible rather than counting as a good turn.
  const nowhere = await takeMeThere(contextFor(store.id, owner.id, { destination: "atlantis", intent: null }));
  assert("an unknown destination is handled rather than crashing", nowhere.handled);
  if (!nowhere.handled) throw new Error("unreachable");
  check("it moves nobody", nowhere.navigate, undefined);
  check("and is recorded as a failure", nowhere.outcome, "failure");
  assert("while still saying something useful",
    nowhere.reply.toLowerCase().includes("not sure"), nowhere.reply);

  // THE MIRROR. NAV_DESTINATIONS restates the schema's own enum, and the
  // mismatch degrades silently: a destination the schema accepts and the map
  // lacks tells the owner "I'm not sure where you want to go" about a place J4
  // was explicitly asked for.
  const schemaDestinations = TakeMeThereInputSchema.shape.destination.options as readonly string[];
  check("every destination the schema accepts can be reached (or is the Office)",
    schemaDestinations.filter((d) => d !== "office" && !Object.hasOwn(NAV_DESTINATIONS, d)), []);
  check("and nothing is mapped that the schema would never send",
    Object.keys(NAV_DESTINATIONS).filter((d) => !schemaDestinations.includes(d)), []);
  assert("the Office is deliberately absent from the map",
    !Object.hasOwn(NAV_DESTINATIONS, "office"),
    "mapping it to any href is how J4 said one place and went to another");

  // Bound by the route, because only the request knows the slug.
  const bound = routeToolHandlers({ resolveHref: (h) => `/b/x${h}` });
  assert("the route binds a navigation handler", typeof bound.take_me_there === "function");

  // ==========================================================================
  console.log("\n=== 5c. Proposing a removal never removes anything ===\n");
  // ==========================================================================
  // delete_product is a hard-locked destructive-category action. This handler
  // writes proposals and stops — and until now nothing checked that, on the one
  // capability where being wrong is irreversible.
  const removal = handlerFor("request_product_removal")!;
  const ring = await prisma.product.create({
    data: { storeId: store.id, name: "Tensor Ring", priceInCents: 8_500, active: true },
  });
  const cuff = await prisma.product.create({
    data: { storeId: store.id, name: "Copper Cuff", priceInCents: 4_500, active: true },
  });
  const catalogue = [
    { id: ring.id, name: ring.name },
    { id: cuff.id, name: cuff.name },
  ];

  const proposed = await removal(
    contextFor(store.id, owner.id, { scope: "specific", productNames: ["Tensor Ring"] }, "", catalogue)
  );
  assert("the proposal is handled", proposed.handled);
  if (!proposed.handled) throw new Error("unreachable");

  // THE ASSERTION THAT MATTERS MOST IN THIS FILE.
  check("both products still exist", await prisma.product.count({ where: { storeId: store.id } }), 2);
  const requests = await prisma.approvalRequest.findMany({
    where: { storeId: store.id, actionType: "delete_product" },
  });
  check("one proposal was written", requests.length, 1);
  check("awaiting the owner's decision", requests[0]?.status, "PENDING_APPROVAL");
  check("for the right product", (requests[0]?.input as { productId: string }).productId, ring.id);
  // The log must not read as a completed deletion.
  check("logged as pending rather than done", proposed.executionStatus, "PENDING");
  assert("and the reply says permanently, so approving is unambiguous",
    proposed.reply.includes("permanently"), proposed.reply);

  // A FRESH PROPOSAL SUPERSEDES A STALE ONE, so approving cannot delete twice
  // and the owner is not shown the same decision more than once.
  await removal(contextFor(store.id, owner.id, { scope: "specific", productNames: ["tensor ring"] }, "", catalogue));
  check("re-proposing the same product does not stack up decisions",
    await prisma.approvalRequest.count({ where: { storeId: store.id, actionType: "delete_product" } }), 1);

  // Matching is trimmed and case-folded because the model is repeating a name
  // the merchant typed, not quoting the database.
  check("names match regardless of case and spacing",
    resolveScopedProducts(catalogue, "specific", ["  TENSOR ring "]).map((p) => p.name), ["Tensor Ring"]);
  check("everything means everything", resolveScopedProducts(catalogue, "all", null).length, 2);
  // AN UNRESOLVED SCOPE PROPOSES NOTHING. Removing the wrong product is
  // irreversible, so the honest move is a question naming what exists.
  check("an unknown scope resolves to nothing", resolveScopedProducts(catalogue, null, null), []);
  check("and a name that matches nothing resolves to nothing",
    resolveScopedProducts(catalogue, "specific", ["Something else"]), []);

  const unresolved = await removal(
    contextFor(store.id, owner.id, { scope: "specific", productNames: ["Something else"] }, "", catalogue)
  );
  assert("an unmatched name is handled", unresolved.handled);
  if (!unresolved.handled) throw new Error("unreachable");
  check("it proposes nothing",
    await prisma.approvalRequest.count({ where: { storeId: store.id, actionType: "delete_product" } }), 1);
  check("and is recorded as a failure", unresolved.outcome, "failure");
  assert("while naming what the store actually has",
    unresolved.reply.includes("Tensor Ring") && unresolved.reply.includes("Copper Cuff"), unresolved.reply);
  assert("and never guesses at the closest match",
    !unresolved.reply.toLowerCase().includes("did you mean copper"), unresolved.reply);

  // "All" is a real scope and must reach every active product.
  await removal(contextFor(store.id, owner.id, { scope: "all", productNames: null }, "", catalogue));
  check("removing everything proposes one decision per product",
    await prisma.approvalRequest.count({ where: { storeId: store.id, actionType: "delete_product" } }), 2);
  check("and still deletes nothing", await prisma.product.count({ where: { storeId: store.id } }), 2);

  // ==========================================================================
  console.log("\n=== 5d. An answer about money uses the outcome's words ===\n");
  // ==========================================================================
  // The reply here has to say both what was learned AND what is still unknown,
  // and the model wrote its text before any of that was known. Using its words
  // would state a conclusion about somebody's money that nothing had reached.
  const economics = makeAnswerSupplierEconomics(async () => ({
    status: "applied",
    reply: "Noted 100 minimum at 4.10 each. I still don't know the shipping.",
    question: { productId: "p1" },
    result: { changes: ["minimumOrderUnits"], stillMissing: ["shipping"] },
  }));
  // The real tool schema, in full — a fixture that skipped a field would be
  // testing a shape the model can never send.
  const quoted = {
    productName: "Tensor Ring",
    outcome: "quoted" as const,
    minimumOrderUnits: 100,
    bulkUnitCostInCents: 410,
    shippingPerUnitInCents: null,
    leadTimeDays: 14,
    note: null,
  };
  const answered = await economics(contextFor(store.id, owner.id, quoted, "All done!"));
  assert("the answer is handled", answered.handled);
  if (!answered.handled) throw new Error("unreachable");
  assert("the reply is the outcome's, not the model's",
    answered.reply.includes("still don't know") && answered.reply !== "All done!", answered.reply);
  assert("and it says what is still unknown",
    answered.reply.toLowerCase().includes("shipping"), answered.reply);
  check("the dashboard is marked for re-render", answered.revalidate, "/dashboard");

  // NEVER BUILD AN ANSWER ABOUT MONEY OUT OF A SHAPE THAT DID NOT VALIDATE.
  const badShape = await makeAnswerSupplierEconomics(async () => {
    throw new Error("should never be reached");
  })(contextFor(store.id, owner.id, { ...quoted, minimumOrderUnits: "loads" }));
  check("a malformed economics answer is refused before anything is applied",
    badShape.handled ? "handled" : badShape.reason, "invalid_input");

  // ==========================================================================
  console.log("\n=== 5e. Campaigns and compositions never invent what they lack ===\n");
  // ==========================================================================
  // Both of these produce something the owner will look at, and both can
  // legitimately produce nothing. The failure worth guarding is the cheerful
  // reply about work that does not exist.
  const emptyPlan = await makePlanCampaign(async () => null)(contextFor(store.id, owner.id, {}));
  assert("a campaign that could not be planned is still handled", emptyPlan.handled);
  if (!emptyPlan.handled) throw new Error("unreachable");
  assert("and says so rather than implying a plan exists",
    emptyPlan.reply.includes("wasn't able"), emptyPlan.reply);
  check("recorded as a failure", emptyPlan.outcome, "failure");
  check("with no group to point at", (emptyPlan.metadata as { groupId: unknown }).groupId, null);

  const realPlan = await makePlanCampaign(async () => ({
    name: "Spring rings",
    groupId: "grp-1",
    channels: [{ channel: "email" }, { channel: "instagram" }],
  }))(contextFor(store.id, owner.id, {}));
  assert("a real plan is described", realPlan.handled);
  if (!realPlan.handled) throw new Error("unreachable");
  assert("by name", realPlan.reply.includes("Spring rings"), realPlan.reply);
  assert("and by channel, so the owner knows what was actually planned",
    realPlan.reply.includes("email") && realPlan.reply.includes("instagram"), realPlan.reply);
  check("carrying the group it belongs to", (realPlan.metadata as { groupId: unknown }).groupId, "grp-1");

  // COMPOSING NEVER INVENTS ARTWORK. A store without enough of the owner's own
  // images is told exactly that, and what to do about it.
  const noImages = await makeCreateComposition(async () => null)(
    contextFor(store.id, owner.id, { surface: "section.collage", columns: 2, subject: null })
  );
  assert("a composition with nothing to compose is handled", noImages.handled);
  if (!noImages.handled) throw new Error("unreachable");
  assert("and explains the real reason",
    noImages.reply.toLowerCase().includes("upload") || noImages.reply.toLowerCase().includes("images"),
    noImages.reply);
  check("recorded as a failure", noImages.outcome, "failure");
  check("and nothing is handed to the panel to draw", noImages.messageChanges, undefined);

  const composed = await makeCreateComposition(async () => ({
    used: [{ label: "Tensor Ring photo" }, { label: "Copper Cuff photo" }],
    design: { mockupUrl: "https://example.test/m.png", designId: "d1", surface: "storefront.hero" },
  }))(contextFor(store.id, owner.id, { surface: "section.collage", columns: 2, subject: null }));
  assert("a real composition is handled", composed.handled);
  if (!composed.handled) throw new Error("unreachable");
  // NAMES WHAT IT USED. A composition the owner cannot trace back to their own
  // files is indistinguishable from one J4 invented.
  assert("naming the owner's own images",
    composed.reply.includes("Tensor Ring photo") && composed.reply.includes("Copper Cuff photo"),
    composed.reply);
  check("and hands the artefact to the panel that draws it",
    (composed.messageChanges as { designId: unknown }).designId, "d1");
  check("marking Studio for re-render", composed.revalidate, "/dashboard/studio");

  // ==========================================================================
  console.log("\n=== 5f. Approving something says what kind of thing it is ===\n");
  // ==========================================================================
  // The distinction Sean called huge: something a customer can BUY versus
  // something that makes the store LOOK BETTER. An owner who thinks they just
  // added a product will go looking for it in their catalogue.
  //
  // Both of these also share a failure mode worth pinning: the underlying work
  // can fail without throwing, and reporting success then would tell somebody
  // their product exists when it does not.

  // Nothing on the table to approve.
  const nothingToPutUp = await makeApproveComposition(async () => "asset-1")(
    contextFor(store.id, owner.id, { role: "storefront.hero", summary: "A hero" })
  );
  assert("approving with no composition is handled", nothingToPutUp.handled);
  if (!nothingToPutUp.handled) throw new Error("unreachable");
  check("and recorded as a failure", nothingToPutUp.outcome, "failure");
  assert("saying there is nothing to put up",
    nothingToPutUp.reply.toLowerCase().includes("don't have a composition"), nothingToPutUp.reply);

  // A real section design to approve.
  await prisma.businessRecord.create({
    data: {
      storeId: store.id, entityType: "design", sourceProvider: "genesis_studio",
      externalId: `d-${uniq()}`,
      data: {
        assetIds: [], surface: "section.collage", arrangement: "grid", arrangementScale: null,
        printFileUrl: "https://example.test/p.png", mockupUrl: "https://example.test/m.png",
        sourceAssetUrls: [], createdAt: new Date().toISOString(),
      } as never,
      provenance: "GENERATED", modelExtracted: true,
    },
  });

  const putUp = await makeApproveComposition(async () => "asset-1")(
    contextFor(store.id, owner.id, { role: "storefront.hero", summary: "A hero" })
  );
  assert("a real composition is approved", putUp.handled);
  if (!putUp.handled) throw new Error("unreachable");
  // THE SENTENCE THAT PREVENTS THE MISUNDERSTANDING.
  assert("and is named as a storefront asset, not something for sale",
    putUp.reply.includes("not something for sale"), putUp.reply);
  assert("both surfaces that show it are marked for re-render",
    Array.isArray(putUp.revalidate) && putUp.revalidate.length === 2, JSON.stringify(putUp.revalidate));

  // SAVING FAILED IS NOT SUCCESS.
  const saveFailed = await makeApproveComposition(async () => null)(
    contextFor(store.id, owner.id, { role: "storefront.hero", summary: "A hero" })
  );
  assert("a failed save is handled", saveFailed.handled);
  if (!saveFailed.handled) throw new Error("unreachable");
  check("recorded as a failure", saveFailed.outcome, "failure");
  assert("and says nothing has changed",
    saveFailed.reply.includes("Nothing has changed"), saveFailed.reply);
  check("with nothing marked for re-render", saveFailed.revalidate, undefined);

  // ---- Creating a real product -------------------------------------------
  const productApproval = { name: "Tensor Ring Tee", priceInCents: 3200, description: null };

  const created = await makeApproveDesignAsProduct(async () => ({ status: "SUCCESS" }))(
    contextFor(store.id, owner.id, productApproval)
  );
  assert("a successful creation is handled", created.handled);
  if (!created.handled) throw new Error("unreachable");
  assert("and tells the owner where to find it",
    created.reply.includes("Commerce"), created.reply);
  assert("every surface listing products is marked for re-render",
    Array.isArray(created.revalidate) && created.revalidate.length === 3, JSON.stringify(created.revalidate));

  // THE ASSERTION THAT MATTERS. execute() never throws for a failure inside
  // run() — it returns a FAILED result. Discarding that would tell somebody
  // their product exists when it does not.
  const failedCreate = await makeApproveDesignAsProduct(async () => ({ status: "FAILED" }))(
    contextFor(store.id, owner.id, productApproval)
  );
  assert("a failed creation is still handled", failedCreate.handled);
  if (!failedCreate.handled) throw new Error("unreachable");
  check("recorded as a failure", failedCreate.outcome, "failure");
  assert("and never claims the product exists",
    !failedCreate.reply.includes("in your store now") && failedCreate.reply.includes("Nothing has changed"),
    failedCreate.reply);
  check("with nothing marked for re-render", failedCreate.revalidate, undefined);

  // A malformed approval proposes nothing rather than creating a product with
  // a guessed price.
  const badApproval = await makeApproveDesignAsProduct(async () => {
    throw new Error("should never run");
  })(contextFor(store.id, owner.id, { name: "x" }));
  assert("a malformed approval is handled without running anything", badApproval.handled);
  if (!badApproval.handled) throw new Error("unreachable");
  check("and recorded as a failure", badApproval.outcome, "failure");

  // ==========================================================================
  console.log("\n=== 5g. Making things: honest colour, honest contrast, no pressure ===\n");
  // ==========================================================================
  // Three handlers that produce artefacts, and three honesty rules that each
  // came from a real failure rather than caution.

  // ---- create_design: never invents artwork ------------------------------
  const noLogo = await makeCreateDesign({ resolveLogo: async () => null })(
    contextFor(store.id, owner.id, { surface: "garment.tshirt", assetRole: null, color: null })
  );
  assert("designing with no logo is handled", noLogo.handled);
  if (!noLogo.handled) throw new Error("unreachable");
  check("recorded as a failure", noLogo.outcome, "failure");
  // AND OFFERS, rather than making one uninvited. The offer is a sentence the
  // owner can ignore, which is the whole of the no-pressure rule.
  assert("it offers to make one rather than making one",
    noLogo.reply.includes("I can make one"), noLogo.reply);

  const design = (colorVerified: boolean | null, contrast: { sufficient: boolean; markIs: string } | null) =>
    makeCreateDesign({
      resolveLogo: async () => ({ id: "logo-1" }),
      compose: async () => ({
        designId: "d-1", mockupUrl: "https://example.test/m.png",
        color: "black", colorVerified, contrast,
      }),
    });

  // THE COLOUR IS MEASURED, NOT ASSUMED. Sean asked for a black hoodie, got a
  // grey one, and was told it was black.
  const wrongColour = await design(false, null)(
    contextFor(store.id, owner.id, { surface: "garment.tshirt", assetRole: null, color: "black" })
  );
  assert("a failed colour check is handled", wrongColour.handled);
  if (!wrongColour.handled) throw new Error("unreachable");
  assert("and J4 says so rather than naming a colour it plainly is not",
    wrongColour.reply.includes("doesn't actually look"), wrongColour.reply);

  // LOW CONTRAST IS A JUDGEMENT, NOT A RENDER ERROR. A dark mark on a black
  // garment composes perfectly and is still something nobody would sell.
  const unreadable = await design(true, { sufficient: false, markIs: "dark" })(
    contextFor(store.id, owner.id, { surface: "garment.tshirt", assetRole: null, color: "black" })
  );
  assert("low contrast is handled", unreadable.handled);
  if (!unreadable.handled) throw new Error("unreachable");
  assert("J4 raises it", unreadable.reply.includes("barely reads"), unreadable.reply);
  // AND OFFERS RATHER THAN ALTERING. Changing somebody's mark so it shows up
  // on black is a decision about their brand, and it is theirs.
  assert("and promises not to change their logo without being told",
    unreadable.reply.includes("won't change your logo"), unreadable.reply);

  const clean = await design(true, { sufficient: true, markIs: "light" })(
    contextFor(store.id, owner.id, { surface: "garment.tshirt", assetRole: null, color: "black" })
  );
  assert("a clean design is handled", clean.handled);
  if (!clean.handled) throw new Error("unreachable");
  assert("and raises neither concern",
    !clean.reply.includes("barely reads") && !clean.reply.includes("doesn't actually look"), clean.reply);
  check("Studio is marked so the bench actually shows the work", clean.revalidate, "/dashboard/studio");
  check("and the mockup rides to the panel that draws it",
    (clean.messageChanges as { designId: unknown }).designId, "d-1");
  check("logged as pending, because nothing was applied", clean.executionStatus, "PENDING");

  // ---- generate_brand_logo: the no-pressure rule, in code ----------------
  // An owner who already has a logo is FINISHED. J4 being able to make another
  // is not a reason to raise it — and this used to live only in the tool's
  // description, where the model had no data to obey it.
  const alreadyHas = await makeGenerateBrandLogo({
    hasLogo: async () => true,
    propose: async () => {
      throw new Error("should never be reached");
    },
  })(contextFor(store.id, owner.id, { ownerDirection: null, wantsAlternatives: false }));
  assert("an owner with a logo is handled without generating one", alreadyHas.handled);
  if (!alreadyHas.handled) throw new Error("unreachable");
  assert("and told J4 will work with the one they have",
    alreadyHas.reply.includes("already got a logo"), alreadyHas.reply);

  // UNLESS THEY ASK. ownerDirection is the override.
  const askedAnyway = await makeGenerateBrandLogo({
    hasLogo: async () => true,
    propose: async () => ({ proposal: { proposalId: "p-1" }, rationale: "Here is one.", groundedIn: {} }),
  })(contextFor(store.id, owner.id, { ownerDirection: "something with a wave", wantsAlternatives: false }));
  assert("an explicit request overrides it", askedAnyway.handled);
  if (!askedAnyway.handled) throw new Error("unreachable");
  assert("and a logo is actually proposed",
    askedAnyway.reply.includes("Here is one."), askedAnyway.reply);

  // ALTERNATIVES ONLY WHEN ASKED — an offer that always fires is not an offer.
  let branched = 0;
  const withAlternatives = await makeGenerateBrandLogo({
    hasLogo: async () => false,
    propose: async () => ({ proposal: { proposalId: "p-1" }, rationale: "Here is one.", groundedIn: {} }),
    branch: async () => {
      branched += 1;
      return { branches: [{}, {}] };
    },
  })(contextFor(store.id, owner.id, { ownerDirection: null, wantsAlternatives: true }));
  assert("alternatives are produced when asked for", withAlternatives.handled && branched === 1);
  if (!withAlternatives.handled) throw new Error("unreachable");
  assert("and the original is said to survive",
    withAlternatives.reply.includes("still there"), withAlternatives.reply);

  branched = 0;
  await makeGenerateBrandLogo({
    hasLogo: async () => false,
    propose: async () => ({ proposal: { proposalId: "p-1" }, rationale: "Here is one.", groundedIn: {} }),
    branch: async () => {
      branched += 1;
      return { branches: [{}] };
    },
  })(contextFor(store.id, owner.id, { ownerDirection: null, wantsAlternatives: false }));
  check("and never produced when not", branched, 0);

  const logoFailed = await makeGenerateBrandLogo({
    hasLogo: async () => false,
    propose: async () => null,
  })(contextFor(store.id, owner.id, { ownerDirection: null, wantsAlternatives: false }));
  assert("a failed generation is handled", logoFailed.handled);
  if (!logoFailed.handled) throw new Error("unreachable");
  check("recorded as a failure", logoFailed.outcome, "failure");
  // No placeholder is invented to cover it.
  assert("and no artefact is claimed",
    !logoFailed.reply.includes("Have a look below"), logoFailed.reply);

  // ---- improve_storefront: a real opinion, or none --------------------------
  const nothingWrong = await makeImproveStorefront({
    evaluate: async () => ({ findings: [], productsWithImages: 4 }),
  })(contextFor(store.id, owner.id, {}));
  assert("a healthy storefront is handled", nothingWrong.handled);
  if (!nothingWrong.handled) throw new Error("unreachable");
  // MANUFACTURING A CONCERN TO LOOK USEFUL is how an owner learns to stop
  // trusting the ones that matter.
  assert("and J4 says nothing is standing out rather than inventing a concern",
    nothingWrong.reply.includes("reasonable shape"), nothingWrong.reply);
  check("with nothing to preview", nothingWrong.messageChanges, undefined);

  // A finding with no composition behind it is still SAID — composing around a
  // gap would hide it.
  const gapOnly = await makeImproveStorefront({
    evaluate: async () => ({
      findings: [{ key: "no_photos", observed: "Two products have no photo.", wouldDo: "Add one each." }],
      productsWithImages: 1,
    }),
  })(contextFor(store.id, owner.id, {}));
  assert("a gap with nothing to compose is still raised", gapOnly.handled);
  if (!gapOnly.handled) throw new Error("unreachable");
  assert("in J4's own words", gapOnly.reply.includes("no photo"), gapOnly.reply);
  check("and nothing is composed around it", gapOnly.messageChanges, undefined);

  // THE MODEL'S OWN WORDS LEAD. Talking over a good answer with a generated
  // list is worse than saying less.
  const spoke = await makeImproveStorefront({
    evaluate: async () => ({
      findings: [{ key: "no_photos", observed: "Two products have no photo.", wouldDo: "Add one each." }],
      productsWithImages: 1,
    }),
  })(contextFor(store.id, owner.id, {}, "Your hero is doing the heavy lifting here."));
  assert("J4's own opening is kept", spoke.handled);
  if (!spoke.handled) throw new Error("unreachable");
  assert("and the generated list does not talk over it",
    spoke.reply.startsWith("Your hero is doing"), spoke.reply);

  // ==========================================================================
  console.log("\n=== 5h. Saving a file, and the regex that could never match ===\n");
  // ==========================================================================
  // THE BUG THIS SECTION EXISTS FOR. The logo-role regex once held four literal
  // BACKSPACE bytes (0x08) where its word boundaries belonged — a shell heredoc
  // turned every \\b into the control character it escapes to. It typechecked,
  // it linted, it read correctly in an editor, and it was false for EVERY
  // input. So "save this as my logo" never normalised onto brand.logo, never
  // set Store.logoUrl, and "put my logo on a t-shirt" could not find the logo
  // the owner had just handed over.
  //
  // The only test that would have caught it is one asserting the regex MATCHES.
  assert("the logo role matches the obvious words",
    isLogoRoleName("logo") && isLogoRoleName("my logo") && isLogoRoleName("primary logo"),
    "this is the assertion the backspace-byte bug needed");
  assert("and the plural, and the other word for it",
    isLogoRoleName("logos") && isLogoRoleName("brand mark"));
  assert("case does not matter", isLogoRoleName("LOGO") && isLogoRoleName("Brand Mark"));
  // Word boundaries are load-bearing: a role that merely contains the letters
  // is not a logo.
  check("but a word that only contains it is not", isLogoRoleName("logotype-ish catalogue"), false);
  check("and nothing is not a logo", isLogoRoleName(null), false);

  assert("the hero role matches too",
    isHeroRoleName("hero") && isHeroRoleName("hero image") && isHeroRoleName("banner"));
  check("and an unrelated role is neither",
    [isLogoRoleName("supplier agreement"), isHeroRoleName("supplier agreement")], [false, false]);

  // ---- The handler itself -------------------------------------------------
  const assetStore = await prisma.store.create({
    data: { userId: owner.id, name: "Asset Shop", slug: `th-asset-${uniq()}` },
  });

  // Nothing uploaded: say so, rather than confirming a save that did not happen.
  const nothingUploaded = await makeManageBusinessAsset({})(
    contextFor(assetStore.id, owner.id, { role: "logo" })
  );
  assert("saving with nothing uploaded is handled", nothingUploaded.handled);
  if (!nothingUploaded.handled) throw new Error("unreachable");
  assert("and says there is nothing to save",
    nothingUploaded.reply.includes("don't see anything uploaded"), nothingUploaded.reply);

  await prisma.businessRecord.create({
    data: {
      storeId: assetStore.id, entityType: "asset", sourceProvider: "genesis_upload",
      externalId: `a-${uniq()}`,
      data: {
        fileType: "photo", category: "brand_asset", storageUrl: "https://example.test/logo.png",
        originalFilename: "logo.png", summary: null, extractionConfidence: null,
        relatedRecordId: null, relatedEntityType: null, role: null, origin: "uploaded",
        supersedesAssetId: null, supersededByAssetId: null, generationPrompt: null,
        aiUsageEventId: null, createdAt: new Date().toISOString(),
      } as never,
      provenance: "OWNER", modelExtracted: false,
    },
  });

  // THE PATH THE BUG BROKE: saying "my logo" must reach brand.logo AND set
  // Store.logoUrl, because that column is what every render path reads.
  const designated: { role: string }[] = [];
  const savedAsLogo = await makeManageBusinessAsset({
    designate: async (_s, _r, role) => {
      designated.push({ role });
    },
  })(contextFor(assetStore.id, owner.id, { role: "my logo" }));
  assert("saving as a logo is handled", savedAsLogo.handled);
  if (!savedAsLogo.handled) throw new Error("unreachable");
  check("it normalises onto the canonical brand role", designated.map((d) => d.role), ["brand.logo"]);
  const withLogo = await prisma.store.findUniqueOrThrow({ where: { id: assetStore.id } });
  check("and Store.logoUrl is kept in step", withLogo.logoUrl, "https://example.test/logo.png");

  // A ROLE NOBODY ANTICIPATED IS KEPT AS THEY SAID IT. The vocabulary is open.
  designated.length = 0;
  const custom = await makeManageBusinessAsset({
    designate: async (_s, _r, role) => {
      designated.push({ role });
    },
  })(contextFor(assetStore.id, owner.id, { role: "supplier agreement" }));
  check("an unanticipated role is kept verbatim", designated.map((d) => d.role), ["supplier agreement"]);
  assert("and named back to them", custom.handled && custom.reply.includes("supplier agreement"));

  // NO ROLE: kept on file, and the question is asked rather than a role guessed.
  const noRole = await makeManageBusinessAsset({})(contextFor(assetStore.id, owner.id, { role: null }));
  assert("a file with no stated role is handled", noRole.handled);
  if (!noRole.handled) throw new Error("unreachable");
  assert("kept on file, with the question asked rather than a role guessed",
    noRole.reply.includes("already saved") && noRole.reply.includes("specific role"), noRole.reply);

  // ---- The hero, and the honesty about whether it will SHOW ---------------
  // Sean's report in its most direct form: designation used to be the whole of
  // the change — a role on a record and a page that never moved.
  let heroSetTo: string | null = null;
  const heroVisible = await makeManageBusinessAsset({
    designate: async () => {},
    setHero: async (_s, url) => {
      heroSetTo = url;
    },
    heroWouldShow: async () => true,
  })(contextFor(assetStore.id, owner.id, { role: "hero image" }));
  check("the storefront is actually changed, not just the record", heroSetTo, "https://example.test/logo.png");
  assert("and the owner is told it is up", heroVisible.handled && heroVisible.reply.includes("top of your storefront"));

  // THREE OF THE FOUR HERO LAYOUTS RENDER NO IMAGE, and the default is one of
  // them. Telling an owner their photo is on the site when the layout cannot
  // show one is the failure this whole thread is about.
  const heroHidden = await makeManageBusinessAsset({
    designate: async () => {},
    setHero: async () => {},
    heroWouldShow: async () => false,
  })(contextFor(assetStore.id, owner.id, { role: "hero" }));
  assert("a hero that will not render is handled", heroHidden.handled);
  if (!heroHidden.handled) throw new Error("unreachable");
  assert("and J4 says it will not appear yet, rather than claiming it is up",
    heroHidden.reply.includes("won't appear yet"), heroHidden.reply);
  assert("offering the fix rather than performing it",
    heroHidden.reply.includes("Say the word"), heroHidden.reply);

  await prisma.store.deleteMany({ where: { id: assetStore.id } });

  // ==========================================================================
  console.log("\n=== 5i. Partial results are reported as partial ===\n");
  // ==========================================================================
  // Two proposal handlers where the normal case is that SOME of it worked.
  // Saying "done" over the top of that leaves an owner believing every product
  // was handled — which is the same failure as reporting a change that did not
  // happen, one step removed.

  const shop = await prisma.store.create({
    data: { userId: owner.id, name: "Partial Shop", slug: `th-partial-${uniq()}` },
  });
  const alpha = await prisma.product.create({
    data: { storeId: shop.id, name: "Alpha", priceInCents: 1000, active: true, description: "Old alpha copy" },
  });
  const beta = await prisma.product.create({
    data: { storeId: shop.id, name: "Beta", priceInCents: 2000, active: true, description: "Old beta copy" },
  });
  const twoProducts = [
    { id: alpha.id, name: "Alpha", description: "Old alpha copy", imageUrl: null, priceInCents: 1000 },
    { id: beta.id, name: "Beta", description: "Old beta copy", imageUrl: null, priceInCents: 2000 },
  ];

  // ---- request_image_change ----------------------------------------------
  const partialImages = await makeRequestImageChange(async (args) =>
    args.name === "Alpha" ? { url: "https://example.test/a.png" } : null
  )(contextFor(shop.id, owner.id, { scope: "all", productNames: null }, "", twoProducts));
  assert("a partial image result is handled", partialImages.handled);
  if (!partialImages.handled) throw new Error("unreachable");
  check("only the one that found a photo is proposed",
    await prisma.approvalRequest.count({ where: { storeId: shop.id, actionType: "update_product_image" } }), 1);
  // THE MISS IS NAMED, with the honest suggestion.
  assert("the miss is named rather than glossed over",
    partialImages.reply.includes("Beta") && partialImages.reply.includes("upload"), partialImages.reply);
  check("logged as pending, because something is awaiting a decision",
    partialImages.executionStatus, "PENDING");

  // Nothing found at all is a WARNING and retryable, not a quiet success.
  const noImages2 = await makeRequestImageChange(async () => null)(
    contextFor(shop.id, owner.id, { scope: "all", productNames: null }, "", twoProducts)
  );
  assert("finding nothing is handled", noImages2.handled);
  if (!noImages2.handled) throw new Error("unreachable");
  check("recorded as a failure", noImages2.outcome, "failure");
  check("logged as a warning", noImages2.executionStatus, "WARNING");
  check("and marked retryable", noImages2.retryable, true);

  // A replacement must never be the thing it replaces.
  const withCurrent = [{ ...twoProducts[0], imageUrl: "https://example.test/current.png" }];
  let excluded: string[] = [];
  await makeRequestImageChange(async (args) => {
    excluded = args.excludeUrls;
    return { url: "https://example.test/new.png" };
  })(contextFor(shop.id, owner.id, { scope: "all", productNames: null }, "", withCurrent));
  check("the current image is excluded from the search", excluded, ["https://example.test/current.png"]);

  // ---- request_product_content_change -------------------------------------
  // A SUGGESTION THAT CHANGES NOTHING IS NOT A PROPOSAL. A decision card that
  // turns out to change nothing wastes the owner's attention.
  const noRealChange = await makeRequestProductContentChange(async () => [
    { productId: alpha.id, name: "Alpha", description: "Old alpha copy", reasoning: "Already good" },
  ])(contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Alpha"], changeType: "both" }, "", twoProducts));
  assert("an identical suggestion is handled", noRealChange.handled);
  if (!noRealChange.handled) throw new Error("unreachable");
  check("no decision is written for it",
    await prisma.approvalRequest.count({ where: { storeId: shop.id, actionType: "update_product" } }), 0);
  // AND THE PRODUCT IS NAMED as left alone — dropping it silently would leave
  // the owner wondering which products J4 even looked at.
  assert("and the product is named as left alone",
    noRealChange.reply.includes("Alpha") && noRealChange.reply.includes("unchanged"), noRealChange.reply);
  check("recorded as a failure with nothing to approve", noRealChange.outcome, "failure");

  const realChange = await makeRequestProductContentChange(async () => [
    { productId: alpha.id, name: "Alpha Ring", description: "Better copy", reasoning: "Clearer" },
    { productId: beta.id, name: "Beta", description: "Old beta copy", reasoning: "Fine already" },
  ])(contextFor(shop.id, owner.id, { scope: "all", productNames: null, changeType: "both" }, "", twoProducts));
  assert("a real change is proposed", realChange.handled);
  if (!realChange.handled) throw new Error("unreachable");
  check("exactly one decision is written",
    await prisma.approvalRequest.count({ where: { storeId: shop.id, actionType: "update_product" } }), 1);
  const contentRequest = await prisma.approvalRequest.findFirstOrThrow({
    where: { storeId: shop.id, actionType: "update_product" },
  });
  // THE PREVIOUS VALUES ARE THE REAL ONES, so the approval card diffs against
  // ground truth rather than the model's restatement of it.
  check("with the product's real previous name",
    (contentRequest.previousValues as { name: string }).name, "Alpha");
  check("and the products still say what they said",
    (await prisma.product.findUniqueOrThrow({ where: { id: alpha.id } })).name, "Alpha");
  assert("while the one that needed nothing is named as unchanged",
    realChange.reply.includes("Beta"), realChange.reply);

  // Changing only the name must not smuggle a description change through.
  await prisma.approvalRequest.deleteMany({ where: { storeId: shop.id } });
  await makeRequestProductContentChange(async () => [
    { productId: alpha.id, name: "Alpha Ring", description: "A totally new description", reasoning: "x" },
  ])(contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Alpha"], changeType: "name" }, "", twoProducts));
  const nameOnly = await prisma.approvalRequest.findFirstOrThrow({
    where: { storeId: shop.id, actionType: "update_product" },
  });
  check("a name-only request proposes only a name",
    Object.keys(nameOnly.input as Record<string, unknown>).sort(), ["name", "productId"]);

  // ---- the scope question, and the loop it used to cause ------------------
  // A merchant asks for something J4 cannot pin to a product. The reply must
  // never be the MODEL's own words: those restate the merchant's sentence back
  // as a question and advance nothing. And asking the SAME question twice is
  // the loop this exists to break — the second ask has to become answerable.
  const modelEcho = "You'd like to change a product photo?";

  const askedOnce = await makeRequestImageChange(async () => null)(
    contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Nothing Real"] }, modelEcho, twoProducts)
  );
  assert("an unresolvable scope is still handled", askedOnce.handled);
  if (!askedOnce.handled) throw new Error("unreachable");
  assert("the clarification is never the model's own words",
    !askedOnce.reply.includes(modelEcho), askedOnce.reply);
  assert("it asks the one detectable question",
    askedOnce.reply.includes(SCOPE_QUESTION), askedOnce.reply);
  assert("grounded in the products that actually exist",
    askedOnce.reply.includes("Alpha") && askedOnce.reply.includes("Beta"), askedOnce.reply);
  check("and nothing is proposed off an unmatched name",
    await prisma.approvalRequest.count({ where: { storeId: shop.id, actionType: "update_product_image" } }), 0);

  // ASKING AGAIN ESCALATES. Same question, same failure — so the second turn
  // stops repeating and offers something answerable with one character.
  const askedTwice = await makeRequestImageChange(async () => null)(
    contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Nothing Real"] }, modelEcho, twoProducts,
      askedOnce.reply)
  );
  assert("asking again is handled", askedTwice.handled);
  if (!askedTwice.handled) throw new Error("unreachable");
  assert("the second ask does not repeat the first",
    askedTwice.reply !== askedOnce.reply, "J4 asked the identical question twice");
  assert("it escalates to a numbered list",
    askedTwice.reply.includes("1. Alpha") && askedTwice.reply.includes("2. Beta"), askedTwice.reply);

  // The escalation is driven by the QUESTION, not by any assistant turn: an
  // unrelated previous reply must not suppress the first ask.
  const unrelated = await makeRequestImageChange(async () => null)(
    contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Nothing Real"] }, modelEcho, twoProducts,
      "Your storefront is live.")
  );
  assert("an unrelated previous turn still gets the plain ask", unrelated.handled);
  if (!unrelated.handled) throw new Error("unreachable");
  check("which is the same first ask", unrelated.reply, askedOnce.reply);

  // All three scope sites share the phrase — if one drifts, repeat-detection
  // silently stops working there and the loop comes back for that tool only.
  const removalAsk = await TOOL_HANDLERS.request_product_removal(
    contextFor(shop.id, owner.id, { scope: "specific", productNames: ["Nothing Real"] }, modelEcho, twoProducts)
  );
  assert("removal asks the detectable question", removalAsk.handled);
  if (!removalAsk.handled) throw new Error("unreachable");
  assert("removal uses the shared phrase", removalAsk.reply.includes(SCOPE_QUESTION), removalAsk.reply);
  assert("and not the model's words", !removalAsk.reply.includes(modelEcho), removalAsk.reply);

  const contentAsk = await makeRequestProductContentChange(async () => [])(
    contextFor(shop.id, owner.id,
      { scope: "specific", productNames: ["Nothing Real"], changeType: "both" }, modelEcho, twoProducts)
  );
  assert("a content change asks it too", contentAsk.handled);
  if (!contentAsk.handled) throw new Error("unreachable");
  assert("with the shared phrase", contentAsk.reply.includes(SCOPE_QUESTION), contentAsk.reply);
  assert("and not the model's words", !contentAsk.reply.includes(modelEcho), contentAsk.reply);

  // A store with nothing to act on gets told that, not asked to choose from
  // an empty list.
  const emptyStore = await makeRequestImageChange(async () => null)(
    contextFor(shop.id, owner.id, { scope: "all", productNames: null }, modelEcho, [])
  );
  assert("an empty catalogue is handled", emptyStore.handled);
  if (!emptyStore.handled) throw new Error("unreachable");
  assert("and is told there is nothing to change yet",
    !emptyStore.reply.includes(SCOPE_QUESTION) && emptyStore.reply.includes("add one first"), emptyStore.reply);

  // ---- refine_storefront: a rebuttal revises, it does not restart ---------
  let opened = 0;
  let revised = 0;
  const refineWith = (open: { proposalId: string; settled: boolean; current: { target: string | null } } | null) =>
    makeRefineStorefront({
      openProposal: async () => open,
      revise: async () => {
        revised += 1;
      },
      open: async () => {
        opened += 1;
      },
      currentTheme: async () => null,
    });

  const refineInput = {
    target: "hero",
    summary: "Make the hero calmer.",
    reason: "It is shouting.",
    // The ACTION's schema, not the tool's: changes are dimension/value pairs
    // drawn from a closed vocabulary, so an invalid one is rejected before it
    // could reach an executable.
    changes: [{ dimension: "heroLayout", value: "split" }],
  };

  await refineWith(null)(contextFor(shop.id, owner.id, refineInput));
  check("with nothing on the table, a new proposal is opened", [opened, revised], [1, 0]);

  // SAME TARGET, STILL OPEN: revise. The version this replaced DELETED the
  // earlier row — answering the rebuttal and destroying the evidence of it in
  // one operation, so "go back to your first idea" referred to something that
  // no longer existed.
  opened = 0;
  revised = 0;
  const pushBack = await refineWith({ proposalId: "p-1", settled: false, current: { target: "hero" } })(
    contextFor(shop.id, owner.id, refineInput)
  );
  check("pushing back on the same target revises it", [opened, revised], [0, 1]);
  assert("and J4 speaks as somebody improving their own idea", pushBack.handled);
  if (!pushBack.handled) throw new Error("unreachable");
  assert("saying it has been revised", pushBack.reply.includes("revised it below"), pushBack.reply);

  // A DIFFERENT TARGET IS ITS OWN PROPOSAL, so a pending hero idea and a
  // pending products idea coexist.
  opened = 0;
  revised = 0;
  await refineWith({ proposalId: "p-1", settled: false, current: { target: "products.layout" } })(
    contextFor(shop.id, owner.id, refineInput)
  );
  check("a different target opens its own", [opened, revised], [1, 0]);

  // A SETTLED PROPOSAL IS NOT REVISED — it is decided, and reopening it would
  // change something the owner already answered.
  opened = 0;
  revised = 0;
  await refineWith({ proposalId: "p-1", settled: true, current: { target: "hero" } })(
    contextFor(shop.id, owner.id, refineInput)
  );
  check("and a settled one is left alone", [opened, revised], [1, 0]);

  // Malformed input proposes nothing.
  opened = 0;
  const badRefine = await refineWith(null)(contextFor(shop.id, owner.id, { target: "hero" }));
  check("a malformed refinement opens nothing", opened, 0);
  assert("and asks which part they meant", badRefine.handled);
  if (!badRefine.handled) throw new Error("unreachable");
  check("recorded as a failure", badRefine.outcome, "failure");

  await prisma.store.deleteMany({ where: { id: shop.id } });

  // ==========================================================================
  console.log("\n=== 6. Handlers stay inside the store they were given ===\n");
  // ==========================================================================
  check("the neighbour has no goals", (await queryRecords(other.id, "goal")).length, 0);
  check("nor challenges", (await queryRecords(other.id, "challenge")).length, 0);
  check("nor anything J4 is watching",
    await prisma.genesisObservation.count({ where: { storeId: other.id } }), 0);
  check("nor a decision awaiting them",
    await prisma.approvalRequest.count({ where: { storeId: other.id } }), 0);
  check("nor a product",
    await prisma.product.count({ where: { storeId: other.id } }), 0);

  // ==========================================================================
  console.log("\n=== 7. A tool does one thing, whichever path served it ===\n");
  // ==========================================================================
  // THE MIGRATION IS FINISHED, and this is what "finished" has to mean. Two
  // separate implementations of the same turn is what let these paths drift:
  // asking for a logo on the Server Action ran a store-content regeneration,
  // because that path had no branch for it and fell through. So:
  //
  //   - every tool in the catalogue has a handler (nothing falls through),
  //   - neither path still carries an inline branch (nothing runs twice),
  //   - and both dispatch through the same runner (nothing can drift again).
  //
  // Asserted against the real files rather than trusted, because the failure
  // mode is silent: a tool with no home does not error, it does the wrong thing.
  const route = readFileSync(join(process.cwd(), "app", "api", "chat", "route.ts"), "utf8");
  const serverAction = readFileSync(join(process.cwd(), "app", "dashboard", "ai-actions.ts"), "utf8");
  const catalog = buildStoreChatUnifiedTools().map((t) => t.name);

  check("every migrated tool is a real tool",
    MIGRATED_TOOLS.filter((n) => !catalog.includes(n)), []);
  // edit_store_content is the one exception, and deliberately so: it is the
  // legacy content pipeline, still owned by the Server Action, and it is named
  // here rather than skipped silently.
  check("and every real tool but edit_store_content has a handler",
    catalog.filter((n) => !MIGRATED_TOOLS.includes(n) && n !== "edit_store_content"), []);

  for (const [label, source] of [["route", route], ["Server Action", serverAction]] as const) {
    // The dispatch shape specifically. edit_store_content is still NAMED on
    // the route — it is what the fallback event reports — but naming a tool is
    // not branching on it, and only a branch can run the work twice.
    check(`no tool still has an inline branch on the ${label}`,
      catalog.filter((n) => source.includes(`if (chosenTool?.name === "${n}")`)), []);
    assert(`the ${label} dispatches through the shared runner`,
      source.includes("await runPlannedTools({"),
      "otherwise the two paths can answer the same question differently again");
    assert(`and the ${label} persists the turn through it`,
      source.includes("persistToolTurn({"),
      "otherwise what is stored and what is shown can disagree");
  }

  // Bound with the real resolver, not a placeholder — an unbound navigation
  // handler sends the owner to whichever business their account last made
  // active rather than the one they are in.
  for (const [label, source] of [["route", route], ["Server Action", serverAction]] as const) {
    assert(`the ${label} binds navigation to this business`,
      source.includes("sectionHref(href, businessBasePath(store.slug))"),
      "otherwise J4 can navigate an owner out of the business they are in");
  }

  // The scope question was written once and is read by the repeat-detector.
  // A second copy anywhere is how "ask again" silently stops escalating.
  check("the scope question is not re-typed on either path",
    [["route", route], ["Server Action", serverAction]]
      .filter(([, source]) => (source as string).includes(SCOPE_QUESTION))
      .map(([label]) => label),
    []);

  // ==========================================================================
  console.log("\n=== 8. The shared runner, which is the thing both paths call ===\n");
  // ==========================================================================
  // Every assertion above tests a handler in isolation. This tests the code
  // BETWEEN the two chat paths and those handlers — the part that decides what
  // gets written down, how many times, and what happens when a tool resolves to
  // nothing. It had no coverage at all until now, which matters because the
  // duplication it replaced is exactly where the two paths drifted apart.
  const runShop = await prisma.store.create({
    data: { userId: owner.id, name: "Runner Test", slug: `th-run-${uniq()}` },
  });
  const toolUse = (name: string, input: unknown) =>
    ({ type: "tool_use", id: `tu-${uniq()}`, name, input }) as Anthropic.ToolUseBlock;
  const runInput = (plannedTools: Anthropic.ToolUseBlock[], role: StoreRole = "OWNER") => ({
    storeId: runShop.id,
    userId: owner.id,
    role,
    userMessage: "whatever the merchant said",
    conversationalReply: "",
    products: [],
    plannedTools,
    resolveHref: (href: string) => href,
    status: () => {},
  });

  // A NAME THE MODEL MADE UP NEVER REACHES A LOOKUP AT ALL. Authorization runs
  // first and there is no policy for a tool that does not exist, so the turn is
  // refused before anything is resolved — the right order, and the reason the
  // outcome here is "refused" rather than "no handler for it".
  const proto = await runPlannedTools(runInput([toolUse("constructor", {})]));
  check("a prototype key is refused before it is looked up", proto.kind, "refused");
  const invented = await runPlannedTools(runInput([toolUse("delete_everything", {})]));
  check("so is an invented tool", invented.kind, "refused");
  // And it is not a handler either, whichever order they are asked in — the
  // registry lookup is closed on its own, not only because a check precedes it.
  check("and neither resolves to a handler", handlerFor("constructor"), null);

  // A REAL TOOL WITH NO HANDLER is the separate failure, and it is surfaced
  // rather than swallowed. Unreachable in the product — the suite above asserts
  // every registered tool has one — so it is provoked here with a name that
  // policy knows and the registry does not.
  const orphan = await runPlannedTools({
    ...runInput([toolUse("edit_store_content", {})]),
  });
  check("a policy-known tool with no handler says so", orphan.kind, "no_handler");
  assert("and names which one",
    orphan.kind === "no_handler" && orphan.toolName === "edit_store_content",
    JSON.stringify(orphan));

  // A DESTINATION THAT DOES NOT EXIST IS STILL A HANDLED TURN. J4 says it does
  // not know where they meant — a designed conversational outcome, not a
  // failure to resolve the tool, and the distinction matters because only the
  // second one is allowed to fall back to something else.
  const unknownDest = await runPlannedTools(runInput([toolUse("take_me_there", { destination: "nowhere", intent: null })]));
  assert("an unknown destination is answered, not dropped",
    unknownDest.kind === "handled" && unknownDest.results[0]?.outcome === "failure",
    JSON.stringify(unknownDest));

  // A HANDLER THAT CANNOT USE ITS INPUT AT ALL REPORTS THAT, rather than a
  // result. Confirming a capture that never happened is worse than falling back.
  const bad = await runPlannedTools(runInput([
    toolUse("capture_business_fact", { entityType: "constructor", data: {} }),
  ]));
  check("unusable input is reported as such", bad.kind, "invalid_input");
  check("and nothing is written for it",
    await prisma.storeMessage.count({ where: { storeId: runShop.id } }), 0);

  // STOPS AT THE FIRST FAILURE. A turn that half-ran and then reported an
  // unrelated fallback leaves the owner unable to tell what happened.
  const halfRun = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
    toolUse("capture_business_fact", { entityType: "constructor", data: {} }),
  ]));
  check("a turn that cannot finish reports the failure, not the half", halfRun.kind, "invalid_input");

  // TWO TOOLS, ONE TURN — and the merchant's message written exactly once.
  // It used to be written inside each branch, which is fine while only one can
  // run and silently wrong the moment two do.
  const both = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
    toolUse("take_me_there", { destination: "studio", intent: null }),
  ]));
  assert("two tools both run", both.kind === "handled" && both.results.length === 2,
    JSON.stringify(both));
  if (both.kind === "handled") {
    check("each to the destination it was given",
      both.results.map((r) => r.navigate), ["/dashboard/orders", "/dashboard/studio"]);
  }
  if (both.kind !== "handled") throw new Error("unreachable");
  await persistToolTurn({
    storeId: runShop.id,
    userId: owner.id,
    userMessage: "take me to commerce and the studio",
    userMessageChanges: null,
    writeUserMessage: true,
    results: both.results,
  });
  check("the merchant's own words are written once",
    await prisma.storeMessage.count({ where: { storeId: runShop.id, role: "user" } }), 1);
  check("and each tool's reply is its own message",
    await prisma.storeMessage.count({ where: { storeId: runShop.id, role: "assistant" } }), 2);

  // The Server Action already wrote the merchant's message before the model was
  // called. Writing it again would duplicate their own words back at them.
  await persistToolTurn({
    storeId: runShop.id,
    userId: owner.id,
    userMessage: "take me to commerce and the studio",
    userMessageChanges: null,
    writeUserMessage: false,
    results: both.results,
  });
  check("a caller that already wrote it does not write it twice",
    await prisma.storeMessage.count({ where: { storeId: runShop.id, role: "user" } }), 1);

  // WHAT THE TURN IS LOGGED AS. A proposal is PENDING, not SUCCESS — recording
  // a proposed deletion as a completed one is the kind of lie this whole
  // milestone exists to stop.
  const logged = await prisma.executionLog.findMany({
    where: { storeId: runShop.id }, orderBy: { createdAt: "asc" },
  });
  check("every handler that ran is logged", logged.length, 4);
  check("navigation is a success", logged[0].status, "SUCCESS");

  // NOTHING RUNS THAT THE VIEWER MAY NOT DO — checked here, at the one place
  // every tool actually executes, and not only where each caller remembers to.
  //
  // This is not defence in depth for its own sake. A per-tool permission check
  // met a multi-tool turn and asked only about the first tool: "what sold worst
  // last month? get rid of it" plans a read then a mutation, the read passes
  // for an employee, and the removal proposal ran behind it. Both callers now
  // refuse that before they get here — they can say which capability and why —
  // and this refuses it again, because the reason this module exists at all is
  // that a capability reachable from two callers was reached by the one that
  // had forgotten a step.
  await prisma.storeMessage.deleteMany({ where: { storeId: runShop.id } });
  await prisma.approvalRequest.deleteMany({ where: { storeId: runShop.id } });
  const employeeTurn = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
    toolUse("request_product_removal", { scope: "all", productNames: null }),
  ], "EMPLOYEE"));
  check("an employee's turn is refused", employeeTurn.kind, "refused");
  assert("named for the capability that was refused, not the one they asked first",
    employeeTurn.kind === "refused" && employeeTurn.toolName === "request_product_removal",
    JSON.stringify(employeeTurn));
  // AND THE ALLOWED TOOL DID NOT RUN EITHER. Running half of what somebody
  // asked for and declining the rest is a decision nobody has made.
  check("and nothing at all ran",
    await prisma.storeMessage.count({ where: { storeId: runShop.id } }), 0);
  check("no deletion was proposed",
    await prisma.approvalRequest.count({ where: { storeId: runShop.id } }), 0);

  // The same turn for the owner runs.
  const ownerTurn = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
  ], "OWNER"));
  check("the owner's does not", ownerTurn.kind, "handled");

  // A read-only turn is fine for an employee — the whole point of moving the
  // gate off the conversation and onto the capability.
  const employeeRead = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
  ], "EMPLOYEE"));
  check("and an employee may still be taken somewhere", employeeRead.kind, "handled");
  await prisma.storeMessage.deleteMany({ where: { storeId: runShop.id } });
  await prisma.executionLog.deleteMany({ where: { storeId: runShop.id } });

  // THE ORDER SOMEBODY READS IT BACK IN. The streaming route says what it is
  // NOT doing before it does the work — correctly, the reader should not wait
  // — but it does not write the merchant's own message until it knows the turn
  // resolved locally. Persisting the notice at the moment it was spoken filed
  // it BEFORE the message it answers, so scrolling back showed J4 declining
  // something the merchant had not said yet.
  await prisma.storeMessage.deleteMany({ where: { storeId: runShop.id } });
  const withNotice = await runPlannedTools(runInput([
    toolUse("take_me_there", { destination: "commerce", intent: null }),
  ]));
  if (withNotice.kind !== "handled") throw new Error("unreachable");
  await persistToolTurn({
    storeId: runShop.id,
    userId: owner.id,
    userMessage: "take me to commerce and rewrite everything",
    userMessageChanges: null,
    writeUserMessage: true,
    droppedNotice: "I'll pick up the other thing you asked for next.",
    results: withNotice.results,
  });
  const inOrder = await prisma.storeMessage.findMany({
    where: { storeId: runShop.id }, orderBy: { createdAt: "asc" }, select: { role: true, content: true },
  });
  check("the merchant's message comes first", inOrder[0]?.role, "user");
  assert("then what J4 is not doing",
    inOrder[1]?.content.includes("pick up the other thing"), JSON.stringify(inOrder[1]));
  assert("then what it did", inOrder[2]?.content.includes("Taking you to"), JSON.stringify(inOrder[2]));
  check("and nothing else", inOrder.length, 3);

  // A turn with nothing dropped writes no notice at all.
  await prisma.storeMessage.deleteMany({ where: { storeId: runShop.id } });
  await persistToolTurn({
    storeId: runShop.id,
    userId: owner.id,
    userMessage: "take me to commerce",
    userMessageChanges: null,
    writeUserMessage: true,
    results: withNotice.results,
  });
  check("nothing dropped means no notice",
    await prisma.storeMessage.count({ where: { storeId: runShop.id } }), 2);
  await prisma.storeMessage.deleteMany({ where: { storeId: runShop.id } });
  await prisma.executionLog.deleteMany({ where: { storeId: runShop.id } });

  const asFailure = [
    { handled: true as const, reply: "a", kind: "one", outcome: "failure" as const },
    { handled: true as const, reply: "b", kind: "two" },
  ];
  check("one failing tool makes the whole turn a failure", turnOutcome(asFailure), "failure");
  check("and the log row still says what ran", turnKind(asFailure), "one+two");
  check("with nothing failing, the turn is a success",
    turnOutcome([{ handled: true, reply: "b", kind: "two" }]), "success");

  // Several tools can ask for the same page; re-rendering it twice is waste.
  check("revalidation paths are flattened and de-duplicated",
    revalidationPaths([
      { handled: true, reply: "a", kind: "one", revalidate: ["/x", "/y"] },
      { handled: true, reply: "b", kind: "two", revalidate: "/x" },
      { handled: true, reply: "c", kind: "three" },
    ]),
    ["/x", "/y"]);

  // The previous turn reaches the handler that needs it, through the runner —
  // not just when a test calls the handler directly.
  check("a fresh conversation has no previous assistant turn",
    lastAssistantContent([{ role: "user", content: "hello" }]), undefined);
  check("and otherwise it is the LAST one, not the first",
    lastAssistantContent([
      { role: "assistant", content: "earlier" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "later" },
    ]),
    "later");

  await prisma.store.deleteMany({ where: { id: runShop.id } });

  check("a prototype key resolves to no handler", handlerFor("constructor"), null);
  check("nor does an invented tool", handlerFor("delete_everything"), null);
  check("every registered handler is callable",
    Object.values(TOOL_HANDLERS).filter((h) => typeof h !== "function"), []);
  check("and every bound one is too",
    Object.values(routeToolHandlers({ resolveHref: (h) => h })).filter((h) => typeof h !== "function"), []);

  await prisma.store.deleteMany({ where: { id: { in: [store.id, other.id] } } });
  await prisma.user.deleteMany({ where: { id: owner.id } });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
