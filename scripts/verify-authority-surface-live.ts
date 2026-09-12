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
// tier "auto" and the chat path published it on the spot. A screen about
// authority that misdescribes authority is worse than no screen, so this one
// is asserted against REAL database state rather than trusted.
//
// THE BEHAVIOUR THEN CHANGED UNDERNEATH IT (2026-09-11). Sean decided the
// owner's "ask me" is an authority boundary rather than an away-mode
// preference, so the conversational path now consults the same grant. Several
// assertions here flipped with it — deliberately, and each says so — because
// a suite that kept passing through that change would have been asserting
// wording rather than truth.
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
 * found the "While you're here" row rather than the delegated one. Callers
 * pass the section they mean.
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
    // THE PRESENT-OWNER ROW FOLLOWS THE SAME AUTHORISATION (2026-09-11).
    // It used to read "Always on" regardless of any grant, which was true of
    // the behaviour and is exactly what Sean changed: presence authenticates,
    // it does not authorise.
    assert("  the present-owner row says it goes ahead when authorised",
      sectionOf(grantedPage, "While you're here").includes("Goes ahead"),
      sectionOf(grantedPage, "While you're here"));
    assert("  and says it asks first when not",
      sectionOf(neverPage, "While you're here").includes("Asks first") &&
        !sectionOf(neverPage, "While you're here").includes("Goes ahead"),
      sectionOf(neverPage, "While you're here"));
    assert("  and a revoked capability asks in conversation too",
      sectionOf(revokedPage, "While you're here").includes("Asks first"),
      "the whole point of the decision: revoking reaches the conversation");

    const awayRow = (page: string) =>
      rowFor(sectionOf(page, "While you're away"), "Publish SEO improvements");
    assert("an active grant renders as granted",
      /\bGranted\b/.test(awayRow(grantedPage)) && !awayRow(grantedPage).includes("Not granted"),
      awayRow(grantedPage));
    assert("  and says Genesis can act without asking, in both contexts",
      /Genesis can do this without asking, here or while you're away/.test(grantedPage));
    assert("  and offers to take it back, unqualified",
      grantedPage.includes("Ask before doing this"));

    assert("a revoked grant renders as revoked", revokedPage.includes("Revoked"));
    assert("  and says Genesis asks in both contexts",
      /asks before doing it, here and while you're away/.test(revokedPage));
    assert("  and offers to authorise it again",
      revokedPage.includes("Let Genesis do this without asking"));
    assert("  a revoked grant is NOT shown as active",
      !/Genesis can do this without asking/.test(revokedPage),
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
      assert(`${name}: presence is not offered as permission`,
        /Being here is not the same as having said yes/.test(page),
        "the invariant, in the owner's own language");
    }

    // THE SENTENCE THE DECISION TURNED AROUND. This screen used to promise the
    // opposite — that turning a capability off applied to being away and did
    // not change what happened in conversation — because that was the
    // behaviour. Both changed together, and the test changed with them.
    assert("revoking is described as applying everywhere",
      /Turning one of these off applies everywhere/.test(revokedPage),
      "the owner's 'ask me' is an authority boundary now, not an away-mode preference");
    assert("  and says so on the ungranted page too",
      /Turning one of these off applies everywhere/.test(neverPage));
    assert("  and the screen never claims a revoke leaves conversation untouched",
      !/does not change what Genesis does in a conversation/.test(revokedPage),
      "that sentence was accurate until the behaviour changed under it");

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
      !/Genesis can do this without asking/.test(afterRevoke));
    assert("  and the conversational row flips to asking first",
      sectionOf(afterRevoke, "While you're here").includes("Asks first"),
      "one grant row, both contexts — the database is the single answer");

    // ======================================================================
    console.log("\n=== 6. Marketing points here rather than competing ===\n");
    // ======================================================================
    const marketing = textOf(await (await granted.session.fetch(`/b/${granted.store.slug}/marketing`)).text());
    // Reads the ungranted copy: section 5 revoked this store's grant, and the
    // page follows the database rather than the state it was created in.
    assert("Marketing still reports the capability's real state",
      /Genesis will ask before changing your SEO title or description/.test(marketing),
      marketing.slice(marketing.indexOf("Genesis's authority"), marketing.indexOf("Genesis's authority") + 260));
    assert("  and sends the owner to the one place it can be changed",
      /is where you change this/.test(marketing));
    assert("  and describes both contexts with one answer",
      /in a conversation or while you're away/.test(marketing),
      "the page that started this said Genesis would always ask, and it was false");
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
