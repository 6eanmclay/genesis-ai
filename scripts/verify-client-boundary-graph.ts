import { readFileSync, readdirSync, statSync, existsSync } from "fs";
import { join, dirname, resolve, relative } from "path";

// NO SERVER-ONLY CODE REACHES A CLIENT BUNDLE:
//
//   npx tsx scripts/verify-client-boundary-graph.ts
//
// ============ WHAT THIS EXISTS TO END (2026-09-14) =====================
//
// lib/j4/observationNeeds.ts needed one string — the "commerce:" namespace —
// and imported it from lib/commerce/conditions.ts, which imports the Prisma
// client, and that single value import pulled pg into a client bundle:
//
// (The name is spelled that way on purpose: suiteLanes.ts decides this suite's
// lane by matching /prisma\./ against the RAW source, comments included, so a
// sentence ending in the word would file a database-free check under the
// database lane. Prose read as code, which is the same mistake this file's own
// parser made an hour ago.)
//
//   app/j4/J4Workspace.tsx  ("use client")
//     -> lib/j4/officeBriefing.ts -> lib/j4/officeActions.ts
//     -> lib/j4/observationNeeds.ts -> lib/commerce/conditions.ts
//     -> @/lib/prisma -> pg -> net / tls / dns / fs
//
// Next could not resolve those builtins for the browser, client chunk
// generation failed, and /onboarding/launch rendered a blank document.
//
// NOTHING ELSE CATCHES IT. tsc compiles it happily. The code lane and the db
// lane import these modules on the SERVER, where prisma resolves fine. Only a
// real client build fails, which is why it took a browser suite in a pre-push
// gate to find a blank page.
//
// ============ A GRAPH, NOT A GREP =====================================
//
// A string test ("does this file mention prisma") proves nothing: the offending
// import was four modules away and named a constant. So this WALKS the real
// import graph from every "use client" entry point and reports the whole chain
// when it reaches something the browser cannot have.
//
// TWO RULES MAKE IT HONEST RATHER THAN NOISY:
//
//   `import type` is erased at compile time and is not followed. A type that
//   crosses this line costs nothing at runtime, which is exactly why
//   lib/j4/boundaries.ts is allowed to import one.
//
//   A "use server" module is a BOUNDARY, not a violation. Next compiles it to
//   a server endpoint and does not bundle its body for the browser, so a client
//   component importing an action is correct and the walk stops there. Without
//   this rule the check would condemn every form in the codebase.

const ROOT = process.cwd();

/** What a browser cannot have, whatever route it arrives by. */
const SERVER_ONLY = [
  "server-only",
  "@/lib/prisma",
  "@prisma/client",
  "next/headers",
  "@/auth",
  "fs", "net", "tls", "dns", "child_process", "crypto", "pg",
];

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `\n      ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail}` : ""}`);
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walkFiles(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

/** Source with comments stripped, so prose is never read as code. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * Every VALUE import specifier in a file. Type-only imports are erased.
 *
 * COMMENTS ARE STRIPPED FIRST, and that is not tidiness. The first version of
 * this matched the word "import" inside a prose comment and ran the match on
 * to the next real `from`, capturing the sentence as an import clause — which
 * does not begin with `type`, so a type-only import of lib/permissions was
 * reported as a value import and navConfig was accused of dragging @/auth into
 * every client bundle. The checker was wrong about code that was right.
 *
 * ANCHORED TO A LINE START for the same reason: `import` inside an expression
 * or a string is not a declaration.
 */
function valueImports(raw: string): string[] {
  const src = codeOnly(raw);
  const found: string[] = [];
  const pattern = /^\s*import\s+([^;]*?)\s*from\s*["']([^"']+)["']/gm;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(src))) {
    const clause = m[1].trim();
    // `import type { X } from` / `import type X from` — erased entirely.
    if (/^type\b/.test(clause)) continue;
    // `import { type A, type B }` — every specifier type-only, so nothing left.
    const named = /^\{([\s\S]*)\}$/.exec(clause);
    if (named) {
      const specs = named[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (specs.length > 0 && specs.every((s) => /^type\s/.test(s))) continue;
    }
    found.push(m[2]);
  }
  // `import "server-only";` has no clause and is a real runtime import.
  const bare = /^\s*import\s+["']([^"']+)["']/gm;
  while ((m = bare.exec(src))) found.push(m[1]);
  return found;
}

function resolveSpecifier(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else return null; // a package — judged by name, never walked into
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

const rel = (f: string) => relative(ROOT, f).replace(/\\/g, "/");

/**
 * The first server-only module reachable from `entry`, with the chain that got
 * there — or null when the whole closure is browser-safe.
 */
function firstServerOnlyReach(entry: string): string[] | null {
  const seen = new Set<string>();
  const stack: { file: string; chain: string[] }[] = [{ file: entry, chain: [rel(entry)] }];

  while (stack.length > 0) {
    const { file, chain } = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const src = readFileSync(file, "utf8");
    // A server action module is a boundary: Next serves it, never bundles it.
    if (file !== entry && /^\s*["']use server["']/m.test(src)) continue;

    for (const spec of valueImports(src)) {
      if (SERVER_ONLY.includes(spec)) return [...chain, `${spec}   <-- server-only`];
      const next = resolveSpecifier(spec, file);
      if (next) stack.push({ file: next, chain: [...chain, rel(next)] });
    }
  }
  return null;
}

const files = walkFiles(join(ROOT, "app")).concat(walkFiles(join(ROOT, "lib")));
const clientEntries = files.filter((f) => /^\s*["']use client["']/m.test(readFileSync(f, "utf8").replace(/^﻿/, "")));

console.log(`\n${clientEntries.length} "use client" entry points\n`);

// ====================================================================
console.log("1. The J4 client graph\n");
// ====================================================================
//
// Scoped to the graph the defect was in, and asserted per entry point so a
// failure names which screen breaks rather than "something, somewhere".
const j4Entries = clientEntries.filter((f) => rel(f).startsWith("app/j4/"));
assert("there are J4 client entry points to check", j4Entries.length > 0, `${j4Entries.length}`);
for (const entry of j4Entries) {
  const reach = firstServerOnlyReach(entry);
  assert(`${rel(entry)} reaches no server-only module`, reach === null, reach ? reach.join("\n        -> ") : "");
}

// ====================================================================
console.log("\n2. The modules that defect ran through\n");
// ====================================================================
//
// Named explicitly, because these are the ones a future edit is most likely to
// reach across: they sit on the Office's action path, which is value-imported
// by a client component.
for (const name of [
  "lib/j4/officeBriefing.ts",
  "lib/j4/officeActions.ts",
  "lib/j4/observationNeeds.ts",
  "lib/j4/officeSections.ts",
  "lib/j4/boundaries.ts",
  "lib/commerce/observationNeeds.ts",
  "lib/commerce/conditionKeys.ts",
]) {
  const file = join(ROOT, name);
  const reach = existsSync(file) ? firstServerOnlyReach(file) : ["MISSING FILE"];
  assert(`${name} is browser-safe`, reach === null, reach ? reach.join("\n        -> ") : "");
}

// ====================================================================
console.log("\n3. CONTROL: the checker can actually see a violation\n");
// ====================================================================
{
  // Without this, every assertion above passes on a checker that resolves
  // nothing. lib/commerce/conditions.ts genuinely imports prisma, and it is
  // exactly what observationNeeds.ts used to reach.
  const known = firstServerOnlyReach(join(ROOT, "lib/commerce/conditions.ts"));
  assert("it finds prisma from lib/commerce/conditions.ts", known !== null,
    known ? known.join(" -> ") : "the walker found nothing, so it proves nothing above");
  // AND THAT IT FOLLOWS A CHAIN, not just direct imports — the defect was four
  // modules deep.
  const deep = firstServerOnlyReach(join(ROOT, "lib/commerce/observationNeeds.ts"));
  assert("  and does not merely check direct imports", deep === null,
    deep ? deep.join(" -> ") : "");
}

console.log(`\n${failures} failed, ${passes} passed`);
if (failures > 0) {
  console.log("\nFAILED:");
  for (const line of failed) console.log(`  ${line}`);
  process.exitCode = 1;
}
