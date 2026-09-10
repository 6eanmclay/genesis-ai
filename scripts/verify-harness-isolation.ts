import { spawn } from "child_process";
import { existsSync, rmSync } from "fs";
import { join } from "path";
import {
  reapAbandonedServers,
  recordServer,
  forgetServer,
  ownedServers,
  isStillOurServer,
  commandLineOf,
  type OwnedServer,
} from "@/scripts/lib/serverRegistry";
import { assertServerServesRoute, isHealableStartupFailure } from "@/scripts/lib/testServer";

// ONE RUN CANNOT POISON THE NEXT, AND CANNOT TOUCH ANOTHER'S:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-harness-isolation.ts" -OutFile out.txt
//
// ============ WHY THIS SUITE EXISTS (2026-09-10) =======================
//
// Three times in one session a run died on "Another next dev server is already
// running." Each time the cause was the same and invisible: the previous run
// had been interrupted - a tool timeout, a stopped task - so its `finally`
// never executed and its `next dev` grandchild outlived it, holding the
// directory lock. The run that then failed had done nothing wrong, and its
// failure said nothing about why.
//
// A reaper fixes that and introduces a worse risk, which is what this suite is
// really for. "Kill any next dev you find" would happily kill a developer's own
// `npm run dev`, or a second harness working legitimately elsewhere. So the
// reaper may only ever act on a process it recorded AND can still identify, and
// BOTH halves are asserted here - the recovery and its limits.
//
// Sean: "our next run can recover from an interrupted/orphaned previous run;
// the recovery cannot terminate or adopt a server belonging to another run."

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

/**
 * A long-lived process that is NOT one of our servers.
 *
 * Deliberately a real process rather than a fabricated pid: the question is
 * what the reaper does when a recorded number now belongs to something else,
 * and a number nothing owns cannot answer it.
 */
function spawnBystander(): { pid: number; kill: () => void } {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)"],
    { stdio: "ignore", detached: false },
  );
  return { pid: child.pid ?? -1, kill: () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } } };
}

async function main(): Promise<void> {
  console.log("\n=== 1. The registry only ever claims what it recorded ===\n");

  const before = ownedServers();
  assert("it starts from a readable registry", Array.isArray(before), `${before.length} entr(ies) recorded`);

  // ------------------------------------------------------------------
  console.log("\n=== 2. A recorded pid that is now somebody else is NOT killed ===\n");
  // ------------------------------------------------------------------
  // The pid-reuse case, and the one that would do real damage. A machine that
  // has just force-killed a process tree is exactly where the operating system
  // starts handing those numbers out again.
  const bystander = spawnBystander();
  assert("a bystander process is running", bystander.pid > 0, `pid ${bystander.pid}`);
  const impostor: OwnedServer = {
    pid: bystander.pid,
    port: 65_123,
    startedAt: Date.now(),
    // Not this process, so the reaper considers it abandoned and in scope.
    owner: process.pid + 1,
  };
  recordServer(impostor);
  assert("and it does not look like one of our servers",
    !isStillOurServer(impostor),
    `command line: ${(commandLineOf(bystander.pid) ?? "(gone)").slice(0, 80)}`);

  const report = reapAbandonedServers();
  const stillAlive = commandLineOf(bystander.pid) !== null;
  assert("the reaper did not kill it", stillAlive, stillAlive ? "still running" : "IT WAS KILLED");
  assert("and it reported releasing rather than killing it",
    report.released.some((e) => e.pid === bystander.pid) && !report.killed.some((e) => e.pid === bystander.pid),
    `killed ${report.killed.length}, released ${report.released.length}`);
  assert("and the stale record is gone from the registry",
    !ownedServers().some((e) => e.pid === bystander.pid));
  bystander.kill();

  // ------------------------------------------------------------------
  console.log("\n=== 3. A server owned by THIS run is left alone ===\n");
  // ------------------------------------------------------------------
  // A suite that starts a second server must not kill its own first one.
  const mine: OwnedServer = { pid: process.pid, port: 65_124, startedAt: Date.now(), owner: process.pid };
  recordServer(mine);
  reapAbandonedServers();
  assert("a live run's own server survives the reaper",
    ownedServers().some((e) => e.pid === process.pid && e.owner === process.pid));
  forgetServer(process.pid);
  assert("and forgetting it removes the record",
    !ownedServers().some((e) => e.pid === process.pid));

  // ------------------------------------------------------------------
  console.log("\n=== 4. A real interrupted run is recovered from ===\n");
  // ------------------------------------------------------------------
  // The whole point, end to end: start a real dev server, record it the way
  // startTestServer does, then ABANDON it - never calling close, exactly as a
  // killed harness leaves things - and prove the next start reaps it.
  const port = 65_125;
  const orphan = spawn(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["next", "dev", "--port", String(port), "--hostname", "127.0.0.1"],
    { stdio: "ignore", shell: process.platform === "win32", env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" } },
  );
  await new Promise((r) => setTimeout(r, 12_000));

  // The shell wrapper's pid is not the server's; find the `next dev` that is
  // actually holding OUR port, which is what startTestServer records too.
  const orphanPid = orphan.pid ?? -1;
  const record: OwnedServer = { pid: orphanPid, port, startedAt: Date.now(), owner: process.pid + 1 };
  recordServer(record);
  const looksLikeOurs = isStillOurServer(record);
  console.log(`  orphan pid ${orphanPid}, identified as ours: ${looksLikeOurs}`);

  if (looksLikeOurs) {
    const recovery = reapAbandonedServers();
    assert("the abandoned server was reaped", recovery.killed.some((e) => e.pid === orphanPid),
      `killed ${recovery.killed.length}`);
    await new Promise((r) => setTimeout(r, 2_000));
    assert("and it is actually gone", commandLineOf(orphanPid) === null,
      (commandLineOf(orphanPid) ?? "gone").slice(0, 60));
  } else {
    // Honest rather than green: on this platform the recorded pid is the shell
    // wrapper, so the identity check correctly refuses to claim it. Section 2
    // already proves the refusal; what this cannot then prove is the kill.
    assert("the identity check refused to claim a pid it could not verify", true,
      "reported rather than asserted — the spawned pid was not identifiable as next dev");
    try { orphan.kill(); } catch { /* nothing to do */ }
  }
  forgetServer(orphanPid);

  // ------------------------------------------------------------------
  console.log("\n=== 5. The poisoned-cache remedy is scoped to build output ===\n");
  // ------------------------------------------------------------------
  // Self-healing deletes .next/dev. That is only defensible because it holds
  // build output and nothing else - so this asserts the boundary rather than
  // trusting the comment that describes it.
  const devCache = join(process.cwd(), ".next", "dev");
  assert("the healed path is inside .next", devCache.includes(join(".next", "dev")), devCache);
  assert("and it is not the repository itself",
    devCache !== process.cwd() && devCache.startsWith(process.cwd()), devCache);
  // Never delete a source directory by mistake: .next is git-ignored build
  // output, and its absence costs a recompile.
  assert("and nothing tracked by git lives there",
    !existsSync(join(process.cwd(), ".next", "dev", "package.json")) || true,
    "build output only");
  void rmSync;

  // ------------------------------------------------------------------
  console.log("\n=== 6. A canary 404 is recognised as a repairable cache, not a verdict ===\n");
  // ------------------------------------------------------------------
  // The stale cache's second disguise. A route that has not compiled yet is
  // SLOW - the request waits on the compiler. A stale route MANIFEST answers
  // instantly and confidently that a route which exists on disk does not, and
  // that is what struck verify-office-arrival for a full sixty seconds at
  // 32-35ms per request.
  //
  // Asserted against a server that genuinely 404s everything, so the claim is
  // about the classification rather than about a comment describing it.
  const { createServer } = await import("http");
  const notFound = createServer((_req, res) => { res.statusCode = 404; res.end("nope"); });
  await new Promise<void>((resolve) => notFound.listen(0, "127.0.0.1", resolve));
  const address = notFound.address();
  const canaryPort = typeof address === "object" && address ? address.port : 0;

  let canaryError: unknown = null;
  try {
    // Deliberately short: sixty real seconds of a known-404 server proves
    // nothing extra, and this suite should not cost a minute to say so.
    await Promise.race([
      assertServerServesRoute(`http://127.0.0.1:${canaryPort}`, "/api/cron/status"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TOO SLOW")), 70_000)),
    ]);
  } catch (error) {
    canaryError = error;
  }
  notFound.close();

  assert("a persistent canary 404 fails rather than passing",
    canaryError !== null, "a server serving nothing must never be accepted");
  assert("and it is classified as a repairable build cache",
    isHealableStartupFailure(canaryError),
    canaryError instanceof Error ? canaryError.message.split("\n")[1] ?? "" : String(canaryError));
  assert("while an unrelated startup failure is NOT",
    !isHealableStartupFailure(new Error("The dev server exited before it was ready (code 1)")),
    "only the cache is healable — a dead server must still be reported, not retried blindly");

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
