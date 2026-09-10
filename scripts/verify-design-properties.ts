import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import { DEFAULT_THEME, type Theme } from "@/lib/theme";
import {
  DESIGN_PROPERTIES, ownershipDrift, statusIsSelfConsistent, observeStatus, claimViolations,
  NO_ELEMENT, NO_VALUE, type Measurement, type PropertyStatus,
} from "@/lib/design/designProperties";
import { designChange } from "@/lib/design/designChange";
import { applyRefinementsToTheme } from "@/lib/execution/executables/refineStorefront";

// EVERY PROPERTY PROVES ITSELF, OR SAYS IT HAS NOT (2026-09-10).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-design-properties.ts" -OutFile out.txt
//
// Sean: "Make sure every property has a real visual measurement rather than
// inheriting a generic verified: true."
//
// So the registry's `status` is a CLAIM, and this is what checks it. Every
// property is mutated and re-measured on a real page, the browser's two
// readings decide a state on their own, and only then are the two compared.
// The suite never asks the registry what state a property is in.
//
// That order is the whole point. The first version read `if (reg.proven)` and
// therefore only tested the properties that already claimed to work - the four
// nobody had proven were skipped by the check that existed to catch them.
// Marking something proven without proving it is the same shape of lie the font
// bug was, and it is a failing test rather than a comment nobody re-reads.

const PASSWORD = "harness-password-not-a-real-one";

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

async function readMeasurement(page: Page, m: Measurement): Promise<string> {
  // The two sentinels are passed IN rather than written again inside the
  // browser, so the reader cannot spell "nothing" differently from the judge.
  return page.evaluate(([spec, noElement, noValue]: [Measurement, string, string]) => {
    const el = document.querySelector(spec.selector);
    if (!el) return noElement;
    if (spec.kind === "computedStyle") {
      // INDEXED, NOT getPropertyValue(). That method takes the CSS property
      // NAME - "font-family" - and the registry uses the JS spelling, so every
      // camelCase lookup returned "" and the first run reported eleven
      // properties as unchanged. `color` and the bounding box were the only
      // two that worked, because their two spellings happen to coincide. The
      // measurements were fine; the instrument was reading nothing.
      const style = getComputedStyle(el) as unknown as Record<string, string>;
      return style[spec.property] || noValue;
    }
    if (spec.kind === "boundingBox") {
      const r = el.getBoundingClientRect();
      return String(Math.round(spec.axis === "width" ? r.width : r.height));
    }
    if (spec.kind === "attribute") return el.getAttribute(spec.attribute) ?? "(none)";
    return [...document.querySelectorAll(spec.selector)].map((n) => n.tagName).join(">");
  }, [m, NO_ELEMENT, NO_VALUE] as [Measurement, string, string]);
}

/** A different, real value for each property, so "changed" means something. */
function mutate(theme: Theme, key: string): Theme {
  switch (key) {
    case "headingFont":
      return { ...theme, typography: { ...theme.typography, headingFont: "Playfair Display" } };
    case "bodyFont":
      return { ...theme, typography: { ...theme.typography, bodyFont: "Space Mono" } };
    case "background":
      return { ...theme, colors: { ...theme.colors, background: "#1a0d2e" } };
    case "accent":
      return { ...theme, colors: { ...theme.colors, accent: "#ff6b35" } };
    case "text":
      return { ...theme, colors: { ...theme.colors, text: "#0b3d2e" } };
    // The presentation/composition families go through the REAL refinement
    // transform, not a hand-written object: applyRefinementsToTheme is what an
    // approved refinement actually runs, and a second copy of it here would be
    // a test proving something the product does not do.
    // `sharp`, NOT `pill`. The default button style IS pill, so refining to
    // pill was a no-op the page correctly rendered identically both sides -
    // and the suite reported it as buttonStyle failing to move. A mutation
    // that does not mutate is an instrument reading zero, not a defect.
    case "buttonStyle":
      return applyRefinementsToTheme(theme, [{ dimension: "buttonStyle", value: "sharp" }]);
    case "cardStyle":
      return applyRefinementsToTheme(theme, [{ dimension: "cardStyle", value: "sharp" }]);
    case "spacing":
      return applyRefinementsToTheme(theme, [{ dimension: "spacing", value: "spacious" }]);
    case "sectionLayout":
      return applyRefinementsToTheme(theme, [{ dimension: "sectionLayout", value: "split" }]);
    case "imageTreatment":
      return applyRefinementsToTheme(theme, [{ dimension: "imageTreatment", value: "fullBleed" }]);
    case "heroLayout":
      return applyRefinementsToTheme(theme, [{ dimension: "heroLayout", value: "fullBleed" }]);
    default:
      return theme;
  }
}

async function main(): Promise<void> {
  console.log("\n=== the registry agrees with itself ===\n");
  const drift = ownershipDrift();
  check("every property's owning action matches what owns it",
    drift.length === 0, drift.join(", ") || "no drift");
  check("every property carries a measurement",
    Object.values(DESIGN_PROPERTIES).every((r) => !!r.measure),
    `${Object.keys(DESIGN_PROPERTIES).length} properties registered`);
  // A `proven` status has to carry the two values it was proven with. This is
  // what stops the state being asserted the way `proven: true` was — a claim
  // with no evidence attached is now a compile-time shape error or this failure.
  const inconsistent = Object.entries(DESIGN_PROPERTIES)
    .filter(([, r]) => !statusIsSelfConsistent(r.status)).map(([k]) => k);
  check("every status carries the evidence its state requires",
    inconsistent.length === 0, inconsistent.join(", ") || "all states carry their evidence");

  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `props-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    // ---- THE FIXTURE HAS TO BE A STORE THE PROPERTIES EXIST ON -----------
    //
    // Three properties read NO ELEMENT on the first fixture and NONE of them
    // was a broken feature. The buy button renders only for a store that can
    // take payments; the hero image renders only on the one hero layout that
    // has an image slot; the text sections render only when there is content.
    // A fixture too bare to show a property cannot be used to conclude
    // anything about it - "no element" was a fact about the fixture that read
    // like a fact about the product.
    // `split` is the only hero that renders an image at all - the one predicate
    // heroLayoutRendersImage owns - so imageTreatment has nothing to treat on
    // the default `centered` hero. Set through the real refinement transform
    // rather than a hand-built composition, for the same reason mutate() does.
    const base: Theme = {
      ...applyRefinementsToTheme(DEFAULT_THEME, [{ dimension: "heroLayout", value: "split" }]),
      typography: { headingFont: "Oswald", bodyFont: "Lora" },
    };
    const store = await prisma.store.create({
      data: {
        userId: user.id, name: "Cubit & Coil", slug: `props-${stamp}`, published: true,
        currency: "USD", theme: base as object,
        tagline: "Wound by hand, measured by cubit", description: "Handmade tensor rings.",
        // aboutUs is what makes a text section render, and therefore what
        // sectionLayout has to reshape; heroImageUrl is what imageTreatment
        // frames. Both live in the blueprint JSON the storefront reads.
        //
        // WRITTEN IN FULL, not as the two fields this suite happens to want.
        // The first attempt supplied only those two and every storefront read
        // returned HTTP 500, because the renderer treats HomepageContent's
        // arrays as present once the object exists (`homepage && homepage.faq
        // .length`). That is a fixture that does not resemble anything the
        // product writes, and it turned all eleven measurements into NO
        // ELEMENT at once - a broken instrument reporting a broken product.
        blueprint: {
          homepageContent: {
            heroHeadline: "Cubit & Coil",
            heroSubheadline: "Wound by hand, measured by cubit",
            primaryCallToAction: "Shop Now",
            secondaryCallToAction: null,
            aboutUs: "Every ring is wound by hand on a mandrel cut to the cubit.",
            whyChooseUs: "Because a ring wound to a whole number holds its tone.",
            featuredCollections: [],
            faq: [],
            newsletterSection: "",
            footerContent: "",
            sectionOrder: [],
            customSection: null,
            heroImageUrl: "/brand/j4-v2.png",
          },
        } as object,
      },
    });
    // The buy button is gated on canStoreAcceptPayments, so without this row
    // `.design-button` does not exist and both accent and buttonStyle measure
    // nothing. A CONNECTED Stripe row is the real gate, not a stub around it.
    await prisma.storeIntegration.create({
      data: { storeId: store.id, provider: "STRIPE", status: "CONNECTED", connectedAt: new Date() },
    });
    await prisma.product.create({
      data: { storeId: store.id, name: "Tensor Ring", description: "Copper.", priceInCents: 4200, active: true },
    });

    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    // EVERY MEASUREMENT ASSUMES THE PAGE RENDERED, so that assumption is
    // checked rather than assumed. A 500 makes every selector match nothing,
    // and "NO ELEMENT" then reads as eleven unproven properties instead of one
    // broken fixture - which is exactly what happened, and cost a bisect.
    // A storefront that did not render is a harness fault, not a result.
    async function load(): Promise<void> {
      const res = await page.goto(`${server.baseUrl}/store/${store.slug}`, { waitUntil: "domcontentloaded" });
      const rendered = await page.evaluate(() => !!document.querySelector(".design-ground"));
      if (!rendered) {
        throw new Error(
          `the storefront did not render (HTTP ${res?.status()}) — every measurement below would be meaningless`
        );
      }
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(500);
    }

    console.log("\n=== each property, measured on the real page ===\n");
    console.log("  property          before -> after");
    const moved: string[] = [];
    const didNotMove: string[] = [];
    /** Key -> the state the BROWSER put it in. The registry gets no vote here. */
    const observed = new Map<string, PropertyStatus>();

    for (const [key, reg] of Object.entries(DESIGN_PROPERTIES)) {
      // Always start from the same theme, so each property is measured alone.
      await prisma.store.update({ where: { id: store.id }, data: { theme: base as object } });
      await load();
      const before = await readMeasurement(page, reg.measure);

      await prisma.store.update({ where: { id: store.id }, data: { theme: mutate(base, key) as object } });
      await load();
      const after = await readMeasurement(page, reg.measure);

      const change = designChange(reg.property, before, after);
      const seen = observeStatus(before, after, change.changed);
      observed.set(key, seen);
      console.log(`  ${key.padEnd(16)} ${before.slice(0, 30)} -> ${after.slice(0, 30)}  [${seen.state}]`);
      (change.changed ? moved : didNotMove).push(key);
    }

    console.log(`\n  moved:        ${moved.join(", ") || "none"}`);
    console.log(`  did not move: ${didNotMove.join(", ") || "none"}`);

    console.log("\n=== the registry's claim, against what the browser saw ===\n");
    for (const [key, reg] of Object.entries(DESIGN_PROPERTIES)) {
      const seen = observed.get(key);
      if (!seen) {
        check(`${key}: was measured at all`, false, "no observation recorded");
        continue;
      }
      // The judge is claimViolations, and it lives in lib/ rather than here -
      // so verify-design-evidence can sabotage it directly with cases a real
      // page would take a fixture to produce, and so this suite and that one
      // cannot drift into two different definitions of a lie.
      const violations = claimViolations(reg.status, seen);
      check(`${key}: the registry says no more than the page showed`,
        violations.length === 0,
        violations.join("; ") || `${reg.status.state}, and the page agrees`);
    }

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
