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
  // What the owner is actually agreeing to: a number that will be sent to a
  // customer, and who is carrying the parcel.
  trackingNumber: "Tracking Number",
  fulfillmentStatus: "Fulfilment",
  carrier: "Carrier",
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
  // ---- promotions (added 2026-09-02) ------------------------------
  //
  // create_promotion and update_promotion have been registered and
  // executable since the promotions milestone, and not one of their fields
  // had a label — so an approval card offered the owner
  // "discountType" and "amountOffInCents" as headings. Found by
  // verify-field-labels.ts the day it first had a runner, alongside the
  // same actions' missing nav section and missing workspace.
  //
  // amountOffInCents keeps the *InCents suffix deliberately: formatDiffValue
  // renders any such field as real currency, so the raw integer never
  // reaches the card.
  code: "Discount Code",
  discountType: "Discount Type",
  percentOff: "Percent Off",
  amountOffInCents: "Amount Off",
  scope: "Applies To",
  active: "Active",
  startsAt: "Starts",
  endsAt: "Ends",
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
  // Added 2026-08-22, found by scripts/verify-field-labels.ts rather than by
  // seeing a card. ActionDiff renders `FIELD_LABELS[key] ?? key`, so each of
  // these was showing an owner the machine's own camelCase name for something
  // they were being asked to approve. Every one is a rename of the existing
  // field, never a new concept — identifiers went to HIDDEN_DIFF_KEYS instead,
  // because a cuid is not a decision.
  colors: "Colours",
  typography: "Typography",
  layout: "Layout",
  presentation: "Presentation",
  composition: "Composition",
  target: "What this changes",
  changes: "Changes",
  reason: "Why",
  summary: "Summary",
  customSection: "Custom Section",
  sectionOrder: "Section Order",
  status: "Status",
  // Both update_brand_logo and update_product_image carry one, and they mean
  // the same thing in each: what J4 asked the image model for.
  generationPrompt: "Image Prompt",
  answer: "Answer",
};

// MOVED HERE FROM ActionDiff.tsx (2026-09-02) so the approval-drift check can
// describe a changed value in the same words the approval card already uses.
// ActionDiff.tsx is "use client"; this module is deliberately dependency-free
// and is already the shared home for exactly this kind of presentation rule.
// One formatter, so a refusal and the card it refers to cannot word the same
// value differently.
export function formatDiffValue(key: string, value: unknown): string {
  if (key.endsWith("InCents") && typeof value === "number") {
    return `$${(value / 100).toFixed(2)}`;
  }
  if (Array.isArray(value)) {
    return value.length > 0 ? value.join(", ") : "(empty)";
  }
  // An empty STRING is an absent value too, exactly as the empty array above
  // already is. Without this a refusal reads: Name was "" and is now "Meridian"
  // — and the approval card renders a blank struck-through line. Found by
  // verify-approval-drift-db.ts asserting the sentence an owner actually reads.
  if (value === "") return "(empty)";
  return String(value ?? "(empty)");
}

// MOVED HERE FROM ActionDiff.tsx (2026-09-02), same reason as
// formatDiffValue above: the approval-drift check has to skip exactly the
// keys the approval card hides, and a second copy of this list is the
// mirrored-registry problem — the copy that drifted would be the one
// nobody read. ActionDiff.tsx re-exports it, so every existing caller and
// scripts/verify-field-labels.ts are untouched.
export const HIDDEN_DIFF_KEYS = new Set([
  "productId",
  // Promotions, 2026-09-02. Same category and the same reason as
  // productId above: which promotion to act on, and which products it
  // covers, are identifiers rather than the change being approved.
  //
  // productIds is hidden RATHER THAN LABELLED because labelling it would
  // put a list of cuids on an approval card under a friendly heading,
  // which is worse than the raw key it replaced — an internal identifier
  // must never become human-facing. Resolving those ids to product NAMES
  // on the card is a real improvement and a design decision, not a label
  // fix; recorded rather than smuggled in here.
  "promotionId",
  // Tracking, 2026-09-03. Which ORDER is being marked shipped is an
  // identifier, not the change being approved — and the card already names
  // the order in its summary, in the owner's own terms. Hidden rather than
  // labelled for the same reason as promotionId: "Order: cmtlu4db2..." under
  // a friendly heading is worse than the raw key it would replace.
  "orderId",
  "productIds",
  "designId",
  "goalRecordId",
  "challengeRecordId",
  "recordId",
  "entityType",
  "topicKey",
  "aiUsageEventId",
  "sourceKey",
  "externalProductId",
  "externalVariantId",
]);
