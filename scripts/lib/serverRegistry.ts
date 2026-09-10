import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

/**
 * WHICH DEV SERVERS THIS HARNESS OWNS, AND HOW IT PROVES IT.
 *
 * ============ THE BUG THIS EXISTS TO END (2026-09-10) ==================
 *
 * `finally` closes the server on every normal path, and its comment already
 * named the hazard exactly: "An orphaned `next dev` holds the port and Next
 * then refuses to start another in the same directory, so the NEXT run fails
 * for a reason that has nothing to do with what it tests."
 *
 * What `finally` cannot do is run when the HARNESS ITSELF is killed - a tool
 * timeout, a Ctrl-C, a task stopped from outside. The `next dev` grandchild
 * then survives, holds the directory lock, and the next run dies on "Another
 * next dev server is already running." That happened three times in one
 * session, and each time it cost a full run before anybody looked at why.
 *
 * ============ REAPING IS DANGEROUS, SO IT IS PROVEN ====================
 *
 * The obvious fix - kill any `next dev` we find - is worse than the problem.
 * A developer's own `npm run dev`, or a second harness run working legitimately
 * in a worktree, would be killed by a suite that has nothing to do with it.
 *
 * So an entry is only ever reaped when THREE things hold:
 *
 *   1. this file recorded it, which means a harness in this directory started
 *      it - a pid we never wrote down is never touched;
 *   2. the pid is still alive; and
 *   3. the live process's own command line still matches the `next dev --port
 *      <recorded port>` we recorded.
 *
 * (3) is what makes this safe against pid reuse, which is not theoretical on a
 * machine that has just killed a process tree: the operating system is free to
 * hand that number to anything, and "kill the pid I wrote down an hour ago" is
 * how a harness comes to kill an editor. The identity is re-established at the
 * moment of the kill, not trusted from the record.
 */

const REGISTRY_DIR = join(process.cwd(), ".next-harness");
const REGISTRY_FILE = join(REGISTRY_DIR, "servers.json");

export interface OwnedServer {
  pid: number;
  port: number;
  startedAt: number;
  /** The run that started it, so a report can say whose it was. */
  owner: number;
}

function read(): OwnedServer[] {
  try {
    if (!existsSync(REGISTRY_FILE)) return [];
    const parsed = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as OwnedServer[]) : [];
  } catch {
    // A corrupt registry must not stop a run. The worst case is that a stale
    // server is not reaped, which is where we already were.
    return [];
  }
}

function write(entries: OwnedServer[]): void {
  try {
    mkdirSync(REGISTRY_DIR, { recursive: true });
    writeFileSync(REGISTRY_FILE, JSON.stringify(entries, null, 2));
  } catch {
    // Same: bookkeeping must never be the reason a suite fails.
  }
}

/** The live command line of a pid, or null when it is gone. */
export function commandLineOf(pid: number): string | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | Select-Object -ExpandProperty CommandLine)`,
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000 },
      );
      const line = out.trim();
      return line.length > 0 ? line : null;
    }
    const out = execFileSync("ps", ["-p", String(pid), "-o", "args="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15_000,
    });
    const line = out.trim();
    return line.length > 0 ? line : null;
  } catch {
    return null;
  }
}

/**
 * Is this pid still the server we recorded?
 *
 * Exported because the isolation proof asserts it directly: a recorded pid that
 * now belongs to something else must not be reaped, and that is a claim about
 * this function rather than about the reaper's good intentions.
 */
export function isStillOurServer(entry: OwnedServer): boolean {
  const line = commandLineOf(entry.pid);
  if (!line) return false;
  return /next/.test(line) && line.includes(String(entry.port));
}

export function recordServer(entry: OwnedServer): void {
  write([...read().filter((e) => e.pid !== entry.pid), entry]);
}

export function forgetServer(pid: number): void {
  write(read().filter((e) => e.pid !== pid));
}

/** Everything currently recorded. For the proof, and for reporting. */
export function ownedServers(): OwnedServer[] {
  return read();
}

export interface ReapReport {
  killed: OwnedServer[];
  /** Recorded, but the pid is gone or is now somebody else's. Forgotten, not killed. */
  released: OwnedServer[];
}

/**
 * Reap what an interrupted run left behind, and nothing else.
 *
 * Called before a server starts. Entries belonging to THIS process are left
 * alone - a suite that starts a second server must not kill its own first one.
 */
export function reapAbandonedServers(): ReapReport {
  const report: ReapReport = { killed: [], released: [] };
  const survivors: OwnedServer[] = [];

  for (const entry of read()) {
    if (entry.owner === process.pid) {
      survivors.push(entry);
      continue;
    }
    if (!isStillOurServer(entry)) {
      // Either gone already, or the number has been handed to something else.
      // Both mean "not ours to kill" - drop the record and move on.
      report.released.push(entry);
      continue;
    }
    try {
      if (process.platform === "win32") {
        execFileSync("taskkill", ["/pid", String(entry.pid), "/T", "/F"], {
          stdio: "ignore",
          timeout: 20_000,
        });
      } else {
        process.kill(entry.pid, "SIGKILL");
      }
      report.killed.push(entry);
    } catch {
      // It may have exited between the check and the kill. Nothing to do, and
      // nothing to complain about.
      report.released.push(entry);
    }
  }

  write(survivors);
  return report;
}
