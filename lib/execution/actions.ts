// Canonical action ids — call sites always use EXECUTION_ACTIONS.X, never a
// raw string literal, same pattern as PERMISSIONS in lib/permissions.ts.
// Deliberately a growing plain-string catalog, not a Prisma enum — see
// ARCHITECTURE.md for why.
export const EXECUTION_ACTIONS = {
  STORE_PUBLISH: "store.publish",
  STORE_EDIT: "store.edit",
  PRODUCT_CREATE: "product.create",
  PRODUCT_EDIT: "product.edit",
  PRODUCT_DELETE: "product.delete",
  PRODUCT_TOGGLE_ACTIVE: "product.toggle_active",
  PRODUCT_UPDATE_IMAGE: "product.update_image",
  INTEGRATION_STRIPE_CONNECT: "integration.stripe.connect",
  INTEGRATION_STRIPE_VERIFY: "integration.stripe.verify",
  INTEGRATION_PAYPAL_CONNECT: "integration.paypal.connect",
  INTEGRATION_PAYPAL_VERIFY: "integration.paypal.verify",
  CHECKOUT_PAYPAL_CAPTURE: "checkout.paypal.capture",
  // Phase 3 Milestone 2 — the 3 proof integrations (Connector Framework).
  INTEGRATION_GOOGLE_CALENDAR_CONNECT: "integration.google_calendar.connect",
  INTEGRATION_GOOGLE_CALENDAR_VERIFY: "integration.google_calendar.verify",
  INTEGRATION_GOOGLE_CALENDAR_SYNC: "integration.google_calendar.sync",
  INTEGRATION_QUICKBOOKS_CONNECT: "integration.quickbooks.connect",
  INTEGRATION_QUICKBOOKS_VERIFY: "integration.quickbooks.verify",
  INTEGRATION_QUICKBOOKS_SYNC: "integration.quickbooks.sync",
  INTEGRATION_MAILCHIMP_CONNECT: "integration.mailchimp.connect",
  INTEGRATION_MAILCHIMP_VERIFY: "integration.mailchimp.verify",
  INTEGRATION_MAILCHIMP_SYNC: "integration.mailchimp.sync",
  GENESIS_DRAFT_MESSAGE: "genesis.draft.message",
  GENESIS_STORE_MESSAGE: "genesis.store.message",
  GENESIS_RECOMMENDATIONS_GENERATE: "genesis.recommendations.generate",
  STORE_UPDATE_SEO: "store.update_seo",
  STORE_UPDATE_HERO: "store.update_hero",
  STORE_UPDATE_THEME: "store.update_theme",
  STORE_UPDATE_BRAND_IDENTITY: "store.update_brand_identity",
  STORE_UPDATE_STORE_IDENTITY: "store.update_store_identity",
  STORE_UPDATE_HOMEPAGE_CONTENT: "store.update_homepage_content",
  STORE_UPDATE_SECTION_ORDER: "store.update_section_order",
  STORE_UPDATE_STORE_CONTENT: "store.update_store_content",
  STORE_UPDATE_DESIGN_DIRECTION: "store.update_design_direction",
  STORE_UPDATE_MARKETING_ASSETS: "store.update_marketing_assets",
} as const;

export type ExecutionAction = (typeof EXECUTION_ACTIONS)[keyof typeof EXECUTION_ACTIONS];
