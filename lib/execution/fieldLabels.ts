// Meeting with J4 M7 — extracted from genesisActions.ts so the generic diff
// renderer (lib/execution/ActionDiff.tsx) can import it without pulling
// genesisActions.ts's own server-only imports (every Executable, Prisma,
// etc.) into a client bundle. ActionDiff.tsx now renders inside
// MeetingScreen.tsx (a "use client" component) as well as the dashboard's
// server-rendered ApprovalRequestsPanel.tsx — this file has zero
// server-only dependencies so it's safe in both.
//
// Display names for the generic Current -> Proposed diff renderer — driven
// by field key, not per-action JSX.
export const FIELD_LABELS: Record<string, string> = {
  seoTitle: "SEO Title",
  seoMetaDescription: "Meta Description",
  heroHeadline: "Hero Headline",
  heroSubheadline: "Hero Subheadline",
  heroImageUrl: "Homepage Hero Image",
  imageUrl: "Product Image",
  brandStory: "Brand Story",
  missionStatement: "Mission Statement",
  visionStatement: "Vision Statement",
  brandPromise: "Brand Promise",
  coreValues: "Core Values",
  brandPersonality: "Brand Personality",
  brandVoiceAndTone: "Brand Voice & Tone",
  targetAudience: "Target Audience",
  uniqueSellingProposition: "Unique Selling Proposition",
  // Shared by update_store_identity (the business's own name) and
  // create_product (a proposed product's name) — kept generic rather than
  // "Business Name" so it reads correctly for both, since FIELD_LABELS is a
  // flat, action-agnostic map by design (see the generic diff renderer).
  name: "Name",
  tagline: "Tagline",
  description: "Description",
  primaryCallToAction: "Primary Call to Action",
  secondaryCallToAction: "Secondary Call to Action",
  aboutUs: "About Us",
  whyChooseUs: "Why Choose Us",
  featuredCollections: "Featured Collections",
  faq: "FAQ",
  newsletterSection: "Newsletter",
  footerContent: "Footer",
  customSectionTitle: "Custom Section Title",
  customSectionBody: "Custom Section Body",
  shippingPolicy: "Shipping Policy",
  returnPolicy: "Return Policy",
  privacyPolicy: "Privacy Policy",
  termsAndConditions: "Terms & Conditions",
  contactPageCopy: "Contact Page",
  visualStyle: "Visual Style",
  brandMood: "Brand Mood",
  photographyStyle: "Photography Style",
  iconStyle: "Icon Style",
  brandKeywords: "Brand Keywords",
  instagramBio: "Instagram Bio",
  facebookDescription: "Facebook Description",
  xBio: "X (Twitter) Bio",
  priceInCents: "Price",
};
