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

    // ==================================================================
    console.log("\n5. A card that is a radio is a control, and a caption is not\n");
    // ==================================================================
    //
    // ============ THE GAP THE AUDIT FOUND (2026-09-17) ================
    //
    // Sean asked for the sweep as well as the rule: "looks interactive →
    // actually interactive → produces visible feedback", and the inverse.
    // Running it turned up one class the first version of the contract missed.
    //
    // A label that wraps its own radio or checkbox is a control: the card is
    // the tap target and the input inside it is usually sr-only. Four exist,
    // including how a customer chooses to PAY — and every one already carried
    // cursor-pointer, so each announced itself as pressable and none of them
    // acknowledged a press.
    //
    // Measured on real elements in the real cascade rather than by reading the
    // stylesheet back, for the same reason sections 2-4 are: a rule can be
    // present and apply to nothing, which is exactly what :where() did to the
    // first draft of this contract.
    {
      // NO INNER FUNCTION IN HERE. tsx compiles this file with esbuild's
      // keepNames, which rewrites a named inner function into a call to a
      // `__name` helper — a helper that exists in Node and not in the page, so
      // the browser answered "__name is not defined" and nothing was measured.
      await page.evaluate(() => {
        const style = "position:fixed;left:8px;width:120px;height:44px;z-index:99999";
        // The card shape: a label that CONTAINS its control.
        const card = document.createElement("label");
        card.id = "probe-radio";
        card.setAttribute("style", `${style};top:8px`);
        card.innerHTML = '<input type="radio" name="probe"> Card';
        document.body.appendChild(card);
        // And the shape that must NOT be treated as one: a caption for a field
        // that sits elsewhere. Clickable in the strict sense, not a control.
        const caption = document.createElement("label");
        caption.id = "probe-caption";
        caption.setAttribute("style", `${style};top:60px`);
        caption.textContent = "Your email";
        document.body.appendChild(caption);
      });

      const cardRest = await styleOf(page, "#probe-radio");
      assert("a label wrapping a radio opts out of the double-tap wait",
        /manipulation/.test(cardRest.touchAction), cardRest.touchAction);

      const cardPressed = await whilePressed(page, "#probe-radio", () => styleOf(page, "#probe-radio"));
      assert("  and it visibly acknowledges the press",
        cardPressed.transform !== cardRest.transform || cardPressed.opacity !== cardRest.opacity,
        `rest ${cardRest.transform}/${cardRest.opacity} vs pressed ${cardPressed.transform}/${cardPressed.opacity}`);
      assert("  by scaling down, like every other control",
        cardPressed.transform.startsWith("matrix(0.97"), cardPressed.transform);

      // THE INVERSE, AND THE REASON THE SELECTOR IS NOT JUST `label`.
      const capRest = await styleOf(page, "#probe-caption");
      const capPressed = await whilePressed(page, "#probe-caption", () => styleOf(page, "#probe-caption"));
      assert("a caption label is left alone",
        capPressed.transform === capRest.transform && capPressed.opacity === capRest.opacity,
        `rest ${capRest.transform}/${capRest.opacity} vs pressed ${capPressed.transform}/${capPressed.opacity}`);

      await page.evaluate(() => {
        document.getElementById("probe-radio")?.remove();
        document.getElementById("probe-caption")?.remove();
      });

      // AND THE SHAPE IS REALLY IN THE PRODUCT, so this rule is not governing
      // a shape nobody uses. Counted, not listed: a list of the four files
      // here would be the hand-maintained copy this repository keeps being bitten
      // by, and it would go stale the first time one of them was renamed.
      const tsx = await import("fs").then((fs) =>
        import("path").then(({ join }) => ({ fs, join })));
      const roots = ["app", "components"];
      let cards = 0;
      const walk = (dir: string): void => {
        for (const e of tsx.fs.readdirSync(dir, { withFileTypes: true })) {
          const p = tsx.join(dir, e.name);
          if (e.isDirectory()) walk(p);
          else if (e.name.endsWith(".tsx")) {
            const src = tsx.fs.readFileSync(p, "utf8");
            // A <label …> whose element contains an <input type="radio"|"checkbox">
            // before the matching </label>.
            for (const m of src.matchAll(/<label\b[\s\S]*?<\/label>/g)) {
              if (/<input[^>]*type=["'](radio|checkbox)["']/.test(m[0])) cards++;
            }
          }
        }
      };
      for (const r of roots) walk(tsx.join(process.cwd(), r));
      assert("the product really does build controls this way",
        cards > 0, `${cards} label-wrapped radio/checkbox controls found`);
      console.log(`      (${cards} found)`);
    }

    // ==================================================================
    console.log("\n6. No control quietly opts out with an inline style\n");
    // ==================================================================
    //
    // ============ THE ONE CONTROL THAT COULD NOT ANSWER ==============
    //
    // The contract acknowledges a press with `transform` and `opacity`, from
    // the stylesheet. An INLINE style beats any stylesheet rule, so a control
    // that sets either of those on itself has silently opted out of being
    // acknowledged — and nothing anywhere said so.
    //
    // One had: the Creation Station's carousel, which is how an owner chooses
    // what to make. It set both, for depth, and so was the single control in
    // Genesis that could not respond to being pressed. Its placement now lives
    // on a wrapper and the button carries none of it.
    //
    // Checked at the source, because this is a fact about how the element is
    // WRITTEN. A rendered check would have to find every such control on every
    // screen first, and the ones worth catching are the ones nobody thought to
    // look at.
    //
    // COMMENTS ARE STRIPPED FIRST. This repository has paid four times for a
    // source check that matched its own prose — including once in the grep that
    // started this very audit, where `role="[a-z]*"` matched the tail of
    // `data-role="content"` and reported six ARIA roles that do not exist.
    {
      const { readdirSync, readFileSync } = await import("fs");
      const { join } = await import("path");

      const offenders: string[] = [];
      const scan = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { scan(p); continue; }
          if (!e.name.endsWith(".tsx")) continue;
          const code = readFileSync(p, "utf8")
            .replace(/\/\*[\s\S]*?\*\//g, " ")
            .replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");
          // Each opening tag of an element that is interactive by its own
          // semantics, up to the `>` that closes it.
          for (const m of code.matchAll(/<(?:button|a)\b[^>]*>/g)) {
            const tag = m[0];
            if (tag.startsWith("<a") && !/href=/.test(tag)) continue; // not a link
            if (!/style=\{\{/.test(tag)) continue;
            if (/\btransform\s*:/.test(tag) || /\bopacity\s*:/.test(tag)) {
              offenders.push(`${p.replace(process.cwd(), "").replace(/\\/g, "/")} — ${tag.slice(0, 70)}`);
            }
          }
        }
      };
      for (const root of ["app", "components"]) scan(join(process.cwd(), root));

      assert("no button or link sets transform or opacity inline",
        offenders.length === 0,
        offenders.slice(0, 4).join("  |  "));
      // AND THE SCAN CAN ACTUALLY SEE TAGS, so a regex that silently matched
      // nothing could not report a clean sweep.
      let tagsSeen = 0;
      const count = (dir: string): void => {
        for (const e of readdirSync(dir, { withFileTypes: true })) {
          const p = join(dir, e.name);
          if (e.isDirectory()) { count(p); continue; }
          if (!e.name.endsWith(".tsx")) continue;
          tagsSeen += [...readFileSync(p, "utf8").matchAll(/<(?:button|a)\b[^>]*>/g)].length;
        }
      };
      for (const root of ["app", "components"]) count(join(process.cwd(), root));
      assert("  and the sweep really read the product",
        tagsSeen > 100, `${tagsSeen} button/link tags scanned`);
      console.log(`      (${tagsSeen} button/link tags scanned)`);
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
