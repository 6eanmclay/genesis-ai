import { readFileSync } from "fs";
import { join } from "path";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  TOOL_HANDLERS,
  MIGRATED_TOOLS,
  handlerFor,
  makeApprovePendingChanges,
  type ToolTurnContext,
} from "@/lib/execution/toolHandlers";
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
  conversationalReply = ""
): ToolTurnContext & { statuses: string[] } {
  const statuses: string[] = [];
  return {
    storeId,
    userId,
    userMessage: "whatever the merchant said",
    conversationalReply,
    input,
    status: (text: string) => statuses.push(text),
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
  console.log("\n=== 6. Handlers stay inside the store they were given ===\n");
  // ==========================================================================
  check("the neighbour has no goals", (await queryRecords(other.id, "goal")).length, 0);
  check("nor challenges", (await queryRecords(other.id, "challenge")).length, 0);
  check("nor anything J4 is watching",
    await prisma.genesisObservation.count({ where: { storeId: other.id } }), 0);

  // ==========================================================================
  console.log("\n=== 7. A migrated tool has exactly one home ===\n");
  // ==========================================================================
  // A tool with BOTH a handler and an inline branch would run twice — the
  // dispatcher would handle it and then the ladder would handle it again. A
  // tool with NEITHER falls through to the legacy content pipeline, which is
  // the defect found on the Server Action path earlier today.
  const route = readFileSync(join(process.cwd(), "app", "api", "chat", "route.ts"), "utf8");
  const catalog = buildStoreChatUnifiedTools().map((t) => t.name);

  check("every migrated tool is a real tool",
    MIGRATED_TOOLS.filter((n) => !catalog.includes(n)), []);
  check("and none of them still has an inline branch",
    MIGRATED_TOOLS.filter((n) => route.includes(`if (chosenTool?.name === "${n}")`)), []);
  check("while every tool that is NOT migrated still has one",
    catalog
      .filter((n) => !MIGRATED_TOOLS.includes(n) && n !== "look_up_business_data")
      .filter((n) => !route.includes(`if (chosenTool?.name === "${n}")`))
      .filter((n) => n !== "edit_store_content"),
    []);
  assert("the route dispatches through the handler registry",
    route.includes("handlerFor(tool.name)"), "otherwise the handlers are dead code");

  check("a prototype key resolves to no handler", handlerFor("constructor"), null);
  check("nor does an invented tool", handlerFor("delete_everything"), null);
  check("every registered handler is callable",
    Object.values(TOOL_HANDLERS).filter((h) => typeof h !== "function"), []);

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
