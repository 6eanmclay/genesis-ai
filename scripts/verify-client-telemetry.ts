import { readFileSync } from "fs";
import { join } from "path";
import { CLIENT_EVENTS, resolveClientEvent } from "@/lib/telemetry/clientEvents";

// A BROWSER CANNOT INVENT AN EVENT:
//
//   npx tsx scripts/run-code-suites.ts client-telemetry
//
// ============ THE CONTRACT (gap 8, 2026-09-16) =========================
//
// logClientEvent is a "use server" action, which is an HTTP endpoint any
// signed-in caller can invoke with any arguments. It took `name` and
// `category` verbatim and wrote them, so the analytics catalog was writable by
// the client: unbounded distinct names, and a navigation event could file
// itself under "creation" and move a number on a screen an owner reads.
//
// TYPES PROVE NOTHING HERE. ClientEventName constrains our own call sites and
// constrains nothing at all coming over the wire, where the argument is
// whatever JSON somebody sent. So the assertions below call the resolver with
// the shapes a caller would actually send — unknown names, wrong types, extra
// metadata keys — rather than with values the compiler already approved.
//
// THE GENERIC WRITER IS DELIBERATELY UNTOUCHED. lib/telemetry/events.ts says
// its own `name` is "a plain, freely-growing string catalog", which is right
// for server call sites somebody wrote and reviewed. Section 4 asserts this
// change did not creep into it.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

/** Source with comments stripped, so prose is never read as code. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const read = (p: string) => codeOnly(readFileSync(join(process.cwd(), p), "utf8"));

// ====================================================================
console.log("\n1. A name nobody declared writes nothing\n");
// ====================================================================
{
  // THE ASSERTION THIS SUITE EXISTS FOR. Before the registry, every one of
  // these produced a ProductEvent row with that exact name.
  for (const name of [
    "totally.made.up",
    "nav.section_view ",         // a trailing space is a different string
    "NAV.SECTION_VIEW",
    "",
    "__proto__",
    "constructor",
  ]) {
    assert(`"${name}" is refused`, resolveClientEvent({ name }) === null,
      JSON.stringify(resolveClientEvent({ name })));
  }
}

// ====================================================================
console.log("\n2. A declared name resolves, and the CATEGORY is ours\n");
// ====================================================================
{
  const resolved = resolveClientEvent({ name: "nav.section_view", storeId: "store_1" });
  assert("a real event resolves", resolved !== null);
  assert("  with its registered category", resolved?.category === "navigation", resolved?.category);
  assert("  and the store it was sent with", resolved?.storeId === "store_1", String(resolved?.storeId));

  // THE OTHER HALF OF THE DEFECT. `category` used to come from the caller, so
  // a navigation event could be filed as creation. It is no longer an input at
  // all — passing one changes nothing.
  const lying = resolveClientEvent({
    name: "nav.section_view",
    category: "creation",
  } as never);
  assert("a caller cannot choose the category", lying?.category === "navigation", lying?.category);

  // And every registered event agrees with itself.
  for (const [name, shape] of Object.entries(CLIENT_EVENTS)) {
    assert(`  ${name} resolves to its own category`,
      resolveClientEvent({ name })?.category === shape.category, name);
  }
}

// ====================================================================
console.log("\n3. Only the metadata that event is declared to carry\n");
// ====================================================================
{
  const resolved = resolveClientEvent({
    name: "perf.action_pending",
    metadata: { label: "Save", feltSlow: true, smuggled: "x".repeat(5000), userId: "someone-else" },
  });
  assert("the declared keys survive",
    resolved?.metadata?.label === "Save" && resolved?.metadata?.feltSlow === true,
    JSON.stringify(resolved?.metadata));
  assert("  and an undeclared key does not",
    resolved?.metadata !== null && !Object.hasOwn(resolved!.metadata!, "smuggled"),
    JSON.stringify(resolved?.metadata));
  assert("  including one that names another person",
    resolved?.metadata !== null && !Object.hasOwn(resolved!.metadata!, "userId"));

  // NOTHING SENT AND NOTHING SURVIVING ARE DIFFERENT FACTS, and neither should
  // become an empty object sitting on a row.
  assert("no metadata stays no metadata",
    resolveClientEvent({ name: "nav.section_view" })?.metadata === null);
  assert("  and metadata that is entirely undeclared comes out null",
    resolveClientEvent({ name: "nav.section_view", metadata: { nope: 1 } })?.metadata === null);

  // A NON-OBJECT IS NOT A CRASH. Telemetry must never break the feature it is
  // attached to, and this is reachable over HTTP.
  for (const bad of ["a string", 42, true, []] as unknown[]) {
    const out = resolveClientEvent({ name: "nav.section_view", metadata: bad as never });
    assert(`metadata ${JSON.stringify(bad)} is survivable`, out !== null, "resolver returned null");
  }
}

// ====================================================================
console.log("\n4. The other fields are checked too, not just passed on\n");
// ====================================================================
{
  assert("a real outcome survives",
    resolveClientEvent({ name: "focus.route_resolved", outcome: "success" })?.outcome === "success");
  assert("  an invented one becomes null",
    resolveClientEvent({ name: "focus.route_resolved", outcome: "brilliant" })?.outcome === null);

  assert("a real duration survives",
    resolveClientEvent({ name: "perf.action_pending", durationMs: 1200 })?.durationMs === 1200);
  // NaN and Infinity are both `typeof "number"`, which is why a bare typeof
  // check is not enough — either would reach the column and break arithmetic
  // downstream of it.
  for (const bad of [NaN, Infinity, -1, -0.5]) {
    assert(`  durationMs ${String(bad)} does not`,
      resolveClientEvent({ name: "perf.action_pending", durationMs: bad })?.durationMs === null,
      String(resolveClientEvent({ name: "perf.action_pending", durationMs: bad })?.durationMs));
  }
}

// ====================================================================
console.log("\n5. The registry is what the product actually sends\n");
// ====================================================================
{
  // A REGISTRY THAT DRIFTS FROM ITS CALL SITES IS THE MIRRORED-REGISTRY BUG
  // ARCHITECTURE.md names. Read off the real files rather than restated here.
  const callers = ["app/dashboard/DashboardShell.tsx", "app/dashboard/SubmitButton.tsx"];
  const source = callers.map(read).join("\n");

  for (const name of Object.keys(CLIENT_EVENTS)) {
    assert(`${name} is actually sent by a real screen`, source.includes(`"${name}"`), name);
  }

  // AND NOTHING IS SENT THAT IS NOT REGISTERED — the direction that would
  // silently drop a real event rather than merely carry a dead entry.
  const sent = [...source.matchAll(/name:\s*(?:[^,\n]*\?\s*)?"([a-z]+\.[a-z_]+)"(?:\s*:\s*"([a-z]+\.[a-z_]+)")?/g)]
    .flatMap((m) => [m[1], m[2]])
    .filter((n): n is string => Boolean(n));
  assert("the scan found the call sites at all", sent.length >= 4, `${sent.length} found`);
  for (const name of sent) {
    assert(`  ${name} is registered`, Object.hasOwn(CLIENT_EVENTS, name), name);
  }

  // THE CALLERS NO LONGER CHOOSE A CATEGORY. The field is gone from the input,
  // so a leftover one is a call site that did not get the message.
  for (const caller of callers) {
    assert(`${caller} no longer passes a category`,
      !/logClientEvent\(\{[^}]*category:/.test(read(caller)), caller);
  }
}

// ====================================================================
console.log("\n6. The SERVER writer is deliberately still open\n");
// ====================================================================
{
  // Sean's standing rule about not narrowing something that was decided on
  // purpose. lib/telemetry/events.ts calls its own name field "a plain,
  // freely-growing string catalog", which is right for call sites somebody
  // wrote and reviewed. This change is about the one entry point a BROWSER
  // reaches, and it must not have crept further.
  const events = read("lib/telemetry/events.ts");
  assert("logProductEvent still takes a plain string name",
    /name:\s*string;/.test(events), "the generic writer was narrowed — check that was intended");
  assert("  and does not consult the client registry",
    !events.includes("CLIENT_EVENTS"), "the server writer should not know about this list");

  // And the action really does go through the resolver rather than around it.
  const action = read("app/dashboard/telemetry-actions.ts");
  assert("the action resolves before it writes", action.includes("resolveClientEvent"));
  assert("  and passes the resolved event, not the caller's input",
    !/name:\s*input\.name/.test(action), "the raw input name still reaches the writer");
  assert("  and no longer takes a category from the caller",
    !/category:\s*input\.category/.test(action));
}

console.log(`\n${failures} failed, ${passes} passed`);
if (failures > 0) {
  console.log("\nFAILED:");
  for (const line of failed) console.log(`  ${line}`);
  process.exit(1);
}
process.exit(0);
