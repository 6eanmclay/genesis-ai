import { chromium, type Page } from "playwright";
import bcrypt from "bcryptjs";
import { startTestServer } from "@/scripts/lib/testServer";
import {
  reserveAt,
  roomsFitAt,
  MIN_TAP_TARGET_PX,
  PRIMARY_ROOMS,
  J4_DOCK_RESERVE_VAR,
} from "@/lib/dashboard/j4DockLayout";

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
  return page.evaluate((varName: string) => {
    const nav = document.querySelector('[data-testid="mobile-room-bar"]');
    const dockEl = document.querySelector('[data-testid="j4-dock"]');
    const cornerEl = document.querySelector('[data-testid="j4-corner"]');
    const officeEl = document.querySelector('[data-testid="j4-office"]');

    const rects = [nav, dockEl, cornerEl, officeEl].map((el) =>
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

    const items = nav
      ? [...nav.querySelectorAll('a,button')].map((el) => {
          const r = el.getBoundingClientRect();
          return {
            label: (el.textContent ?? '').trim(),
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
      items,
      art,
      paintedImages,
      reserve: getComputedStyle(document.documentElement).getPropertyValue(varName).trim(),
      innerWidth: window.innerWidth,
    };
  }, J4_DOCK_RESERVE_VAR);
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
