// A failing suite must not exit 0 (2026-09-02, gap 25).
//
// THE BUG THIS EXISTS FOR. `embedded-postgres` calls `AsyncExitHook(...)` at
// module scope (dist/index.js:397), so merely importing it registers
// async-exit-hook's handlers. One of those is
//
//     add.hookEvent("beforeExit", 0)          async-exit-hook/index.js:90
//
// whose listener ends in `process.nextTick(process.exit.bind(null, 0))` — a
// hard exit with a HARD-CODED ZERO. Any process that reports failure the
// ordinary Node way, by setting `process.exitCode` and returning, therefore
// exits 0 once the event loop drains. The failure is real, the assertions
// printed it, and the runner still records PASS, because a runner has nothing
// to go on but the child's exit code.
//
// That reached every suite that touches a real Postgres or a test server:
// scripts/lib/testServer.ts imports realPostgres, so the whole HTTP lane
// inherited it. Suites that call `process.exit(1)` outright were unaffected,
// which is why the code-only lane never lied.
//
// THE FIX. `prependListener` puts this ahead of async-exit-hook's handler
// whatever order the modules load in — deliberately not "import this first",
// which is an ordering convention a formatter can silently undo. When the
// process meant to fail, it exits with the code it meant; when it meant to
// succeed, this does nothing at all and the graceful-shutdown hook runs
// exactly as before.
//
// `process.exit()` still emits "exit", so embedded-postgres's synchronous
// teardown continues to run on the failing path too.
process.prependListener("beforeExit", () => {
  const intended = process.exitCode;
  if (intended === undefined || intended === 0) return;
  process.exit(typeof intended === "number" ? intended : 1);
});

export {};
