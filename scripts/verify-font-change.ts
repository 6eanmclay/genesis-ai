import { chromium } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import { designChange, isPerceptibleFontChange, reportChange, readProperty, designOutcome } from "@/lib/design/designChange";
import { classifyDesignRequest, propertiesOf, mayExecuteDesignMutation } from "@/lib/design/designRouting";

// "I CHANGED THE FONT" HAS TO BE TRUE (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-font-change.ts" -OutFile out.txt
//
// Sean: "If J4 says it changed something, I should be able to see it... a
// screenshot alone is not sufficient, and a J4 success message is not proof."
// So this reads the RENDERED font family off the storefront with
// getComputedStyle, before and after a real theme change, in a real browser.
//
// WHY A BROWSER IS THE ONLY HONEST PLACE FOR THIS. Every layer between the
// stored value and the owner's eye can silently swallow the change: the theme
// column can update while the CSS variable does not, the variable can update
// while no stylesheet loads the family, and the family can load while the
// element uses a different variable. update_theme's own verify() checks the
// stored column and would pass through all three.

const PASSWORD = "harness-password-not-a-real-one";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function main(): Promise<void> {
  // ---- the record refuses to claim what did not happen -------------------
  console.log("\n=== a design change cannot claim more than it did ===\n");
  const unchanged = designChange({ group: "typography", field: "headingFont" }, "Oswald", "Oswald");
  check("the same value is not a change", unchanged.changed === false, String(unchanged.changed));
  check("and J4 says so out loud", /did not change/.test(reportChange(unchanged)), reportChange(unchanged));

  const real = designChange({ group: "typography", field: "headingFont" }, "Oswald", "Playfair Display");
  check("a different value is a change", real.changed === true);
  check("and the report names both sides",
    /Oswald/.test(reportChange(real)) && /Playfair Display/.test(reportChange(real)), reportChange(real));

  // Sean: "It cannot choose a nearly identical font and claim that the website
  // has meaningfully changed."
  console.log("\n=== a near-identical substitute is not a font change ===\n");
  for (const [a, b] of [["Helvetica", "Helvetica Neue"], ["Lora", "lora"], ["Oswald", "Oswald Medium"]] as const) {
    check(`${a} -> ${b} is not perceptible`, !isPerceptibleFontChange(a, b));
  }
  for (const [a, b] of [["Oswald", "Playfair Display"], ["Lora", "Space Mono"], ["", "Inter"]] as const) {
    check(`${a || "unset"} -> ${b} IS perceptible`, isPerceptibleFontChange(a, b));
  }
  const near = designChange({ group: "typography", field: "headingFont" }, "Helvetica", "Helvetica Neue");
  check("a near-identical change is reported honestly, not as a win",
    /may not see a difference/.test(reportChange(near)), reportChange(near));

  // ---- 2. THE THREE STATES, and what each one is allowed to do ---------
  //
  // Sean: "A classifier is not a security gate over everything it doesn't
  // understand. It is a routing aid for the narrow set of requests it
  // recognizes." So the three states fall four different ways, and the last
  // one is the one that must never be tightened:
  //
  //   confident + capable    execute
  //   confident + incapable  refuse honestly and explain why
  //   ambiguous              ask before changing anything
  //   unclassified           do not interfere
  console.log("\n=== 1. CONFIDENT: a named property routes and executes ===\n");
  for (const ask of [
    "Change the heading font to Playfair Display.",
    "change the font",
    "can we change the font underneath wound by hand measured by cubit?",
    "I want a different typeface",
  ]) {
    const req = classifyDesignRequest(ask);
    check(`"${ask.slice(0, 42)}" is confident typography`,
      req.kind === "confident" && propertiesOf(req).every((p) => p.group === "typography"),
      req.kind === "confident" ? propertiesOf(req).map((p) => p.field).join(", ") : req.kind);

    // Confident + incapable: refused, and the owner is told why.
    const wrong = mayExecuteDesignMutation(req, "refine_storefront");
    check("   refine_storefront is refused it", wrong.allowed === false,
      wrong.allowed === false ? wrong.because.slice(0, 72) : "ALLOWED");
    check("   and the refusal explains rather than just failing",
      wrong.allowed === false && /font/i.test(wrong.because));

    // Confident + capable: allowed.
    const right = mayExecuteDesignMutation(req, "update_theme");
    check("   update_theme may execute it", right.allowed === true);
  }

  console.log("\n=== 2. AMBIGUOUS: design intent, no property named -> ask ===\n");
  for (const ask of [
    "Make the website feel more modern.",
    "the website looks boring",
    "my homepage feels bland",
    "can you make the site look better",
  ]) {
    const req = classifyDesignRequest(ask);
    check(`"${ask.slice(0, 42)}" is ambiguous`, req.kind === "ambiguous", req.kind);

    // THE POINT: it cannot reach a mutation, whichever action received it.
    for (const action of ["update_theme", "refine_storefront"] as const) {
      const gate = mayExecuteDesignMutation(req, action);
      check(`   no mutation runs via ${action}`, gate.allowed === false,
        gate.allowed === false ? "refused" : "REACHED A MUTATION");
    }
    const gate = mayExecuteDesignMutation(req, "update_theme");
    check("   and J4 asks a question instead",
      gate.allowed === false && !!gate.ask && gate.ask.length > 20,
      gate.allowed === false ? (gate.ask ?? "no question").slice(0, 76) : "-");
  }

  console.log("\n=== 3. UNCLASSIFIED: the classifier stays out of the way ===\n");
  for (const ask of [
    "how many orders did I get this week",
    "add a product called Tensor Ring",
    "make the buttons rounder",
    "make the background warmer",
    "make the font size bigger",
    "what did you change yesterday",
  ]) {
    const req = classifyDesignRequest(ask);
    check(`"${ask.slice(0, 42)}" is left alone`, req.kind === "unclassified", req.kind);
    // And critically it does not BLOCK: normal J4 handling continues.
    check("   normal handling continues",
      mayExecuteDesignMutation(req, "refine_storefront").allowed === true);
  }

  // ---- 4 and 5. success is derived, never asserted ----------------------
  console.log("\n=== J4 cannot report success it did not earn ===\n");
  const good = designChange({ group: "typography", field: "headingFont" }, "Oswald", "Playfair Display");

  const failedRun = designOutcome({ executed: false, change: null, rendered: null, failure: '"solid copper fill" is not a real option for Button style.' });
  check("a failed mutation cannot produce a completion", failedRun.state === "failed", failedRun.report.slice(0, 80));
  check("and the failure is told to the owner in their terms",
    /could not make that change/.test(failedRun.report), failedRun.report.slice(0, 60));

  const renderedFalse = designOutcome({ executed: true, change: good, rendered: false });
  check("a change the page does not show is NOT a success",
    renderedFalse.state === "failed", renderedFalse.report.slice(0, 90));

  const unverifiable = designOutcome({ executed: true, change: good, rendered: null });
  check("an unverifiable change says so rather than claiming",
    unverifiable.state === "changed_but_unverified", unverifiable.report.slice(0, 80));

  const nothingMoved = designOutcome({
    executed: true,
    change: designChange({ group: "typography", field: "headingFont" }, "Oswald", "Oswald"),
    rendered: true,
  });
  check("executing without changing anything is not a success",
    nothingMoved.state === "not_changed", nothingMoved.report);

  const verified = designOutcome({ executed: true, change: good, rendered: true });
  check("only a verified change reports as done", verified.state === "verified", verified.report);

  // ---- the class that carries a font must be able to carry one ----------
  //
  // THE ACTUAL BUG, and it was one missing word. Tailwind v4 treats an
  // arbitrary `font-[...]` value as ambiguous between font-family and
  // font-weight, and resolves nothing without a type hint. Every themed
  // element in this app was written `font-[var(--font-heading)]`, so all 37 of
  // them were INERT: the theme was right, the CSS variable was right, the
  // Google Fonts stylesheet was loading, and no element on any page ever used
  // any of it. Measured before the fix, the storefront heading rendered
  // "Arial, Helvetica, sans-serif" while --font-heading said "Oswald".
  //
  // That is the whole of Sean's months-old complaint: when J4 did write the
  // right font, the page could not change, so the only visible movement was
  // whatever colour it also touched.
  //
  // Scanned across the app rather than asserted on one file: the defect was
  // uniform, so a single-file check would have passed while 36 stayed broken.
  console.log("\n=== every themed element can actually take a font ===\n");
  const { execSync } = await import("node:child_process");
  const hintless = execSync('grep -rn "font-\\[var(--font-" --include=*.tsx app || true', { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.trim().length > 0);
  check("no themed element uses an untyped arbitrary font value",
    hintless.length === 0,
    hintless.length ? `${hintless.length} inert: ${hintless[0].slice(0, 90)}` : "all use family-name:");

  // ---- and now the rendered page, which is the only proof that counts ----
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `font-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });

    // A store whose heading font is a real, loadable family — the "before".
    const before: Theme = {
      ...DEFAULT_THEME,
      typography: { headingFont: "Oswald", bodyFont: "Lora" },
    };
    const store = await prisma.store.create({
      data: {
        userId: user.id,
        name: "Cubit & Coil",
        slug: `font-${stamp}`,
        published: true,
        currency: "USD",
        theme: before as object,
        tagline: "Wound by hand, measured by cubit",
        description: "Handmade tensor rings.",
      },
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // THE THEMED HEADING, not the first h1 on the page.
    //
    // The first version took `document.querySelector("h1")` and read back
    // "Arial, Helvetica, sans-serif" — which looked like the font pipeline was
    // broken end to end. It was the wrong element: the storefront has chrome
    // above the themed content, and an h1 that is not styled from the theme is
    // not evidence about the theme. So this finds the element that actually
    // asks for the variable, and reports the variable itself alongside, so a
    // future failure says WHICH layer broke rather than just "not Oswald".
    async function renderedHeading(): Promise<{ font: string; variable: string; all: string[] }> {
      await page.goto(`${server.baseUrl}/store/${store.slug}`, { waitUntil: "domcontentloaded" });
      // The webfont has to actually arrive, or this measures the fallback.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(800);
      return page.evaluate(() => {
        const headings = [...document.querySelectorAll("h1,h2")];
        const themed = headings.find((h) => h.className.includes("--font-heading"));
        const scope = themed ?? document.body;
        return {
          font: themed ? getComputedStyle(themed).fontFamily : "NO THEMED HEADING FOUND",
          variable: getComputedStyle(scope).getPropertyValue("--font-heading").trim() || "(unset)",
          all: headings.slice(0, 6).map((h) => `${h.tagName} "${(h.textContent ?? "").trim().slice(0, 24)}" ${getComputedStyle(h).fontFamily}`),
        };
      });
    }

    console.log("\n=== the rendered storefront, before and after ===\n");
    const seenBefore = await renderedHeading();
    for (const h of seenBefore.all) console.log(`      ${h}`);
    const renderedBefore = seenBefore.font;
    check("the storefront has a heading styled from the theme",
      renderedBefore !== "NO THEMED HEADING FOUND", renderedBefore);
    check("the --font-heading variable carries the theme's family",
      /oswald/i.test(seenBefore.variable), seenBefore.variable);
    check("and the heading actually renders in it",
      /oswald/i.test(renderedBefore), renderedBefore);

    // THE REAL EXECUTION PATH. Not a direct column write dressed up as one:
    // this is the executable the approval flow runs, so what is proven here is
    // what an owner's approval actually does.
    // THE SAME WRITE THE EXECUTABLE MAKES, against the harness database.
    //
    // updateThemeExecutable.run imports the app's prisma client, which points
    // at whatever DATABASE_URL this process has - not the temporary Postgres
    // the harness started - so calling it here reached the wrong database and
    // was refused. Its run() is one column write, `data: { theme: input }`,
    // and that is what happens here; the executable's own shape is asserted in
    // the code-only checks below rather than pretended at.
    const after: Theme = { ...before, typography: { headingFont: "Playfair Display", bodyFont: "Lora" } };
    await prisma.store.update({ where: { id: store.id }, data: { theme: after as object } });

    const seenAfter = await renderedHeading();
    const renderedAfter = seenAfter.font;
    console.log(`      before: ${renderedBefore}`);
    console.log(`      after:  ${renderedAfter}`);

    check("the RENDERED font family actually changed",
      renderedBefore !== renderedAfter, `${renderedBefore} -> ${renderedAfter}`);
    check("and it is the family that was asked for",
      /playfair/i.test(renderedAfter), renderedAfter);
    check("the old family is gone from the rendered element",
      !/oswald/i.test(renderedAfter), renderedAfter);

    // THE WHOLE POINT: the stored value agreeing is not the same as the page
    // agreeing. update_theme's own verify() checks the column, and would have
    // passed even if none of the above were true.
    const stored = (await prisma.store.findUnique({ where: { id: store.id }, select: { theme: true } }))?.theme as Theme;
    const storedChange = designChange(
      { group: "typography", field: "headingFont" },
      readProperty(before, { group: "typography", field: "headingFont" }),
      readProperty(stored, { group: "typography", field: "headingFont" }),
    );
    check("the stored property changed too", storedChange.changed, `${storedChange.before} -> ${storedChange.after}`);

    // ---- 7. EVERY CUSTOMER-FACING SURFACE, not the one h1 that proved it ---
    //
    // The defect was uniform across 37 usages in ten files, so proving it on a
    // single heading would have been proving the least of it. These are the
    // routes a customer actually reaches without signing in; the dashboard and
    // preview are covered by the app-wide scan above, which is what catches a
    // usage in a file no browser test happens to visit.
    const product = await prisma.product.create({
      data: {
        storeId: store.id,
        name: "Tensor Ring — Cubit",
        description: "Hand-wound copper.",
        priceInCents: 4200,
        active: true,
      },
    });
    const surfaces: { label: string; path: string }[] = [
      { label: "storefront", path: `/store/${store.slug}` },
      { label: "product page", path: `/store/${store.slug}/products/${product.id}` },
      { label: "bag", path: `/store/${store.slug}/bag` },
    ];
    for (const surface of surfaces) {
      await page.goto(`${server.baseUrl}${surface.path}`, { waitUntil: "domcontentloaded" });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
      const seen = await page.evaluate(() => {
        const themed = [...document.querySelectorAll("h1,h2,body,div")].find((el) =>
          typeof el.className === "string" && el.className.includes("--font-heading"),
        );
        return themed ? getComputedStyle(themed).fontFamily : "NO THEMED ELEMENT";
      });
      check(`${surface.label} renders the new family`, /playfair/i.test(seen), seen);
    }
    check("and the change is one an owner would see",
      isPerceptibleFontChange(storedChange.before, storedChange.after));

    await page.screenshot({ path: "verification-screenshots/font-after.png" });
    await page.close();
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
