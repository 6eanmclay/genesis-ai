import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import {
  recordSignal,
  readSignals,
  tallySignals,
  signalsForCorrelation,
  SIGNAL_KINDS,
} from "@/lib/security/signals";
import { withCorrelation, currentCorrelation, correlationId, newCorrelationId } from "@/lib/observability/correlation";

// THE SECURITY STREAM, AGAINST A REAL DATABASE:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts security-signals-db
//
// ============ WHAT THIS HAS TO PROVE (2026-08-30) ======================
//
// Three things, and only one of them is "the write works":
//
//   the stream can describe what SecurityEvent cannot — an actor who is not a
//     user, a store that no longer exists, a request with nobody signed in
//   recording never breaks the thing it observes, because a permission check
//     must refuse identically whether or not the signal was written
//   the correlation id actually ties rows together, which is the whole reason
//     an incident is reconstructable rather than inferred from timestamps

let failures = 0;
let passes = 0;
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
function eq(name: string, actual: unknown, expected: unknown): void {
  assert(name, JSON.stringify(actual) === JSON.stringify(expected),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();
  const owner = await prisma.user.create({ data: { email: `sig-${stamp}@example.test`, name: "Owner" } });
  const store = await prisma.store.create({
    data: { userId: owner.id, name: "Sig", slug: `sig-${stamp}`, tagline: "t", description: "d" },
  });

  console.log("\n--- it can describe what SecurityEvent structurally cannot ---\n");
  {
    // SecurityEvent requires a userId and has no storeId. Each of these would
    // be unrepresentable there, and each is an ordinary security event.
    await recordSignal({
      kind: SIGNAL_KINDS.authzDenied, actorKind: "anonymous",
      surface: "route:/api/whatever", ipAddress: "203.0.113.7", severity: "warning",
    });
    await recordSignal({
      kind: SIGNAL_KINDS.isolationViolation, actorKind: "system",
      storeId: store.id, severity: "critical", surface: "Product.findMany",
    });
    await recordSignal({
      kind: SIGNAL_KINDS.webhookUnsigned, actorKind: "provider", surface: "webhook:stripe",
    });
    await recordSignal({
      kind: SIGNAL_KINDS.executionAnomaly, actorKind: "genesis", storeId: store.id,
    });

    const anon = await readSignals({ kinds: [SIGNAL_KINDS.authzDenied] });
    const anonymous = anon.find((s) => s.actorKind === "anonymous");
    assert("an actor with no user at all is recordable", !!anonymous, "anonymous actor missing");
    // ============ THE ADDRESS IS OPT-IN NOW (2026-08-30) ==========
    //
    // This asserted the address came back by default, and it deliberately no
    // longer does. It is still RECORDED for forensics — that half is unchanged
    // and asserted below — but reading it is a separate act, because most
    // reading of this stream is counting and filtering, and an address is
    // personal data about somebody who has usually done nothing wrong.
    eq("its address is not handed out by default", anonymous?.ipAddress, null);
    eq("and no user invented for it", anonymous?.actorId, null);

    // Still there, and still reachable by a caller that says so.
    const withAddress = await readSignals({
      kinds: [SIGNAL_KINDS.authzDenied], includeAddress: true,
    });
    eq("but it is kept, and returned when explicitly asked for",
      withAddress.find((s) => s.actorKind === "anonymous")?.ipAddress, "203.0.113.7");

    const kinds = (await readSignals({ limit: 100 })).map((s) => s.actorKind);
    for (const k of ["anonymous", "system", "provider", "genesis"]) {
      assert(`a "${k}" actor is representable`, kinds.includes(k), JSON.stringify(kinds));
    }
  }

  console.log("\n--- a signal outlives the store it was about ---\n");
  {
    const doomed = await prisma.store.create({
      data: { userId: owner.id, name: "Doomed", slug: `sig-d-${stamp}`, tagline: "t", description: "d" },
    });
    await recordSignal({ kind: SIGNAL_KINDS.isolationViolation, actorKind: "system", storeId: doomed.id, severity: "critical" });
    await prismaSystem.store.delete({ where: { id: doomed.id } });
    // No foreign key, deliberately: a delete must never cascade the evidence
    // away with the thing it was evidence about.
    const kept = await readSignals({ storeId: doomed.id });
    eq("the signal survives", kept.length, 1);
    eq("still naming the store that is gone", kept[0]?.storeId, doomed.id);
  }

  console.log("\n--- correlation ties one unit of work together ---\n");
  {
    const traced = await withCorrelation({ origin: "http", surface: "test" }, async () => {
      const id = correlationId();
      await recordSignal({ kind: SIGNAL_KINDS.authzDenied, actorKind: "user", actorId: owner.id, storeId: store.id });
      await recordSignal({ kind: SIGNAL_KINDS.authzDenied, actorKind: "user", actorId: owner.id, storeId: store.id });
      await recordSignal({ kind: SIGNAL_KINDS.rateLimited, actorKind: "user", actorId: owner.id });
      return id;
    });
    assert("a correlation exists inside the scope", !!traced);
    const together = await signalsForCorrelation(traced!);
    // THE POINT. "There were three warnings around 3pm" becomes "this request
    // was refused twice and then throttled."
    eq("all three rows come back as one incident", together.length, 3);
    eq("and they share the id", [...new Set(together.map((s) => s.correlationId))], [traced]);
  }
  {
    // Nesting must NOT start a new id — a job enqueued by a request and the
    // request that enqueued it are one causal chain.
    const [outer, inner] = await withCorrelation({ origin: "http" }, async () => {
      const a = correlationId();
      const b = await withCorrelation({ origin: "job" }, async () => correlationId());
      return [a, b];
    });
    eq("a nested scope keeps the outer id", inner, outer);
  }
  {
    eq("outside any scope there is simply none", correlationId(), null);
    assert("and the current correlation is null, not invented", currentCorrelation() === null);
    // A caller starting a chain gets a fresh id without needing a scope.
    assert("a new id can still be minted", newCorrelationId().length > 10);
  }
  {
    const explicit = newCorrelationId();
    await recordSignal({ kind: SIGNAL_KINDS.credentialLost, actorKind: "provider", correlationId: explicit });
    eq("an explicit id overrides the ambient one", (await signalsForCorrelation(explicit)).length, 1);
  }

  console.log("\n--- every refusal site records, checked in the source ---\n");
  {
    // ============ WHY THIS IS A SOURCE CHECK (2026-08-30) ===========
    //
    // The first version called requireStorePermission directly and asserted a
    // signal appeared. It failed 0 -> 0 twice, for two different reasons, and
    // the second is the real constraint: these helpers call auth() for a
    // session, so a database script cannot reach ANY refusal branch — it is
    // turned away at "not signed in" before a permission is ever considered.
    //
    // Faking a session would test the fake. So the behaviour is proven above
    // with recordSignal directly, and what is asserted here is that the refusal
    // sites actually call it — the part that would silently rot if somebody
    // removed the instrumentation.
    //
    // End-to-end coverage of a real refusal needs a browser suite, where a
    // genuine session exists. Recorded as a known gap rather than papered over.
    const { readFileSync } = await import("fs");
    const permissions = readFileSync("lib/permissions.ts", "utf8");
    const isolation = readFileSync("lib/tenantIsolation.ts", "utf8");

    const calls = (permissions.match(/recordSignal[(]/g) || []).length;
    assert("permissions.ts records on the refusal branches it owns", calls >= 4, calls + " recordSignal calls");
    assert("including the unresolved-business branch",
      permissions.indexOf("SIGNAL_KINDS.authzUnresolved") !== -1, "authz.unresolved not wired");
    assert("and the role-insufficient branch",
      permissions.indexOf("SIGNAL_KINDS.authzDenied") !== -1, "authz.denied not wired");
    assert("tenant isolation records its violation",
      isolation.indexOf("SIGNAL_KINDS.isolationViolation") !== -1, "isolation violation not wired");
    assert("at critical severity, because it should be impossible",
      /isolationViolation[\s\S]{0,400}severity: "critical"/.test(isolation), "isolation violation is not critical");
    // A refusal must still refuse: the throw has to survive the instrumentation.
    assert("and the refusal itself is still a throw",
      /recordSignal[(][\s\S]{0,700}?throw new Error/.test(permissions), "a refusal stopped throwing");
  }

  console.log("\n--- recording never breaks what it observes ---\n");
  {
    // THE PROPERTY THAT MATTERS MOST. A detail object that cannot be stored, a
    // store that does not exist — the write fails inside and the caller sees
    // nothing.
    let threw = false;
    try {
      await recordSignal({
        kind: SIGNAL_KINDS.authzDenied, actorKind: "user",
        storeId: "cl_store_that_never_existed",
        detail: { deep: { nested: { fine: true } } },
      });
      await recordSignal({ kind: "x".repeat(500_000), actorKind: "system" });
    } catch {
      threw = true;
    }
    assert("an unstorable signal does not propagate", !threw);
  }

  console.log("\n--- the read contract is what a security layer gets ---\n");
  {
    const rows = await readSignals({ limit: 5 });
    assert("it returns rows", rows.length > 0);
    // userAgent is recorded for forensics and deliberately not handed to a
    // reasoning layer — high-cardinality noise, and narrowing later is easy
    // while un-giving access is not.
    assert("and never hands out userAgent", rows.every((r) => !("userAgent" in r)), JSON.stringify(Object.keys(rows[0])));

    const capped = await readSignals({ limit: 99999 });
    assert("the limit is capped regardless of what is asked for", capped.length <= 1000, `${capped.length}`);

    const critical = await readSignals({ severities: ["critical"] });
    assert("severity filters", critical.length > 0 && critical.every((r) => r.severity === "critical"));

    const tally = await tallySignals(new Date(Date.now() - 60 * 60 * 1000));
    assert("the cheap aggregate works", tally.length > 0, JSON.stringify(tally));
    assert("and is ordered by how much is happening", tally.every((t, i) => i === 0 || tally[i - 1].count >= t.count));
  }

  console.log("\n--- the stream is append-only in practice ---\n");
  {
    // There is no update or delete in the module's surface. Asserted over the
    // export list rather than by trying to call one, because the point is that
    // a caller cannot reach for it.
    const module = await import("@/lib/security/signals");
    const exported = Object.keys(module);
    const mutating = exported.filter((n) => /update|delete|remove|purge|clear/i.test(n));
    eq("no exported function can change or remove a signal", mutating, []);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
