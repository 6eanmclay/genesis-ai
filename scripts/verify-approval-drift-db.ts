import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { randomUUID } from "crypto";
import { driftFor, driftedFields, explainDrift } from "@/lib/execution/approvalDrift";
import { buildActionContext } from "@/lib/execution/genesisAutonomy";
import { GENESIS_ACTIONS } from "@/lib/execution/genesisActions";

// A PENDING PROPOSAL MUST NOT OVERWRITE THE WORK DONE SINCE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts approval-drift-db
//
// ============ THE RULE, AND WHY IT IS NOT A TIMER ====================
//
// Sean approved it as: a pending proposal must not apply a frozen payload if
// its underlying current values have changed — refuse, and explain what
// changed. Age is a proxy; drift is the condition. So none of these tests
// asserts anything about how old a proposal is, and one deliberately proves a
// very old unchanged proposal still executes.
//
// ============ WHAT THESE EXERCISE, AND WHAT THEY CANNOT ==============
//
// `driftFor` is the real gate both approval paths call, and it is driven here
// for real: real stores, real proposals, the real context builder and the real
// getCurrentValues, against a real database. That covers the decision, the
// explanation and the tenant scoping.
//
// It does NOT cover the two call sites. performApproveGenesisAction and
// performApproveGenesisActionGroup are server actions that call headers(), and
// a script has no request scope — the same structural wall
// verify-approval-recovery.ts hit for the same function. Section 7 asserts the
// wiring from source and says so plainly rather than implying more. That is
// lane 4, and the honest statement of it is: nothing here would notice if both
// call sites stopped compiling their way to `driftFor` in some way source
// matching missed.

let passes = 0;
let failures = 0;
const failed: string[] = [];

function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else { failures++; failed.push(name); }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);

  const stamp = Date.now();
  let seq = 0;

  const makeStore = async (identity: { name: string; tagline: string; description: string }) => {
    const nth = ++seq;
    const user = await prisma.user.create({ data: { email: `drift-${stamp}-${nth}@example.test` } });
    return prisma.store.create({
      data: { userId: user.id, slug: `drift-${stamp}-${nth}`, currency: "USD", ...identity },
    });
  };

  // A proposal to rename the business, frozen against whatever the store said
  // at the moment it was made — which is exactly what the real proposal paths
  // do, through the same builder.
  const proposeIdentity = async (
    storeId: string,
    input: { name: string; tagline: string; description: string },
    overrides: Record<string, unknown> = {}
  ) => {
    const definition = GENESIS_ACTIONS.update_store_identity;
    const context = await buildActionContext(storeId);
    const previousValues = await definition.getCurrentValues(context);
    return prisma.approvalRequest.create({
      data: {
        storeId,
        actionType: "update_store_identity",
        input,
        previousValues: previousValues as object,
        summary: "Give the business a clearer name",
        status: "PENDING_APPROVAL",
        ...overrides,
      },
    });
  };

  const identityOf = (storeId: string) =>
    prisma.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { name: true, tagline: true, description: true },
    });

  // ======================================================================
  console.log("\n=== 1. An unchanged proposal still executes ===\n");
  // ======================================================================
  //
  // FIRST, because it is the assertion every other one here depends on. A
  // refusal that refuses everything would pass all five remaining tests.
  {
    const store = await makeStore({ name: "Loam & Ember", tagline: "Slow-made", description: "Hand-poured candles." });
    const proposal = await proposeIdentity(store.id, {
      name: "Loam & Ember Studio",
      tagline: "Slow-made, small-batch",
      description: "Hand-poured candles from a studio in Leeds.",
    });

    eq("an untouched proposal is not refused",
      (await driftFor(proposal, store.id)).length, 0);
  }

  // ======================================================================
  console.log("\n=== 2. Age alone is never the reason ===\n");
  // ======================================================================
  //
  // Sean: no timer-based expiration unless the audit proves it is needed
  // elsewhere. It did not, so this pins the absence — a proposal old enough to
  // be one of the four thirty-day-old rows in production still applies when
  // the business genuinely has not moved.
  {
    const store = await makeStore({ name: "Wildwood", tagline: "t", description: "d" });
    const ancient = await proposeIdentity(
      store.id,
      { name: "Wildwood Candles", tagline: "t", description: "d" },
      { createdAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) }
    );

    eq("a ninety-day-old proposal on an unchanged business is not refused",
      (await driftFor(ancient, store.id)).length, 0);
  }

  // ======================================================================
  console.log("\n=== 3. A changed value refuses, and changes nothing ===\n");
  // ======================================================================
  {
    const store = await makeStore({ name: "", tagline: "", description: "" });
    const proposal = await proposeIdentity(store.id, {
      name: "Meridian Cold Brew",
      tagline: "Slow-steeped",
      description: "Cold brew in small batches.",
    });

    // The owner names the business themselves while the card sits there. This
    // is the real production shape: paypal-test-books has a pending
    // placeholder-identity proposal frozen against three empty strings, and a
    // real identity now.
    await prisma.store.update({
      where: { id: store.id },
      data: { name: "Meridian", tagline: "Coffee, unhurried", description: "A cold brew company." },
    });

    const drifted = await driftFor(proposal, store.id);
    assert("a proposal whose ground moved is refused", drifted.length > 0, JSON.stringify(drifted));

    // ============ AND THE CHECK ITSELF MUTATES NOTHING ===============
    // driftFor is a read, and this is what says so.
    const after = await identityOf(store.id);
    eq("the owner's own name survives", after.name, "Meridian");
    eq("their tagline survives", after.tagline, "Coffee, unhurried");
    eq("their description survives", after.description, "A cold brew company.");

    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: proposal.id } });
    eq("the proposal is still pending, not consumed", row.status, "PENDING_APPROVAL");
    eq("and nothing claimed it", row.claimedAt, null);
    eq("and no execution was recorded against it", row.executionId, null);

    // ============ AND THE OWNER IS TOLD SOMETHING USEFUL =============
    const message = explainDrift(drifted);
    assert("the explanation names the field that changed", message.includes("Name"), message);
    assert("and quotes what it was, readably", message.includes('was "(empty)"'), message);
    assert("and quotes what it is now", message.includes("Meridian"), message);
    assert("and does not call it a failure", !/fail|error|wrong/i.test(message), message);
    assert("and offers a way forward", /look again|another look|propose/i.test(message), message);
    assert("and never names a raw camelCase key", !/[a-z][A-Z]/.test(message.replace(/Cold Brew|Meridian/g, "")), message);
  }

  // ======================================================================
  console.log("\n=== 4. A stale proposal cannot overwrite newer business data ===\n");
  // ======================================================================
  //
  // The same rule stated as the outcome rather than the mechanism, and driven
  // through the GROUP path — the one-click 'approve all', which calls execute()
  // itself rather than delegating, and would otherwise skip the check entirely.
  {
    const store = await makeStore({ name: "Haul", tagline: "t", description: "d" });
    const groupId = randomUUID();
    const stale = await proposeIdentity(
      store.id,
      { name: "Haul & Co. Bags", tagline: "Built to last", description: "Canvas totes." },
      { groupId }
    );

    await prisma.store.update({ where: { id: store.id }, data: { name: "Haul & Co." } });

    const batchDrift = await driftFor(stale, store.id);
    assert("the batch member is refused rather than executed",
      batchDrift.length > 0, JSON.stringify(batchDrift));
    assert("and the batch can say which field moved",
      explainDrift(batchDrift).includes("Name"), explainDrift(batchDrift));

    // The refusal is a read. Nothing it did could have touched the store
    // or the row, and both are asserted rather than assumed.
    const after = await identityOf(store.id);
    eq("the newer name was not overwritten by the older plan", after.name, "Haul & Co.");
    const row = await prisma.approvalRequest.findUniqueOrThrow({ where: { id: stale.id } });
    eq("and the proposal is still decidable", row.status, "PENDING_APPROVAL");
  }

  // ======================================================================
  console.log("\n=== 5. One business's change is never another's refusal ===\n");
  // ======================================================================
  {
    const mine = await makeStore({ name: "Fernbrook", tagline: "t", description: "d" });
    const neighbour = await makeStore({ name: "Fernbrook", tagline: "t", description: "d" });

    const proposal = await proposeIdentity(mine.id, {
      name: "Fernbrook Botanicals", tagline: "t", description: "d",
    });

    // The NEIGHBOUR moves. Nothing about my proposal has changed.
    await prisma.store.update({ where: { id: neighbour.id }, data: { name: "Someone Else Entirely" } });

    eq("a neighbour's edit does not refuse my proposal",
      (await driftFor(proposal, mine.id)).length, 0);

    // AND THE OPPOSITE, so the test can tell scoping from indifference:
    // the same proposal judged against the NEIGHBOUR's data does drift,
    // which is only true if driftFor reads the store it is given.
    assert("and it is the store it is given that decides",
      (await driftFor(proposal, neighbour.id)).length > 0, "same proposal, other store");
  }

  // ======================================================================
  console.log("\n=== 6. The comparison itself ===\n");
  // ======================================================================
  //
  // The pure part, where the shapes that would silently misbehave live.
  {
    eq("identical values are not drift", driftedFields({ a: "x" }, { a: "x" }).length, 0);
    eq("a changed value is drift", driftedFields({ a: "x" }, { a: "y" }).length, 1);
    eq("null and undefined are the same absence",
      driftedFields({ a: null }, { a: undefined }).length, 0);

    // An object field compared by reference would read as drifted forever, so
    // every update_theme proposal would be permanently unapprovable.
    eq("an unchanged object field is not drift",
      driftedFields({ colors: { primary: "#fff" } }, { colors: { primary: "#fff" } }).length, 0);
    eq("a changed object field is drift",
      driftedFields({ colors: { primary: "#fff" } }, { colors: { primary: "#000" } }).length, 1);

    // Only what was frozen. A field the proposal never recorded is a statement
    // about our schema, not about the business.
    eq("a key only the current values have is not drift",
      driftedFields({ a: "x" }, { a: "x", b: "new" }).length, 0);

    // Machine plumbing is not a decision the owner made.
    eq("a productId is not reported as a business change",
      driftedFields({ productId: "p1" }, { productId: "p2" }).length, 0);

    const one = driftedFields({ name: "" }, { name: "Cubit & Coil" });
    eq("the drifted field carries its owner-facing label", one[0]?.label, "Name");
    eq("and an empty value reads as empty rather than blank", one[0]?.was, "(empty)");

    const many = driftedFields(
      { name: "a", tagline: "b", description: "c", seoTitle: "d" },
      { name: "A", tagline: "B", description: "C", seoTitle: "D" }
    );
    const summary = explainDrift(many);
    eq("four changes are found", many.length, 4);
    assert("the explanation names some and counts the rest",
      summary.includes("1 other field"), summary);
    assert("and it does not run to an unreadable list",
      summary.split(";").length <= 3, summary);
  }


  // ======================================================================
  console.log("\n=== 7. Both approval paths actually consult the gate ===\n");
  // ======================================================================
  //
  // LANE 4 — SOURCE-ASSERTED, and named as such rather than dressed up.
  // performApproveGenesisAction and performApproveGenesisActionGroup are
  // server actions that call headers(); a script has no request scope, so
  // they cannot be driven here. verify-approval-recovery.ts hit the same
  // wall for the same function and answered it the same way.
  //
  // Everything ABOVE is real: real stores, real proposals, the real context
  // builder and the real getCurrentValues. What is asserted from source is
  // only that the two call sites reach it, and that a refusal happens
  // BEFORE the row is claimed — which is what makes 'the refusal mutates
  // nothing' true of the whole path rather than only of driftFor.
  {
    const { readFileSync } = await import("fs");
    const { join } = await import("path");
    const src = readFileSync(join(process.cwd(), "app", "dashboard", "ai-actions.ts"), "utf8");

    assert("the single-approval path asks whether the ground moved",
      src.includes("const drifted = await driftFor(approval, storeId);"),
      "without it a stale proposal applies a frozen payload unread");
    assert("and refuses before claiming the row",
      src.indexOf("const drifted = await driftFor(approval, storeId);") <
        src.indexOf('data: { status: "EXECUTING", claimedAt: new Date(), attemptExecutionId },'),
      "claiming first would leave a refused proposal reading as EXECUTING");
    assert("and returns the refusal rather than falling through",
      src.includes('return { outcome: "stale", message: explainDrift(drifted), changed: drifted };'),
      "a computed refusal nobody returns is not a refusal");

    assert("the one-click group path asks the same question",
      src.includes("const groupDrift = await driftFor(approval, storeId);"),
      "'approve all' is exactly where a stale proposal goes unread");
    // SLICED FROM THE GATE ONWARD, not indexOf across the whole file. The
    // first `const result = await execute(` in this file belongs to a
    // different function entirely (the chat propose path, ~line 2954), so a
    // naive whole-file comparison compared the group gate against someone
    // else's execute and failed for a reason that had nothing to do with the
    // group loop. It caught that on the first run, which is the only reason
    // this comment exists.
    const fromGate = src.slice(src.indexOf("const groupDrift = await driftFor(approval, storeId);"));
    assert("and skips that member instead of executing it",
      fromGate.indexOf("continue;") < fromGate.indexOf("const result = await execute("),
      "checking after execute() would be checking after the damage");

    assert("and the owner is told, in the conversation",
      src.includes('data: { storeId, role: "assistant", content: result.message },'),
      "the button redirects, so a refusal with nowhere to appear is invisible");
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failed.length > 0) {
    console.log("\nFailures:");
    for (const f of failed) console.log(`  ${f}`);
  }
  if (failures > 0) process.exitCode = 1;
}

main()
  .catch((error) => { console.error(error); process.exitCode = 1; })
  .finally(async () => { await prismaSystem.$disconnect(); });
