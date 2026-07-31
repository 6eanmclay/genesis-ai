import type { IntegrationProvider } from "@prisma/client";
import type { IntegrationConnector } from "./types";
import { googleCalendarConnector } from "./googleCalendar";
import { quickbooksConnector } from "./quickbooks";
import { mailchimpConnector } from "./mailchimp";

// Phase 3 Milestone 2 — the categorized registry driving /dashboard/
// connections. Covers all 7 of Sean's categories immediately, even though
// only 3 providers are real yet ("coming soon" entries have
// connector: null and no reserved IntegrationProvider enum value — nothing
// is added ahead of a real implementation existing). "developer_api" is
// deliberately left with zero entries — its actual shape (a merchant-
// configurable webhook/API-key connector vs. outbound programmatic access
// to Genesis itself) is still genuinely undecided; guessing would be
// wasted work.
export type ConnectionCategory =
  | "business_systems"
  | "finance_accounting"
  | "marketing"
  | "customers_crm"
  | "communication"
  | "social_media"
  | "developer_api";

export const CONNECTION_CATEGORY_LABELS: Record<ConnectionCategory, string> = {
  business_systems: "Business Systems",
  finance_accounting: "Finance & Accounting",
  marketing: "Marketing",
  customers_crm: "Customers / CRM",
  communication: "Communication",
  social_media: "Social Media",
  developer_api: "Developer / Custom APIs",
};

// Category ordering for the page — matches Sean's own listed order.
export const CONNECTION_CATEGORY_ORDER: ConnectionCategory[] = [
  "business_systems",
  "finance_accounting",
  "marketing",
  "customers_crm",
  "communication",
  "social_media",
  "developer_api",
];

export interface CatalogEntry {
  id: string;
  provider: IntegrationProvider | null;
  name: string;
  category: ConnectionCategory;
  description: string;
  authMethod: "oauth" | "api_key";
  sensitivity: "standard" | "sensitive";
  recommendedFor: string[]; // lib/businessTaxonomy.ts subcategory slugs
  connector: IntegrationConnector | null; // null = "coming soon"
}

export const CONNECTOR_CATALOG: CatalogEntry[] = [
  {
    id: "google-calendar",
    provider: "GOOGLE_CALENDAR",
    name: "Google Calendar",
    category: "business_systems",
    description: "See your upcoming appointments and let Genesis answer questions about your schedule.",
    authMethod: "oauth",
    sensitivity: "standard",
    recommendedFor: [
      "salon_spa",
      "fitness_gym",
      "health_practitioner",
      "barbershop",
      "contractor_construction",
      "cleaning_services",
      "landscaping",
      "hvac_plumbing_electrical",
      "handyman",
      "consulting",
      "legal",
      "real_estate",
      "event_planning",
      "photography_videography",
      "tutoring",
      "coaching_training",
    ],
    connector: googleCalendarConnector,
  },
  {
    id: "quickbooks",
    provider: "QUICKBOOKS",
    name: "QuickBooks Online",
    category: "finance_accounting",
    description: "Bring your invoices and payments into Genesis so it can explain your numbers in plain English.",
    authMethod: "oauth",
    sensitivity: "sensitive",
    recommendedFor: [
      "restaurant",
      "cafe_coffee_shop",
      "bar_lounge",
      "catering",
      "bakery",
      "general_retail",
      "boutique_apparel",
      "online_dtc_brand",
      "contractor_construction",
      "consulting",
      "accounting_bookkeeping",
      "real_estate",
      "hotel_lodging",
    ],
    connector: quickbooksConnector,
  },
  {
    id: "mailchimp",
    provider: "MAILCHIMP",
    name: "Mailchimp",
    category: "marketing",
    description: "Let Genesis summarize your campaign performance and surface what's working.",
    authMethod: "api_key",
    sensitivity: "standard",
    recommendedFor: [
      "general_retail",
      "boutique_apparel",
      "online_dtc_brand",
      "specialty_goods",
      "restaurant",
      "bakery",
      "salon_spa",
      "fitness_gym",
      "event_venue",
      "marketing_agency",
    ],
    connector: mailchimpConnector,
  },

  // Coming soon — seeds every category so the page shows the full vision
  // immediately, per Sean's own "don't build dozens immediately... but the
  // page can still show where this is going." No enum value, no connector.
  {
    id: "toast-pos",
    provider: null,
    name: "Toast POS",
    category: "business_systems",
    description: "Restaurant point-of-sale, order, and menu management.",
    authMethod: "oauth",
    sensitivity: "sensitive",
    recommendedFor: ["restaurant", "cafe_coffee_shop", "bar_lounge", "food_truck", "bakery"],
    connector: null,
  },
  {
    id: "square-pos",
    provider: null,
    name: "Square POS",
    category: "business_systems",
    description: "Point-of-sale and in-person payments for retail and services.",
    authMethod: "oauth",
    sensitivity: "sensitive",
    recommendedFor: ["general_retail", "boutique_apparel", "salon_spa", "barbershop"],
    connector: null,
  },
  {
    id: "calendly",
    provider: null,
    name: "Calendly",
    category: "business_systems",
    description: "Booking and scheduling for appointment-based businesses.",
    authMethod: "oauth",
    sensitivity: "standard",
    recommendedFor: ["consulting", "coaching_training", "health_practitioner", "photography_videography"],
    connector: null,
  },
  {
    id: "xero",
    provider: null,
    name: "Xero",
    category: "finance_accounting",
    description: "Accounting and bookkeeping, as an alternative to QuickBooks.",
    authMethod: "oauth",
    sensitivity: "sensitive",
    recommendedFor: ["accounting_bookkeeping", "consulting", "real_estate"],
    connector: null,
  },
  {
    id: "hubspot",
    provider: null,
    name: "HubSpot",
    category: "customers_crm",
    description: "Customer relationship management and sales pipeline.",
    authMethod: "oauth",
    sensitivity: "standard",
    recommendedFor: ["marketing_agency", "consulting", "real_estate", "financial_services"],
    connector: null,
  },
  {
    id: "twilio",
    provider: null,
    name: "Twilio",
    category: "communication",
    description: "SMS and voice notifications to customers.",
    authMethod: "api_key",
    sensitivity: "standard",
    recommendedFor: ["restaurant", "salon_spa", "contractor_construction", "event_venue"],
    connector: null,
  },
  {
    id: "instagram",
    provider: null,
    name: "Instagram",
    category: "social_media",
    description: "Business profile insights and post performance.",
    authMethod: "oauth",
    sensitivity: "standard",
    recommendedFor: ["boutique_apparel", "online_dtc_brand", "restaurant", "artist_maker"],
    connector: null,
  },
];
