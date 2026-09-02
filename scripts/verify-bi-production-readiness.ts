import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";
import { readFileSync } from "fs";
import { join } from "path";

// THE BI ENGINE, PRODUCTION-READY — acceptance for P1-P3.
//
//   npx tsx scripts/verify-bi-production-readiness.ts
//
// BI_PRODUCTION_READINESS.md gaps 1-3. Brings its own Postgres — the cycle
// fans out and PGlite serves one connection — so this is NOT in the shared 41.
//
// WHAT THIS SUITE IS ABOUT. Every assertion here is about a failure being
// SURVIVABLE and VISIBLE, never about the engine concluding better things. The
// engine's conclusions are M1-M9's subject and are not retested.
//
// Every gate has a negative control that proves it can fail.

let failures = 0;
function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `\n        ${detail}` : ""}`);
}
function eq(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(label, ok, ok ? "" : `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
/** Comments explain the reason; code is the evidence. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const read = (...p: string[]) => readFileSync(join(process.cwd(), ...p), "utf8");

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();
  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { prisma } = await import("@/lib/prisma");
  const cycle = await import("@/lib/intelligence/cycle");

  try {
    const user = await prisma.user.create({ data: { email: `bipr-${Date.now()}@test.local` } });
    const store = await prisma.store.create({
      data: { userId: user.id, name: "Engine Co", slug: `engine-${Date.now()}` },
    });

    // ==================================================================
    console.log("\n=== GAP 1 — a stage failure does not take the stages behind it ===\n");
    // ==================================================================
    const cycleSrc = codeOnly(read("lib", "intelligence", "cycle.ts"));

    // The shape that made the defect possible: a stage awaited straight, so its
    // throw becomes the caller's throw. Every stage is now handed to runStage
    // as a thunk, so a bare `await stages.` anywhere is the defect returning.
    //
    // Checked against `stages.`, not against the underlying function names:
    // runIntelligenceCycle's wiring genuinely does await
    // runOpportunisticAiReviewIfStale — inside the lambda it hands to
    // runCycleStages, which is exactly right. A cruder check flagged that.
    eq("no stage is awaited straight",
      (cycleSrc.match(/await stages\./g) ?? []).length, 0);

    // COUNTED, NOT MERELY PRESENT. A presence check stays green when five of
    // six stages are wrapped — which is the exact shape of the defect being
    // fixed, one case that stopped being covered when the set grew.
    const staged = [...cycleSrc.matchAll(/runStage\(\s*"([a-z_]+)"/g)].map((m) => m[1]);
    eq("all six stages run through the isolator",
      staged.sort(),
      ["ai_review", "insights", "learn", "notify", "speak", "staff_policy_gap"]);
    assert("and notify additionally records the dependency it cannot satisfy",
      /failedStages\.push\("notify"\)/.test(cycleSrc),
      "it needs insights, so a failed insights stage makes it failed too, not merely skipped");

    // THE BEHAVIOUR, not the shape. A stage that throws must not stop the rest.
    //
    // DEMONSTRATED WITH `learn` SINCE 2026-09-02. It used to be the AI review,
    // which was the original defect — one stage needing a provider took two
    // that did not down with it. The review is no longer a stage at all (it is
    // its own task now, see BI_ENGINE.md section 17), but the property it
    // exposed belongs to every stage and is held here with a deterministic one.
    const order: string[] = [];
    const boom = new Error("a stage is down");
    const summary = await cycle.runCycleStages(store.id, {
      insights: async () => { order.push("insights"); return []; },
      notify: async () => { order.push("notify"); },
      learn: async () => { order.push("learn"); throw boom; },
      staffPolicyGap: async () => { order.push("staff_policy_gap"); },
      speak: async () => { order.push("speak"); return { spoken: 3 }; },
    });

    eq("the failing stage is named", summary.failedStages, ["learn"]);
    assert("and the two stages behind it still ran",
      order.includes("staff_policy_gap") && order.includes("speak"),
      "this is the whole defect: neither depended on it, both died with it");
    eq("J4 still spoke", summary.spoken, 3);
    eq("and the pass is honestly not ok", summary.ok, false);

    // ==================================================================
    console.log("\n=== GAP 1 — a failed insights stage does not retract findings ===\n");
    // ==================================================================
    let notified = false;
    const failedInsights = await cycle.runCycleStages(store.id, {
      insights: async () => { throw new Error("insight engine is down"); },
      notify: async () => { notified = true; },
      learn: async () => {},
      staffPolicyGap: async () => {},
      speak: async () => ({ spoken: 0 }),
    });
    assert("notify does NOT run on an empty list when insights failed", !notified,
      "notifyFromInsights resolves anything absent from the set it is given — [] would " +
        "silently retract every standing finding the owner is looking at");
    eq("and both stages are named as failed", failedInsights.failedStages, ["insights", "notify"]);
    eq("insights is reported as 0, never as a count it did not produce", failedInsights.insights, 0);

    // CONTROL: the same shape with nothing thrown is a clean pass.
    const clean = await cycle.runCycleStages(store.id, {
      insights: async () => [],
      notify: async () => {},
      learn: async () => {},
      staffPolicyGap: async () => {},
      speak: async () => ({ spoken: 0 }),
    });
    eq("CONTROL: nothing failing means nothing named", clean.failedStages, []);
    eq("CONTROL: and ok is true", clean.ok, true);

    // ==================================================================
    console.log("\n=== GAP 2 — the failure reaches a person ===\n");
    // ==================================================================
    const reported: { stage: string; storeId?: string | null }[] = [];
    await cycle.runCycleStages(store.id, {
      insights: async () => [],
      notify: async () => {},
      learn: async () => { throw new Error("learn is down"); },
      staffPolicyGap: async () => {},
      speak: async () => ({ spoken: 0 }),
    }, (_message, _error, context) => reported.push({ stage: context.stage, storeId: context.storeId }));

    eq("a failed stage is reported once", reported.length, 1);
    eq("named by stage", reported[0]?.stage, "intelligence.learn");
    eq("and tagged with the tenant", reported[0]?.storeId, store.id);

    assert("CONTROL: a clean pass reports nothing",
      await (async () => {
        const quiet: unknown[] = [];
        await cycle.runCycleStages(store.id, {
          insights: async () => [],
          notify: async () => {},
          learn: async () => {},
          staffPolicyGap: async () => {},
          speak: async () => ({ spoken: 0 }),
        }, () => quiet.push(1));
        return quiet.length === 0;
      })(),
      "an operator alert on a healthy pass is worse than none");

    // The error is BOUND. The catch that used to hold this path took no
    // parameter, so a failing cycle produced ok:false and no error anywhere.
    //
    // SCOPED TO THE OUTER FUNCTION. Asserting against the whole file was green
    // with this catch unbound, because runStage's own catch binds one and the
    // regex could not tell the two apart — "some catch somewhere binds an
    // error" is not the claim.
    const outerSrc = cycleSrc.slice(cycleSrc.indexOf("export async function runDueIntelligenceCycles"));
    assert("the per-store catch binds its error", /\} catch \(error\) \{/.test(outerSrc),
      "it took no parameter at all, so a failing cycle produced ok:false and no error anywhere");
    assert("and reports it", /reportIssue\([\s\S]{0,200}intelligence\.cycle/.test(outerSrc));

    // The cron route's stages too — counted, for the same reason as above.
    const cronSrc = codeOnly(read("app", "api", "cron", "sync", "route.ts"));
    const cronReports = [...cronSrc.matchAll(/stage: "cron\.([a-zA-Z]+)"/g)].map((m) => m[1]);
    eq("every cron stage reports its own failure",
      cronReports.sort(),
      ["growthPoints", "intelligence", "pruneAuthAttempts", "sourcing", "syncs"]);
    eq("and none is left reporting only to the console",
      (cronSrc.match(/console\.error/g) ?? []).length, 0);

    // ==================================================================
    console.log("\n=== GAP 3 — production can say whether the engine ran ===\n");
    // ==================================================================
    const statusSrc = codeOnly(read("app", "api", "cron", "status", "route.ts"));
    assert("the status route is still CRON_SECRET-gated",
      statusSrc.includes("isAuthorizedCronRequest"),
      "it is cross-tenant, so the header check IS the authorization");
    assert("and still writes nothing",
      !/\.(create|update|upsert|delete|createMany|updateMany|deleteMany)\(/.test(statusSrc),
      "a diagnostic that changes what it measures is not a diagnostic");

    // MATCHED AS A PROPERTY KEY, not as a substring. `includes("eventLag")` was
    // green after the field was renamed to `eventLagX`, because the new name
    // contains the old one — a rename is exactly how a reported field goes
    // missing, and the gate could not see it.
    for (const field of ["eventLag", "lastCognitiveOutputAt", "lastAiReview", "cursorUpdatedAt"]) {
      assert(`it reports ${field}`, new RegExp(`\\b${field}:`).test(statusSrc));
    }
    assert("all of it from rows the engine already writes",
      !/model \w+Run|cycleRun/.test(read("prisma", "schema.prisma")),
      "no new table was added to make this answerable");

    // The behaviour: a store with unconsumed events shows lag.
    const { GET } = await import("@/app/api/cron/status/route");
    process.env.CRON_SECRET = "test-secret";
    const authed = new Request("http://localhost/api/cron/status", {
      headers: { authorization: "Bearer test-secret" },
    });

    await prisma.businessEvent.create({
      data: { storeId: store.id, entityType: "item", eventType: "item.created",
              sourceProvider: "test", summary: "something happened" },
    });
    const body = await (await GET(authed as never)).json();
    const row = (body.intelligence as { storeId: string; eventLag: number }[])
      .find((r) => r.storeId === store.id);
    assert("a store with unconsumed events appears", Boolean(row));
    assert("with real lag", (row?.eventLag ?? 0) > 0,
      "this is the signal that the engine is behind, and it needed no new write to produce");

    const unauthed = new Request("http://localhost/api/cron/status");
    eq("CONTROL: without the secret it says nothing at all",
      (await GET(unauthed as never)).status, 401);
  } finally {
    await db.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
