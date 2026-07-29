import Link from "next/link";
import { redirect } from "next/navigation";
import { after } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { SubmitButton } from "./SubmitButton";
import { GenesisAssistant } from "./GenesisAssistant";
import {
  generateStoreDraft,
  updateStoreDraft,
  discardStoreDraft,
  sendDraftMessage,
  applyThemePersonality,
  restoreStoreDraftVersion,
  confirmStoreDraft,
  explainRecommendation,
  reviewBusinessWithGenesis,
} from "./ai-actions";
import { DEFAULT_THEME, googleFontsUrl, themeCssVars, type Theme } from "@/lib/theme";
import { PERMISSIONS, hasPermission, resolveUserStore, type Permission } from "@/lib/permissions";
import { getOrderSummary, getRecentActivity, getRecentOrders } from "@/lib/dashboard/whatHappened";
import { getAttentionItems } from "@/lib/dashboard/needsAttention";
import { getRecommendations } from "@/lib/dashboard/recommendations";
import { getInventorySnapshot } from "@/lib/dashboard/inventory";
import { getPendingApprovals } from "@/lib/dashboard/pendingApprovals";
import { runOpportunisticAiReviewIfStale } from "@/lib/dashboard/genesisObservations";
import { measureDueMeasurements } from "@/lib/dashboard/postExecutionMeasurement";
import { ActivityFeed } from "./ActivityFeed";
import { AttentionPanel } from "./AttentionPanel";
import { RecommendationsPanel } from "./RecommendationsPanel";
import { ApprovalsSummary } from "./ApprovalsSummary";
import { RecentOrdersCard } from "./RecentOrdersCard";
import { BusinessJourney } from "./BusinessJourney";
import { logJourneyStageIfChanged } from "@/lib/dashboard/journeyStage";

const BRAND_PERSONALITIES = [
  "Luxury",
  "Modern",
  "Professional",
  "Friendly",
  "Heritage",
  "Bold",
  "Minimal",
  "Organic",
] as const;

type DraftProduct = {
  name: string;
  description: string;
  price: number;
};

// Small relative-time formatter for "Generated X ago" — this codebase has
// no existing time-ago utility (elsewhere just uses toLocaleString()), and
// pulling in a date library for one label wasn't worth it.
function formatTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

// A subtle accent-tinted header for the workspace, plus a monogram avatar
// and accent-colored primary buttons — this is intentionally lighter-touch
// than the full theme applied on the public storefront. Body text, form
// inputs, and card backgrounds stay neutral so the workspace stays
// readable no matter what palette Genesis generates.
function BrandHeader({
  theme,
  name,
  eyebrow,
}: {
  theme: Theme;
  name: string;
  eyebrow?: string;
}) {
  const fontsUrl = googleFontsUrl([theme.typography.headingFont]);
  return (
    <>
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}
      <div
        className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-[var(--brand-primary)]/10 via-[var(--brand-accent)]/10 to-transparent p-4"
      >
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--brand-accent)] text-lg font-semibold text-white">
          {name.trim().charAt(0).toUpperCase() || "?"}
        </div>
        <div>
          {eyebrow && (
            <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">
              {eyebrow}
            </p>
          )}
          <p className="font-[var(--font-heading)] text-2xl font-semibold text-black dark:text-zinc-50">
            {name}
          </p>
        </div>
      </div>
    </>
  );
}

// Padding/text-size are deliberately excluded so every call site sets its
// own — Tailwind class order doesn't reliably resolve conflicting utilities
// (e.g. px-5 from here vs px-4 at the call site), so this only ever
// contains non-conflicting brand styling.
const ACCENT_BUTTON =
  "rounded-full bg-[var(--brand-accent)] text-white transition hover:opacity-90 disabled:opacity-50";

export default async function DashboardPage() {
  const session = await auth();

  if (!session?.user) {
    redirect("/login");
  }

  const resolved = await resolveUserStore(session.user.id);
  const store = resolved?.store ?? null;
  const role = resolved?.role ?? null;

  if (!store) {
    const draft = await prisma.storeDraft.findUnique({
      where: { userId: session.user.id },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        generations: { orderBy: { createdAt: "asc" } },
      },
    });

    if (draft) {
      const theme = (draft.theme as Theme | null) ?? DEFAULT_THEME;
      const products = (draft.productsDraft as DraftProduct[] | null) ?? [];

      return (
        <div
          style={themeCssVars(theme)}
          className="min-h-screen bg-gradient-to-b from-zinc-100 via-zinc-50 to-white p-8 dark:from-zinc-950 dark:via-black dark:to-zinc-950"
        >
          <BrandHeader theme={theme} name={draft.name} eyebrow="Draft" />
          {draft.tagline && (
            <p className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
              {draft.tagline}
            </p>
          )}
          <p className="mt-1 text-xs text-zinc-500">version {draft.version}</p>

          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Theme
          </h2>
          <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
            How should your brand feel? Genesis will create a custom color
            palette, typography, and visual style that matches it.
          </p>
          <p className="mt-1 text-xs text-zinc-500">
            Every version is saved automatically — try as many as you like,
            you can always come back to an earlier look in{" "}
            <span className="font-medium">Your Store&apos;s Vision</span>{" "}
            below.
          </p>
          <form
            action={applyThemePersonality}
            className="mt-4 flex max-w-md flex-wrap gap-2"
          >
            {BRAND_PERSONALITIES.map((p) => (
              <SubmitButton
                key={p}
                name="personality"
                value={p}
                pendingText="Applying..."
                className="rounded-full border border-black/[.08] px-4 py-2 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
              >
                {p}
              </SubmitButton>
            ))}
            <SubmitButton
              name="personality"
              value="auto"
              pendingText="Applying..."
              className="rounded-full bg-foreground px-4 py-2 text-sm text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
            >
              ✨ Let Genesis Decide
            </SubmitButton>
          </form>

          <form action={updateStoreDraft} className="mt-10">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
              Store details
            </h2>
            <div className="mt-4 flex max-w-md flex-col gap-4">
              <input
                name="name"
                type="text"
                defaultValue={draft.name}
                required
                className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
              <textarea
                name="description"
                defaultValue={draft.description ?? ""}
                rows={5}
                className="max-h-64 rounded-lg border border-black/[.08] px-4 py-2 [field-sizing:content] dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
              />
            </div>

            <details className="mt-8">
              <summary className="cursor-pointer text-lg font-semibold text-black dark:text-zinc-50">
                Advanced Customization
              </summary>
              <p className="mt-2 text-xs text-zinc-500">
                Fine-tune individual colors, fonts, and layout by hand — most
                people won&apos;t need this, since Genesis handles design
                above.
              </p>
              <div className="mt-4 grid max-w-md grid-cols-2 gap-4 sm:grid-cols-4">
                {(
                  [
                    ["primary", "colorPrimary"],
                    ["secondary", "colorSecondary"],
                    ["accent", "colorAccent"],
                    ["background", "colorBackground"],
                    ["surface", "colorSurface"],
                    ["text", "colorText"],
                    ["textSecondary", "colorTextSecondary"],
                  ] as const
                ).map(([role, fieldName]) => (
                  <div
                    key={role}
                    className="flex flex-col items-center gap-1"
                  >
                    <input
                      name={fieldName}
                      type="color"
                      defaultValue={theme.colors[role]}
                      className="h-10 w-10 cursor-pointer rounded border border-black/[.08] dark:border-white/[.145]"
                    />
                    <span className="text-xs text-zinc-500">{role}</span>
                  </div>
                ))}
              </div>
              <div className="mt-4 flex max-w-md flex-col gap-4">
                <input
                  name="headingFont"
                  type="text"
                  defaultValue={theme.typography.headingFont}
                  placeholder="Heading font"
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <input
                  name="bodyFont"
                  type="text"
                  defaultValue={theme.typography.bodyFont}
                  placeholder="Body font"
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
                <select
                  name="layout"
                  defaultValue={theme.layout}
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                >
                  <option value="grid">Grid</option>
                  <option value="list">List</option>
                  <option value="featured">Featured</option>
                </select>
              </div>
            </details>

            <h2 className="mt-8 text-lg font-semibold text-black dark:text-zinc-50">
              Products
            </h2>
            <input type="hidden" name="productCount" value={products.length} />
            <ul className="mt-4 flex max-w-md flex-col gap-4">
              {products.map((product, index) => (
                <li
                  key={index}
                  className="flex flex-col gap-2 rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
                >
                  <input
                    name={`product-${index}-name`}
                    type="text"
                    defaultValue={product.name}
                    required
                    className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                  <textarea
                    name={`product-${index}-description`}
                    defaultValue={product.description}
                    rows={5}
                    className="max-h-64 rounded-lg border border-black/[.08] px-3 py-1.5 [field-sizing:content] dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                  <input
                    name={`product-${index}-price`}
                    type="number"
                    step="0.01"
                    min="0"
                    defaultValue={product.price}
                    required
                    className="rounded-lg border border-black/[.08] px-3 py-1.5 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                  />
                </li>
              ))}
            </ul>

            <SubmitButton
              pendingText="Saving..."
              className={`mt-6 self-start px-5 py-2 ${ACCENT_BUTTON}`}
            >
              Save changes
            </SubmitButton>
          </form>

          {draft.generations.length > 0 &&
            (() => {
              // Every version — not just the original and current endpoints
              // — is a real, restorable checkpoint (restoreStoreDraftVersion
              // already accepts any generation id). Listing all of them,
              // newest first, is what actually makes theme exploration feel
              // safe: a beta tester who tried three looks in a row needs to
              // get back to the second one, not just all the way to the
              // start. Reversed for display so the most likely restore
              // target (something tried recently) is at the top.
              const cards = [...draft.generations].reverse().map((gen) => {
                const isCurrent = gen.version === draft.version;
                const isOriginal = gen.milestone === "original";
                return {
                  key: gen.id,
                  label: isOriginal
                    ? "Original Vision"
                    : isCurrent
                      ? "Current Vision"
                      : `Version ${gen.version}`,
                  blurb: isOriginal
                    ? "The first version Genesis created from your original idea."
                    : isCurrent
                      ? "The version currently shaping your store."
                      : "An earlier version, saved along the way.",
                  date: gen.createdAt,
                  restoreId: isCurrent ? null : gen.id,
                };
              });

              return (
                <>
                  <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
                    Your Store&apos;s Vision
                  </h2>
                  <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
                    See how your store&apos;s direction has evolved, and bring
                    back any earlier vision anytime — not just the original.
                    This stays with your store for good — even after it goes
                    live.
                  </p>
                  <ul className="mt-4 flex max-w-md flex-col gap-3">
                    {cards.map((card) => (
                      <li
                        key={card.key}
                        className="rounded-lg border border-black/[.08] p-4 dark:border-white/[.145]"
                      >
                        <p className="font-medium text-black dark:text-zinc-50">
                          {card.label}
                        </p>
                        <p className="mt-1 text-xs text-zinc-500">
                          {card.blurb}
                        </p>
                        <p className="mt-1 text-xs text-zinc-400">
                          {card.date.toLocaleDateString()}
                        </p>
                        {card.restoreId && (
                          <form
                            action={restoreStoreDraftVersion.bind(
                              null,
                              card.restoreId
                            )}
                            className="mt-3"
                          >
                            <SubmitButton
                              pendingText="Restoring..."
                              className="rounded-full border border-black/[.08] px-3 py-1 text-xs disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
                            >
                              Restore This Vision
                            </SubmitButton>
                          </form>
                        )}
                      </li>
                    ))}
                  </ul>
                </>
              );
            })()}

          <div className="mt-10 rounded-2xl border border-black/[.08] bg-gradient-to-br from-white to-zinc-50 p-6 text-center shadow-sm dark:border-white/[.145] dark:from-zinc-900 dark:to-zinc-950">
            <p className="text-lg font-semibold text-black dark:text-zinc-50">
              Ready to bring {draft.name} to life?
            </p>
            <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
              Genesis will turn this vision into a real, working store.
            </p>
            <form action={confirmStoreDraft} className="mt-4 flex justify-center">
              <SubmitButton
                pendingText="Bringing your store to life..."
                className={`px-8 py-3 text-base font-medium hover:scale-105 ${ACCENT_BUTTON}`}
              >
                Confirm &amp; Create Store
              </SubmitButton>
            </form>
          </div>

          {/* "Welcome to Genesis" (v20) — deliberately demoted and relabeled
              from "Your input"/"Regenerate": talking to Genesis (above) is
              the normal way to refine the business, since it's tracked
              conversationally (a real StoreDraftMessage + diff + version).
              This form calls the same generateStoreDraft action but bypasses
              that entirely — a full, untracked regeneration from these raw
              fields — so it's framed here as a rare "start over" escape
              hatch, not the primary refinement mechanism. */}
          <details className="mt-10">
            <summary className="cursor-pointer text-sm font-medium text-zinc-500 hover:text-black dark:hover:text-zinc-300">
              Start over from scratch
            </summary>
            <p className="mt-2 max-w-md text-xs text-zinc-500">
              This replaces your store details, theme, and products with a
              brand new generation from these fields — skip this and just
              tell Genesis what you&apos;d like to change instead, if you can.
            </p>
            <form
              action={generateStoreDraft}
              className="mt-4 flex max-w-md flex-col gap-4"
            >
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-black dark:text-zinc-50">
                  Store name
                </label>
                <input
                  name="inputStoreName"
                  type="text"
                  defaultValue={draft.inputStoreName ?? ""}
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-black dark:text-zinc-50">
                  What do you want to sell?
                </label>
                <input
                  name="inputProductType"
                  type="text"
                  defaultValue={draft.inputProductType ?? ""}
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-black dark:text-zinc-50">
                  Describe your vision*
                </label>
                <textarea
                  name="inputVision"
                  defaultValue={draft.inputVision ?? ""}
                  rows={3}
                  required
                  className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
                />
              </div>
              <SubmitButton
                pendingText="Starting over..."
                className="mt-2 self-start rounded-full border border-black/[.08] px-5 py-2 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
              >
                Start over
              </SubmitButton>
            </form>
          </details>

          <form action={discardStoreDraft} className="mt-6">
            <SubmitButton
              pendingText="Discarding..."
              className="rounded-full border border-black/[.08] px-4 py-1.5 text-sm disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-50"
            >
              Discard draft
            </SubmitButton>
          </form>

          <GenesisAssistant
            storeName={draft.name}
            messages={draft.messages}
            sendMessage={sendDraftMessage}
            // Drafts have no ApprovalRequest/GenesisObservation concept at
            // all (Phase 1/4 both scoped entirely to live stores) — always
            // false, not a placeholder.
            hasUrgentIssue={false}
            hasPendingDecision={false}
            hasOpportunity={false}
            // "Welcome to Genesis" (v20) — open by default for a genuinely
            // fresh landing (nothing to show yet), so talking to Genesis
            // reads as the primary way to shape the business rather than an
            // easy-to-miss auxiliary widget. Deliberately NOT unconditional:
            // every message send redirects back to this same page, which
            // remounts GenesisAssistant and resets its local open/closed
            // state — an unconditional defaultOpen meant the panel forced
            // itself back open after every single message, permanently,
            // for the lifetime of the draft. A real user got trapped by
            // this exact bug, unable to reach the rest of the page no
            // matter how many times they closed it. Once real conversation
            // exists, the panel goes back to respecting whatever the owner
            // actually did with it.
            defaultOpen={draft.messages.length === 0}
            // This standalone page has no left Domicile rail to dock
            // beside — its own form content already occupies the left
            // side, so left-anchoring here overlaps Theme/Store-details
            // controls instead of sitting cleanly next to them.
            dockLeft={false}
          />
        </div>
      );
    }

    return (
      <div className="min-h-screen bg-zinc-50 p-8 dark:bg-black">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">
          Welcome to Genesis
        </h1>
        <p className="mt-2 max-w-md text-sm text-zinc-600 dark:text-zinc-400">
          Tell Genesis what you want to build, in your own words — a real
          business, not a demo. Genesis will ask for anything it still needs
          as you go; by the time you&apos;re done, your store will already
          exist.
        </p>

        <form
          action={generateStoreDraft}
          className="mt-6 flex max-w-md flex-col gap-4"
        >
          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              Store name
            </label>
            <p className="text-xs text-zinc-500">
              Optional — If you already have a name, tell us. If not, Genesis
              will create one for you.
            </p>
            <input
              name="inputStoreName"
              type="text"
              placeholder="e.g. Atlas Athletics"
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              What do you want to sell?
            </label>
            <p className="text-xs text-zinc-500">
              Optional — Tell us what products or services you want to offer.
            </p>
            <input
              name="inputProductType"
              type="text"
              placeholder="e.g. Performance gym clothing"
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label className="text-sm font-medium text-black dark:text-zinc-50">
              Describe your vision*
            </label>
            <p className="text-xs text-zinc-500">
              Required — Tell Genesis about your style, audience, colors,
              branding, and the feeling you want your store to create.
            </p>
            <textarea
              name="inputVision"
              placeholder={`"Cozy rustic candle shop."\n"Dark luxury fitness brand."\n"Minimalist clothing company."`}
              rows={4}
              required
              className="rounded-lg border border-black/[.08] px-4 py-2 dark:border-white/[.145] dark:bg-zinc-900 dark:text-zinc-50"
            />
          </div>

          <SubmitButton
            pendingText="Creating..."
            className="mt-2 self-start rounded-full bg-foreground px-5 py-2 text-background transition-colors hover:bg-[#383838] disabled:opacity-50 dark:hover:bg-[#ccc]"
          >
            Create My Store
          </SubmitButton>
        </form>
      </div>
    );
  }

  // Phase 4 — the opportunistic, cost-gated AI review trigger. Scheduled
  // via after() so an unlucky page load that happens to be stale never
  // blocks or slows this render — it only runs once the response has
  // already been sent. runOpportunisticAiReviewIfStale does its own
  // staleness/claim check first and is usually a no-op.
  after(() => runOpportunisticAiReviewIfStale(store.id, session.user.id).catch(() => {}));
  // Phase 5 — a separate after() call, deliberately not bundled into the
  // AI-review gate above: measurement is deterministic/zero-AI-cost and
  // should run on every opportunistic trigger, not only when the (unrelated)
  // AI-review staleness check happens to fire.
  after(() => measureDueMeasurements(store.id).catch(() => {}));

  const products = await prisma.product.findMany({
    where: { storeId: store.id },
    select: { active: true },
  });

  const [stripeIntegration, paypalIntegration] =
    role === "OWNER"
      ? await Promise.all([
          prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "STRIPE" } },
            select: { status: true },
          }),
          prisma.storeIntegration.findUnique({
            where: { storeId_provider: { storeId: store.id, provider: "PAYPAL" } },
            select: { status: true },
          }),
        ])
      : [null, null];

  const can = (permission: Permission) => (role ? hasPermission(role, permission) : false);
  const canViewOrders = can(PERMISSIONS.ORDERS_VIEW);
  const canViewRevenue = can(PERMISSIONS.REVENUE_VIEW);
  const canViewAnalytics = can(PERMISSIONS.ANALYTICS_VIEW);
  // Activity Feed / Attention Panel mix in action types (Stripe changes,
  // store renames) an Employee doesn't have visibility into anywhere else
  // on the dashboard today — Owner-only for now, not architecturally
  // permanent (see ARCHITECTURE.md).
  const isOwnerManager = role === "OWNER";

  const [orderSummary, recentOrders, activityItems, attention] = await Promise.all([
    canViewOrders ? getOrderSummary(store.id, { includeRevenue: canViewRevenue }) : Promise.resolve(null),
    canViewOrders
      ? getRecentOrders(store.id, { includeRevenue: canViewRevenue, limit: 5 })
      : Promise.resolve([]),
    // Home shows only the highest-signal recent activity — a full,
    // undifferentiated log isn't what "concise command center" means.
    isOwnerManager ? getRecentActivity(store.id, 5) : Promise.resolve([]),
    isOwnerManager
      ? getAttentionItems(store.id, {
          store: { published: store.published },
          products,
          stripeIntegration,
          paypalIntegration,
        })
      : Promise.resolve({ recentOutcomes: [], currentState: [] }),
  ]);

  const inventorySnapshot = canViewOrders ? getInventorySnapshot(products) : null;

  // Family-beta instrumentation (v20) — same gate BusinessJourney itself
  // renders under, reusing its exact stage logic (lib/dashboard/
  // journeyStage.ts) rather than a second computation. Scheduled via
  // after() so it never adds latency to this page load; a no-op unless the
  // stage genuinely changed since the last time this ran.
  if (isOwnerManager && canViewOrders && orderSummary) {
    after(() =>
      logJourneyStageIfChanged(session.user.id, store.id, session.user.sessionInstanceId, {
        published: store.published,
        hasActiveProducts: (inventorySnapshot?.activeCount ?? 0) > 0,
        stripeIntegration,
        paypalIntegration,
        allTimeOrderCount: orderSummary.allTimeOrderCount,
      }).catch(() => {})
    );
  }
  const storeBlueprint = store.blueprint as {
    brandIdentity?: {
      brandPersonality?: string;
      brandVoiceAndTone?: string;
      targetAudience?: string;
      uniqueSellingProposition?: string;
    };
    homepageContent?: { heroHeadline?: string; aboutUs?: string };
  } | null;

  const [recommendations, latestGenesisRecommendation, pendingApprovals] = canViewAnalytics
    ? await Promise.all([
        getRecommendations({
          storeId: store.id,
          storeName: store.name,
          store: { published: store.published },
          products: await prisma.product.findMany({
            where: { storeId: store.id },
            select: { name: true, description: true, priceInCents: true, active: true },
          }),
          stripeIntegration,
          attentionItems: [...attention.recentOutcomes, ...attention.currentState],
          orderSummary: orderSummary ?? {
            orderCount: 0,
            revenueInCents: null,
            allTimeOrderCount: 0,
            allTimeRevenueInCents: null,
            windowLabel: "Last 30 days",
          },
          customerSummaries: [],
          inventorySnapshot,
          recentActivity: activityItems,
          blueprint: storeBlueprint?.brandIdentity
            ? {
                brandPersonality: storeBlueprint.brandIdentity.brandPersonality ?? "",
                brandVoiceAndTone: storeBlueprint.brandIdentity.brandVoiceAndTone ?? "",
                targetAudience: storeBlueprint.brandIdentity.targetAudience ?? "",
                uniqueSellingProposition: storeBlueprint.brandIdentity.uniqueSellingProposition ?? "",
                heroHeadline: storeBlueprint.homepageContent?.heroHeadline ?? "",
                aboutUs: storeBlueprint.homepageContent?.aboutUs ?? "",
              }
            : null,
        }),
        prisma.generatedRecommendation.findFirst({
          where: { storeId: store.id },
          orderBy: { generatedAt: "desc" },
          select: { generatedAt: true },
        }),
        getPendingApprovals(store.id),
      ])
    : [[], null, []];

  const storeTheme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const fontsUrl = googleFontsUrl([storeTheme.typography.headingFont]);
  const hasAttentionOrApprovals = attention.recentOutcomes.length > 0 || pendingApprovals.length > 0;

  return (
    <div style={themeCssVars(storeTheme)} className="min-h-screen p-8 lg:min-h-0">
      {fontsUrl && <link rel="stylesheet" href={fontsUrl} />}

      {/* Today, at a glance — the workspace now begins directly with real
          business state; the greeting moved to Live Intelligence (see
          GenesisGreeting.tsx/LiveIntelligence.tsx), which already briefs
          the owner by name before they ever reach this page. Large
          numbers, no boxes; spacing and type carry the hierarchy instead
          of bordered cards. */}
      {canViewOrders && orderSummary && (
        <div className="flex flex-wrap items-baseline gap-x-12 gap-y-5">
          {orderSummary.revenueInCents !== null && (
            <div>
              <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
                ${(orderSummary.revenueInCents / 100).toFixed(2)}
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {orderSummary.windowLabel.toLowerCase()} revenue
              </p>
            </div>
          )}
          <div>
            <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
              {orderSummary.orderCount}
            </p>
            <p className="mt-1 text-xs text-zinc-500">
              order{orderSummary.orderCount === 1 ? "" : "s"}, {orderSummary.windowLabel.toLowerCase()}
            </p>
          </div>
          {inventorySnapshot && (
            <div>
              <p className="font-[var(--font-heading)] text-4xl font-semibold text-black dark:text-zinc-50">
                {inventorySnapshot.activeCount}
              </p>
              <p className="mt-1 text-xs text-zinc-500">active products</p>
            </div>
          )}
          <Link href="/dashboard/website" className="group">
            <p
              className={
                store.published
                  ? "font-[var(--font-heading)] text-4xl font-semibold text-emerald-600 dark:text-emerald-400"
                  : "font-[var(--font-heading)] text-4xl font-semibold text-zinc-400 dark:text-zinc-600"
              }
            >
              {store.published ? "Live" : "Unpublished"}
            </p>
            <p className="mt-1 text-xs text-zinc-500 group-hover:underline">
              storefront
            </p>
          </Link>
        </div>
      )}

      {/* Needs your attention — genuine issues only (Red) and real pending
          decisions (Yellow), in that priority order; routine incomplete
          setup lives positively in Business Journey below instead.
          Deliberately rendered here, directly under Snapshot and before
          Business Journey, rather than further down the page: when a
          genuine owner-action state exists, the thing requiring the owner
          should be visible in the initial viewport without scrolling — the
          greeting/Live Intelligence above already says as much, so the
          page itself shouldn't bury the reason. This is presentation
          ordering of the exact same gated block, not a second alert — when
          hasAttentionOrApprovals is false (nothing renders here at all),
          Business Journey below is exactly what a visitor sees first,
          unchanged from before. Purple ("From Genesis") and Recent Orders
          deliberately keep their own current position further down — this
          reordering is scoped to genuine Red/Yellow states only. */}
      {isOwnerManager && hasAttentionOrApprovals && (
        <>
          <h2 id="attention" className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Needs your attention
          </h2>
          <div className="mt-3 flex max-w-md flex-col gap-4">
            <AttentionPanel items={attention.recentOutcomes} />
            {canViewAnalytics && pendingApprovals.length > 0 && (
              <div>
                <p className="mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500">
                  Awaiting your decision
                </p>
                <ApprovalsSummary approvals={pendingApprovals} />
              </div>
            )}
          </div>
        </>
      )}

      {/* Business Journey — real progress, not a software setup checklist.
          Leads with what's moving forward before anything problem-shaped
          (when nothing above needed the owner, this is the first thing
          shown after Snapshot, unchanged from before). */}
      {isOwnerManager && canViewOrders && orderSummary && (
        <BusinessJourney
          published={store.published}
          hasActiveProducts={(inventorySnapshot?.activeCount ?? 0) > 0}
          stripeIntegration={stripeIntegration}
          paypalIntegration={paypalIntegration}
          allTimeOrderCount={orderSummary.allTimeOrderCount}
        />
      )}

      {/* Recent orders — positive activity, shown separately from anything problem-shaped */}
      {canViewOrders && recentOrders.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Recent orders
          </h2>
          <RecentOrdersCard orders={recentOrders} />
        </>
      )}

      {/* Genesis insights — keeps its review control even with nothing to show right now */}
      {canViewAnalytics && (
        <>
          <div className="mt-10 flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
              From Genesis
            </h2>
            <div className="flex items-center gap-3">
              <span className="text-xs text-zinc-500">
                {latestGenesisRecommendation
                  ? `Reviewed ${formatTimeAgo(latestGenesisRecommendation.generatedAt)}`
                  : "Genesis hasn't reviewed this business yet"}
              </span>
              <form action={reviewBusinessWithGenesis}>
                <SubmitButton
                  pendingText="Reviewing..."
                  className="rounded-full border border-black/[.08] px-3 py-1.5 text-xs text-zinc-600 transition-colors hover:bg-black/[.03] disabled:opacity-50 dark:border-white/[.145] dark:text-zinc-300 dark:hover:bg-white/[.05]"
                >
                  ✨ Ask Genesis to Review My Business
                </SubmitButton>
              </form>
            </div>
          </div>
          <RecommendationsPanel recommendations={recommendations} explainAction={explainRecommendation} />
        </>
      )}

      {/* Recently — compact, human-readable, absent entirely when there's nothing */}
      {isOwnerManager && activityItems.length > 0 && (
        <>
          <h2 className="mt-10 text-lg font-semibold text-black dark:text-zinc-50">
            Recently
          </h2>
          <div className="mt-3 max-w-md">
            <ActivityFeed items={activityItems} />
          </div>
        </>
      )}
    </div>
  );
}
