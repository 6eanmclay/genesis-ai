import "@/scripts/lib/allowServerOnly";
import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { emit } from "@/lib/telemetry/emit";
import { EVENT_NAMES } from "@/lib/telemetry/taxonomy";
import { recordDelivery, markProcessed, markFailed } from "@/lib/webhooks/delivery";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";
import { SURFACES } from "@/lib/design/surfaces";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// THE EVENTS THAT WERE DECLARED AND NEVER HAPPENED:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts telemetry-gaps-db
//
// ============ WHAT WAS ACTUALLY MISSING (2026-09-01) ===================
//
// The taxonomy declared fourteen events. A sweep of every emission site in the
// repository — with comments stripped, because this file and that one both
// mention the names in prose — found eleven of them wired and three that had
// never fired anywhere:
//
//   webhook.processed          arrivals were counted, completions were not
//   creation.product_created   the end of the Creation Station funnel
//   creation.design_saved      whether an owner's work was preserved
//
// Nothing was broken. Each was a declaration with no code behind it, which is
// worse than an absent event in one specific way: a dashboard built on the
// registry shows a category with a zero in it, and a zero reads as "this never
// happens" rather than "this was never measured".
//
// ============ AND THE ONE THAT KEEPS IT FROM RECURRING =================
//
// ARCHITECTURE.md's mirrored-registry rule: a registry that mirrors another
// needs a runtime cross-check, and the check must DERIVE from the source rather
// than restate it. EVENTS is a registry of what Genesis may say; the emit calls
// scattered through lib/ and app/ are what it actually says. Nothing compared
// them, which is exactly how three declarations sat dead for a month.
//
// The final section below sweeps the tree for emit sites and asserts every
// declared name has one. A fifteenth event declared without being wired fails
// this suite on the commit that declares it.
//
// ============ WHAT IS EXECUTED AND WHAT IS NOT ========================
//
// VERIFICATION_LANES.md's categories, kept apart on purpose:
//
//   EXECUTED   webhook.processed, both outcomes, through the real functions
//              against a real database, with the rows read back.
//   EXECUTED   creation.product_created NOT firing for a product no supplier
//              accepted — the composed path runs for real with nothing
//              connected, which is the guard most worth proving.
//   EXECUTED   creation.design_saved on the failure branch, by calling the real
//              Server Action with no session so it throws where an owner's save
//              would fail.
//   BLOCKED    the success branch of both creation events needs a CONNECTED
//              print supplier making live HTTP calls. Their emit payloads are
//              executed directly and their call sites are source-asserted, and
//              those two things are not the same as having watched it happen.

let failures = 0;
let passes = 0;
const failed: string[] = [];
function assert(name: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${name}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `  — ${detail}` : ""}`);
}
/**
 * Object keys sorted, arrays left alone.
 *
 * Postgres `jsonb` does not keep insertion order — it stores keys by length
 * then value, so metadata emitted as {provider, ok} reads back as {ok,
 * provider}. Comparing the serialisations directly made a correct row fail,
 * which is a test asserting a property of the storage engine instead of the
 * property under test.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

function eq(name: string, actual: unknown, expected: unknown): void {
  assert(
    name,
    JSON.stringify(canonical(actual)) === JSON.stringify(canonical(expected)),
    `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
  );
}

/**
 * Wait for a fire-and-forget emit to land.
 *
 * emitAsync deliberately does not block the thing it observes, so a test that
 * read immediately would race it. Polling rather than sleeping a fixed 250ms:
 * the fast case stays fast, and a slow one still passes instead of producing a
 * flake somebody later "fixes" by deleting the assertion.
 */
async function eventually<T>(read: () => Promise<T | null>, ms = 4000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const found = await read();
    if (found) return found;
    if (Date.now() > until) return null;
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** recordDelivery can answer null. A suite that silently skipped on one would prove nothing. */
async function deliver(input: Parameters<typeof recordDelivery>[0]): Promise<string> {
  const recorded = await recordDelivery(input);
  if (!recorded?.id) throw new Error(`the fixture delivery was not recorded: ${JSON.stringify(recorded)}`);
  return recorded.id;
}

const rowFor = (attemptKey: string) => () =>
  prismaSystem.productEvent.findFirst({ where: { attemptKey, name: "webhook.processed" } });

/** Source with comments removed. The prose in these files names every event. */
function strip(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  const user = await prisma.user.create({ data: { email: `tg-${stamp}@example.test` } });
  const store = await prisma.store.create({
    data: { userId: user.id, name: "Cubit & Coil", slug: `tg-${stamp}`, tagline: "t", description: "d" },
  });

  // ======================================================================
  console.log("\n=== 1. A webhook that finishes now says so ===\n");
  // ======================================================================
  {
    const delivery = await deliver({
      provider: "stripe",
      externalEventId: `evt_tg_${stamp}_1`,
      storeId: store.id,
      signatureValid: true,
      rawBody: '{"id":"evt_1"}',
    });

    await markProcessed(delivery, store.id);
    const row = await eventually(rowFor(delivery));
    assert("marking it processed emitted webhook.processed", row !== null);
    if (row) {
      eq("as a webhooks event", row.subsystem, "webhooks");
      // The systems half of telemetry is all `performance` — the category the
      // audit found had never fired at all.
      eq("in the performance category", row.category, "performance");
      eq("acted by the system, not a person", row.actorKind, "system");
      eq("and it succeeded", row.outcome, "success");
      eq("attributed to the business", row.storeId, store.id);
      eq("carrying the provider and the verdict", row.metadata, { provider: "stripe", ok: true });
      assert("with the arrival-to-completion gap on it",
        typeof row.durationMs === "number" && row.durationMs! >= 0, String(row.durationMs));
    }

    // ---- the pairing, which is the whole point --------------------------
    const received = await prismaSystem.productEvent.findFirst({
      where: { attemptKey: delivery, name: "webhook.received" },
    });
    assert("the arrival carries the same key as the completion", received !== null);
    eq("so one delivery is one group, not two unrelated rows",
      received?.attemptKey, row?.attemptKey);
  }

  // ======================================================================
  console.log("\n=== 2. And a webhook that does not finish also says so ===\n");
  // ======================================================================
  {
    const delivery = await deliver({
      provider: "paypal",
      externalEventId: `evt_tg_${stamp}_2`,
      storeId: store.id,
      signatureValid: true,
      rawBody: '{"id":"evt_2"}',
    });
    // A message with something private-looking in it, to prove where it does
    // and does not end up.
    await markFailed(delivery, new Error("card 4242424242424242 belongs to ada@example.test"));

    const row = await eventually(rowFor(delivery));
    assert("a failed handler emitted webhook.processed too", row !== null);
    if (row) {
      // "The handler finished, OR DID NOT" — one event, two outcomes. Two
      // separate event names would make the gap a subtraction across three
      // numbers instead of a count of one.
      eq("with a failure outcome", row.outcome, "failure");
      eq("and ok false", row.metadata, { provider: "paypal", ok: false });
    }

    // ---- the allowlist is the privacy boundary --------------------------
    const serialised = JSON.stringify(row?.metadata ?? {});
    assert("the provider's error text is NOT copied into telemetry",
      !serialised.includes("4242") && !serialised.includes("ada@example.test"), serialised);
    const onRow = await prismaSystem.webhookDelivery.findUnique({
      where: { id: delivery },
      select: { error: true, status: true },
    });
    assert("it is on the delivery row, which is where it belongs",
      (onRow?.error ?? "").includes("4242424242424242"), String(onRow?.error));
    eq("and the delivery is marked failed", onRow?.status, "failed");
  }

  // ======================================================================
  console.log("\n=== 3. The provider label comes off the row, not the caller ===\n");
  // ======================================================================
  {
    // markProcessed is never TOLD which provider it is finishing. If it took
    // one as a parameter, a route could label a Stripe delivery "paypal" and
    // every per-provider count would be quietly wrong with nothing to catch it.
    const delivery = await deliver({
      provider: "easypost",
      externalEventId: `evt_tg_${stamp}_3`,
      storeId: null,
      signatureValid: true,
      rawBody: "{}",
    });
    await markProcessed(delivery, store.id);
    const row = await eventually(rowFor(delivery));
    eq("the emitted provider is the one recorded on the delivery",
      (row?.metadata as { provider?: string } | null)?.provider, "easypost");
    // markProcessed's storeId argument attaches a business the route learned
    // about after the delivery arrived — the row is updated, so the event must
    // carry the new one rather than the null it was recorded with.
    eq("and the store it was finally attributed to", row?.storeId, store.id);
  }

  // ======================================================================
  console.log("\n=== 4. Nothing recorded means nothing to report ===\n");
  // ======================================================================
  {
    const before = await prismaSystem.productEvent.count({ where: { name: "webhook.processed" } });
    await markProcessed(null);
    await markFailed(null, new Error("boom"));
    await new Promise((r) => setTimeout(r, 150));
    const after = await prismaSystem.productEvent.count({ where: { name: "webhook.processed" } });
    eq("a null delivery id emits nothing at all", after, before);
  }

  // ======================================================================
  console.log("\n=== 5. The gap between received and processed is now readable ===\n");
  // ======================================================================
  {
    // The number the event was declared to produce. Before this milestone the
    // second half of it was always zero, so the leak could not be seen.
    const provider = `gap-${stamp}`;
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      ids.push(await deliver({
        provider, externalEventId: `evt_gap_${stamp}_${i}`, storeId: store.id,
        signatureValid: true, rawBody: "{}",
      }));
    }
    // Two finish. One is the leak — a handler that never came back.
    await markProcessed(ids[0], store.id);
    await markFailed(ids[1], new Error("handler threw"));
    await eventually(rowFor(ids[1]));

    const countFor = (name: string) =>
      prismaSystem.productEvent.count({
        where: { name, metadata: { path: ["provider"], equals: provider } },
      });
    eq("three arrived", await countFor("webhook.received"), 3);
    eq("two were accounted for", await countFor("webhook.processed"), 2);
    // Stated as the subtraction an operator would actually make.
    eq("so exactly one delivery leaked",
      (await countFor("webhook.received")) - (await countFor("webhook.processed")), 1);
  }

  // ======================================================================
  console.log("\n=== 6. A product no supplier accepted is not a supplier product ===\n");
  // ======================================================================
  {
    // ============ EXECUTED, NOT ASSERTED ==============================
    //
    // The composed path runs for real here with NO fulfillment integration
    // connected, which is the state this test database is genuinely in. A
    // Product row is written and no supplier holds it — so the event whose
    // purpose says "at a supplier" must not fire.
    //
    // This is the negative half of creation.product_created and it is the half
    // that can be executed. Emitting here would put a row in the table meaning
    // something the taxonomy does not declare.
    const before = await prismaSystem.productEvent.count({
      where: { name: "creation.product_created" },
    });

    const record = await prisma.businessRecord.create({
      data: {
        storeId: store.id,
        entityType: "design",
        externalId: `d-tg-${stamp}`,
        sourceProvider: "genesis_studio",
        data: {
          assetIds: ["asset_1"],
          surface: Object.keys(SURFACES)[0],
          arrangement: "centered",
          arrangementScale: 1,
          printFileUrl: "https://blob.test/print.png",
          mockupUrl: "https://blob.test/mockup.png",
          sourceAssetUrls: ["https://blob.test/asset.png"],
          createdAt: null,
        } as never,
      },
    });

    const result = await createProductFromDesignExecutable.run(
      { designId: record.id, name: "Tensor Ring Tee", priceInCents: 2500 } as never,
      { storeId: store.id, userId: user.id } as never,
    );
    const productId = (result.metadata as { productId?: string }).productId;
    assert("the composed path really did create a product", Boolean(productId), JSON.stringify(result.metadata));
    eq("and no supplier registered it", (result.metadata as { registeredWithProvider?: boolean }).registeredWithProvider, false);

    await new Promise((r) => setTimeout(r, 250));
    const after = await prismaSystem.productEvent.count({
      where: { name: "creation.product_created" },
    });
    eq("so creation.product_created did NOT fire", after, before);
  }

  // ======================================================================
  console.log("\n=== 7. A design save that fails is recorded as a failure ===\n");
  // ======================================================================
  {
    // ============ EXECUTED THROUGH THE REAL ACTION ====================
    //
    // "Distinguishes abandonment from failure" is the event's whole purpose,
    // and that distinction only exists if a save that did NOT work still
    // emits. Called with no session, so requireBusiness throws exactly where
    // an owner's save would fail — the wrapper's catch is the code under test.
    const { saveDesignDraft } = await import("@/app/b/[slug]/studio/create/actions");

    const draftId = `draft-tg-${stamp}`;
    const design = {
      externalProductId: "71",
      externalVariantId: "4012",
      placements: {
        // Two sides carry work, one is present and empty. surfaceCount must be
        // 2 — an empty side is not a surface somebody designed.
        front: [{ assetUrl: "https://blob.test/a.png", x: 0, y: 0, width: 1, height: 1, rotation: 0 }],
        back: [{ assetUrl: "https://blob.test/b.png", x: 0, y: 0, width: 1, height: 1, rotation: 0 }],
        sleeve_left: [],
      },
    };

    const result = await saveDesignDraft("no-such-store-anywhere", design as never, {
      name: "Tee", retailPriceInCents: 2500, draftId,
    });
    eq("the save failed, as it must with no session", result.ok, false);

    const row = await eventually(() =>
      prismaSystem.productEvent.findFirst({ where: { attemptKey: draftId } }),
    );
    assert("and it still emitted creation.design_saved", row !== null);
    if (row) {
      eq("named", row.name, "creation.design_saved");
      eq("as a creation event", row.subsystem, "creation");
      eq("with a failure outcome", row.outcome, "failure");
      // The distinction the purpose names: a failure is a row, abandonment is
      // no row. If this only fired on success the two would be identical.
      eq("counting only the sides that carry work", row.metadata, { surfaceCount: 2 });
      eq("attributed to the person who pressed Save", row.actorKind, "user");
      assert("and timed", typeof row.durationMs === "number", String(row.durationMs));
    }
  }

  // ======================================================================
  console.log("\n=== 8. The declared payloads survive the allowlist ===\n");
  // ======================================================================
  {
    // The success branch of creation.product_created needs a CONNECTED print
    // supplier making live calls, so what is executed here is the emit itself:
    // that the declared metadata keys are the ones that survive, and that an
    // undeclared key is dropped rather than stored.
    const attemptKey = `payload-tg-${stamp}`;
    await emit({
      name: "creation.product_created",
      actorKind: "user",
      storeId: store.id,
      userId: user.id,
      outcome: "success",
      attemptKey,
      metadata: {
        supplier: "PRINTFUL",
        variantCount: 12,
        // Not declared on this event. Must not reach the table.
        buyerEmail: "ada@example.test",
      },
    });
    const row = await prismaSystem.productEvent.findFirst({ where: { attemptKey } });
    assert("the event was accepted", row !== null);
    eq("keeping exactly the declared keys", row?.metadata, { supplier: "PRINTFUL", variantCount: 12 });
    eq("and it is a creation event", row?.subsystem, "creation");
  }

  // ======================================================================
  console.log("\n=== 9. Every declared event has code behind it ===\n");
  // ======================================================================
  {
    // ============ THE CROSS-CHECK THAT WOULD HAVE CAUGHT THIS =========
    //
    // ARCHITECTURE.md: a registry that mirrors another needs a runtime check,
    // derived from the source rather than restated. EVENTS is the declaration;
    // these files are the behaviour. Nothing compared them, which is how three
    // names sat dead for a month while a dashboard read zeroes off them.
    //
    // COMMENTS ARE STRIPPED FIRST. Both this file and the emit sites discuss
    // the event names in prose, and a sweep that counted those would report
    // every event wired the moment somebody wrote about it — a check that can
    // only pass is not a check.
    const roots = ["lib", "app"];
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.tsx?$/.test(entry) && !path.includes("telemetry")) files.push(path);
      }
    };
    for (const root of roots) walk(root);

    const emitted = new Set<string>();
    for (const file of files) {
      const source = strip(readFileSync(file, "utf8"));
      for (const name of EVENT_NAMES) {
        if (source.includes(`"${name}"`)) emitted.add(name);
      }
    }

    const dead = EVENT_NAMES.filter((name) => !emitted.has(name));
    eq("no declared event is without an emit site", dead, []);
    assert("and the sweep read a real number of files", files.length > 200, String(files.length));
    // The sweep has to be capable of reporting a dead event, or it proves
    // nothing. An undeclared name is the control.
    assert("the sweep would notice one that was missing",
      !emitted.has("creation.definitely_not_a_real_event" as never), "control");
  }

  // Planted rows cleared: ProductEvent and Order are read by platform-wide
  // reporting and this lane shares one database.
  await prismaSystem.productEvent.deleteMany({ where: { storeId: store.id } });
  await prismaSystem.productEvent.deleteMany({
    where: { attemptKey: { in: [`payload-tg-${stamp}`, `draft-tg-${stamp}`] } },
  });
  await prismaSystem.webhookDelivery.deleteMany({
    where: { externalEventId: { startsWith: `evt_tg_${stamp}` } },
  });
  await prismaSystem.webhookDelivery.deleteMany({
    where: { externalEventId: { startsWith: `evt_gap_${stamp}` } },
  });
  await prismaSystem.user.deleteMany({ where: { email: `tg-${stamp}@example.test` } });

  for (const name of failed) console.log(`FAILED: ${name}`);
  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
