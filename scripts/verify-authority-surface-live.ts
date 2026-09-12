import { startTestServer } from "@/scripts/lib/testServer";
import { signIn } from "@/scripts/lib/httpSession";

// THE AUTHORITY SCREEN SAYS WHAT IS ACTUALLY TRUE (2026-09-11):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-authority-surface-live.ts" -OutFile out.txt
//
// ============ WHY THIS SUITE EXISTS ==================================
//
// The screen this covers replaced a sentence that was false: with no grant in
// place the Marketing page told owners "Genesis will always ask before
// changing your SEO title or description," while update_seo is registered at
// tier "auto" and the chat path publishes it on the spot. A screen about
// authority that misdescribes authority is worse than no screen, so this one
// is asserted against REAL database state rather than trusted.
//
// Three grant states, three real stores, one signed-in owner per store, and
// the assertions read the HTML a real Next server rendered.
//
// ============ WHAT THIS PROVES, AND WHAT IT DOES NOT =================
//
// It proves the rendered document: the state each capability is shown in, and
// the sentences the page commits to. It does NOT prove pixels — nothing here
// can tell you the badge is legible or the section is above the fold. A
// browser suite would, and the trade is deliberate: these assertions are
// about what the page CLAIMS, which is text, and the login-and-screenshot
// route buys nothing for that while costing Chromium's flake.

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

/** Tags stripped, entities decoded, whitespace flattened — the page's words. */
function textOf(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<style[\s\S]*?<\/style>/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&apos;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&mdash;|&#8212;/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

/** One section's own text — the page has two, and they say different things. */
function sectionOf(page: string, heading: string): string {
  const start = page.indexOf(heading);
  if (start < 0) return "";
  const rest = page.slice(start + heading.length);
  const end = ["While you're away", "Not a permission", "Everything else asks"]
    .map((h) => rest.indexOf(h))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return rest.slice(0, end ?? rest.length);
}

/**
 * One capability's own text, from its label up to whatever follows it.
 *
 * TWO REASONS THIS IS SCOPED, both found by its own failures. A badge means
 * "this capability's state", so asserting it against the whole page asks a
 * different question — on a store with one grant and two ungranted
 * capabilities, every badge string appears somewhere. And update_seo appears
 * TWICE by design, once under each warrant: searching the page for its label
 * found the "While you're here" row, which has no grant state at all and
 * correctly says "Always on". Callers pass the section they mean.
 */
function rowFor(page: string, label: string): string {
  const start = page.indexOf(label);
  if (start < 0) return "";
  const rest = page.slice(start + label.length);
  const nextLabel = [
    "Mark a goal achieved or abandoned",
    "Close out a challenge you've dealt with",
    "Publish SEO improvements",
    "Not a permission",
    "Everything else asks",
  ]
    .map((l) => rest.indexOf(l))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return (label + rest.slice(0, nextLabel ?? rest.length)).trim();
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const { baseUrl, db } = server;
  const stamp = Date.now();

  try {
    const makeOwner = async (name: string) => {
      const session = await signIn({ baseUrl, db, email: `${name}-${stamp}@example.test` });
      const store = await db.prisma.store.create({
        data: {
          userId: session.userId,
          name: `${name} Co`,
          slug: `${name}-${stamp}`,
          tagline: "t",
          description: "d",
          currency: "USD",
          blueprint: { marketingAssets: { seoTitle: "T", seoMetaDescription: "D" } },
        },
      });
      return { session, store };
    };

    // THREE STORES, THREE REAL GRANT STATES. Separate owners rather than one
    // store mutated three times: a page cached from the previous state would
    // otherwise pass as the next one.
    const granted = await makeOwner("granted");
    await db.prisma.delegatedAuthority.create({
      data: {
        storeId: granted.store.id,
        actionType: "update_seo",
        grantedByUserId: granted.session.userId,
      },
    });

    const revoked = await makeOwner("revoked");
    await db.prisma.delegatedAuthority.create({
      data: {
        storeId: revoked.store.id,
        actionType: "update_seo",
        grantedByUserId: revoked.session.userId,
        revokedAt: new Date(),
      },
    });

    const never = await makeOwner("never");

    const pageFor = async (o: { session: { fetch: (p: string) => Promise<Response> }; store: { slug: string } }) => {
      const res = await o.session.fetch(`/b/${o.store.slug}/authority`);
      if (res.status !== 200) throw new Error(`/authority answered ${res.status}`);
      return textOf(await res.text());
    };

    // ======================================================================
    console.log("\n=== 0. The control — a real session, the right business ===\n");
    // ======================================================================
    {
      const session = await granted.session.fetch("/api/auth/session");
      check("signing in is real", session.status, 200);
      const body = (await session.json()) as { user?: { email?: string } };
      check("  and it is the right person", body.user?.email, granted.session.email);
    }

    const grantedPage = await pageFor(granted);
    const revokedPage = await pageFor(revoked);
    const neverPage = await pageFor(never);
    assert("the screen renders at all", grantedPage.includes("Genesis's authority"),
      grantedPage.slice(0, 120));

    // ======================================================================
    console.log("\n=== 1. Each grant state renders as itself ===\n");
    // ======================================================================
    //
    // The badge AND the sentence, because either alone could be right while
    // the page as a whole misleads.
    // ONE ROW, NOT THE WHOLE PAGE. The first version asserted that "Not
    // granted" appeared nowhere on a store that HAD a grant — and failed
    // against a perfectly correct page, because two other delegable
    // capabilities are legitimately ungranted on it. A page-wide assertion
    // about a per-capability badge was the wrong shape, not the wrong answer.
    // THE SAME CAPABILITY UNDER BOTH WARRANTS, which is the design and not a
    // duplication bug: SEO is the one action J4 may publish while the owner is
    // present AND the one an owner may delegate for when they are away. If it
    // ever appears under only one, the screen has started hiding a warrant.
    assert("SEO appears under both warrants, saying different things",
      sectionOf(grantedPage, "While you're here").includes("Publish SEO improvements") &&
        sectionOf(grantedPage, "While you're away").includes("Publish SEO improvements"),
      "one capability, two authorities");
    assert("  and the present-owner row carries no grant state",
      sectionOf(grantedPage, "While you're here").includes("Always on") &&
        !sectionOf(grantedPage, "While you're here").includes("Granted"),
      sectionOf(grantedPage, "While you're here"));

    const awayRow = (page: string) =>
      rowFor(sectionOf(page, "While you're away"), "Publish SEO improvements");
    assert("an active grant renders as granted",
      /\bGranted\b/.test(awayRow(grantedPage)) && !awayRow(grantedPage).includes("Not granted"),
      awayRow(grantedPage));
    assert("  and says Genesis can act while the owner is away",
      /Genesis can do this while you're away/.test(grantedPage));
    assert("  and offers to take it back",
      grantedPage.includes("Ask before doing this while I'm away"));

    assert("a revoked grant renders as revoked", revokedPage.includes("Revoked"));
    assert("  and says Genesis will not act",
      /will not do it while you're away/.test(revokedPage));
    assert("  and offers to grant it again",
      revokedPage.includes("Let Genesis do this while I'm away"));
    assert("  a revoked grant is NOT shown as active",
      !/Genesis can do this while you're away/.test(revokedPage),
      "a revoked row reading as granted is the worst version of this screen");

    assert("no grant at all renders as not granted", neverPage.includes("Not granted"));
    assert("  and is not described as revoked",
      !neverPage.includes("Revoked"),
      "never granted and turned off are different answers");

    // ======================================================================
    console.log("\n=== 2. The two warrants are described separately ===\n");
    // ======================================================================
    for (const [name, page] of [["granted", grantedPage], ["revoked", revokedPage], ["never", neverPage]] as const) {
      assert(`${name}: both warrants are on the page`,
        page.includes("While you're here") && page.includes("While you're away"));
      assert(`${name}: the present-owner warrant is not described as something granted`,
        /This is not something you have granted/.test(page));
    }

    // THE ONE SENTENCE THIS SCREEN EXISTS TO STOP BEING FALSE. Revoking closes
    // the away path and nothing else, and the page must not imply otherwise.
    assert("the screen never claims a revoke disables chat-auto",
      /does not change what Genesis does in a conversation/.test(revokedPage),
      "the unresolved product decision has to stay visible, not be answered by omission");
    assert("  and says so on the ungranted page too",
      /does not change what Genesis does in a conversation/.test(neverPage),
      "an owner who never granted anything is the likeliest to assume Genesis does nothing");
    assert("  the screen never says Genesis will always ask",
      !/always ask/i.test(neverPage),
      "that is the exact sentence that was false");

    // ======================================================================
    console.log("\n=== 3. Exempt is not dressed up as a permission ===\n");
    // ======================================================================
    assert("the exempt capability appears", neverPage.includes("Tell you something it noticed"));
    assert("  under a heading that denies it is a permission",
      neverPage.includes("Not a permission"));
    assert("  labelled informational",
      neverPage.includes("Informational"));
    assert("  and nothing to grant or revoke",
      /There is nothing to grant or revoke/.test(neverPage));
    // THE ONE THAT MATTERS. communicate_finding's cap would let it be granted,
    // and a grant would change nothing — it reaches execute() through the
    // authority-exempt seam, which consults no grant at all. Listing it as a
    // delegable permission would offer the owner a control over nothing and
    // describe an authority they never gave.
    for (const [name, page] of [["granted", grantedPage], ["never", neverPage]] as const) {
      assert(`${name}: the exempt capability is NOT offered as a delegable permission`,
        !sectionOf(page, "While you're away").includes("Tell you something it noticed"),
        sectionOf(page, "While you're away").slice(0, 160));
      assert(`${name}: nor as something J4 does on the owner's standing authority`,
        !sectionOf(page, "While you're here").includes("Tell you something it noticed"),
        "it is not a content change and does not ride the present-owner warrant either");
    }

    // ======================================================================
    console.log("\n=== 4. Delegable-but-uncontrolled says which it is ===\n");
    // ======================================================================
    //
    // update_goal_status and resolve_challenge are genuinely delegable in the
    // engine and have no control anywhere. The screen lists them and says so,
    // rather than either hiding them or inventing a button.
    assert("a delegable capability with no control is still listed",
      neverPage.includes("Mark a goal achieved or abandoned") &&
        neverPage.includes("Close out a challenge you've dealt with"));
    assert("  and is labelled as having no control yet",
      /there's no control for it yet/.test(neverPage),
      "informational, and honest about why");

    // ======================================================================
    console.log("\n=== 5. The state shown is the state in the database ===\n");
    // ======================================================================
    //
    // The page is derived from GENESIS_ACTIONS and the grant rows. This walks
    // the same question from the other end: change the database, re-read the
    // page, and see it move.
    await db.prisma.delegatedAuthority.updateMany({
      where: { storeId: granted.store.id, actionType: "update_seo" },
      data: { revokedAt: new Date() },
    });
    const afterRevoke = await pageFor(granted);
    assert("revoking in the database turns the page's badge to Revoked",
      afterRevoke.includes("Revoked"),
      "if this fails the screen is reading something other than the real grant");
    assert("  and the active sentence is gone",
      !/Genesis can do this while you're away/.test(afterRevoke));

    // ======================================================================
    console.log("\n=== 6. Marketing points here rather than competing ===\n");
    // ======================================================================
    const marketing = textOf(await (await granted.session.fetch(`/b/${granted.store.slug}/marketing`)).text());
    assert("Marketing still reports the away-state", /While you're away/.test(marketing));
    assert("  and links to the one authority surface",
      /has the full picture/.test(marketing));
    assert("  and no longer claims Genesis will always ask",
      !/always ask/i.test(marketing),
      "the sentence this whole slice started from");
  } finally {
    await server.close();
  }

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
