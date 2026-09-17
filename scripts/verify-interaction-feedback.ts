import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "fs";
import { join } from "path";
import { startTestServer } from "@/scripts/lib/testServer";

// EVERY CONTROL ACKNOWLEDGES THE PRESS, AND NOTHING ELSE PRETENDS TO:
//
//   powershell -File scripts/run-unelevated.ps1 \
//     -Command "npx tsx scripts/verify-interaction-feedback.ts" -OutFile out.txt
//
// ============ THE CONTRACT (Sean, 2026-09-17) =========================
//
// "Anything that is interactive must visibly acknowledge the interaction
// immediately... a user should never tap something and be left wondering
// whether Genesis received the tap." And the inverse, in the same breath: "do
// not add fake click feedback to non-interactive text or decorative elements."
//
// ============ THE GAP THAT WAS MEASURED FIRST =========================
//
// `hover:` appears 332 times across 95 component files. `active:` appears 32
// times across 19. Hover does nothing on a touchscreen, so on the device most
// owners actually use, the overwhelming majority of Genesis's controls
// acknowledged nothing at all.
//
// ============ WHY THIS IS A BROWSER SUITE =============================
//
// A source check on globals.css can pass against CSS that never applies —
// a typo'd selector, a rule the cascade overrides, a property the browser
// drops. The only honest evidence is a REAL computed style, on a REAL element,
// while the pointer is genuinely down. So sections 2-4 press things and measure
// what the browser actually computed.
//
// Same lesson this repository has already paid for twice: a DOM assertion once
// passed underneath a full-screen overlay, and a webhook contract test passed
// against a verifier deliberately broken to accept unsigned deliveries.
//
// NO WAITS. `:active` is applied by the browser on pointer-down, before any
// handler runs and before navigation begins, so there is nothing to wait for
// and nothing is slept on to manufacture the effect.

let failures = 0;
let passes = 0;
const failed: string[] = [];

function assert(label: string, ok: boolean, detail = ""): void {
  if (ok) passes++;
  else {
    failures++;
    failed.push(`${label}${detail ? `  — ${detail}` : ""}`);
  }
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `  — ${detail}` : ""}`);
}

/** What the element looks like right now, as the browser computed it. */
async function styleOf(page: Page, selector: string) {
  return page.$eval(selector, (el) => {
    const s = getComputedStyle(el);
    return { transform: s.transform, opacity: s.opacity, transition: s.transitionProperty, cursor: s.cursor, touchAction: s.touchAction };
  });
}

/** Press and hold, read the style, then release. */
async function whilePressed<T>(page: Page, selector: string, read: () => Promise<T>): Promise<T> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`no box for ${selector}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  try {
    return await read();
  } finally {
    await page.mouse.up();
  }
}

async function main(): Promise<void> {
  // ==================================================================
  console.log("\n1. The contract exists, and says what it excludes\n");
  // ==================================================================
  {
    const css = readFileSync(join(process.cwd(), "app/globals.css"), "utf8");

    assert("globals.css carries the interaction contract",
      /INTERACTION FEEDBACK CONTRACT/.test(css));
    // PLAIN SELECTORS, NOT :where(). The first version used :where() for zero
    // specificity and applied to nothing at all — the browser reported
    // touch-action:auto on the very button it was meant to govern. Section 2
    // caught it before this shipped, which is the reason section 2 exists.
    assert("  it keys on real controls, not on a class somebody remembers",
      /^button, \[role="button"\], \[role="tab"\]/m.test(css));
    assert("  a disabled control is excluded",
      /button:not\(:disabled\):not\(\[aria-disabled="true"\]\):active/.test(css));
    assert("  keyboard focus is acknowledged too",
      /:focus-visible/.test(css));

    // NO MANUFACTURED TIMING. The whole effect must come from :active, which
    // the browser applies on pointer-down.
    assert("no transition-delay is used to fake the effect",
      !/transition-delay/.test(css.slice(css.indexOf("INTERACTION FEEDBACK CONTRACT"))),
      "a delay would make the acknowledgement later, not sooner");

    // REDUCED MOTION KEEPS THE FEEDBACK. Removing it would take the contract
    // away from the people most likely to need it.
    const reduced = css.slice(css.lastIndexOf("prefers-reduced-motion"));
    assert("reduced motion still acknowledges the press", /opacity:\s*0\.8/.test(reduced),
      "reduced motion must drop the ANIMATION, not the feedback");
    assert("  and drops the MOTION rather than the state change",
      /transform:\s*none/.test(reduced),
      "scale gives way to opacity; the acknowledgement itself stays");
  }

  const server = await startTestServer();
  let browser: Browser | null = null;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    // THE LOGIN PAGE, chosen because it is public, always present, and carries
    // a real submit button plus real inert text — both halves of the contract
    // on one screen, with no fixture to seed and no session to establish.
    await page.goto(`${server.baseUrl}/login`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('button[type="submit"]');

    // ==================================================================
    console.log("\n2. A real control really changes while pressed\n");
    // ==================================================================
    {
      const at_rest = await styleOf(page, 'button[type="submit"]');
      assert("at rest the button is untransformed", at_rest.transform === "none" || at_rest.transform === "matrix(1, 0, 0, 1, 0, 0)",
        at_rest.transform);
      assert("  and fully opaque", at_rest.opacity === "1", at_rest.opacity);
      // ============ A CORRECTION, MADE BY RUNNING IT =================
      //
      // This first asserted the element carried a transform/opacity TRANSITION.
      // It failed, and the failure was right: Tailwind's own `transition-colors`
      // utility sets transition-property on many of these buttons, and a
      // shorthand in globals.css cannot append to it — one of them wins and it
      // is not ours.
      //
      // The contract does not need it. `:active` applies on pointer-down and an
      // INSTANT change is the fastest possible acknowledgement, not a degraded
      // one — which is the thing being asked for. So what is asserted is that
      // the pressed state is genuinely different, below, and the animation is
      // left to whatever each component already chose.
      assert("  and the browser is not waiting on a double-tap before acting",
        /manipulation/.test(at_rest.touchAction), at_rest.touchAction);

      const pressed = await whilePressed(page, 'button[type="submit"]', () =>
        styleOf(page, 'button[type="submit"]'));

      // THE ASSERTION THIS SUITE EXISTS FOR.
      assert("while pressed, the button is visibly changed",
        pressed.transform !== at_rest.transform || pressed.opacity !== at_rest.opacity,
        `rest ${at_rest.transform}/${at_rest.opacity} vs pressed ${pressed.transform}/${pressed.opacity}`);
      assert("  specifically it scales down", pressed.transform.startsWith("matrix(0.97"),
        pressed.transform);
      assert("  and dims", Number(pressed.opacity) < 1, pressed.opacity);

      const released = await styleOf(page, 'button[type="submit"]');
      assert("and it returns when released", released.transform === at_rest.transform,
        released.transform);
    }

    // ==================================================================
    console.log("\n3. Nothing informational pretends to be a control\n");
    // ==================================================================
    {
      // THE INVERSE HALF, and the one a blanket rule would fail. A heading is
      // not a control and must not acknowledge a press.
      const inert = await page.$$eval("h1, h2, p, label", (els) =>
        els.slice(0, 6).map((el) => {
          const s = getComputedStyle(el);
          return { tag: el.tagName, transition: s.transitionProperty, cursor: s.cursor };
        }));
      assert("the page has inert text to check", inert.length > 0, `${inert.length}`);
      assert("no inert element is given a press transition",
        inert.every((e) => !/transform/.test(e.transition)),
        JSON.stringify(inert));
      assert("  and none is given a pointer cursor",
        inert.every((e) => e.cursor !== "pointer"),
        JSON.stringify(inert));
    }

    // ==================================================================
    console.log("\n4. Touch delay is removed rather than compensated for\n");
    // ==================================================================
    {
      const touch = await page.$eval('button[type="submit"]', (el) => getComputedStyle(el).touchAction);
      assert("the control opts out of the legacy double-tap wait",
        /manipulation/.test(touch), touch);
    }
  } finally {
    await browser?.close();
    await server.close();
  }

  console.log(`\n${failures} failed, ${passes} passed`);
  if (failures > 0) {
    console.log("\nFAILED:");
    for (const line of failed) console.log(`  ${line}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
