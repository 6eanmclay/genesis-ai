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
  // Product media gallery (2026-08-08) — up to 10 ordered images per
  // product, see lib/execution/executables/productImages.ts.
  PRODUCT_ADD_IMAGES: "product.add_images",
  PRODUCT_REORDER_IMAGES: "product.reorder_images",
  PRODUCT_DELETE_IMAGE: "product.delete_image",
  PRODUCT_REPLACE_IMAGE: "product.replace_image",
  // Promotions and discount codes (2026-08-26). Under PRODUCTS_MANAGE, because
  // a promotion is a pricing decision about products.
  PROMOTION_CREATE: "promotion.create",
  PROMOTION_UPDATE: "promotion.update",
  PROMOTION_DELETE: "promotion.delete",
  ORDER_TOGGLE_FULFILLED: "order.toggle_fulfilled",
  ORDER_PURCHASE_SHIPPING_LABEL: "order.purchase_shipping_label",
  ORDER_ATTACH_TRACKING: "order.attach_tracking",
  // Correcting a number already recorded. Its own verb because replacing is
  // a different act from adding — see correctTracking.ts.
  ORDER_CORRECT_TRACKING: "order.correct_tracking",
  INTEGRATION_STRIPE_CONNECT: "integration.stripe.connect",
  INTEGRATION_STRIPE_VERIFY: "integration.stripe.verify",
  INTEGRATION_PAYPAL_CONNECT: "integration.paypal.connect",
  INTEGRATION_PAYPAL_VERIFY: "integration.paypal.verify",
  CHECKOUT_PAYPAL_CAPTURE: "checkout.paypal.capture",
  // A VERIFIED PayPal refund that could not be applied to any order
  // (2026-08-20). Same reasoning as CHECKOUT_STRIPE_UNRECORDED below: money has
  // genuinely moved and Genesis has nothing to show for it, so it must be
  // visible to the owner rather than existing only as a console line — see
  // app/api/webhooks/paypal/[storeId]/route.ts.
  CHECKOUT_PAYPAL_REFUND_UNAPPLIED: "checkout.paypal.refund_unapplied",
  // A completed Stripe checkout that could NOT be turned into an Order.
  // Recorded so real money arriving with nothing to show for it is visible to
  // the owner rather than existing only as a console line — see
  // app/api/webhooks/stripe/route.ts.
  CHECKOUT_STRIPE_UNRECORDED: "checkout.stripe.unrecorded",
  // A completed PLATFORM payment (Growth Points or a plan subscription) that
  // could not be applied to a store. Same reasoning as the storefront one
  // above: the owner paid Genesis and got nothing, and that must be visible.
  BILLING_STRIPE_UNAPPLIED: "billing.stripe.unapplied",
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
  // The brand logo, as a real action rather than a one-off during onboarding
  // (2026-08-16). Distinct from STORE_UPDATE_BRAND_IDENTITY, which is the
  // written identity — this one produces a file, designates it as the
  // brand.logo Asset, and is the first step of Asset -> Design -> Product.
  STORE_UPDATE_BRAND_LOGO: "store.update_brand_logo",
  STORE_UPDATE_STORE_IDENTITY: "store.update_store_identity",
  STORE_UPDATE_HOMEPAGE_CONTENT: "store.update_homepage_content",
  STORE_UPDATE_SECTION_ORDER: "store.update_section_order",
  STORE_UPDATE_STORE_CONTENT: "store.update_store_content",
  STORE_UPDATE_DESIGN_DIRECTION: "store.update_design_direction",
  // Storefront Canvas, step 3 of 6 (2026-08-12) — one small, reasoned
  // improvement to the storefront's structure or presentation, as opposed to
  // update_theme's all-or-nothing rewrite.
  STORE_REFINE_STOREFRONT: "store.refine_storefront",
  STORE_UPDATE_MARKETING_ASSETS: "store.update_marketing_assets",
  // Phase 3 Milestone 6 (J4 Cognitive Layer) — the first two "operations"-
  // category actions, deliberately not "store."-prefixed like everything
  // above (those all write to Store's own columns/blueprint; these write to
  // a specific BusinessRecord row instead).
  GOAL_UPDATE_STATUS: "goal.update_status",
  CHALLENGE_RESOLVE: "challenge.resolve",
  // J4 Foundation Phase 1 (Execute Hardening) — the first "communication"-
  // category action: Reason surfacing a finding to the owner, routed
  // through execute() like every other mechanic instead of a raw write.
  GENESIS_COMMUNICATE_FINDING: "genesis.communicate_finding",
  // Onboarding v2 — registering the confirmed Store's product with the
  // fulfillment connector (see lib/fulfillment/). Failure here is
  // non-fatal to store confirmation (logged FAILED/retryable, not thrown)
  // — see confirmStoreDraftCore's own comment for why.
  ONBOARDING_FULFILLMENT_PRODUCT_REGISTER: "onboarding.fulfillment.product_register",
  // Onboarding v2 — the draft-phase fulfillment OAuth connect (see
  // app/api/onboarding/fulfillment/callback/route.ts). storeDraftId-only,
  // never storeId, unlike every INTEGRATION_*_CONNECT action above.
  ONBOARDING_FULFILLMENT_CONNECT: "onboarding.fulfillment.connect",
} as const;

export type ExecutionAction = (typeof EXECUTION_ACTIONS)[keyof typeof EXECUTION_ACTIONS];
