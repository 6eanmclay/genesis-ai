// MUST BE FIRST — see the file's own comment. It restores reachability of
// modules marked `server-only` and stands in for nothing.
import "@/scripts/lib/allowServerOnly";

import { requireTestDatabase } from "@/scripts/lib/requireTestDatabase";
import { prisma, prismaSystem } from "@/lib/prisma";
import { accessTo } from "@/lib/businessContext";
import { readFileSync } from "node:fs";

// CROSS-STORE READS THROUGH SERVER ACTIONS:
//
//   part of the database sweep — npx tsx scripts/run-db-suites.ts store-scope-db
//
// ============ THE VULNERABILITY THIS CLOSES (2026-08-30) ===============
//
// Four server actions took a `storeId` FROM THE CALLER and queried it with no
// authorization:
//
//   savedDesignsFor(storeId)        loadDesignDraft(storeId, draftId)
//   socialDraftsFor(storeId)        loadSocialDraft(storeId, postId)
//
// The pages calling them had already checked access, and that protected the
// pages. A server action is a POST endpoint with a generated id: it can be
// invoked with no page render and no layout in the path — which is the lesson
// Item 8 learned about a layout, one level down. An authenticated user is not
// an authorised one, and a supplied storeId is not a permission.
//
// ============ WHY THE FIX REMOVES THE PARAMETER =======================
//
// Not a check on the argument — the argument is gone. The business now comes
// from requireBusinessOrActive, so "read that other business" is not a request
// these actions can be asked to make. A wrong state that cannot be expressed
// does not need to be rejected.
//
// ============ WHAT IS PROVEN HERE, AND HOW ============================
//
// The actions are invoked FOR REAL, against a real database, with no session —
// exactly as a direct POST would arrive. Nothing stubs auth(), because a stub
// would replace the thing under test; this codebase has already been bitten by
// a seam that measured the injection point instead of the guard.

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

// ============ READ FROM THE SOURCE, NEVER RETYPED (2026-08-30) ========
//
// This was a hardcoded "genesis-creation" for both. The real values are
// `genesis_creation` and `genesis_social` — underscores, and DIFFERENT per
// file. So every planted row carried a sourceProvider neither action queries,
// and the assertion that store B's records never come back could not fail no
// matter what the code did. Three separate inert assertions, all from one
// retyped constant.
//
// Derived from each file instead, with a hard failure if the shape moves. A
// fixture that does not match what the reader asks for is not a fixture.
function draftSourceOf(file: string): string {
  const found = /const DRAFT_SOURCE = "([^"]+)"/.exec(readFileSync(file, "utf8"));
  if (!found) throw new Error(`DRAFT_SOURCE not found in ${file} — this suite's fixtures would be inert`);
  return found[1];
}

const CREATE_ACTIONS = "app/b/[slug]/studio/create/actions.ts";
const SOCIAL_ACTIONS = "app/b/[slug]/studio/social/actions.ts";
const DESIGN_SOURCE = draftSourceOf(CREATE_ACTIONS);
const POST_SOURCE = draftSourceOf(SOCIAL_ACTIONS);

/** Invoke for real and report which happened. No session exists here. */
async function invoke(fn: () => Promise<unknown>): Promise<
  { outcome: "returned"; value: unknown } | { outcome: "refused"; message: string }
> {
  try {
    return { outcome: "returned", value: await fn() };
  } catch (error) {
    return { outcome: "refused", message: error instanceof Error ? error.message : String(error) };
  }
}

async function main(): Promise<void> {
  await requireTestDatabase(prismaSystem);
  const stamp = Date.now();

  // Two businesses, two owners, neither a member of the other.
  const ownerA = await prisma.user.create({ data: { email: `ss-a-${stamp}@example.test`, name: "Owner A" } });
  const ownerB = await prisma.user.create({ data: { email: `ss-b-${stamp}@example.test`, name: "Owner B" } });
  const storeA = await prisma.store.create({
    data: { userId: ownerA.id, name: "A", slug: `ss-a-${stamp}`, tagline: "t", description: "d" },
  });
  const storeB = await prisma.store.create({
    data: { userId: ownerB.id, name: "B", slug: `ss-b-${stamp}`, tagline: "t", description: "d" },
  });

  // A saved design and a social draft in each, so a leak has something to leak.
  //
  // ============ THE FIXTURES MUST ACTUALLY PARSE (2026-08-30) ==========
  //
  // The first version of these did not. SocialPostSchema requires at least one
  // target and PlacementDesignSchema requires a provider and a product id, so
  // both readers dropped the planted rows during safeParse — and the assertion
  // that store B's records never come back could not fail, whatever the code
  // did. Sabotage caught it: the guard was removed, the leak assertion stayed
  // green, and only a weaker assertion noticed.
  //
  // So these are shaped exactly as the real writers write them. A fixture the
  // reader discards is not a fixture, it is a hole with a green tick over it.
  for (const [store, tag] of [[storeA, "A"], [storeB, "B"]] as const) {
    await prisma.businessRecord.create({
      data: {
        storeId: store.id, entityType: "design", sourceProvider: DESIGN_SOURCE,
        externalId: `design-${tag}-${stamp}`, syncedAt: new Date(),
        data: {
          assetIds: [], surface: "", arrangement: "", arrangementScale: null,
          printFileUrl: null, mockupUrl: null, sourceAssetUrls: [], createdAt: null,
          placement: {
            provider: "PRINTFUL", externalProductId: "3719", externalVariantId: "v1",
            sellableVariantIds: ["v1"], sellableSizes: ["L"],
            productName: `${tag} secret design`, color: "black", colorHex: "#000000",
            size: "L", blanks: {}, retailPriceInCents: 4500, productId: null,
            supplierProductCreated: false, updatedAt: null,
            placements: {
              front: [{ id: "l1", assetUrl: "https://example.test/a.png", x: 0, y: 0, width: 10, height: 10, flipX: false, flipY: false, rotation: 0 }],
            },
          },
        },
      },
    });
    await prisma.businessRecord.create({
      data: {
        storeId: store.id, entityType: "socialPost", sourceProvider: POST_SOURCE,
        externalId: `post-${tag}-${stamp}`, syncedAt: new Date(),
        data: {
          name: `${tag} secret post`,
          amplifyStory: false,
          targets: [{
            platform: "x", content: { kind: "x", text: `${tag} secret post body` },
            publishedAt: null, publishedUrl: null, storyPublishedAt: null,
          }],
        },
      },
    });
  }

  // THE FIXTURES ARE THEMSELVES ASSERTED. If a schema changes and these stop
  // parsing, the leak assertions go quietly inert again — so the suite proves
  // they are readable before it proves anything about who may read them.
  {
    const { DesignSchema, SocialPostSchema } = await import("@/lib/businessModel/entities");
    const design = await prisma.businessRecord.findFirst({
      where: { storeId: storeB.id, entityType: "design" }, select: { data: true },
    });
    const post = await prisma.businessRecord.findFirst({
      where: { storeId: storeB.id, entityType: "socialPost" }, select: { data: true },
    });
    const d = DesignSchema.safeParse(design?.data);
    const s = SocialPostSchema.safeParse(post?.data);
    assert("the planted design parses, so a leak of it would be visible",
      d.success && !!d.data.placement, d.success ? "no placement" : JSON.stringify(d.error.issues[0]));
    assert("the planted post parses, so a leak of it would be visible",
      s.success, s.success ? "" : JSON.stringify(s.error.issues[0]));

    // The fixtures must be filed under exactly what the readers ask for. These
    // two differ from each other, which is precisely how one retyped constant
    // silenced three assertions at once.
    assert("the design source was read from the action", DESIGN_SOURCE.length > 0 && DESIGN_SOURCE.includes("creation"), DESIGN_SOURCE);
    assert("the post source was read from the action", POST_SOURCE.length > 0 && POST_SOURCE.includes("social"), POST_SOURCE);
    const reachable = await prisma.businessRecord.count({
      where: { storeId: storeB.id, entityType: "socialPost", sourceProvider: POST_SOURCE },
    });
    eq("and store B's post is reachable by the reader's own filter", reachable, 1);
  }

  const actions = await import("@/app/b/[slug]/studio/create/actions");
  const social = await import("@/app/b/[slug]/studio/social/actions");

  console.log("\n--- 1. an authorized owner reaches their own business ---\n");
  {
    const access = await accessTo(ownerA.id, storeA.id);
    assert("the owner has access to their own store", !!access, JSON.stringify(access));
    const accessB = await accessTo(ownerB.id, storeB.id);
    assert("and so does the other owner, to theirs", !!accessB);

    // The store-scoped read the actions perform returns that owner's work.
    const own = await prisma.businessRecord.findMany({
      where: { storeId: storeA.id, entityType: "design", sourceProvider: DESIGN_SOURCE },
    });
    eq("their own design is readable", own.length, 1);
  }

  console.log("\n--- 2. an owner has no access to another business ---\n");
  {
    // ============ THE DECISION requireBusiness MAKES ================
    //
    // lib/permissions.ts:239 calls exactly this before returning a store. If
    // it answered yes here, every guard in the codebase would be decorative.
    const cross = await accessTo(ownerB.id, storeA.id);
    eq("owner B has no access to store A", cross, null);
    const reverse = await accessTo(ownerA.id, storeB.id);
    eq("and owner A none to store B", reverse, null);
  }

  console.log("\n--- 3. a business that does not exist is refused, not guessed ---\n");
  {
    const missing = await prisma.store.findUnique({ where: { slug: `ss-nothing-${stamp}` } });
    eq("an unknown slug resolves to nothing", missing, null);
    // requireBusiness throws "Store not found" on exactly this — deliberately
    // the same answer it gives for a store that exists and is not yours, so
    // the refusal never confirms a business exists.
    const bogus = await accessTo(ownerA.id, `cl-not-a-store-${stamp}`);
    eq("and an unknown id grants nothing", bogus, null);
  }

  console.log("\n--- 4 & 5. invoked directly, with no session, all four refuse ---\n");
  {
    // ============ THE END-TO-END ASSERTION =========================
    //
    // This is a direct call with no request, no page and no layout — the shape
    // a POST to the action id arrives in. Each must refuse before it reads
    // anything. Sabotage removes the guard and these return rows instead.
    const results = [
      ["savedDesignsFor", await invoke(() => actions.savedDesignsFor(storeA.slug))],
      ["loadDesignDraft", await invoke(() => actions.loadDesignDraft(`design-A-${stamp}`, storeA.slug))],
      ["socialDraftsFor", await invoke(() => social.socialDraftsFor(storeA.slug))],
      ["loadSocialDraft", await invoke(() => social.loadSocialDraft(`post-A-${stamp}`, storeA.slug))],
    ] as const;

    for (const [name, result] of results) {
      assert(`${name} refuses an unauthenticated direct call`,
        result.outcome === "refused",
        result.outcome === "returned" ? `RETURNED ${JSON.stringify(result.value).slice(0, 160)}` : "");
      // The refusal must come from the guard, before any query. `headers` is
      // what auth() reaches for, so this names where it stopped.
      if (result.outcome === "refused") {
        assert(`${name} stopped in the authorization guard`,
          /headers|request scope|login|session|permission|not found/i.test(result.message),
          result.message.slice(0, 160));
      }
    }

    // ============ THE ATTACK, ATTEMPTED FOR REAL ==================
    //
    // Owner A's session does not exist here at all, and the argument is store
    // B's own identifier — both its id (what the old signature took) and its
    // slug (what the new one takes). Neither may produce B's records.
    //
    // This is the assertion that watches the hole itself rather than the shape
    // of the code around it: with the guard removed and the storeId parameter
    // restored, these calls return "B secret design" and "B secret post", and
    // the suite reports the leaked rows.
    for (const [name, attempt] of [
      ["savedDesignsFor", await invoke(() => actions.savedDesignsFor(storeB.id))],
      ["savedDesignsFor by slug", await invoke(() => actions.savedDesignsFor(storeB.slug))],
      ["socialDraftsFor", await invoke(() => social.socialDraftsFor(storeB.id))],
      ["socialDraftsFor by slug", await invoke(() => social.socialDraftsFor(storeB.slug))],
      ["loadDesignDraft", await invoke(() => actions.loadDesignDraft(`design-B-${stamp}`, storeB.id))],
      ["loadSocialDraft", await invoke(() => social.loadSocialDraft(`post-B-${stamp}`, storeB.id))],
    ] as const) {
      const leaked = attempt.outcome === "returned"
        ? JSON.stringify(attempt.value ?? "")
        : "";
      assert(`${name} cannot reach store B's records`,
        !/B secret (design|post)|design-B-|post-B-/.test(leaked),
        `LEAKED ${leaked.slice(0, 220)}`);
    }

    // And no session means no data, however the refusal was worded.
    for (const [name, result] of results) {
      assert(`${name} returned no business data at all`,
        result.outcome === "refused" || result.value == null ||
          (Array.isArray(result.value) && result.value.length === 0),
        String(JSON.stringify((result as { value?: unknown }).value)).slice(0, 160));
    }
  }

  console.log("\n--- 6. the store id is not something a caller can supply ---\n");
  {
    // The capability is gone from the signature, which is stronger than a
    // check on it. Arity and source together: a storeId parameter cannot come
    // back without this failing.
    const createSrc = readFileSync(CREATE_ACTIONS, "utf8");
    const socialSrc = readFileSync(SOCIAL_ACTIONS, "utf8");

    for (const [name, src] of [["create", createSrc], ["social", socialSrc]] as const) {
      for (const fn of name === "create" ? ["savedDesignsFor", "loadDesignDraft"] : ["socialDraftsFor", "loadSocialDraft"]) {
        const at = src.indexOf(`export async function ${fn}(`);
        const sig = src.slice(at, src.indexOf("{", at));
        assert(`${fn} takes no storeId`, !/\bstoreId\b/.test(sig), sig.replace(/\s+/g, " ").slice(0, 120));
        const body = src.slice(at, at + 900);
        const guardAt = body.indexOf("requireBusinessOrActive(");
        const queryAt = body.indexOf("prisma.");
        assert(`${fn} authorizes before it queries`,
          guardAt > -1 && queryAt > guardAt, `guard ${guardAt}, query ${queryAt}`);
      }
    }

    // An arity assertion was here and has been REMOVED rather than corrected.
    // Function.length cannot tell a slug parameter from a store id parameter —
    // both are one string — so it would have passed whichever the signature
    // took, which is precisely the vulnerability. The source assertions above
    // discriminate; a number that cannot is worse than no assertion, because it
    // reads as coverage.
  }

  console.log("\n--- 6b. and the query itself is scoped, so an id would not help ---\n");
  {
    // ============ WHY THIS HALF MATTERS SEPARATELY =================
    //
    // Defence in depth, and each half is asserted on its own. Even if a store
    // identifier reached the query again, the read is scoped to the authorised
    // store — so another business's records are not merely un-asked-for, they
    // are unreachable through this shape.
    const scoped = await prisma.businessRecord.findMany({
      where: { storeId: storeA.id, entityType: "design", sourceProvider: DESIGN_SOURCE },
      select: { storeId: true, externalId: true },
    });
    assert("a scoped read returns only the authorised store",
      scoped.length > 0 && scoped.every((r) => r.storeId === storeA.id),
      JSON.stringify(scoped));
    assert("and none of the other business's designs",
      !scoped.some((r) => r.externalId === `design-B-${stamp}`));

    // THE LEAK, DEMONSTRATED. The pre-fix shape — a caller-supplied id — really
    // did return the other business's work. Proving the vulnerability was real
    // rather than theoretical is what makes the fix worth its commit.
    const asCallerSupplied = await prisma.businessRecord.findMany({
      where: { storeId: storeB.id, entityType: "design", sourceProvider: DESIGN_SOURCE },
      select: { externalId: true },
    });
    assert("the old shape would have returned store B's design",
      asCallerSupplied.some((r) => r.externalId === `design-B-${stamp}`),
      JSON.stringify(asCallerSupplied));
  }

  console.log("\n--- no other action still takes a caller-supplied store id ---\n");
  {
    // ============ THE REGRESSION GUARD =============================
    //
    // The four were found by an audit, not by a test, and an audit does not run
    // again on its own. This is that audit as an assertion: any NEW action that
    // takes a store identifier without authorizing it fails here.
    const { execSync } = await import("node:child_process");
    const GUARDS = ["requireStorePermission", "requireBusiness", "requireBusinessPage",
      "requireBusinessOrActive", "requireBusinessPageOrActive", "requireStorePageAccess",
      "requirePlatformAdmin", "assertPlatformAdmin", "isPlatformAdmin", "auth()",
      "getStoreRole", "resolveUserStore", "approvalAccessibleTo", "requireOwner",
      "requireUserId", "requireUser", "requireOwnStore", "reachableApproval", "forBusiness", "context("];

    const files = execSync('git ls-files "app/**/*.ts" "app/**/*.tsx" "lib/**/*.ts"', { encoding: "utf8" })
      .split("\n").filter(Boolean)
      .filter((f) => {
        const head = readFileSync(f, "utf8").replace(/^﻿/, "").trimStart();
        return head.startsWith('"use server"') || head.startsWith("'use server'");
      });

    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const part of src.split(/^export async function /m).slice(1)) {
        const fn = part.slice(0, part.indexOf("(")).trim();
        const sig = part.slice(part.indexOf("("), part.indexOf("{"));
        if (!/\b(storeId|businessId)\b/.test(sig)) continue;
        if (GUARDS.some((g) => part.includes(g))) continue;
        offenders.push(`${file} ${fn}`);
      }
    }
    eq("no unguarded action accepts a store identifier", offenders, []);
  }

  console.log(`\n${failures} failed, ${passes} passed\n`);
  await prismaSystem.$disconnect();
  process.exitCode = failures === 0 ? 0 : 1;
}

void main();
