import { test, expect } from "@playwright/test";

// Regression coverage for the primary entry path — updated for
// Experience-First Onboarding (EXPERIENCE_FIRST_ONBOARDING.md, Milestone
// 2): a fresh, logged-out visitor to "/" now enters the real experience
// flow directly, with no signup wall in front of it. This test covers the
// identity of the entry point itself, so a stale deployment or an
// accidental revert to the old signup-first landing page is caught
// automatically. The full generation round trip (both the "ask" and
// "generate" branches of decideExperienceNextStep, real AI calls) is
// inherently non-deterministic and costs a real provider call per run —
// covered end-to-end in Milestone 6, not here.
//
// Superseded coverage: this test previously verified the OLD marketing
// landing page's "Get started" -> /signup -> /onboarding path, written
// after investigating a false-alarm regression report (2026-08-03) that
// traced to a real account never actually being created, not a code or
// deployment issue. That path itself still exists (returning users can
// still log in, and account creation still happens — just later, at
// claim), but it is no longer the first thing a new visitor sees.
test("a fresh visitor lands directly in the real experience flow, no signup wall", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByText("What's the business you've been meaning to start?")).toBeVisible();
  await expect(page.getByPlaceholder(/candle shop/i)).toBeVisible();

  // Returning users can still simply log in — the one other real
  // affordance on this screen, per EXPERIENCE_FIRST_ONBOARDING.md's
  // platform principle ("returning users sign in").
  await expect(page.getByRole("link", { name: "Log in" })).toBeVisible();
});
