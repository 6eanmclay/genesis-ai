import { test, expect } from "@playwright/test";

// Regression coverage for the Experience-First Onboarding flow
// (EXPERIENCE_FIRST_ONBOARDING.md, Milestone 6) — the anonymous entry
// point's own conversational mechanics, on top of onboarding-entry.spec.ts's
// coverage of the entry screen's identity.
//
// Deliberately scoped to what's real, deterministic, and doesn't depend on
// external services this suite can't drive: real Anthropic text calls
// (bounded, one call per test) are exercised; real OpenAI image generation
// and real Printful/Stripe OAuth are NOT — the same reasoning
// onboarding-entry.spec.ts's own comment already gives for stopping before
// the account-creation flow reaches Printful. The confident-generation
// branch (real images, real pricing), the claim -> activation handoff, and
// the anonymous rate limit actually triggering were all verified manually
// against a real local server with real evidence (screenshots + direct
// database inspection) during this milestone's own build — see the review
// artifacts from that pass. They aren't automated here because doing so
// safely would need either a mocked image provider or a dedicated test
// OpenAI project, neither of which exists yet; a real, separately-scoped
// follow-up, not silently skipped.
test("a vague idea gets exactly one clarifying question, which survives a reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("What's the business you've been meaning to start?")).toBeVisible();

  // Deliberately as open-ended as the real prompt describes triggering a
  // clarifying question for (lib/onboarding's decideExperienceNextStep):
  // no audience, style, or product hinted at all.
  //
  // pressSequentially, not fill — a real, reproducible mobile-safari-only
  // flake found via this test: fill() sets the DOM value directly and the
  // controlled input's React onChange sometimes doesn't pick it up in time
  // under WebKit (confirmed: the input showed the typed text while the
  // Send button stayed disabled, meaning React's own `input` state never
  // updated), so the button stayed permanently disabled. Typing character
  // by character fires real keyboard events, which React's onChange
  // reliably observes on every engine.
  const ideaInput = page.getByPlaceholder(/candle shop/i);
  await ideaInput.click();
  await ideaInput.pressSequentially("I want to start a business", { delay: 10 });
  const sendButton = page.getByRole("button", { name: "Send" });
  await expect(sendButton).toBeEnabled();
  await sendButton.click();

  const answerInput = page.getByPlaceholder(/type your answer/i);
  await expect(answerInput).toBeVisible({ timeout: 30000 });
  const questionLocator = page.locator("p.genesis-onboarding-rise").first();
  const question = await questionLocator.textContent();
  expect(question?.length ?? 0).toBeGreaterThan(0);

  // The real regression this test exists to catch: a reload mid-conversation
  // must resume the exact same question via the real anonymous session
  // cookie (lib/onboarding/anonymousSession.ts), not silently restart the
  // whole experience from the beginning.
  await page.reload();
  await expect(answerInput).toBeVisible({ timeout: 15000 });
  await expect(questionLocator).toHaveText(question ?? "");
});
