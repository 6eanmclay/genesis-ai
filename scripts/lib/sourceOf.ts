import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative, sep } from "path";

// WHERE THE CODE IS NOW, ASKED RATHER THAN REMEMBERED.
//
// ============ THE FAILURE CLASS THIS ENDS (2026-09-02) ===============
//
// A source assertion names a file by hand:
//
//     const stripeHook = read("app", "api", "webhooks", "stripe", "route.ts");
//     assert("...", /stripeAccount: event\.account/.test(stripeHook));
//
// The code then moves. The behaviour is intact at its new address, the file
// at the old one still exists, and the assertion goes red for a reason that
// has nothing to do with what it is checking. Four suites failed exactly this
// way in a single run of the new lanes: the Stripe handler had moved into
// lib/payments/stripeEvent.ts, the destination map into toolHandlers.ts as
// NAV_DESTINATIONS, the cron stages into the scheduler, and a card list had
// been deliberately removed from a page.
//
// Worse is the silent direction. A file that is DELETED and recreated
// elsewhere leaves the assertion reading a stale copy and passing — green,
// about code nobody runs.
//
// ============ WHY THIS CANNOT BECOME A SECOND SOURCE OF TRUTH ========
//
// The obvious shape is a map — { NAV_DESTINATIONS: "lib/execution/toolHandlers.ts" }
// — and it would be the same bug one level up: a hand-maintained record of
// where things live, drifting the moment something moves.
//
// So THIS RECORDS NOTHING. Every call walks the tree and finds the
// declaration. The filesystem is the only source of truth, there is no
// mapping to update, and a symbol that has moved is simply found in its new
// home. Nothing here can disagree with the implementation, because nothing
// here remembers the implementation.
//
// ============ AND IT NEVER GUESSES ===================================
//
// No fallback to a filename, no "closest match", no partial-name search. A
// symbol that cannot be resolved throws SymbolNotFound; one that resolves in
// more than one place throws SymbolAmbiguous and names them. Both are loud
// and both name the symbol, because the whole point is to convert a confusing
// assertion failure into a sentence that says what actually happened.

const ROOTS = ["app", "lib"];
const EXTENSIONS = [".ts", ".tsx"];

/** The symbol is nowhere. It was renamed, deleted, or never existed. */
export class SymbolNotFound extends Error {
  constructor(readonly symbol: string) {
    super(
      `No declaration of \`${symbol}\` under ${ROOTS.join("/ or ")}/. ` +
        `It was renamed, deleted, or is not exported at the top level — find where the behaviour ` +
        `lives now and check it there. Do NOT re-point this at a file by hand; that is the habit ` +
        `this helper exists to remove.`
    );
    this.name = "SymbolNotFound";
  }
}

/** More than one declaration. Guessing between them is exactly the wrong move. */
export class SymbolAmbiguous extends Error {
  constructor(readonly symbol: string, readonly files: string[]) {
    super(
      `\`${symbol}\` is declared in ${files.length} files: ${files.join(", ")}. ` +
        `Pick a symbol unique to the module you mean, or use sourceOfRoute() if this is a route ` +
        `handler — every Next route exports GET, so the name is not an identity there.`
    );
    this.name = "SymbolAmbiguous";
  }
}

/** A route path with no handler. The URL itself has changed, which is real. */
export class RouteNotFound extends Error {
  constructor(readonly routePath: string, readonly tried: string) {
    super(
      `No route handler for \`${routePath}\` (looked for ${tried}). ` +
        `A route that moved changed its URL, which is a behavioural change rather than a ` +
        `refactor — check what serves that path now.`
    );
    this.name = "RouteNotFound";
  }
}

/**
 * WALKED EVERY TIME, DELIBERATELY.
 *
 * This cached the file list per process, and its own test caught why that is
 * wrong: after a module is MOVED the cache still lists the old path, so the
 * next resolve reads a file that is no longer there. Following a move is the
 * single property this helper exists to provide, and a cache that defeats it
 * inside one process would defeat it inside one suite run.
 *
 * The trees are small and the callers are few. Correctness is worth more here
 * than the milliseconds.
 */
function allSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (EXTENSIONS.some((e) => entry.endsWith(e))) out.push(full);
    }
  };
  for (const root of ROOTS) walk(join(process.cwd(), root));
  return out;
}

/**
 * Every top-level declaration form this codebase actually uses.
 *
 * Deliberately anchored at the start of a line and followed by a word
 * boundary: without the boundary `runDueTasks` would match `runDueTasksNow`,
 * which is the resolve-something-unrelated failure this must not have.
 */
function declares(source: string, symbol: string): boolean {
  const name = symbol.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    `^export (?:async function|function|const|let|class|interface|type|enum) ${name}\\b|` +
      `^(?:async function|function|const|let|class|interface|type|enum) ${name}\\b`,
    "m"
  ).test(source);
}

/** Repo-relative path of the file declaring `symbol`. Throws rather than guesses. */
export function fileOfSymbol(symbol: string): string {
  const matches = allSourceFiles().filter((f) => declares(readFileSync(f, "utf8"), symbol));
  const relatives = matches.map((f) => relative(process.cwd(), f).split(sep).join("/")).sort();
  if (relatives.length === 0) throw new SymbolNotFound(symbol);
  if (relatives.length > 1) throw new SymbolAmbiguous(symbol, relatives);
  return relatives[0];
}

/**
 * The source of the module that declares `symbol`.
 *
 * This is what an assertion should read. The pattern it then tests is still
 * its own business — this only answers WHERE, never WHETHER.
 */
export function sourceOfSymbol(symbol: string): string {
  return readFileSync(join(process.cwd(), fileOfSymbol(symbol)), "utf8");
}

/**
 * A Next route handler, identified by the URL it serves.
 *
 * Routes need this because their exported names are fixed by the framework —
 * fourteen files in this repository export `GET`, so a symbol is no identity.
 * The path IS the identity, and it is still derived rather than recorded: the
 * file location follows from the URL by Next's own convention, so a route
 * that moves has changed its URL, which is a real change and should fail.
 */
export function fileOfRoute(routePath: string): string {
  const clean = routePath.replace(/^\/+|\/+$/g, "");
  const candidate = join("app", ...clean.split("/"), "route.ts");
  try {
    statSync(join(process.cwd(), candidate));
  } catch {
    throw new RouteNotFound(routePath, candidate);
  }
  return candidate.split(sep).join("/");
}

export function sourceOfRoute(routePath: string): string {
  return readFileSync(join(process.cwd(), fileOfRoute(routePath)), "utf8");
}
