import { createServer, connect } from "net";

// A PORT THE OS SAYS IS FREE, not one derived from a PID (gap 26).
//
// ============ WHAT THIS REPLACES, AND WHY IT FAILED ================
//
// Both harnesses picked a port arithmetically - `47000 + process.pid % 9000`
// for Postgres, `41000 + ...` for the dev server - and never asked whether
// anything was already there. Measured failures, both from real lane runs:
//
//   could not bind IPv4 address "127.0.0.1": Permission denied
//   FATAL:  could not create any TCP/IP sockets
//
//   LOG:  listening on IPv6 address "::1", port 51248
//   LOG:  could not bind IPv4 address "127.0.0.1": Only one usage of each ...
//   LOG:  database system is ready to accept connections
//   Error: P1001: Can't reach database server at `127.0.0.1:51248`
//
// The second is the instructive one. Postgres bound ONE address family, then
// announced itself ready - truthfully, from its own point of view - while the
// client connects over the other and cannot reach it. "Ready" was never a
// promise that the thing that has to talk to it can.
//
// Binding port 0 makes the operating system choose, so the port is free, it is
// not inside a reserved range, and it is bindable ON THE ADDRESS THE CLIENT
// WILL USE - because that is the address bound to find it.
//
// This is selection, not retrying: one port is chosen once, and if anything is
// wrong with it afterwards the caller is told, never re-attempted into silence.

export async function reserveFreePort(host = "127.0.0.1"): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, host, () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error(`Could not read a port back from ${host}`)));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Prove something is actually reachable at the exact address a client will use.
 *
 * The gap this closes is the one above: a server that reports itself ready
 * having bound a DIFFERENT address family than the connection string names.
 * Called after a server claims to have started, so the failure is reported
 * where it happened rather than as a confusing error much later.
 */
export async function assertReachable(host: string, port: number, what: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = connect({ host, port });
    const done = (error?: Error) => {
      socket.destroy();
      if (error) reject(error);
      else resolve();
    };
    socket.setTimeout(5000);
    socket.on("connect", () => done());
    socket.on("timeout", () => done(new Error(`${what} did not answer at ${host}:${port} within 5s`)));
    socket.on("error", (error) =>
      done(
        new Error(
          `${what} reported itself started, but nothing accepts a connection at ${host}:${port} (${error.message}). ` +
            `A server that binds only one address family reports "ready" and is still unreachable to a client using the other.`,
        ),
      ),
    );
  });
}
