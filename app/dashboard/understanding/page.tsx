import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { getReviewableBeliefs } from "@/lib/intelligence/beliefReview";
import { BeliefReview } from "./BeliefReview";

const CARD =
  "rounded-xl border border-black/[.08] bg-black/[.02] p-4 dark:border-white/[.145] dark:bg-white/[.03]";
import { formatMoney } from "@/lib/money";

const LABEL = "text-xs font-medium uppercase tracking-wide text-zinc-500";
const VALUE = "mt-0.5 text-sm text-black dark:text-zinc-50";

// The store's own currency, threaded rather than assumed. This screen states
// what Genesis understands about the business, and a revenue figure carrying
// the wrong symbol is a claim about which money the business takes.
const formatCents = formatMoney;

function formatDate(value: string | Date): string {
  return new Date(value).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function trendArrow(direction: "up" | "down" | "flat" | undefined): string {
  return direction === "up" ? "↑" : direction === "down" ? "↓" : "—";
}

function ConfidencePill({ confidence }: { confidence: number }) {
  const pct = Math.round(confidence * 100);
  return (
    <span className="ml-2 rounded-full bg-black/[.05] px-2 py-0.5 text-xs text-zinc-600 dark:bg-white/[.1] dark:text-zinc-300">
      {pct}% confidence
    </span>
  );
}

// Beta Readiness P4 — the first real, owner-facing view of
// getBusinessUnderstanding() (see J4_FOUNDATION.md §1-§3 for what this
// object is and how it's assembled). Deliberately read-only, matching
// app/dashboard/brand/page.tsx's own real precedent for AI-derived
// understanding: no manual edit form exists here, because none exists for
// any of this data today — Genesis's own understanding is corrected
// through conversation/uploads, not a form on this page. A real
// correction UI is named future work (J4_FOUNDATION.md's coverage-gap
// section), not built here.
//
// Only shows, directly and fully, data with no other real home in this
// app today (people/employees, suppliers, locations, goals, challenges,
// assets, beliefs, recent decisions, platform relationship). Everything
// that already has a dedicated, fuller page (brand identity, the product
// catalog, the customer list, connections, billing) gets a brief real
// summary and a link out — never a second, competing display of the same
// data.
//
// Deliberately owns no ApprovalRequest/GenesisObservation panels — this
// page reads Understand only. "What's awaiting your decision" is a
// different, real concern that already lives on Home and each owning
// section.
// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged. What changed is where it gets its business: a
// `slug` means it was reached at /b/[slug] and that business is authoritative;
// no slug means the legacy /dashboard route, which resolves the account's active
// business exactly as before.
//
// `basePath` is what every link inside uses, so a page rendered for one business
// never links into another.
export async function UnderstandingScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store, userId } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const understanding = await getBusinessUnderstanding(store.id);
  const { profile, recentDecisions, activeThoughts, platformRelationship } = understanding;

  // BELIEFS ARE READ SEPARATELY FROM UNDERSTANDING (2026-08-22, U4), and not
  // because the data differs — it is the same table. What differs is what a
  // PERSON needs from it versus what a PROMPT does. getBusinessUnderstanding
  // returns claims for reasoning; this returns the evidence behind each one, the
  // dates that say whether it still holds, and the ones the owner has already
  // corrected, which a prompt should never see because they are no longer true.
  const { active: activeBeliefs, contradicted: correctedBeliefs } = await getReviewableBeliefs(
    store.id,
    userId
  );
  // Only the owner may correct. STORE_MANAGE gets you onto this page; it does
  // not make you the person J4's beliefs are about.
  const canCorrect = store.userId === userId;

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-8 lg:min-h-0">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Understanding</h1>
      <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        What J4 currently understands about your business — source-attributed, and honest about what
        it isn&apos;t sure of yet.
      </p>

      <div className="mt-6 flex max-w-3xl flex-col gap-8">
        {/* 1. Identity & classification */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Identity &amp; classification</h2>
          <div className={`mt-3 ${CARD}`}>
            <p className={VALUE}>
              <span className="font-medium">{profile.identity.name}</span>
              {profile.identity.tagline ? ` — ${profile.identity.tagline}` : ""}
            </p>
            {profile.identity.description && <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">{profile.identity.description}</p>}
            {(profile.classification.businessCategories.length > 0 || profile.classification.revenueStreams.length > 0) && (
              <p className="mt-2 text-xs text-zinc-500">
                {profile.classification.businessCategories.map((c) => c.label).join(", ")}
                {profile.classification.businessCategories.length > 0 && profile.classification.revenueStreams.length > 0 ? " · " : ""}
                {profile.classification.revenueStreams.map((r) => r.label).join(", ")}
              </p>
            )}
            <a href={`${basePath}/brand`} className="mt-3 inline-block text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">
              See full brand identity →
            </a>
          </div>
        </section>

        {/* 2. What you sell */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">What you sell</h2>
          <div className={`mt-3 ${CARD}`}>
            <p className={VALUE}>
              {profile.offerings.activeCount} active product{profile.offerings.activeCount === 1 ? "" : "s"}
            </p>
            {profile.offerings.trends.filter((t) => t.trend !== null).length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-sm text-zinc-600 dark:text-zinc-400">
                {profile.offerings.trends
                  .filter((t) => t.trend !== null)
                  .slice(0, 3)
                  .map((t) => (
                    <li key={t.item.id}>
                      {trendArrow(t.trend?.direction)} {t.item.data.name} — {Math.round((t.trend?.changeRatio ?? 0) * 100)}%
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-zinc-500">No trend data yet — not enough history to compare.</p>
            )}
            <a href={`${basePath}/products`} className="mt-3 inline-block text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">
              See full catalog →
            </a>
          </div>
        </section>

        {/* 3. Revenue */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Revenue</h2>
          <div className={`mt-3 flex gap-6 ${CARD}`}>
            <div>
              <p className={LABEL}>Last 30 days</p>
              <p className={VALUE}>{formatCents(profile.revenue.last30DaysInCents, store.currency)}</p>
            </div>
            <div>
              <p className={LABEL}>All time</p>
              <p className={VALUE}>{formatCents(profile.revenue.allTimeInCents, store.currency)}</p>
            </div>
          </div>
        </section>

        {/* 4. Customers */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Customers</h2>
          <div className={`mt-3 ${CARD}`}>
            <p className={VALUE}>{profile.customers.totalContactCount} known contacts</p>
            <dl className="mt-2 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <div>
                <dt className="text-xs text-zinc-500">Repeat</dt>
                <dd>{profile.customers.segments.repeatCustomers.length} {trendArrow(profile.customers.segmentTrends.repeatCustomers?.direction)}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">High-value</dt>
                <dd>{profile.customers.segments.highValueCustomers.length} {trendArrow(profile.customers.segmentTrends.highValueCustomers?.direction)}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">Lapsed</dt>
                <dd>{profile.customers.segments.lapsedCustomers.length} {trendArrow(profile.customers.segmentTrends.lapsedCustomers?.direction)}</dd>
              </div>
              <div>
                <dt className="text-xs text-zinc-500">New</dt>
                <dd>{profile.customers.segments.newCustomers.length} {trendArrow(profile.customers.segmentTrends.newCustomers?.direction)}</dd>
              </div>
            </dl>
            <a href={`${basePath}/customers`} className="mt-3 inline-block text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">
              See full customer list →
            </a>
          </div>
        </section>

        {/* 5. People */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">People</h2>
          <div className={`mt-3 ${CARD}`}>
            {profile.people.owner && (
              <p className={VALUE}>
                {profile.people.owner.name ?? profile.people.owner.email} — Owner
              </p>
            )}
            {profile.people.members.map((m, i) => (
              <p key={i} className="mt-1 text-sm text-black dark:text-zinc-50">
                {m.name ?? m.email} — {m.role}
              </p>
            ))}
            {profile.people.employees.length === 0 && profile.people.members.length === 0 ? (
              <p className="mt-1 text-sm text-zinc-500">No other team members yet.</p>
            ) : null}
            {profile.people.employees.length > 0 && (
              <ul className="mt-2 flex flex-col gap-1 border-t border-black/[.08] pt-2 text-sm dark:border-white/[.145]">
                {profile.people.employees.map((e) => (
                  <li key={e.id} className="text-black dark:text-zinc-50">
                    {e.data.name}
                    {e.data.title ? ` — ${e.data.title}` : ""}
                    {e.data.status === "former" ? " (former)" : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 6. Suppliers */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Suppliers</h2>
          <div className={`mt-3 ${CARD}`}>
            {profile.suppliers.length === 0 ? (
              <p className="text-sm text-zinc-500">None known yet — mentioned in chat, or found in an uploaded document, and I&apos;ll remember them here.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {profile.suppliers.map((s) => (
                  <li key={s.id} className="text-black dark:text-zinc-50">
                    {s.data.name}
                    {s.data.email ? ` — ${s.data.email}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 7. Locations */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Locations</h2>
          <div className={`mt-3 ${CARD}`}>
            {profile.locations.length === 0 ? (
              <p className="text-sm text-zinc-500">None known yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {profile.locations.map((l) => (
                  <li key={l.id} className="text-black dark:text-zinc-50">
                    {l.data.name}
                    {l.data.city ? ` — ${l.data.city}${l.data.state ? `, ${l.data.state}` : ""}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 8. Goals & Challenges */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Goals &amp; challenges</h2>
          <div className={`mt-3 flex flex-col gap-3 ${CARD}`}>
            {profile.goals.length === 0 && profile.challenges.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing stated yet — tell me a goal or a challenge and I&apos;ll remember it here.</p>
            ) : (
              <>
                {profile.goals.map((g) => (
                  <p key={g.id} className="text-sm text-black dark:text-zinc-50">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Goal — {g.data.status}</span>
                    <br />
                    {g.data.description}
                  </p>
                ))}
                {profile.challenges.map((c) => (
                  <p key={c.id} className="text-sm text-black dark:text-zinc-50">
                    <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">Challenge — {c.data.status}</span>
                    <br />
                    {c.data.description}
                  </p>
                ))}
              </>
            )}
          </div>
        </section>

        {/* 9. Business Assets */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Business assets</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">Every photo and document you&apos;ve uploaded through chat, and what I found in each one.</p>
          <div className={`mt-3 flex flex-col gap-3 ${CARD}`}>
            {profile.assets.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing uploaded yet — use Upload Photos or Upload Documents in chat.</p>
            ) : (
              profile.assets.map((a) => (
                <div key={a.id} className="border-b border-black/[.06] pb-2 last:border-0 last:pb-0 dark:border-white/[.1]">
                  <p className="text-sm font-medium text-black dark:text-zinc-50">
                    {a.data.originalFilename}
                    {a.data.category === "unclassified" ? (
                      <span className="ml-2 rounded-full bg-black/[.05] px-2 py-0.5 text-xs text-zinc-500 dark:bg-white/[.1]">not yet reviewed</span>
                    ) : (
                      <>
                        <span className="ml-2 text-xs font-normal text-zinc-500">{a.data.category.replace(/_/g, " ")}</span>
                        {a.data.extractionConfidence !== null && <ConfidencePill confidence={a.data.extractionConfidence} />}
                      </>
                    )}
                  </p>
                  {a.data.summary && <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{a.data.summary}</p>}
                </div>
              ))
            )}
          </div>
        </section>

        {/* 10. Connected systems */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Connected systems</h2>
          <div className={`mt-3 ${CARD}`}>
            {profile.connectedSystems.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing connected yet.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {profile.connectedSystems.map((s) => (
                  <li key={s.provider} className="text-black dark:text-zinc-50">
                    {s.displayName} — {s.status}
                    {s.syncedAgoLabel ? ` — synced ${s.syncedAgoLabel}${s.isStale ? " (stale)" : ""}` : ""}
                  </li>
                ))}
              </ul>
            )}
            <a href={`${basePath}/connections`} className="mt-3 inline-block text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">
              Manage connections →
            </a>
          </div>
        </section>

        {/* 11. What J4 has learned */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">What J4 has learned</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Patterns J4 has noticed from things that actually happened. If one of them is wrong,
            say so — it stops being used.
          </p>
          <div className={`mt-3 ${CARD}`}>
            <BeliefReview
              active={activeBeliefs}
              contradicted={correctedBeliefs}
              canCorrect={canCorrect}
              slug={slug}
            />
          </div>
        </section>

        {/* 12. Recent decisions */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Recent decisions</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">What you&apos;ve approved or declined in the last two weeks.</p>
          <div className={`mt-3 ${CARD}`}>
            {recentDecisions.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing in the last two weeks.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {recentDecisions.map((d, i) => (
                  <li key={i} className="text-black dark:text-zinc-50">
                    {d.decision === "executed" ? "✓" : "✕"} {d.summary} — {formatDate(d.decidedAt)}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 13. Still open */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Still open</h2>
          <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            What I&apos;ve already told you and haven&apos;t heard back on — the full, live version is on{" "}
            <a href={`${basePath}`} className="font-medium text-[var(--brand-accent)] hover:opacity-80">Your Business</a>.
          </p>
          <div className={`mt-3 ${CARD}`}>
            {activeThoughts.length === 0 ? (
              <p className="text-sm text-zinc-500">Nothing open right now.</p>
            ) : (
              <ul className="flex flex-col gap-1 text-sm">
                {activeThoughts.slice(0, 5).map((t) => (
                  <li key={t.id} className="text-black dark:text-zinc-50">
                    {t.summary}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        {/* 14. Platform relationship */}
        <section>
          <h2 className="text-lg font-semibold text-black dark:text-zinc-50">Your relationship with Genesis</h2>
          <div className={`mt-3 ${CARD}`}>
            <p className={VALUE}>
              {platformRelationship.planName ?? "No plan"} — {platformRelationship.growthPointBalance} Growth Points
            </p>
            {platformRelationship.subscriptionStatus && (
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">{platformRelationship.subscriptionStatus}</p>
            )}
            {platformRelationship.businessPartnerTrialEndsAt && (
              <p className="mt-0.5 text-sm text-zinc-600 dark:text-zinc-400">
                Business Partner trial ends {formatDate(platformRelationship.businessPartnerTrialEndsAt)}
              </p>
            )}
            <div className="mt-3 flex gap-4">
              <a href={`${basePath}/billing`} className="text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">Billing →</a>
              <a href={`${basePath}/growth-points`} className="text-xs font-medium text-[var(--brand-accent)] hover:opacity-80">Growth Points →</a>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/understanding renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function UnderstandingPage() {
  return UnderstandingScreen({ basePath: LEGACY_BUSINESS_BASE });
}
