import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import {
  reserveAt,
  occupiedAt,
  roomsFitAt,
  MIN_TAP_TARGET_PX,
  PRIMARY_ROOMS,
  J4_DOCK_RESERVE_VAR,
  J4_DOCK_OCCUPIED_VAR,
} from "@/lib/dashboard/j4DockLayout";

/**
 * NOTHING AN OWNER CAN SCROLL TO ENDS UP BEHIND J4.
 *
 * ============ WHAT THIS WAS WRITTEN FOR (2026-09-17) ================
 *
 * The reserve keeps the five ROOMS out from under J4 and this suite has
 * asserted that since 2026-09-09. Nothing asserted the same for PAGE CONTENT,
 * and he is far taller than the bar the rooms sit in — 141px against 56px at
 * 390px. <main> cleared him with a hand-written pb-28 of 112px, so the last
 * 29px of every page went behind his helmet.
 *
 * It was visible in three separate production screenshots before any check
 * noticed, because every check was looking at the navigation.
 *
 * Measured at the BOTTOM of the page, which is where Sean's requirement lives:
 * "Content should terminate/scroll above the J4 occupied region, so the user
 * can always see the last content rather than having it disappear behind the
 * character."
 *
 * Leaves only: a wrapper legitimately spans the page, and it is the text and
 * the rules and the controls that must not be underneath him. Fixed and sticky
 * elements are skipped because they are chrome rather than scrollable content
 * — the room bar itself is one, and it is SUPPOSED to be down there.
 */
async function contentUnderJ4(page: Page): Promise<{
  found: boolean; offenders: string[]; dockTop: number; mainPadding: string;
}> {
  await page.evaluate(() => {
    document.documentElement.style.scrollBehavior = "auto";
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page
    .waitForFunction(() => {
      const atBottom = window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 4;
      return atBottom || document.documentElement.scrollHeight <= window.innerHeight + 4;
    }, undefined, { timeout: 10_000 })
    .catch(() => {});

  return page.evaluate(() => {
    const main = document.querySelector("main");
    const dock = document.querySelector('[data-testid="j4-dock"]');
    if (!main || !dock) return { found: false, offenders: ["no main or dock"], dockTop: 0, mainPadding: "" };
    const d = dock.getBoundingClientRect();
    const offenders: string[] = [];
    for (const el of main.querySelectorAll("*")) {
      if (el.children.length > 0) continue;
      const s = getComputedStyle(el);
      if (s.position === "fixed" || s.position === "sticky") continue;
      if (s.visibility === "hidden" || s.opacity === "0") continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const overlapsX = Math.min(r.right, d.right) - Math.max(r.left, d.left) > 0;
      const overlapsY = Math.min(r.bottom, d.bottom) - Math.max(r.top, d.top) > 0;
      if (overlapsX && overlapsY) {
        offenders.push(`${el.tagName}.${(el as HTMLElement).className}`.replace(/\s+/g, " ").slice(0, 70));
      }
    }
    return {
      found: true,
      offenders: offenders.slice(0, 6),
      dockTop: Math.round(d.top),
      mainPadding: getComputedStyle(main).paddingBottom,
    };
  });
}

// NOTHING SITS UNDERNEATH J4 (2026-09-09).
//
//   powershell -File scripts/run-unelevated.ps1 -Command "npx tsx scripts/verify-mobile-nav-layout.ts" -OutFile out.txt
//
// Sean, having looked at it once too often: "no overlapping, no wrapping, no
// tiny unusable buttons, and no weird floating placement."
//
// WHY THIS IS A BROWSER SUITE AND NOT A CLASS-NAME CHECK. The bug was two
// components each deciding the same layout - J4Dock anchoring bottom-left while
// the bar reserved a gap in its CENTRE - and every class name involved was
// individually correct. Only the rendered boxes showed it:
//
//     j4-corner   x=8   w=90
//     Business    x=0   w=55   *** UNDER J4 ***
//     Storefront  x=55  w=55   *** UNDER J4 ***
//     Studio      x=194        <- 84px of empty gap before this
//
// So this measures real geometry at real widths. It is also why this file
// screenshots: a DOM assertion once passed underneath a full-screen overlay in
// this repository, and a picture is what caught it.

const PASSWORD = "harness-password-not-a-real-one";
const WIDTHS = [360, 390, 430];

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

interface Box { x: number; y: number; w: number; h: number }
function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// NO const-ASSIGNED ARROW FUNCTIONS INSIDE page.evaluate.
//
// tsx compiles with esbuild, which wraps a named function expression in a
// `__name(...)` helper. That helper exists in the Node bundle and NOT in the
// page, so the first version of this threw `ReferenceError: __name is not
// defined` inside the browser - a failure that looks like a broken assertion
// and is really a transpiler artifact. Everything below is inline.
async function measure(page: Page) {
  return page.evaluate((vars: { reserve: string; occupied: string }) => {
    const nav = document.querySelector('[data-testid="mobile-room-bar"]');
    const dockEl = document.querySelector('[data-testid="j4-dock"]');
    const cornerEl = document.querySelector('[data-testid="j4-corner"]');
    const officeEl = document.querySelector('[data-testid="j4-office"]');
    const groundEl = document.querySelector('[data-testid="j4-dock-ground"]');

    const rects = [nav, dockEl, cornerEl, officeEl, groundEl].map((el) =>
      el
        ? (() => {
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
          })()
        : null,
    );

    // J4 HIMSELF, NOT THE BOX HE SITS IN. The dock measured 104x45 with the
    // artwork painted at 0x0, and every box assertion passed.
    const artEl = document.querySelector('[data-testid="j4-corner"] div[data-j4-state]');
    const artRect = artEl?.getBoundingClientRect();
    const art = artRect
      ? { x: Math.round(artRect.x), y: Math.round(artRect.y), w: Math.round(artRect.width), h: Math.round(artRect.height) }
      : null;
    const paintedImages = [...document.querySelectorAll('[data-testid="j4-corner"] img')].map((n) => {
      const img = n as HTMLImageElement;
      const r = img.getBoundingClientRect();
      return { src: img.getAttribute("src") ?? "", loaded: img.complete && img.naturalWidth > 0, w: Math.round(r.width) };
    });

    // NOTHING IN J4'S CORNER SITS ON TOP OF ANYTHING ELSE IN IT.
    //
    // Sean, from a production screenshot: an unexplained "P-A-N-D" under J4.
    // It was the Expand control. j4-office is positioned against j4-corner,
    // which includes the Expand button below the artwork, so trimming the
    // dock's padding to make J4 larger brought the Office doorway down over
    // the first two letters. "Expand" became "pand", and it read as a stray
    // string from nowhere rather than a control being covered.
    //
    // Measured rather than eyeballed, and every control in the corner is
    // included, so a future control cannot land on one either.
    const dockControls = [...document.querySelectorAll('[data-testid="j4-corner"] [data-testid]')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-testid") ?? "",
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        x: Math.round(r.x),
        y: Math.round(r.y),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });

    const items = nav
      ? [...nav.querySelectorAll('a,button')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: (el.textContent ?? '').trim(),
            // The glyph itself, so two rooms cannot wear the same one.
            // Compared as its path geometry rather than by name: an icon map
            // that points two keys at one drawing is exactly the defect this
            // catches, and the names would look different while the pictures
            // were identical.
            glyph: [...el.querySelectorAll('svg path')].map((pp) => pp.getAttribute('d') ?? '').join('|'),
            x: Math.round(r.x),
            y: Math.round(r.y),
            w: Math.round(r.width),
            h: Math.round(r.height),
          };
        })
      : [];

    return {
      nav: rects[0],
      dock: rects[1],
      corner: rects[2],
      office: rects[3],
      ground: rects[4],
      // HOW SOLID THE GROUND REALLY IS, read off the browser rather than off
      // the class list: bg-white/95 is a claim until something measures it.
      groundBg: groundEl ? getComputedStyle(groundEl).backgroundColor : "(no element)",
      // NOT ALWAYS rgba(), AND ASSUMING SO REPORTED A SOLID PANEL AS INVISIBLE.
      // Tailwind v4 writes an opacity modifier as a color-mix, and Chrome
      // resolves bg-white/95 to `oklab(0.999994 … / 0.95)`. The first version
      // of this only understood `rgba(…)`, found no match, and answered 0 — a
      // measurement failing on its own parser while the thing it measured was
      // exactly right. Both modern `… / alpha` and legacy rgba are read.
      groundAlpha: (() => {
        if (!groundEl) return 0;
        const bg = getComputedStyle(groundEl).backgroundColor;
        if (bg === "transparent" || bg === "rgba(0, 0, 0, 0)") return 0;
        const slash = /\/\s*([0-9.]+%?)\s*\)/.exec(bg);
        if (slash) {
          const v = slash[1];
          return v.endsWith("%") ? Number(v.slice(0, -1)) / 100 : Number(v);
        }
        const rgba = /rgba?\(([^)]+)\)/.exec(bg);
        if (rgba) {
          const parts = rgba[1].split(/[,\s]+/).filter(Boolean).map(Number);
          return parts.length >= 4 ? parts[3] : 1;
        }
        return 1;
      })(),
      items,
      dockControls,
      art,
      paintedImages,
      reserve: getComputedStyle(document.documentElement).getPropertyValue(vars.reserve).trim(),
      occupied: getComputedStyle(document.documentElement).getPropertyValue(vars.occupied).trim(),
      innerWidth: window.innerWidth,
    };
  }, { reserve: J4_DOCK_RESERVE_VAR, occupied: J4_DOCK_OCCUPIED_VAR });
}

async function main(): Promise<void> {
  const server = await startTestServer();
  const prisma = server.db.prisma;
  let browser;
  try {
    const stamp = Date.now();
    const email = `navlayout-${stamp}@example.test`;
    const user = await prisma.user.create({
      data: { email, name: "Sean McLay", password: await bcrypt.hash(PASSWORD, 10) },
    });
    await prisma.store.create({
      data: { userId: user.id, name: "Cubit & Coil", slug: `navlayout-${stamp}`, published: true, currency: "USD" },
    });

    browser = await chromium.launch();

    // ONE SESSION, THREE WIDTHS.
    //
    // The first version opened a fresh page and signed in again for each width.
    // That is three sign-ins to measure a CSS media query, and the dev server
    // died partway through the second one - so a layout suite reported a
    // failure that had nothing to do with layout. Resizing is what actually
    // changes here: every rule involved (--j4-dock-reserve's breakpoints, the
    // label's min-[380px] step) is CSS, and CSS re-evaluates on resize exactly
    // as it does on load.
    const page = await browser.newPage({ viewport: { width: WIDTHS[0], height: 844 } });
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.fill('input[type="email"]', email);
    await page.fill('input[type="password"]', PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForFunction(() => !window.location.pathname.startsWith("/login"), undefined, { timeout: 30_000 });
    await page.waitForSelector('[data-testid="mobile-room-bar"]', { timeout: 30_000 });

    // WAIT FOR THE ENTRANCE TO FINISH.
    //
    // J4Boot is `fixed inset-0 z-[120]`, and the first version of this suite
    // measured underneath it: every number was right and every screenshot was
    // a picture of the greeting animation. getBoundingClientRect does not care
    // what is painted on top, which is precisely the failure mode that once
    // let a green DOM check pass under a full-screen overlay in this repo.
    //
    // Nothing here is tappable until the greeting ends, so the working state
    // is the only state worth measuring.
    await page.waitForSelector('[data-testid="j4-boot"]', { state: "detached", timeout: 60_000 });
    await page.waitForTimeout(500);

    for (const width of WIDTHS) {
      console.log(`\n=== ${width}px ===\n`);
      await page.setViewportSize({ width, height: 844 });
      await page.waitForTimeout(400);

      const m = await measure(page);

      // ---- the reserve really is one value, and both sides use it ---------
      const expected = reserveAt(width);
      check(`${width}: the reserve resolves to the documented ${expected}px`,
        m.reserve === `${expected}px`, m.reserve);
      check(`${width}: J4's own width IS the reserve`,
        m.dock?.w === expected, `dock w=${m.dock?.w}`);
      // ---- and J4 is actually PAINTED in the space held for him ------------
      //
      // These exist because the first version of this suite passed completely
      // while J4 was 0x0: the dock's box was the right size and the artwork
      // inside it had collapsed. Sean would have opened the deploy and seen an
      // empty corner with five neat rooms beside it.
      //
      // The 14px allowance is the dock's px-1 and the corner's p-0.5 - 12px of
      // chrome around him, plus a pixel of rounding each way. It is deliberately
      // tight: loosen it and J4 can shrink inside a correct-looking reserve,
      // which is the shape of the bug it was written for.
      check(`${width}: J4's artwork fills the reserve, not 0x0`,
        !!(m.art && m.art.w >= expected - 14 && m.art.w > 0),
        m.art ? `${m.art.w}x${m.art.h} inside ${expected}px` : "no character element");
      check(`${width}: J4's artwork is square`,
        !!(m.art && Math.abs(m.art.w - m.art.h) <= 1), m.art ? `${m.art.w}x${m.art.h}` : "-");

      // ---- and his HEIGHT is held the same way his width is ---------------
      //
      // The width declaration keeps the rooms clear of him. This keeps the
      // PAGE clear of him, and it is the half that was missing.
      {
        const tall = occupiedAt(width);
        check(`${width}: the occupied height resolves to the documented ${tall}px`,
          m.occupied === `${tall}px`, m.occupied);
        // THE ANTI-DRIFT ASSERTION. The declaration is a mirror of J4's real
        // box, and a mirror is only worth having if something checks it: make
        // J4 taller without updating the value and the page silently stops
        // clearing him again.
        check(`${width}: and that IS his real box, not a number that used to be`,
          m.dock?.h === tall, `dock h=${m.dock?.h}, declared ${tall}`);

        // THE GROUND HE STANDS ON, covering exactly his box so no page content
        // is ever seen sliding under a cut-out helmet.
        check(`${width}: he stands on a ground, not over the page`,
          !!m.ground, m.ground ? `${m.ground.w}x${m.ground.h}` : "no ground element");
        check(`${width}: and the ground covers all of him`,
          !!(m.ground && m.ground.w === m.dock?.w && m.ground.h === m.dock?.h),
          `ground ${m.ground?.w}x${m.ground?.h} vs dock ${m.dock?.w}x${m.dock?.h}`);
        // OPAQUE, or it is not a ground. A transparent panel would satisfy
        // every geometric check above and hide nothing at all.
        check(`${width}: the ground is opaque enough to hide what passes behind it`,
          m.groundAlpha >= 0.9, `alpha ${m.groundAlpha} from ${m.groundBg}`);

        // ---- THE REQUIREMENT ITSELF ---------------------------------------
        const under = await contentUnderJ4(page);
        check(`${width}: the page has a <main> and a dock to compare`, under.found,
          under.offenders.join(", "));
        check(`${width}: <main> reserves his full height`,
          under.mainPadding === `${tall}px`, `padding-bottom ${under.mainPadding}, expected ${tall}px`);
        check(`${width}: NOTHING an owner can scroll to sits underneath J4`,
          under.offenders.length === 0,
          `at the bottom of the page, ${under.offenders.length} element(s) overlap his box: ${under.offenders.join(" | ")}`);
      }
      // ONE LAYER NOW, NOT TWO (2026-09-09).
      //
      // This asserted "both of J4's layers" because the character was a base
      // plus a face lit over the visor. The new direction is a clean visor —
      // no face asset at all — so two images would mean something had been
      // composited back onto him. The count is the assertion, not a detail of
      // it: expecting two here after the change would have gone green on an
      // artwork rule Sean stated explicitly.
      check(`${width}: J4 is one image, loaded, with real width`,
        m.paintedImages.length === 1 && m.paintedImages.every((i) => i.loaded && i.w > 0),
        m.paintedImages.map((i) => `${i.src.split("/").pop()} ${i.loaded ? "loaded" : "MISSING"} ${i.w}px`).join(", ") || "no images");

      check(`${width}: the bar starts where J4 ends`,
        (m.items[0]?.x ?? -1) >= expected, `first room x=${m.items[0]?.x}`);

      // ---- no control in J4's corner covers another -----------------------
      //
      // The "P-A-N-D" Sean saw in production: the Office doorway had come to
      // sit over the first letters of "Expand". A covered control reads as a
      // stray string from nowhere, which is worse than a missing one.
      const covered: string[] = [];
      for (const a of m.dockControls) {
        for (const b of m.dockControls) {
          if (a.id === b.id || a.id === "j4-open") continue;
          // j4-open is J4 himself and legitimately contains the others.
          if (b.id === "j4-open") continue;
          if (overlaps(a, b)) covered.push(`${a.id} over ${b.id}`);
        }
      }
      check(`${width}: nothing in J4's corner covers anything else in it`,
        covered.length === 0,
        covered.length ? covered.join(", ") : m.dockControls.map((c) => c.id).join(", "));

      // And every control that carries words shows all of them.
      const clipped = m.dockControls.filter((c) => c.text.length > 0 && (c.w < 12 || c.h < 8));
      check(`${width}: every labelled control in the corner has room for its label`,
        clipped.length === 0,
        clipped.length ? clipped.map((c) => `${c.id}="${c.text}" ${c.w}x${c.h}`).join(", ") : "all legible");

      // ---- the actual complaint -------------------------------------------
      check(`${width}: all ${PRIMARY_ROOMS} rooms are in the bar`,
        m.items.length === PRIMARY_ROOMS, m.items.map((i) => i.label).join(" | "));

      const under = m.items.filter((i) => m.corner && overlaps(i, m.corner));
      check(`${width}: NOTHING sits underneath J4`, under.length === 0,
        under.length ? under.map((u) => u.label).join(", ") : "no overlap");

      // ---- real tap targets, no wrapping ----------------------------------
      const tiny = m.items.filter((i) => i.w < MIN_TAP_TARGET_PX);
      check(`${width}: every room is at least ${MIN_TAP_TARGET_PX}px wide`, tiny.length === 0,
        tiny.length ? tiny.map((t) => `${t.label}=${t.w}px`).join(", ") : `narrowest ${Math.min(...m.items.map((i) => i.w))}px`);

      const tall = m.items.filter((i) => i.h > 60);
      check(`${width}: no label has wrapped to a second line`, tall.length === 0,
        tall.length ? tall.map((t) => `${t.label} h=${t.h}`).join(", ") : `tallest ${Math.max(...m.items.map((i) => i.h))}px`);

      // ---- nothing floats where it should not ------------------------------
      const gaps = m.items.slice(1).map((it, i) => it.x - (m.items[i].x + m.items[i].w));
      check(`${width}: the rooms are one continuous row, no gaps`,
        gaps.every((g) => Math.abs(g) <= 1), `gaps ${gaps.join(",")}`);

      // ---- every room is a different picture ------------------------------
      //
      // Business and Storefront both mapped to the house glyph, so the two
      // primary rooms looked the same and said nothing about where they went.
      // Sean: "Do not simply use two variations of the same house icon."
      const glyphs = m.items.filter((i) => i.glyph.length > 0);
      const duplicated = glyphs.filter((g, idx) => glyphs.findIndex((o) => o.glyph === g.glyph) !== idx);
      check(`${width}: no two rooms share an icon`,
        duplicated.length === 0,
        duplicated.length ? duplicated.map((d) => d.label).join(" and ") + " share a glyph" : `${glyphs.length} distinct glyphs`);
      check(`${width}: every room actually has an icon`,
        glyphs.length === m.items.length, `${glyphs.length} of ${m.items.length} drawn`);

      // ---- Office belongs to J4, not to the navigation ---------------------
      check(`${width}: no room is called Office`,
        !m.items.some((i) => /office/i.test(i.label)), m.items.map((i) => i.label).join(" | "));
      check(`${width}: the Office doorway is inside J4's square`,
        !!(m.office && m.corner && overlaps(m.office, m.corner)),
        m.office ? `office x=${m.office.x} corner x=${m.corner?.x}` : "no office control found");

      // ---- and the arithmetic agrees with the geometry --------------------
      const fit = roomsFitAt(width);
      check(`${width}: the documented arithmetic said this would fit`,
        fit.fits, `${fit.perRoom.toFixed(1)}px per room`);

      console.log(`   rooms: ${m.items.map((i) => `${i.label}(${i.x}..${i.x + i.w})`).join("  ")}`);
      await page.screenshot({ path: `verification-screenshots/nav-after-${width}.png` });
    }

    // ---- DESKTOP: J4 IS THE SIZE HE ALWAYS WAS --------------------------
    //
    // The dock and the bar now share one variable, so a number chosen for a
    // phone reaches a desktop where there is no bar to justify it. The first
    // version of this change set the desktop reserve to 168px and would have
    // grown J4 from 124px to 156px with nothing measuring it. This is the
    // width where a silent change is most likely, so it is the width with an
    // assertion on it.
    console.log(`\n=== 1280px (desktop) ===\n`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.waitForTimeout(400);
    const d = await measure(page);
    check("1280: the reserve resolves to the documented 156px", d.reserve === "156px", d.reserve);
    check("1280: J4 is still the 124px he was before any of this",
      !!(d.art && Math.abs(d.art.w - 124) <= 1), d.art ? `${d.art.w}x${d.art.h}` : "no character element");
    // Not rendered, not absent: `md:hidden` is display:none, so the five rooms
    // are still in the DOM and querySelectorAll still returns them - with zero
    // boxes. Asserting they are GONE fails against correct code, which is a
    // test bug rather than a finding. What matters is that the bar takes no
    // space on a desktop, so that is what this measures.
    check("1280: the phone room bar takes up no space",
      !d.nav || d.nav.h === 0, d.nav ? `bar is ${d.nav.w}x${d.nav.h}` : "no bar in the DOM");
    await page.screenshot({ path: "verification-screenshots/nav-after-1280.png" });

    await page.close();
  } finally {
    if (browser) await browser.close();
    // close(), not stop(). The first draft called server.stop(), which does not
    // exist - so the run threw on teardown and left `next dev` holding its port,
    // and the NEXT run failed with "Another next dev server is already running".
    await server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? `ALL PASS (${results.length})` : `${failed.length} of ${results.length} FAILED`}`);
  if (failed.length) console.log(failed.map((f) => `  - ${f.name}`).join("\n"));
  console.log("screenshots: verification-screenshots/nav-after-*.png");
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
