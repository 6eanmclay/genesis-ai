import { test, expect } from "@playwright/test";

// Regression coverage for the primary entry path: a fresh visitor to "/"
// should be able to reach the real guided onboarding experience (the Idea
// act, "What's the business you've been meaning to start?") via Get
// Started -> account creation, with nothing silently reverting them to an
// older flow along the way.
//
// Written after investigating a false-alarm regression report (2026-08-03)
// that traced to a real account never actually being created, not a code
// or deployment issue — see J4_APP_ROADMAP.md-adjacent history in
// CHANGELOG.md for context. This test exists so an ACTUAL future
// regression in this path (a stale deployment, a flipped feature flag, a
// broken redirect) is caught automatically instead of only being found by
// a confused real user.
test("a fresh visitor can create an account and reach the real onboarding entry point", async ({ page }) => {
  await page.goto("/");

  // The landing page itself — deliberately minimal, not a marketing site.
  await expect(page.getByRole("heading", { name: "Your AI business partner" })).toBeVisible();
  const getStarted = page.getByRole("link", { name: "Get started" });
  await expect(getStarted).toBeVisible();

  await getStarted.click();
  await expect(page).toHaveURL(/\/signup$/);

  const email = `e2e-onboarding-entry-${Date.now()}-${test.info().project.name}@example.test`;
  await page.getByPlaceholder("Email").fill(email);
  await page.getByPlaceholder("Password").fill("E2e-test-password-2026!");
  await page.getByRole("button", { name: /sign up/i }).click();

  // Real account created, real session established, landed on the real
  // guided-onboarding entry point — not the classic form, not stuck on
  // signup, not bounced back to the landing page.
  await expect(page).toHaveURL(/\/onboarding$/, { timeout: 15000 });
  await expect(
    page.getByText("What's the business you've been meaning to start?")
  ).toBeVisible();
});
