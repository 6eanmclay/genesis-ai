import {
  J4_CANNOT,
  actionForNeed,
  contradictedBoundaries,
  unresolvedTools,
  type BusinessNeed,
} from "@/lib/j4/ownerCapability";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";

// NEEDS_OWNER MEANS THE OWNER, NOT "THIS WAS HARD" (2026-09-10).
//
//   npx tsx scripts/verify-owner-capability.ts
//
// Sean: "Do not make it a generic fallback for anything J4 cannot execute...
// Do not turn every limitation, failure, or uncertainty into needs_owner."
//
// The four cases below are his own examples, used as the acceptance criteria
// rather than paraphrased into something easier to pass.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const BASE = "/b/cubit-and-coil";

// ---- Sean's four examples ------------------------------------------------
console.log("\n=== the four examples, as given ===\n");

// 1. "I need authentic product photography." -> needs_owner, because J4 does
//    not have the required source material/capability.
const photography: BusinessNeed = {
  id: "product_photography",
  what: "photographs of the real product",
  boundary: "photograph_physical_object",
  provideAt: { section: "/dashboard/products", label: "Add photographs" },
};
const a1 = actionForNeed(photography, BASE);
check("product photography is needs_owner", a1.kind === "needs_owner", a1.kind);
check("  and the missing thing is a capability",
  a1.kind === "needs_owner" && a1.missing === "capability",
  a1.kind === "needs_owner" ? a1.missing : a1.kind);
check("  and it names what it needs",
  a1.kind === "needs_owner" && a1.what.length > 0,
  a1.kind === "needs_owner" ? a1.what : "");
check("  and its destination is rebased to this business",
  a1.kind === "needs_owner" && a1.provideAt?.href === `${BASE}/products`,
  a1.kind === "needs_owner" ? (a1.provideAt?.href ?? "none") : a1.kind);

// 2. "You haven't posted in four days, and J4 has the content + social
//    connection required." -> execute.
//
//    IT DOES NOT, AND THIS SUITE SAYS SO. There is no publishing tool in the
//    catalogue - 25 tools, none of which post anything. So this need resolves
//    to `internal`: Genesis has not built publishing, which is our gap and not
//    the owner's, and routing it to needs_owner would tell an owner they are
//    the missing piece when the missing piece is our unshipped feature.
//
//    When a publishing tool lands, this need gains a real tool name and this
//    assertion is what forces the change to be deliberate.
const posting: BusinessNeed = {
  id: "social_posting",
  what: "turn your material into platform-specific posts and publish them",
  tool: "publish_social_post",
};
const a2 = actionForNeed(posting, BASE);
check("social posting does NOT claim to be executable", a2.kind !== "execute", a2.kind);
check("  and it does NOT blame the owner", a2.kind !== "needs_owner", a2.kind);
check("  it is Genesis' own gap, kept out of the Office",
  a2.kind === "internal" && a2.because.includes("not the owner's to supply"),
  a2.kind === "internal" ? a2.because.slice(0, 90) : a2.kind);

// A need whose tool DOES exist is executable - the same routing, the other way.
const realTool: BusinessNeed = {
  id: "storefront_refinement",
  what: "refine the storefront",
  tool: "refine_storefront",
};
check("a need backed by a REAL tool is execute", actionForNeed(realTool, BASE).kind === "execute",
  actionForNeed(realTool, BASE).kind);

// 3. "You should consider changing your brand positioning." -> a decision, not
//    automatically a capability gap.
const positioning: BusinessNeed = {
  id: "brand_positioning",
  what: "decide how you want the business positioned",
  boundary: "choose_owner_intent",
};
const a3 = actionForNeed(positioning, BASE);
check("positioning is needs_owner", a3.kind === "needs_owner", a3.kind);
check("  and it is a DECISION, not a capability",
  a3.kind === "needs_owner" && a3.missing === "decision",
  a3.kind === "needs_owner" ? a3.missing : a3.kind);
check("  and it offers no destination, because there is nowhere to go",
  a3.kind === "needs_owner" && a3.provideAt === undefined);

// 4. "Nothing currently requires attention." -> none.
const quiet: BusinessNeed = { id: "quiet", what: "nothing" };
const a4 = actionForNeed(quiet, BASE);
check("a need with neither boundary nor tool is none", a4.kind === "none", a4.kind);
check("  and it says why", a4.kind === "none" && a4.because.length > 20,
  a4.kind === "none" ? a4.because : a4.kind);

// ---- needs_owner cannot be reached by accident ---------------------------
//
// The property that makes this a state rather than a shrug: the ONLY route to
// needs_owner is a declared boundary. Nothing reaches it by being difficult,
// by failing, or by being unrecognised.
console.log("\n=== needs_owner has exactly one entrance ===\n");
const NON_BOUNDARY: BusinessNeed[] = [
  { id: "no_tool_no_boundary", what: "x" },
  { id: "unbuilt_tool", what: "x", tool: "invent_a_customer" },
  { id: "real_tool", what: "x", tool: "take_me_there" },
];
const EXPECTED: [BusinessNeed, string][] = [
  [NON_BOUNDARY[0], "none"],      // nothing known about it
  [NON_BOUNDARY[1], "internal"],  // Genesis' gap, not the owner's
  [NON_BOUNDARY[2], "execute"],   // a real tool, so J4 does it
];
for (const [n, expected] of EXPECTED) {
  const a = actionForNeed(n, BASE);
  // THE POSITIVE OUTCOME, not merely the absence of the wrong one. Asking only
  // "is it not needs_owner?" let a real tool resolve wrongly to `internal` and
  // still pass, which is how a nine-tool hole in the capability model survived
  // a green run.
  check(`${n.id} resolves to ${expected}`, a.kind === expected, a.kind);
  check(`  and is not needs_owner`, a.kind !== "needs_owner", a.kind);
}

const bogus: BusinessNeed = { id: "bad", what: "x", boundary: "not_a_real_boundary" as never };
check("a need citing an unknown boundary is internal, not owner-facing",
  actionForNeed(bogus, BASE).kind === "internal", actionForNeed(bogus, BASE).kind);

// ---- the mirrored registry, guarded the day it was written ---------------
//
// ARCHITECTURE.md: "A registry that mirrors another must carry a runtime
// cross-check asserting every referenced name resolves in the registry it
// mirrors." Both directions, because the stale-boundary direction is the one
// that would quietly send an owner to do work J4 could have done.
console.log("\n=== the capability model matches the real catalogue ===\n");
const DECLARED: BusinessNeed[] = [photography, positioning, realTool, quiet];
check("every tool named resolves in the catalogue", unresolvedTools(DECLARED).length === 0,
  unresolvedTools(DECLARED).join(", ") || `${buildStoreChatUnifiedTools().length} tools in catalogue`);
check("no need claims a boundary AND a tool", contradictedBoundaries(DECLARED).length === 0,
  contradictedBoundaries(DECLARED).join("; ") || "disjoint");
check("the detector CAN see an unresolved tool", unresolvedTools([posting]).length === 1,
  unresolvedTools([posting]).join(", "));
check("the detector CAN see a contradiction",
  contradictedBoundaries([{ id: "c", what: "x", boundary: "photograph_physical_object", tool: "create_design" }]).length === 1);

// ---- the boundaries are claims somebody made -----------------------------
console.log("\n=== every boundary states its reason ===\n");
check("four boundaries, closed list", J4_CANNOT.length === 4, J4_CANNOT.map((b) => b.id).join(", "));
check("each names which kind of thing is missing",
  J4_CANNOT.every((b) => ["information", "decision", "permission", "capability"].includes(b.missing)));
check("each gives a real reason, not an apology",
  J4_CANNOT.every((b) => b.because.length > 40 && !/sorry|unfortunately|I'm afraid/i.test(b.because)));
check("the ids are unique", new Set(J4_CANNOT.map((b) => b.id)).size === J4_CANNOT.length);

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
