import Module from "node:module";

// LET THE HARNESS IMPORT A MODULE MARKED `server-only`.
//
//   import "@/scripts/lib/allowServerOnly";   // FIRST, before the module
//
// ============ WHY THIS IS NOT A TEST SEAM (2026-08-30) =================
//
// `server-only` is a package with no runtime behaviour whatsoever. Its entire
// job is to be unresolvable in a client bundle, so that importing a server
// module from client code fails the BUILD. Next provides it; plain tsx does
// not, so any module that imports it — and anything importing that module,
// transitively — has been unreachable from this harness. That has quietly
// decided what could be tested for months.
//
// Stubbing its RESOLUTION restores reachability and changes no behaviour: there
// is no behaviour to change. It is the opposite of the seam this codebase has
// been bitten by, where an injected double replaced the thing under test and
// four green checks measured the injection point. Nothing here stands in for
// anything — least of all a session, a permission, or a guard, which must
// always be the real ones.
//
// Harness-only. Nothing in lib/ or app/ imports this file, and a suite that
// used it to replace a real dependency would be doing something else entirely.

const NAME = "server-only";

type Resolver = (this: unknown, request: string, ...rest: unknown[]) => string;
const loader = Module as unknown as { _resolveFilename: Resolver };

if (!(globalThis as Record<string, unknown>).__serverOnlyStubbed) {
  const original = loader._resolveFilename;
  loader._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]): string {
    // Resolve to a module that exists and does nothing. `node:util` is always
    // present and importing it for its side effects has none.
    if (request === NAME || request === `${NAME}/empty`) {
      return original.call(this, "node:util", ...rest);
    }
    return original.call(this, request, ...rest);
  } as Resolver;
  (globalThis as Record<string, unknown>).__serverOnlyStubbed = true;
}
