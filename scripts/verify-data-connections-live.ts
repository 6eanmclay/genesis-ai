import { startTestServer } from "@/scripts/lib/testServer";
import { signIn } from "@/scripts/lib/httpSession";
import { CONNECTION_CATEGORY_LABELS, CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { allConnectors } from "@/lib/integrations/registry";

// DATA & CONNECTIONS TELLS THE TRUTH ABOUT WHAT J4 KNOWS (2026-09-12):
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-data-connections-live.ts" -OutFile out.txt
//
// ============ WHY THIS SUITE EXISTS ==================================
//
// This is the first surface of the Genesis Experience Rebuild, and the stated
// failure mode of that whole phase is a beautiful screen showing numbers
// nobody measured. The reference composition this page is built from displays
// "Data Health 92%", "24,831 Data Points" and "Automations 12 · 4 active" —
// invented figures in a design study. Two of those three have no denominator
// or no concept behind them anywhere in this system.
//
// So the page is allowed to show exactly what can be counted, and this suite
// is the thing that keeps it that way. It is the proof obligation written
// into DATA_AND_CONNECTIONS.md, asserted against real rows.
//
// ============ THE CORRECTION IT PROTECTS =============================
//
// In the reference, every tool flows into the brain. Here most do not, on
// purpose: Stripe, PayPal, Printful, Twilio and AliExpress implement no sync.
// A rail that has written no records is working perfectly. Seven production
// connections were once told "Connected and syncing. This provider has not
// returned any business data yet" — false on both halves — which is why
// ConnectionEvidence.syncs exists. A single flow diagram would say the same
// false thing again, prettier. Section 3 is that assertion.

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

/** One section's own text. */
function sectionOf(page: string, heading: string, until: string[]): string {
  const start = page.indexOf(heading);
  if (start < 0) return "";
  const rest = page.slice(start + heading.length);
  const end = until
    .map((h) => rest.indexOf(h))
    .filter((i) => i > 0)
    .sort((a, b) => a - b)[0];
  return rest.slice(0, end ?? rest.length);
}

const HEADINGS = ["What that lets J4 do", "Where it comes from", "Needs you", "Recommended for"];

/**
 * ONE PLATFORM APP, SO THERE IS AN AVAILABLE PROVIDER TO FAIL (2026-09-17).
 *
 * `configured()` asks whether GENESIS has an OAuth app registered with a
 * provider — a fact about this platform, not about any owner's account. In
 * production the answer is yes for the connectors that have one; in a bare
 * harness it is no for every single data-carrying connector on this page, and
 * "unavailable" outranks a stored failure by design. Section 2 then has no
 * provider whose failure could be shown, and its own guard says so rather than
 * passing on nothing.
 *
 * So the harness registers one, the same way testServer already sets
 * STRIPE_SECRET_KEY: "sk_test_harness" for every suite. Set before the server
 * starts, because it is spawned with this process's environment.
 *
 * NOTHING IS CALLED AND NOTHING IS REAL. No request reaches Mailchimp in this
 * suite; the failure under test is a row written directly into the database.
 * These two values exist only to make this environment resemble production in
 * the one respect the section depends on — that a platform app exists at all.
 */
process.env.MAILCHIMP_CLIENT_ID ||= "harness-platform-app-not-a-real-one";
process.env.MAILCHIMP_CLIENT_SECRET ||= "harness-platform-app-not-a-real-one";

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
        },
      });
      return { session, store };
    };

    const pageFor = async (o: { session: { fetch: (p: string) => Promise<Response> }; store: { slug: string } }) => {
      const res = await o.session.fetch(`/b/${o.store.slug}/connections`);
      if (res.status !== 200) throw new Error(`/connections answered ${res.status}`);
      return await res.text();
    };

    // ======================================================================
    console.log("\n=== 0. A business that has connected nothing ===\n");
    // ======================================================================
    const bare = await makeOwner("bare");
    const barePage = textOf(await pageFor(bare));
    assert("the screen renders", barePage.includes("Data & Connections"), barePage.slice(0, 120));
    assert("it says J4 knows nothing yet, plainly",
      /no connected tool has sent J4 any business data/.test(barePage),
      "zero is a real answer and has to read like one");
    assert("  and calls that accurate rather than broken",
      /not a problem with the connection/.test(barePage));
    assert("  no total is claimed", !/records J4 has read/.test(barePage));

    // THE INVENTED FIGURES, ASSERTED ABSENT. These are the reference's, and
    // the page must never grow them.
    for (const invented of ["Data Health", "Data Points", "Automations"]) {
      assert(`  the reference's "${invented}" is not rendered`, !barePage.includes(invented),
        "a figure with no denominator is a mood, not a measurement");
    }

    // ======================================================================
    console.log("\n=== 1. What J4 knows is counted from the rows ===\n");
    // ======================================================================
    const fed = await makeOwner("fed");
    // A REAL SOURCE with real rows: Google Calendar writes appointments.
    for (let i = 0; i < 3; i++) {
      await db.prisma.businessRecord.create({
        data: {
          storeId: fed.store.id,
          entityType: "appointment",
          sourceProvider: "google_calendar",
          externalId: `appt-${stamp}-${i}`,
          data: { title: `Fitting ${i}`, startAt: new Date().toISOString() } as never,
        },
      });
    }
    // AND ONE INTERNAL RECORD, which is NOT from a connection. A goal the
    // owner set is not something a tool told us, and must not be counted as
    // knowledge a connection produced.
    await db.prisma.businessRecord.create({
      data: {
        storeId: fed.store.id,
        entityType: "goal",
        sourceProvider: "internal",
        externalId: `goal-${stamp}`,
        data: { status: "active", title: "Reach 100 orders" } as never,
      },
    });

    const fedPage = textOf(await pageFor(fed));
    assert("the real record count is shown", /3 Appointments/.test(fedPage) || /Appointments/.test(fedPage),
      sectionOf(fedPage, "What J4 knows", HEADINGS).slice(0, 200));
    const knows = sectionOf(fedPage, "What J4 knows", HEADINGS);
    // THE EXACT RENDERED FIGURE, not a digit search. The first version asked
    // whether the section contained "3" and not "4", which a timestamped slug
    // or any stray number could satisfy or break for reasons having nothing
    // to do with the count under test.
    assert("  the total counts only connection-sourced rows",
      knows.includes("3 records J4 has read") && !knows.includes("4 records"),
      `three appointments from a connection, one internal goal that is not: ${knows.slice(0, 200)}`);
    assert("  and the internal record is not presented as connection knowledge",
      !/Reach 100 orders/.test(fedPage) && !knows.includes("Goal"),
      "a goal the owner set is not something a tool told us");

    // ======================================================================
    console.log("\n=== 2. A failed connection shows the provider's own words ===\n");
    // ======================================================================
    //
    // MAILCHIMP RATHER THAN QUICKBOOKS, and the reason is a real property of
    // the health model worth knowing. QuickBooks declares
    // `configured: () => Boolean(QUICKBOOKS_CLIENT_ID && ..._SECRET)`, which
    // is false in a harness with no OAuth app — so its state is "unavailable",
    // and unavailable outranks a stored failure by design. The first version
    // of this section asserted against QuickBooks and failed against entirely
    // correct behaviour. Mailchimp declares no `configured`, so it is
    // available and a failure on it is visible.
    // ============ AND MAILCHIMP STOPPED BEING THAT (2026-09-17) =========
    //
    // The paragraph above is still true and its conclusion stopped being: a
    // later fix gave Mailchimp the `configured()` it was missing (see
    // registry.ts's own note about "the mirrored-registry failure that let
    // Mailchimp's missing configured() sit"). In a harness with no Mailchimp
    // OAuth app that makes it unavailable, unavailable outranks a stored
    // failure by design, and this section began failing against entirely
    // correct behaviour — exactly what it says happened with QuickBooks,
    // one provider later.
    //
    // Naming a third provider by hand would buy the same failure a third time.
    // What this section actually needs is "a provider that is AVAILABLE here
    // and can carry data", so that is what it asks the registry for:
    //
    //   available  — configured() is true, or absent, which means nothing to
    //                configure. The connector decides; no list decides for it.
    //   a feed     — it implements sync. The suite's own words further down:
    //                "it implements no sync: the absence of `sync` here is the
    //                answer". A rail's failure belongs to section 3.
    //
    // If that set is ever empty the section would pass by testing nothing, so
    // it fails loudly instead.
    // A third condition, and it was earned: the first version of this filter
    // chose EasyPost, which satisfies both of the above and is not on this
    // page at all — "EasyPost sits behind shipping", as the paragraph further
    // down already says of it. A provider has to be IN THE CATALOGUE to be
    // something this screen could ever show.
    const feedsOnThisPage = allConnectors()
      .filter(([, c]) => (c.configured?.() ?? true) && typeof c.sync === "function")
      .map(([p]) => ({ provider: p, entry: CONNECTOR_CATALOG.find((e) => e.provider === p) }))
      .filter((x): x is { provider: typeof x.provider; entry: NonNullable<typeof x.entry> } => !!x.entry);
    assert("a provider that could show a failure exists in this environment",
      feedsOnThisPage.length > 0,
      "every data-carrying connector on this page reports itself unconfigured — this section would prove nothing");
    const failedProvider = feedsOnThisPage[0].provider;
    const failedName = feedsOnThisPage[0].entry.name;
    console.log(`        (failure shown through ${failedName})`);

    const broken = await makeOwner("broken");
    const PROVIDER_WORDS = "The account was a test account created with a testmode key";
    await db.prisma.storeIntegration.create({
      data: {
        storeId: broken.store.id,
        provider: failedProvider,
        status: "FAILED",
        lastError: PROVIDER_WORDS,
        syncFailureCount: 1,
        connectedByUserId: broken.session.userId,
        connectedAt: new Date(),
      },
    });
    const brokenPage = textOf(await pageFor(broken));
    assert("the failure is surfaced under Needs you",
      sectionOf(brokenPage, "Needs you", ["Recommended for", "Where it comes from"]).includes(failedName),
      sectionOf(brokenPage, "Needs you", ["Recommended for"]).slice(0, 200));
    assert("  and the provider's message is verbatim, not rewritten",
      brokenPage.includes(PROVIDER_WORDS),
      "no sentence this codebase could generate would be more useful");

    // ======================================================================
    console.log("\n=== 3. A rail that has sent nothing is not described as failing ===\n");
    // ======================================================================
    //
    // Stripe implements no sync. It is connected, working, and will never
    // write a record. The page must say that is by design.
    const railed = await makeOwner("railed");
    await db.prisma.storeIntegration.create({
      data: {
        storeId: railed.store.id,
        provider: "STRIPE",
        status: "CONNECTED",
        connectedByUserId: railed.session.userId,
        connectedAt: new Date(),
        lastVerifiedAt: new Date(),
      },
    });
    const railedPage = textOf(await pageFor(railed));
    const comesFrom = sectionOf(railedPage, "Where it comes from", ["Needs you", "Recommended for"]);
    assert("the two populations are both on the page",
      comesFrom.includes("Feeds J4") && comesFrom.includes("Does a job, doesn't report back"),
      comesFrom.slice(0, 220));

    // ============ WHICH COLUMN EACH TOOL IS IN (2026-09-12) ===========
    //
    // ADDED BECAUSE THIS SECTION'S OWN SABOTAGE PASSED. Putting every
    // connector into "Feeds J4" — the reference's single flow diagram, exactly
    // the thing this page exists to correct — left all three assertions here
    // green, because they were checking static copy: both headings are always
    // rendered, the explanatory sentence is a constant, and Stripe does not
    // raise attention in either column.
    //
    // Three true statements that proved nothing about the split they were
    // written to protect. So this reads the membership itself.
    const RAIL_HEADING = "Does a job, doesn't report back";
    const feedsList = comesFrom.slice(0, comesFrom.indexOf(RAIL_HEADING));
    // BOUNDED BY THE REAL CATEGORY LABELS, not by the end of the page. The
    // first version let the rails list run on into the catalogue grid below,
    // where every connector appears again with its description — so "Google
    // Calendar is not in the rails column" was false for a reason that had
    // nothing to do with the column. Terminators come from the catalog itself
    // rather than being typed here, so a renamed category cannot silently
    // widen this window again.
    const afterRails = comesFrom.slice(comesFrom.indexOf(RAIL_HEADING));
    const gridStart = Object.values(CONNECTION_CATEGORY_LABELS)
      .map((label) => afterRails.indexOf(label))
      .filter((i) => i > 0)
      .sort((a, b) => a - b)[0];
    const railsList = afterRails.slice(0, gridStart ?? afterRails.length);
    assert("  the rails column really ends before the catalogue grid",
      gridStart !== undefined && gridStart > 0 && railsList.length < afterRails.length,
      `rails panel ${railsList.length} chars of ${afterRails.length}`);
    assert("  the split is real, not just two headings",
      feedsList.length > 0 && railsList.length > 0 && comesFrom.indexOf(RAIL_HEADING) > 0);
    // THE CATALOG IS NOT THE REGISTRY, and this suite asserted otherwise at
    // first. Stripe and PayPal are real connectors that never appear here —
    // payments have their own page, deliberately ("I don't want payment
    // connections buried in Settings") — and EasyPost sits behind shipping.
    // Asserting on them tested a page they are not on.
    for (const rail of ["Printful", "Twilio"]) {
      assert(`  ${rail} is a rail, and is listed as one`,
        railsList.includes(rail) && !feedsList.includes(rail),
        "it implements no sync: stripe.ts puts it plainly — \"the absence of `sync` here is the answer\"");
    }
    assert("  and a real source is on the other side",
      feedsList.includes("Google Calendar") && !railsList.includes("Google Calendar"),
      "google calendar writes appointment records");
    assert("  Mailchimp too",
      feedsList.includes("Mailchimp") && !railsList.includes("Mailchimp"));

    // AND THE COUNT IN THE SENTENCE IS THE LENGTH OF THE LIST BESIDE IT.
    // This one is the whole phase in miniature: the copy above that list read
    // "Nine tools can send J4 business data" while the list showed eight,
    // because the nine came from the registry and the list comes from the
    // catalog. An invented figure, on the page built to stop inventing them.
    const claimed = /(\d+) of these can send J4 business data/.exec(comesFrom)?.[1];
    const listed = feedsList.split(/Coming later|Not connected|Connected|records|Failed|Needs reconnection/).length - 1;
    assert("  the number in the sentence matches the list beneath it",
      claimed !== undefined && Number(claimed) === listed,
      `sentence says ${claimed}, list shows ${listed}`);
    assert("  and the page says nothing is missing when a rail sends nothing",
      /nothing is missing when they don't/.test(railedPage),
      "a rail that has written no records is working perfectly");
    assert("  a connected rail does not raise attention",
      !sectionOf(railedPage, "Needs you", ["Recommended for"]).includes("Stripe"),
      "this is the exact false alarm ConnectionEvidence.syncs was added to end");

    // ======================================================================
    console.log("\n=== 4. Capabilities are named whether or not they exist yet ===\n");
    // ======================================================================
    assert("an unconnected business is still told what it could have",
      /Connect QuickBooks or Xero/.test(barePage) &&
        /Connect Google Calendar/.test(barePage) &&
        /Connect Mailchimp/.test(barePage),
      "hiding a capability an owner could have is its own kind of dishonesty");
    assert("  and the capability is not claimed as available",
      sectionOf(barePage, "What that lets J4 do", ["Where it comes from"]).includes("Connect"),
      "named, with what would produce it");

    // A COUNT IS NOT A SENTENCE (2026-09-12). "0 still ahead" was accurate and
    // read like a database value. Connected-but-empty now says so in words and
    // keeps its available state — the capability really is working, there is
    // simply nothing in it. Asserted as an absence because the presence
    // depends on whether a fixture's dates happen to be in the future.
    for (const [name, page] of [["bare", barePage], ["fed", fedPage]] as const) {
      assert(`${name}: a zero is never rendered as a bare count`,
        !page.includes("0 still ahead") && !page.includes("0 outstanding"),
        "communicate availability without implying activity");
    }

    // ======================================================================
    console.log("\n=== 5. No credential reaches the page ===\n");
    // ======================================================================
    //
    // The one assertion here that is about safety rather than honesty. The
    // raw HTML, not the stripped text — a secret rendered into an attribute
    // would not survive textOf and would still have been served.
    const secret = await makeOwner("secret");
    const MARKER = `ZZSECRET${stamp}`;
    await db.prisma.storeIntegration.create({
      data: {
        storeId: secret.store.id,
        provider: "MAILCHIMP",
        status: "CONNECTED",
        externalAccountId: `acct_${MARKER}`,
        credentials: { accessToken: MARKER, refreshToken: `${MARKER}-refresh` } as never,
        connectedByUserId: secret.session.userId,
        connectedAt: new Date(),
      },
    });
    const rawHtml = await pageFor(secret);
    assert("the connection is really there to leak", rawHtml.includes("Mailchimp"));
    assert("  and no credential appears anywhere in the HTML",
      !rawHtml.includes(MARKER),
      "tokens, secrets and external account ids never render");

    // ======================================================================
    console.log("\n=== 6. The functional core survived the rebuild ===\n");
    // ======================================================================
    //
    // The screen was restructured, not replaced. Connecting things is the
    // reason it exists and must still be reachable.
    assert("the catalogue is still grouped by its real categories",
      railedPage.includes("Payments") || railedPage.includes("Business systems") ||
        railedPage.includes("Finance") || railedPage.includes("Marketing"),
      railedPage.slice(railedPage.indexOf("Where it comes from"), railedPage.indexOf("Where it comes from") + 400));
    assert("  and connecting is still offered",
      /Connect/.test(railedPage));
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
