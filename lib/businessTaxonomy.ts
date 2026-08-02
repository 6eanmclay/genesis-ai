// Phase 3 Milestone 2 — a code-level taxonomy, never a Prisma enum: adding a
// new category or subcategory should never require a schema migration,
// matching ApprovalRequest.status's own "avoid enum-migration friction"
// convention. Drives Recommended Connections now; industry-aware guidance
// and future business-specific recommendations later — a broad,
// general-purpose small-business taxonomy, not narrowed to any one cohort.

export interface BusinessSubcategory {
  slug: string;
  label: string;
}

export interface BusinessCategoryGroup {
  category: string;
  subcategories: BusinessSubcategory[];
}

export const BUSINESS_CATEGORIES: BusinessCategoryGroup[] = [
  {
    category: "Food & Beverage",
    subcategories: [
      { slug: "restaurant", label: "Restaurant" },
      { slug: "cafe_coffee_shop", label: "Cafe / Coffee Shop" },
      { slug: "bar_lounge", label: "Bar / Lounge" },
      { slug: "food_truck", label: "Food Truck" },
      { slug: "catering", label: "Catering" },
      { slug: "bakery", label: "Bakery" },
      { slug: "brewery_winery", label: "Brewery / Winery" },
    ],
  },
  {
    category: "Retail & E-commerce",
    subcategories: [
      { slug: "general_retail", label: "General Retail" },
      { slug: "boutique_apparel", label: "Boutique / Apparel" },
      { slug: "specialty_goods", label: "Specialty Goods" },
      { slug: "online_dtc_brand", label: "Online-Only DTC Brand" },
      { slug: "grocery_market", label: "Grocery / Market" },
    ],
  },
  {
    category: "Personal Care & Wellness",
    subcategories: [
      { slug: "salon_spa", label: "Salon / Spa" },
      { slug: "fitness_gym", label: "Fitness / Gym" },
      { slug: "health_practitioner", label: "Health Practitioner" },
      { slug: "barbershop", label: "Barbershop" },
    ],
  },
  {
    category: "Home & Trade Services",
    subcategories: [
      { slug: "contractor_construction", label: "Contractor / Construction" },
      { slug: "cleaning_services", label: "Cleaning Services" },
      { slug: "landscaping", label: "Landscaping" },
      { slug: "hvac_plumbing_electrical", label: "HVAC / Plumbing / Electrical" },
      { slug: "handyman", label: "Handyman" },
    ],
  },
  {
    category: "Professional Services",
    subcategories: [
      { slug: "consulting", label: "Consulting" },
      { slug: "legal", label: "Legal" },
      { slug: "accounting_bookkeeping", label: "Accounting / Bookkeeping" },
      { slug: "real_estate", label: "Real Estate" },
      { slug: "marketing_agency", label: "Marketing Agency" },
      { slug: "financial_services", label: "Financial Services" },
    ],
  },
  {
    category: "Hospitality & Events",
    subcategories: [
      { slug: "hotel_lodging", label: "Hotel / Lodging" },
      { slug: "event_venue", label: "Event Venue" },
      { slug: "event_planning", label: "Event Planning" },
      { slug: "tour_operator", label: "Tour Operator" },
    ],
  },
  {
    category: "Creative & Media",
    subcategories: [
      { slug: "photography_videography", label: "Photography / Videography" },
      { slug: "design_studio", label: "Design Studio" },
      { slug: "artist_maker", label: "Artist / Maker" },
      { slug: "music_entertainment", label: "Music / Entertainment" },
    ],
  },
  {
    category: "Automotive",
    subcategories: [
      { slug: "auto_repair", label: "Auto Repair" },
      { slug: "auto_sales", label: "Auto Sales" },
      { slug: "auto_detailing", label: "Auto Detailing" },
    ],
  },
  {
    category: "Education & Childcare",
    subcategories: [
      { slug: "tutoring", label: "Tutoring" },
      { slug: "daycare_childcare", label: "Daycare / Childcare" },
      { slug: "coaching_training", label: "Coaching / Training" },
    ],
  },
  {
    category: "Other",
    subcategories: [{ slug: "other", label: "Other" }],
  },
];

export const BUSINESS_SUBCATEGORY_SLUGS: string[] = BUSINESS_CATEGORIES.flatMap(
  (group) => group.subcategories.map((s) => s.slug)
);

const SLUG_SET = new Set(BUSINESS_SUBCATEGORY_SLUGS);

// Silently drops anything not in the real taxonomy rather than failing —
// a misclassification is low-stakes content, never worth failing an
// entire generation over. See ai-actions.ts's CoreFieldsSchema.
export function filterKnownBusinessCategories(candidates: string[]): string[] {
  return candidates.filter((slug) => SLUG_SET.has(slug));
}

const LABEL_BY_SLUG = new Map(
  BUSINESS_CATEGORIES.flatMap((group) =>
    group.subcategories.map((s) => [s.slug, s.label] as const)
  )
);

export function businessCategoryLabel(slug: string): string {
  return LABEL_BY_SLUG.get(slug) ?? slug;
}

// Phase 3 Milestone 5 — a second, small, open classification taxonomy:
// *how* a business makes money, distinct from *what industry* it's in
// (above). Colocated here rather than a new file since it's the same
// pattern — small, open, purely-additive, used for AI classification +
// validation at store-generation time (see ai-actions.ts's CoreFieldsSchema)
// — not because it's conceptually the same axis.

export interface RevenueStreamType {
  slug: string;
  label: string;
}

export const REVENUE_STREAM_TYPES: RevenueStreamType[] = [
  { slug: "product_sales", label: "Product Sales" },
  // Onboarding v2 — split out from product_sales: a physical product has a
  // real fulfillment/shipping cost and routes through lib/fulfillment/; a
  // digital product doesn't and needs a different (not yet built) delivery
  // path. Conflating the two under one slug would have made the
  // ecommerce-path gate in ONBOARDING_V2_DESIGN.md section 4 ambiguous
  // about which businesses actually need a fulfillment strategy.
  { slug: "digital_products", label: "Digital Products" },
  { slug: "service_fees", label: "Service Fees" },
  { slug: "subscriptions", label: "Subscriptions" },
  { slug: "bookings_appointments", label: "Bookings / Appointments" },
  { slug: "commissions", label: "Commissions" },
  { slug: "rentals", label: "Rentals" },
  { slug: "licensing", label: "Licensing" },
  { slug: "advertising", label: "Advertising" },
  { slug: "donations", label: "Donations" },
  { slug: "other", label: "Other" },
];

export const REVENUE_STREAM_SLUGS: string[] = REVENUE_STREAM_TYPES.map(
  (t) => t.slug
);

const REVENUE_STREAM_SLUG_SET = new Set(REVENUE_STREAM_SLUGS);

export function filterKnownRevenueStreams(candidates: string[]): string[] {
  return candidates.filter((slug) => REVENUE_STREAM_SLUG_SET.has(slug));
}

const REVENUE_STREAM_LABEL_BY_SLUG = new Map(
  REVENUE_STREAM_TYPES.map((t) => [t.slug, t.label] as const)
);

export function revenueStreamLabel(slug: string): string {
  return REVENUE_STREAM_LABEL_BY_SLUG.get(slug) ?? slug;
}

// Onboarding v2 — a third, independent classification axis: not *what* the
// business sells (BUSINESS_CATEGORY_GROUPS above) or *how* it makes money
// (REVENUE_STREAM_TYPES above), but *what kind of brand* it is. Same shape
// as both — small, open, purely additive, `other` as an honest fallback —
// deliberately not folded into either existing taxonomy, since a business's
// category and revenue stream don't determine its brand positioning (two
// product_sales apparel businesses can be luxury or budget). Real gap this
// closes: blueprint.brandIdentity.brandPersonality (see
// lib/execution/genesisActions.ts) is free-text AI prose, generated after
// the fact — never a closed slug an owner explicitly picks or downstream
// code (lib/fulfillment/strategy.ts's selectFulfillmentStrategy,
// lib/onboarding/pricing.ts's recommendPrice) can branch on. See
// ONBOARDING_V2_DESIGN.md section 5.

export interface BrandPositioningType {
  slug: string;
  label: string;
}

export const BRAND_POSITIONING_TYPES: BrandPositioningType[] = [
  { slug: "luxury", label: "Luxury" },
  { slug: "streetwear", label: "Streetwear" },
  { slug: "minimalist", label: "Minimalist" },
  { slug: "budget", label: "Budget" },
  { slug: "family", label: "Family" },
  { slug: "professional", label: "Professional" },
  { slug: "other", label: "Other" },
];

export const BRAND_POSITIONING_SLUGS: string[] = BRAND_POSITIONING_TYPES.map(
  (t) => t.slug
);

const BRAND_POSITIONING_SLUG_SET = new Set(BRAND_POSITIONING_SLUGS);

export function isKnownBrandPositioning(slug: string): boolean {
  return BRAND_POSITIONING_SLUG_SET.has(slug);
}

const BRAND_POSITIONING_LABEL_BY_SLUG = new Map(
  BRAND_POSITIONING_TYPES.map((t) => [t.slug, t.label] as const)
);

export function brandPositioningLabel(slug: string): string {
  return BRAND_POSITIONING_LABEL_BY_SLUG.get(slug) ?? slug;
}
