import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { GENESIS_ACTIONS, CATEGORY_MAX_TIER } from "@/lib/execution/genesisActions";
import { ProposedActionSchema, PROPOSABLE_ACTION_TYPES } from "@/lib/intelligence/cognitiveLayer";
import { buildStoreChatUnifiedTools } from "@/lib/execution/genesisTools";

// WHAT J4 IS ALLOWED TO DO, AND WHAT STOPS IT (2026-09-11).
//
//   npx tsx scripts/verify-authority-boundary.ts
//
// The authority audit found the boundary in good shape and held together by
// construction rather than by tests: nothing asserted the ceilings, nothing
// asserted that a belief cannot reach an executable, and nothing swept the
// server actions for a chokepoint. Every one of those was true because
// somebody was careful, which is exactly the kind of true that stops being
// true quietly.
//
// These are the invariants Sean asked to lock BEFORE any autonomy is
// widened. Each FAILS CLOSED: a new action, a new server action or a new
// executable that does not satisfy them breaks this suite rather than
// shipping.

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

const root = process.cwd();
const read = (...p: string[]) => readFileSync(join(root, ...p), "utf8");
/** Comments explain intent; code is the evidence. */
const codeOnly = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir))) {
    if (e === "node_modules" || e.startsWith(".")) continue;
    const rel = `${dir}/${e}`;
    if (statSync(join(root, rel)).isDirectory()) sourceFiles(rel, acc);
    else if (e.endsWith(".ts") || e.endsWith(".tsx")) acc.push(rel);
  }
  return acc;
}

const RANK: Record<string, number> = { always_ask: 0, auto_below_limit: 1, auto: 2 };
// THE REAL TABLE, NOT A COPY OF IT.
//
// This was a hardcoded duplicate of CATEGORY_MAX_TIER, and its own sabotage
// exposed that: raising the real destructive ceiling to "auto" left this suite
// green, because it was asserting against its own copy. A registry mirrored in
// a test is the ARCHITECTURE.md hazard wearing a lab coat — it reports on a
// world it made up. CATEGORY_MAX_TIER is now exported so there is one table.
const CEILING: Record<string, string> = CATEGORY_MAX_TIER;

type Def = {
  category: string;
  authorizationTier: string;
  maxAuthorityTier: string;
  authorityExempt?: boolean;
  executable: { action: string; verify?: unknown };
};
const actions = Object.entries(GENESIS_ACTIONS) as unknown as [string, Def][];

// ===========================================================================
console.log("\n=== 1. Money and destructive can never reach auto ===\n");
// ===========================================================================
//
// The ceiling table is hardcoded and enforced at module load. What was NOT
// enforced is the table's own contents: nothing asserted that money and
// destructive are still capped, so a one-word edit could widen the most
// consequential category in the system and every existing test would pass.
check("money is capped at always_ask", CEILING.money === "always_ask", CEILING.money);
check("destructive is capped at always_ask", CEILING.destructive === "always_ask", CEILING.destructive);

const overCeiling = actions.filter(([, d]) => RANK[d.maxAuthorityTier] > RANK[CEILING[d.category]]);
check("no action's cap exceeds its category ceiling", overCeiling.length === 0,
  overCeiling.map(([k]) => k).join(", ") || `${actions.length} actions within their ceilings`);

const moneyOrDestructive = actions.filter(([, d]) => d.category === "money" || d.category === "destructive");
check("every money/destructive action is always_ask RIGHT NOW",
  moneyOrDestructive.every(([, d]) => d.authorizationTier === "always_ask"),
  moneyOrDestructive.map(([k, d]) => `${k}=${d.authorizationTier}`).join(", "));
check("  and none of them could ever be raised",
  moneyOrDestructive.every(([, d]) => d.maxAuthorityTier === "always_ask"),
  `${moneyOrDestructive.length} actions, all hard-capped`);

// THE GAP THE AUDIT FOUND. The module-load loop checks maxAuthorityTier
// against the category ceiling, and checks the authorityExempt carve-out. It
// never checks the tier an action is ACTUALLY REGISTERED WITH against that
// action's own cap — so `authorizationTier: "auto"` beside
// `maxAuthorityTier: "always_ask"` would load without complaint.
const overOwnCap = actions.filter(([, d]) => RANK[d.authorizationTier] > RANK[d.maxAuthorityTier]);
check("no action is running above its own cap", overOwnCap.length === 0,
  overOwnCap.map(([k, d]) => `${k}: ${d.authorizationTier} > ${d.maxAuthorityTier}`).join("; ") ||
    "every tier is within its own maxAuthorityTier");

// ===========================================================================
console.log("\n=== 2. Anything at auto must really read back ===\n");
// ===========================================================================
//
// Autonomy without verification is the worst combination available: J4 acts
// unsupervised and cannot say whether it worked. `verify` is a required member
// of Executable so it always EXISTS; what this asserts is that an autonomous
// action's verify does real work rather than returning success.
const autoActions = actions.filter(([, d]) => d.authorizationTier === "auto" && !d.authorityExempt);
check("every autonomous action has an executable", autoActions.every(([, d]) => !!d.executable),
  autoActions.map(([k]) => k).join(", ") || "none");

for (const [key, d] of autoActions) {
  // THE FUNCTION ITSELF, not a file that mentions the action.
  //
  // Executables declare `action: EXECUTION_ACTIONS.STORE_UPDATE_SEO` — a
  // CONSTANT — so searching source for the resolved string "store.update_seo"
  // finds nothing. The first version of this check failed against perfectly
  // good code for that reason, which is the file-hunting version of trusting a
  // name instead of the thing.
  const verify = (d.executable as { verify?: unknown }).verify;
  check(`${key}: its executable really has a verify`, typeof verify === "function", typeof verify);
  if (typeof verify !== "function") continue;
  const body = String(verify);
  // A READ-BACK: it goes back to the store (or a provider) and looks at what
  // actually landed, rather than returning success.
  check(`${key}: its verify reads the resulting state back`,
    /prisma\.|readBack|findFirst|findUnique|namedKeyMismatches/.test(body),
    "autonomy without verification is the worst combination available");
  // FOLLOWING THE DELEGATION. updateSeo.verify is one line —
  // `verifyBlueprintSection(...)` — and the mismatch vocabulary lives in that
  // helper. Reading only the immediate body reported a correct executable as
  // unable to detect failure.
  const READ_BACK_HELPERS = /verifyBlueprintSection|verifyStoreColumns|verifyRowExists|verifyRowAbsent/;
  const helperSrc = codeOnly(read("lib", "execution", "readBack.ts"));
  const viaHelper = READ_BACK_HELPERS.test(body);
  check(`${key}: and can report a real mismatch`,
    /verifiedUnless|mismatches|unavailable/.test(body) ||
      (viaHelper && /verifiedUnless\(namedKeyMismatches/.test(helperSrc)),
    viaHelper ? "through a readBack helper that reports named mismatches" : "inline");
}

// ===========================================================================
console.log("\n=== 3. No belief can reach an executable ===\n");
// ===========================================================================
//
// A belief is J4's own conclusion, carrying a confidence that may be 51%.
// Beliefs legitimately reach prompts and reasoning; an EXECUTABLE is where
// something real happens, and a conclusion must never be the thing that
// authorises or parameterises it.
const executableFiles = sourceFiles("lib/execution/executables");
const beliefLeaks = executableFiles.filter((f) => {
  const src = codeOnly(read(...f.split("/")));
  return /\bgetBeliefs\b|\bbeliefs\b|prisma\.belief\./.test(src);
});
check("no executable reads a belief", beliefLeaks.length === 0,
  beliefLeaks.join(", ") || `${executableFiles.length} executables, none touch a belief`);

// And the engine itself must not hand one down.
const engineSrc = codeOnly(read("lib", "execution", "engine.ts"));
check("the execution engine does not carry beliefs", !/\bbeliefs\b|getBeliefs/.test(engineSrc));

// The CONTROL: beliefs genuinely do reach reasoning, so this is a real
// boundary rather than a string that happens to be absent everywhere.
const digestSrc = codeOnly(read("lib", "businessModel", "digest.ts"));
check("CONTROL: beliefs really do reach reasoning", /belief/i.test(digestSrc),
  "if this fails, the assertion above proves nothing");

// ===========================================================================
console.log("\n=== 4. A consequential target is an id, or an exact match ===\n");
// ===========================================================================
//
// The one text-matched path is contradict_belief, and it is deliberate: a
// language model has no id to work from. It is admissible because it REFUSES
// on ambiguity instead of choosing.
const handlers = codeOnly(read("lib", "execution", "toolHandlers.ts"));
check("scoped product resolution is exact, never substring",
  /wanted\.includes\(p\.name\.trim\(\)\.toLowerCase\(\)\)/.test(handlers),
  "a substring match would let one product name select another");
check("the one text-matched target refuses when ambiguous",
  handlers.includes("contradict_belief_ambiguous"),
  "matching by wording is admissible only if it can decline to guess");

// A CONSEQUENTIAL MUTATION TARGETS A ROW BY ID, NEVER BY A NAME.
//
// This first demanded `metadata`, then demanded `storeId` in every WHERE, and
// both were the wrong shape. A store-scoped executable writes
// prisma.store.update and its target IS the store, already on
// ExecutionLog.storeId; and tenant scoping is a separate invariant with its
// own suite (verify-tenant-isolation-db) rather than one of the five being
// locked here.
//
// What this locks is Sean's actual invariant: the thing a mutation acts on is
// identified by an id, not resolved from language at the point of the write.
const SUB_ENTITY_WRITE = /prisma\.(?!store\.)[a-zA-Z]+\.(?:update|delete)\(\s*\{[\s\S]{0,200}?\}/g;
const byName: string[] = [];
for (const f of executableFiles) {
  const src = codeOnly(read(...f.split("/")));
  for (const m of src.match(SUB_ENTITY_WRITE) ?? []) {
    // A write keyed on a name, title or slug would be a language-resolved
    // target reaching a mutation.
    //
    // THIS ASSERTION WAS DEAD UNTIL 2026-09-11. The word boundary below was
    // written through a shell heredoc, which turned `\b` into a literal
    // backspace BYTE (0x08) — so the pattern demanded a control character no
    // source file contains, and could never match anything. It reported
    // "every sub-entity write is keyed on an id" by being incapable of
    // finding a counter-example. Found by `file`, which called the script
    // "with overstriking"; the sabotage below now proves it can fail.
    if (/where:\s*\{[^}]*\b(name|title|slug|claim|summary)\s*:/.test(m)) {
      byName.push(`${f}: ${m.replace(/\s+/g, " ").slice(0, 70)}`);
    }
  }
}
check("no mutation resolves its target from a name",
  byName.length === 0,
  byName.join(" | ") || "every sub-entity write is keyed on an id")

// ===========================================================================
console.log("\n=== 5. Every server action reaches a chokepoint ===\n");
// ===========================================================================
//
// Swept by hand during the audit, which found three false positives before it
// found the real answer — the chokepoints are more numerous than any one
// pattern suggests. That is exactly why it belongs in a test rather than in
// somebody's attention.
const CHOKEPOINTS = [
  "auth()",
  "requireBusinessOrActive",
  "resolveOfficeAccess",
  "accessTo",
  "requireStorePageAccess",
  "assertPlatformAdmin",
  "requireOwner",
  "requireUserId",
  "forBusiness",
];

/**
 * Deliberately public server actions.
 *
 * Each is unauthenticated BY DESIGN and named individually, because a blanket
 * "skip these directories" rule would silently absolve a new file dropped
 * beside them.
 */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "app/forgot-password/actions.ts": "a person who cannot log in is the point",
  "app/reset-password/actions.ts": "reached by emailed token, not by session",
  "app/store/[slug]/actions.ts": "a customer buying is not a user of this platform",
  "app/store/[slug]/bagActions.ts": "the shopping bag belongs to an anonymous visitor",
};

const serverActionFiles = [...sourceFiles("app")].filter((f) =>
  read(...f.split("/")).startsWith('"use server"'),
);
check("the sweep finds the server actions at all", serverActionFiles.length > 10, `${serverActionFiles.length} files`);

const unguarded = serverActionFiles.filter((f) => {
  if (PUBLIC_BY_DESIGN[f]) return false;
  const src = codeOnly(read(...f.split("/")));
  return /export async function/.test(src) && !CHOKEPOINTS.some((c) => src.includes(c));
});
check("every non-public server-action file reaches a chokepoint",
  unguarded.length === 0,
  unguarded.join(", ") || `${serverActionFiles.length - Object.keys(PUBLIC_BY_DESIGN).length} guarded`);

// AND THE EXEMPTIONS STAY HONEST. A named file that has since gained a
// chokepoint, or stopped existing, should be removed from the list rather than
// left as a standing permission.
const staleExemptions = Object.keys(PUBLIC_BY_DESIGN).filter((f) => !serverActionFiles.includes(f));
check("no exemption names a file that is not a server action any more",
  staleExemptions.length === 0, staleExemptions.join(", ") || "all four are real");

// ===========================================================================
console.log("\n=== 6. Nothing is autonomous that production cannot select ===\n");
// ===========================================================================
//
// THE INVARIANT THE AUDIT DID NOT HAVE, AND THE ONE THAT WOULD HAVE CAUGHT ME.
//
// update_homepage_content and update_store_content were raised to auto in
// e09f793. Every existing invariant passed, because every existing invariant
// asked whether the tier was PERMISSIBLE. None asked whether it was
// REACHABLE — whether anything in production can actually select the action
// the registry has just made autonomous. An action that is auto and
// unreachable is a permission granted to nobody: it reads as capability in
// every report and is capability in none.
//
// ============ AND I GOT THE FIRST ANSWER WRONG ==========================
//
// I told Sean nothing could select those two actions. That was false, and
// writing this invariant is what found it. app/dashboard/ai-actions.ts calls
// its own proposeAction("update_homepage_content", ...) on the chat path, and
// proposeAction executes IMMEDIATELY when definition.authorizationTier is
// "auto". So the raise did have an effect — a larger one than I claimed it
// had, because that path never checks a delegated grant at all.
//
// That is the second lesson and the more useful one: "autonomous" is not one
// path. There are two, with DIFFERENT gates.
//
//   tryExecuteAutonomousAction   requires an owner's explicit grant
//   proposeAction (chat)         requires only the registry tier
//
// An invariant that knew about one and not the other would have gone on
// reporting confidently about a world it half-modelled — which is the exact
// failure it exists to prevent. Both are derived below.
//
// So this traces the whole path, from the real registrations rather than a
// list kept beside them:
//
//   decision namespace  →  callable action  →  executable  →  policy
//
// Four things can select an action, and they are genuinely different — the
// conflation is what made the original mistake easy:
//
//   A. ProposedActionSchema — what Reason may PROPOSE. The proposal decision
//      layer; its literals are read off the discriminated union itself.
//   B. the chat tool catalogue — what the model may CALL mid-conversation.
//      A separate namespace that overlaps GENESIS_ACTIONS only where a tool
//      is named for an action; most tools are not.
//   C. production code that selects an action ITSELF, with no model in the
//      loop, and hands it to a path that can execute without asking —
//      communicate_finding via communicateFinding, and every key
//      ai-actions.ts proposes into the conversational auto-execute gate.
//
// GENESIS_ACTIONS is none of these. It is the EXECUTION namespace: what can
// be executed once something has decided to.
const proposable = (
  ProposedActionSchema as unknown as { options: { shape: { actionType: { value: string } } }[] }
).options.map((o) => o.shape.actionType.value);
check("A. the proposal layer yields real literals", proposable.length > 0, proposable.join(" "));
check("  and every one of them is a registered action",
  proposable.every((k) => Object.hasOwn(GENESIS_ACTIONS, k)),
  proposable.filter((k) => !Object.hasOwn(GENESIS_ACTIONS, k)).join(", ") || `${proposable.length} proposable`);

// THE LIST BESIDE THE SCHEMA HAS TO AGREE WITH THE SCHEMA. cognitiveLayer
// keeps PROPOSABLE_ACTION_TYPES by hand so growthPointCosts can price exactly
// what Reason can propose. `satisfies` proves each entry is a real action; it
// does not prove the list matches the union. If they drift, this invariant is
// reading one world and production is pricing another.
check("  and the hand-kept proposable list matches it",
  [...PROPOSABLE_ACTION_TYPES].slice().sort().join(" ") === proposable.slice().sort().join(" "),
  [...PROPOSABLE_ACTION_TYPES].join(" "));

const chatToolNames = buildStoreChatUnifiedTools().map((t) => t.name);
const chatSelectable = chatToolNames.filter((n) => Object.hasOwn(GENESIS_ACTIONS, n));
check("B. the chat catalogue yields real tools", chatToolNames.length > 0, `${chatToolNames.length} tools`);
// NOT A DEFECT — A BOUNDARY. Most chat tools are not GENESIS_ACTIONS keys,
// because a tool is a conversational capability and an action is an execution
// record. The overlap is the part of the decision namespace that names the
// execution namespace directly, and it is what makes those actions selectable.
check("  and the overlap with the execution namespace is real",
  chatSelectable.length > 0, chatSelectable.join(" "));

// C. PRODUCTION SELECTING AN ACTION ON ITS OWN. Two stages, both derived: the
// file has to reach a path that can execute WITHOUT ASKING, AND name an
// action key where that path can receive it. Either alone is worthless —
// dashboards filter rows by actionType without executing anything, and the
// autonomy module mentions plenty of keys it never selects.
//
// BOTH UNASKED-EXECUTION PATHS, or this is the half-model again:
//   tryExecuteAutonomousAction   the grant-gated path (cognitiveLayer)
//   authorityExemptAction        the additive carve-out (communicateFinding)
//   authorizationTier === "auto" the conversational auto-execute gate in
//                                ai-actions.ts, which acts on the registry
//                                tier alone
const ENTRY_POINT =
  /tryExecuteAutonomousAction\(|authorityExemptAction|authorizationTier\s*===\s*"auto"/;
// A key is SELECTED when it is bound to actionType or passed by name into a
// propose-style call — `proposeAction("update_seo", ...)` is how the chat
// path names one, and a positional argument is not an `actionType:` property.
const ACTION_TYPE_BINDING = /(?:actionType\s*[:=]\s*|propose[A-Za-z]*\(\s*)"([a-z_]+)"/g;
const selectionSites: { file: string; keys: string[] }[] = [];
for (const f of [...sourceFiles("app"), ...sourceFiles("lib")]) {
  const src = codeOnly(read(...f.split("/")));
  if (!ENTRY_POINT.test(src)) continue;
  const keys = [...new Set(
    [...src.matchAll(ACTION_TYPE_BINDING)].map((m) => m[1]).filter((k) => Object.hasOwn(GENESIS_ACTIONS, k)),
  )];
  if (keys.length) selectionSites.push({ file: f, keys });
}
check("C. production selects at least one action by name itself",
  selectionSites.length > 0,
  selectionSites.map((s) => `${s.file} → ${s.keys.join(" ")}`).join("; "));

const reachable = new Set([...proposable, ...chatSelectable, ...selectionSites.flatMap((s) => s.keys)]);
const whereFrom = (k: string): string =>
  [
    proposable.includes(k) ? "proposal" : "",
    chatSelectable.includes(k) ? "chat tool" : "",
    selectionSites.some((s) => s.keys.includes(k)) ? "production code" : "",
  ].filter(Boolean).join(" + ") || "NOTHING";

// AUTONOMOUS MEANS "RUNS WITHOUT ASKING", which includes auto_below_limit —
// an action that executes on its own under a threshold is still an action
// nobody approved.
const autonomous = actions.filter(([, d]) => RANK[d.authorizationTier] >= RANK.auto_below_limit);
check("the registry has autonomous actions to check at all", autonomous.length > 0,
  autonomous.map(([k]) => k).join(" "));

for (const [key, d] of autonomous) {
  console.log(`      ${key}: ${d.authorizationTier} ← ${whereFrom(key)}`);
}

const unreachable = autonomous.filter(([k]) => !reachable.has(k));
check("EVERY AUTONOMOUS ACTION IS REACHABLE FROM A PRODUCTION DECISION PATH",
  unreachable.length === 0,
  unreachable.map(([k, d]) => `${k} is ${d.authorizationTier} but nothing can select it`).join("; ") ||
    autonomous.map(([k]) => `${k} ← ${whereFrom(k)}`).join("; "));

// AND THE PATH ENDS SOMEWHERE REAL. Reachable is only half of it: the
// decision has to arrive at an executable that exists and names its execution
// action, or the trace stops in mid-air.
for (const [key, d] of autonomous) {
  const executed = (d.executable as { action?: unknown }).action;
  check(`  ${key}: the path ends at an executable`,
    typeof executed === "string" && executed.length > 0,
    typeof executed === "string" ? executed : typeof executed);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
process.exit(failed.length === 0 ? 0 : 1);
