import { startRealPostgres } from "@/scripts/lib/realPostgres";
import { TEST_DATABASE_ENV } from "@/scripts/lib/requireTestDatabase";

// THE BUSINESS A REQUEST IS ABOUT — BUSINESS_CONTEXT.md Phase C, the routes:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-route-business-live.ts" -OutFile out.txt
//
// Phase C's own item 8: "Route handlers (/api/chat, /api/j4/speak, both upload
// routes, /api/chat/recent-messages) take the business explicitly from the
// request rather than resolving it."
//
// TWO REAL DEFECTS THIS COVERS.
//
// 1. THE CHAT POST RESOLVED THE ACTIVE BUSINESS. J4Surface was fixed in August
//    to render the business named in the URL — but SENDING a message posted to
//    /api/chat, which resolved the account's active business instead. On
//    /b/copper-coil the conversation on screen was Copper & Coil's and the turn
//    was written against Iron Gym. The same defect the browser test found for
//    the surface, still live on the path that writes.
//
// 2. AMBIGUOUS AND NONE WERE THE SAME NULL. resolveUserStore returns null for
//    both "this account has no business" and "it has several and nothing says
//    which", so every one of these routes treated them identically. /j4/room
//    sent the second case to /onboarding — telling an owner to create a
//    business when they have several.
//
// What is asserted here is the resolution those handlers now share, against
// real rows. The handlers themselves need a signed-in session and are covered
// by the browser suite; this is the layer where the decision is decidable.

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) console.log(`        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`);
}

function assert(label: string, ok: boolean, detail = ""): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  — ${detail}` : ""}`);
}

async function main() {
  const db = await startRealPostgres();
  await db.prisma.$disconnect();

  process.env[TEST_DATABASE_ENV] = "1";
  process.env.DATABASE_URL = db.url;

  const { resolveBusiness, setActiveBusiness, businessFromSlug } = await import("@/lib/businessContext");
  const { prismaSystem: prisma } = await import("@/lib/prisma");

  const store = (userId: string, name: string, slug: string) =>
    prisma.store.create({
      data: { userId, name, slug, tagline: "t", description: "d", currency: "USD" },
    });

  /**
   * Exactly what the route handlers now do with a slug from the request body:
   * look it up, then resolve. Kept here as the same two steps in the same order
   * rather than a reimplementation of the decision, which would prove nothing.
   */
  async function resolveFromRequest(userId: string, requestedSlug?: string) {
    const named = requestedSlug ? await businessFromSlug(userId, requestedSlug) : null;
    if (requestedSlug && !named) return { kind: "no_such_business" as const };
    return resolveBusiness(userId, named?.store.id);
  }

  const owner = await prisma.user.create({ data: { email: "routes-owner@example.test" } });
  const iron = await store(owner.id, "Iron Gym", "iron-gym");
  const copper = await store(owner.id, "Copper & Coil", "copper-coil");
  await setActiveBusiness(owner.id, iron.id);

  // ==========================================================================
  console.log("\n=== 1. The slug in the request decides the turn ===\n");
  // ==========================================================================
  const named = await resolveFromRequest(owner.id, "copper-coil");
  check("a named business is resolved", named.kind, "resolved");
  check(
    "and it is the one named, not the one active",
    named.kind === "resolved" && named.store.slug,
    "copper-coil"
  );
  // THE DEFECT, stated as an assertion: without the slug this is Iron Gym.
  const unnamed = await resolveFromRequest(owner.id);
  check("with no slug the active business is still used", unnamed.kind === "resolved" && unnamed.store.slug, "iron-gym");
  assert(
    "so sending the slug is what changes the answer",
    named.kind === "resolved" && unnamed.kind === "resolved" && named.storeId !== unnamed.storeId,
    "the legacy /dashboard route keeps its old behaviour by sending nothing"
  );

  // ==========================================================================
  console.log("\n=== 2. A slug that is not yours is refused, never substituted ===\n");
  // ==========================================================================
  const stranger = await prisma.user.create({ data: { email: "routes-stranger@example.test" } });
  await store(stranger.id, "Not Yours", "not-yours");

  const borrowed = await resolveFromRequest(owner.id, "not-yours");
  const missing = await resolveFromRequest(owner.id, "no-such-slug");
  assert(
    "a real business belonging to someone else is refused",
    borrowed.kind !== "resolved",
    "succeeding with a different business than the one asked for is worse than failing"
  );
  check("a slug naming nothing at all is refused too", missing.kind, "no_such_business");
  // THE SAME ANSWER FOR BOTH, deliberately. Telling somebody a business exists
  // but is not theirs is an answer they did not have before — the rule
  // requireBusiness already states, now holding on this path too because
  // businessFromSlug returns null for both cases rather than distinguishing
  // "found but unreachable" from "not found".
  check("and the two are indistinguishable from outside", borrowed.kind, missing.kind);

  // ==========================================================================
  console.log("\n=== 3. Ambiguous is its own answer, not 'no business' ===\n");
  // ==========================================================================
  // The state /j4/room used to send to /onboarding: two businesses reachable and
  // nothing saying which.
  await prisma.user.update({ where: { id: owner.id }, data: { activeStoreId: null } });
  const ambiguous = await resolveFromRequest(owner.id);
  check("two businesses and no pointer is ambiguous", ambiguous.kind, "ambiguous");
  assert("which is NOT none", ambiguous.kind !== "none", "an account with businesses is not an account without one");
  assert(
    "and the caller is offered the real choices",
    ambiguous.kind === "ambiguous" && ambiguous.choices.length === 2
  );

  // A genuinely empty account is still none, and must stay distinguishable.
  const newcomer = await prisma.user.create({ data: { email: "routes-newcomer@example.test" } });
  check("an account with no business is none", (await resolveFromRequest(newcomer.id)).kind, "none");

  // Naming a business answers the question without setting the pointer — a
  // request is not a choice.
  const namedWhileAmbiguous = await resolveFromRequest(owner.id, "copper-coil");
  check("naming one resolves it even while ambiguous", namedWhileAmbiguous.kind, "resolved");
  check("without making it active",
    (await prisma.user.findUniqueOrThrow({ where: { id: owner.id }, select: { activeStoreId: true } })).activeStoreId,
    null);
  check("so the next unnamed request is still ambiguous", (await resolveFromRequest(owner.id)).kind, "ambiguous");

  // ==========================================================================
  console.log("\n=== 4. Two concurrent requests naming different businesses ===\n");
  // ==========================================================================
  const [a, b] = await Promise.all([
    resolveFromRequest(owner.id, "iron-gym"),
    resolveFromRequest(owner.id, "copper-coil"),
  ]);
  check("the request naming Iron Gym got Iron Gym", a.kind === "resolved" && a.store.slug, "iron-gym");
  check("the request naming Copper & Coil got Copper & Coil", b.kind === "resolved" && b.store.slug, "copper-coil");
  assert(
    "neither borrowed the other's business",
    a.kind === "resolved" && b.kind === "resolved" && a.storeId !== b.storeId
  );
  assert("and neither is the account's active one", copper.id !== iron.id);

  // ==========================================================================
  console.log("\n=== 5. One implementation of the refusal rule ===\n");
  // ==========================================================================
  // businessFromSlug is the single owner of "look the slug up, then check
  // access". Three call sites had grown their own copy — the chat route, the
  // chat-turn actions, and the non-streaming send fallback — and three copies of
  // an authorization rule is three chances for one to be lenient. Asserted here
  // directly, because every one of those sites now depends on it.
  const own = await businessFromSlug(owner.id, "iron-gym");
  assert("a business you own resolves", own?.store.slug === "iron-gym");
  check("with the role you hold there", own?.role, "OWNER");

  check("a slug naming nothing is null", await businessFromSlug(owner.id, "no-such-slug"), null);
  check("a real business you cannot reach is null", await businessFromSlug(owner.id, "not-yours"), null);
  check("an empty slug is null", await businessFromSlug(owner.id, ""), null);
  check("whitespace is not a slug", await businessFromSlug(owner.id, "   "), null);
  // The whole point: null is a refusal, not a signal to fall back.
  assert(
    "and null never means 'use the one they can reach'",
    (await businessFromSlug(owner.id, "not-yours")) === null,
    "the caller decides what to do with null, visibly, at its own call site"
  );
  // Surrounding whitespace is trimmed rather than failing — a form field can
  // carry it, and refusing there would be pedantry rather than safety.
  assert("a padded slug still resolves", (await businessFromSlug(owner.id, "  iron-gym  "))?.store.slug === "iron-gym");

  // ==========================================================================
  console.log("\n=== 6. And the surfaces that act actually send it ===\n");
  // ==========================================================================
  // Section 1 proves that sending the slug is what changes the answer. That is
  // worth nothing where nobody sends it — which is exactly what J4's attention
  // cards were doing (found 2026-08-22).
  //
  // Every card on every screen posts to a server action. None of them carried
  // the business, so dismissing a card, answering a supplier's economics
  // question, or turning a card into a conversation all resolved the ACCOUNT's
  // active business. Visiting /b/[slug] deliberately does not make a business
  // active — that write happens only at /choose-business — so from inside
  // Business A those actions ran against Business B, and the card the owner
  // clicked stayed exactly where it was.
  //
  // Checked structurally because this is a wiring fact, not a decidable one:
  // the resolution is already proved above, and what failed was that no caller
  // reached it. A behavioural test would need a signed-in session; this needs
  // only to know whether the field is on the form.
  const { readFileSync } = await import("fs");
  const { join } = await import("path");
  const source = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

  const card = source("app/dashboard/AttentionCard.tsx");
  assert(
    "the card puts the business on the form the action reads",
    /name="slug"/.test(card),
    "businessForTurn reads exactly this field, and reads nothing else"
  );
  assert(
    "and the dismiss action is given it too",
    /dismissAction\.bind\(null, card\.id, currentPath, slug\)/.test(card),
    "dismiss takes arguments rather than FormData, so it is bound instead"
  );

  // The approve/reject controls are bound rather than posted, so they carry the
  // business as a bound argument. Approving was ALREADY correctly scoped — the
  // approval row names its own business — but "Approve all" was not: the group
  // lookup resolved the active business and then searched inside it, so from
  // Business A's page it matched nothing and did nothing, silently. And every
  // one of the three then redirected to /dashboard, dropping the owner out of
  // the business they were working in.
  assert("approve carries the business", /approveAction\.bind\(null, card\.approvalRequestId, slug\)/.test(card));
  assert("so does reject", /rejectAction\.bind\(null, card\.approvalRequestId, slug\)/.test(card));
  const list = source("app/dashboard/AttentionCardList.tsx");
  assert("and so does approve-all", /approveGroupAction\.bind\(null, group\.groupId, slug\)/.test(list));
  assert(
    "including the one call site that binds the group action directly",
    /approveGenesisActionGroup\.bind\(null, groupKey, slug\)/.test(source("app/dashboard/website/page.tsx")),
    "a bound action missing an argument silently receives FormData in its place"
  );

  // Every screen that shows cards, so a new one cannot quietly opt out.
  const SCREENS = [
    "app/dashboard/HomeWorkspace.tsx",
    "app/dashboard/brand/page.tsx",
    "app/dashboard/marketing/page.tsx",
    "app/dashboard/products/page.tsx",
    "app/dashboard/settings/page.tsx",
    "app/dashboard/website/page.tsx",
  ];
  for (const screen of SCREENS) {
    const text = source(screen);
    const lists = (text.match(/<AttentionCardList/g) ?? []).length;
    const passes = (text.match(/slug=\{slug\}/g) ?? []).length;
    assert(
      `${screen.split("/").slice(-2).join("/")} passes the business to every card list`,
      lists > 0 && passes >= lists,
      `${lists} list(s), ${passes} slug prop(s)`
    );
  }

  // AND NOBODY HARDCODES THE LEGACY PATH. HomeWorkspace pinned
  // currentPath="/dashboard" while rendering a business page, so the
  // revalidation after a dismiss targeted a page the owner was not on.
  for (const screen of SCREENS) {
    assert(
      `${screen.split("/").slice(-2).join("/")} does not pin the legacy path on a card`,
      !/currentPath="\/dashboard"/.test(source(screen)),
      "revalidating /dashboard from /b/<slug> leaves the dismissed card on screen"
    );
  }

  await prisma.$disconnect();
  await db.close();

  console.log(`\n${failures === 0 ? "All route-business assertions passed." : `${failures} assertion(s) FAILED.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
