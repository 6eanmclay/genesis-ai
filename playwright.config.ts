import { defineConfig, devices } from "@playwright/test";

// Real end-to-end regression tests against a running Genesis instance —
// deliberately NOT pointed at production by default. Signup-flow tests
// create real User/StoreDraft rows; running them repeatedly against
// production would leave real orphaned test accounts behind on every run.
// Default target is local dev (`npm run dev`); override PLAYWRIGHT_BASE_URL
// to point at a real deployment for a one-off manual check, the same way
// this project's manual verification passes have all session.
const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  use: {
    baseURL,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "mobile-safari", use: { ...devices["iPhone 13"] } },
  ],
});
