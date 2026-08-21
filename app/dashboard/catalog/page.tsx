import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { themeCssVars, DEFAULT_THEME, type Theme } from "@/lib/theme";
import { catalogView, type CatalogItem } from "@/lib/sourcing/catalogView";
import { J4_VOICE } from "@/lib/dashboard/j4Voice";
import { SubmitButton } from "../SubmitButton";
import { adoptFromCatalog, dismissFromCatalog, priceFromCatalog, rediscoverForCatalog } from "./actions";

// THE CATALOG — what Genesis thinks this business should sell, and why.
//
// "The catalog is not the product. The intelligence behind the catalog is the
// product." (Sean.) So this screen is deliberately not a grid of things a
// supplier sells. Every row is a recommendation with reasoning attached, grouped
// by what the sourcing method means for the owner, and every judgement on it was
// made by `catalogView` — which in turn made none of its own, and called the
// functions that were already verified.
//
// A supplier's NAME appears nowhere. "Printful" is an answer to a question
// nobody building a business is asking; "can I put my brand on it, and do I have
// to hold any of it" is the question, and that is what the group headings say.

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 2 }).format(cents / 100);
}

/**
 * What Genesis knows about this one's cost, and who said it.
 *
 * Shown rather than summarised into a badge: "you told me this" and "their
 * catalogue says this" are different claims, and somebody deciding whether to
 * spend money is entitled to know which one they are reading. An unpriced row
 * says so plainly and offers to go and ask.
 */
function Economics({ item, currency }: { item: CatalogItem; currency: string }) {
  const { economics } = item;
  const shown = economics.currency ?? currency;

  if (economics.unitCostInCents === null) {
    return (
      <p className="text-xs text-zinc-500 dark:text-zinc-400">
        I don&apos;t know what this costs yet.
      </p>
    );
  }

  const who = economics.attribution.find((a) => a.fact === "unitCost");

  return (
    <p className="text-xs text-zinc-500 dark:text-zinc-400">
      <span className="tabular-nums text-black dark:text-zinc-50">
        {money(economics.unitCostInCents, shown)}
      </span>{" "}
      each
      {economics.minimumOrderUnits !== null && (
        <> · {economics.minimumOrderUnits} minimum</>
      )}
      {who && <> · {who.said === "you" ? "you told me" : "from their catalogue"}</>}
      {economics.anyStale && <> · worth checking</>}
      {/* The currency a supplier quotes in is theirs, and when it is not the
          business's own the engine refuses to compare rather than converting.
          Saying so here is the same refusal, in the owner's words. */}
      {economics.currency && economics.currency !== currency && (
        <> · quoted in {economics.currency}, which I can&apos;t compare to {currency}</>
      )}
    </p>
  );
}

/** What Genesis would say about acting on this one, already decided. */
function Verdict({ item }: { item: CatalogItem }) {
  const { outcome } = item;

  if (outcome.kind === "cannot_assess") {
    return (
      <p className={`text-xs text-zinc-500 dark:text-zinc-400 ${J4_VOICE}`}>
        I can&apos;t judge this one yet — I&apos;d need to know {outcome.missing.join(", and ")}.
      </p>
    );
  }
  if (outcome.kind === "not_a_fit") {
    return (
      <p className={`text-xs text-zinc-500 dark:text-zinc-400 ${J4_VOICE}`}>
        {outcome.concerns[0] ?? "This doesn't fit the brand you've described."}
      </p>
    );
  }
  if (outcome.kind === "not_yet") {
    return (
      <div className={`flex flex-col gap-1 text-xs text-zinc-500 dark:text-zinc-400 ${J4_VOICE}`}>
        {outcome.blockers.map((blocker, i) => (
          <p key={i}>{blocker}</p>
        ))}
        <p>{outcome.plan}</p>
        {outcome.caveats.map((caveat, i) => (
          <p key={`c${i}`}>{caveat}</p>
        ))}
      </div>
    );
  }
  return (
    <div className={`flex flex-col gap-1 text-xs text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
      {outcome.reasons.slice(0, 2).map((reason, i) => (
        <p key={i}>{reason}</p>
      ))}
      {outcome.caveats.map((caveat, i) => (
        <p key={`c${i}`}>{caveat}</p>
      ))}
    </div>
  );
}

export async function CatalogScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;
  const view = await catalogView(store.id);
  const currency = store.currency;

  const hidden = (
    <>
      <input type="hidden" name="slug" value={slug ?? ""} />
      <input type="hidden" name="basePath" value={basePath} />
    </>
  );

  return (
    <div style={themeCssVars(theme)} className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">What you could sell</h1>
        {view.knowsTheBusiness ? (
          <p className={`text-[15px] text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
            These are the products I&apos;d put in front of you, based on how you&apos;ve described your
            business. Everything here is a suggestion with a reason — nothing is a catalogue dump.
          </p>
        ) : (
          // "I don't know you yet" is not "nothing fits you", and only one of
          // them is the owner's problem to fix.
          <p className={`text-[15px] text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
            I don&apos;t know enough about your business yet to say what you should sell. Tell me what
            you&apos;re building and who it&apos;s for, and I&apos;ll come back with real suggestions
            rather than a list of things somebody happens to stock.
          </p>
        )}
      </header>

      {view.startingSet && view.startingSet.picks.length > 0 && (
        <section className="rounded-xl border border-[#2563eb]/15 bg-[#2563eb]/[0.035] px-4 py-4">
          <h2 className="text-[15px] font-medium text-black dark:text-zinc-50">
            If I were starting your shelf
          </h2>
          <ul className="mt-2 flex flex-col gap-1">
            {view.startingSet.picks.map((pick) => (
              <li key={pick.sourcedProductId} className="text-[14px] text-zinc-700 dark:text-zinc-200">
                {pick.name}
              </li>
            ))}
          </ul>
          {view.startingSet.advice.map((line, i) => (
            <p key={i} className={`mt-2 text-[13px] text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
              {line}
            </p>
          ))}
          {/* A real absence, named rather than padded with something invented
              to fill the slot. */}
          {view.startingSet.gaps.map((gap, i) => (
            <p key={`g${i}`} className={`mt-2 text-[13px] text-zinc-500 dark:text-zinc-400 ${J4_VOICE}`}>
              {gap}
            </p>
          ))}
        </section>
      )}

      {view.groups.length === 0 ? (
        <section className="rounded-xl border border-black/[.08] px-4 py-6 dark:border-white/[.145]">
          <p className={`text-[15px] text-zinc-600 dark:text-zinc-300 ${J4_VOICE}`}>
            Nothing on my list right now.
          </p>
          <form action={rediscoverForCatalog} className="mt-3">
            {hidden}
            <SubmitButton pendingText="Looking…" className="rounded-full bg-[#2563eb] px-4 py-2 text-sm font-medium text-white">
              Go and look
            </SubmitButton>
          </form>
        </section>
      ) : (
        view.groups.map((group) => (
          <section key={group.kind} className="flex flex-col gap-3">
            <div>
              <h2 className="text-[17px] font-medium text-black dark:text-zinc-50">{group.label}</h2>
              <p className="text-[13px] font-medium text-[#2563eb]">{group.intent}</p>
              <p className="mt-1 max-w-2xl text-[13px] text-zinc-500 dark:text-zinc-400">
                {group.explanation}
              </p>
            </div>

            <ul className="flex flex-col gap-3">
              {group.items.map((item) => (
                <li
                  key={item.sourcedProductId}
                  className="rounded-xl border border-black/[.08] px-4 py-3 dark:border-white/[.145]"
                >
                  <div className="flex items-start gap-3">
                    {item.imageUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={item.imageUrl}
                        alt=""
                        className="h-14 w-14 shrink-0 rounded-lg object-cover"
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] font-medium text-black dark:text-zinc-50">{item.name}</p>

                      {/* WHY, in the business's own words. This is the whole
                          difference between a recommendation and a listing. */}
                      <Verdict item={item} />
                      <div className="mt-1.5">
                        <Economics item={item} currency={currency} />
                      </div>

                      <div className="mt-2.5 flex flex-wrap items-center gap-2">
                        <form action={adoptFromCatalog} className="flex items-center gap-2">
                          {hidden}
                          <input type="hidden" name="sourcedProductId" value={item.sourcedProductId} />
                          {/* The owner's price wins. Left empty it falls back to
                              the supplier's suggestion, and adoption refuses
                              rather than inventing one when neither exists. */}
                          <input
                            type="number"
                            name="priceInCents"
                            min={1}
                            step={1}
                            placeholder={
                              item.suggestedRetailInCents !== null
                                ? String(item.suggestedRetailInCents)
                                : "price in cents"
                            }
                            aria-label={`What you'll charge for ${item.name}, in cents`}
                            className="w-32 rounded-lg border border-black/[.08] bg-white px-2.5 py-1.5 text-[13px] tabular-nums text-black dark:border-white/[.145] dark:bg-black/20 dark:text-zinc-50"
                          />
                          <SubmitButton pendingText="Adding…" className="rounded-full bg-[#2563eb] px-3.5 py-1.5 text-xs font-medium text-white">
                            Add to my store
                          </SubmitButton>
                        </form>

                        {item.economics.unitCostInCents === null && (
                          <form action={priceFromCatalog}>
                            {hidden}
                            <input type="hidden" name="sourcedProductId" value={item.sourcedProductId} />
                            <SubmitButton pendingText="Asking…" className="rounded-full border border-black/[.08] px-3.5 py-1.5 text-xs text-zinc-600 dark:border-white/[.145] dark:text-zinc-300">
                              What does it cost?
                            </SubmitButton>
                          </form>
                        )}

                        <form action={dismissFromCatalog}>
                          {hidden}
                          <input type="hidden" name="sourcedProductId" value={item.sourcedProductId} />
                          <SubmitButton pendingText="Removing…" className="rounded-full px-2 py-1.5 text-xs text-zinc-500 underline dark:text-zinc-400">
                            Not for me
                          </SubmitButton>
                        </form>
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))
      )}

      {/* NAMED, NEVER SILENTLY OMITTED. "Why did this only search one supplier"
          has to be answerable without reading code. */}
      {view.blockedSources.length > 0 && (
        <section className="rounded-xl border border-black/[.06] px-4 py-3 dark:border-white/[.08]">
          <p className="text-[13px] font-medium text-zinc-600 dark:text-zinc-300">
            Places I couldn&apos;t look
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {view.blockedSources.map((source) => (
              <li key={source.key} className="text-[13px] text-zinc-500 dark:text-zinc-400">
                {source.displayName} — {source.blockedOn.join("; ")}
              </li>
            ))}
          </ul>
        </section>
      )}

      {view.groups.length > 0 && (
        <form action={rediscoverForCatalog} className="flex items-center gap-3">
          {hidden}
          <SubmitButton pendingText="Looking…" className="rounded-full border border-black/[.08] px-4 py-2 text-sm text-zinc-600 dark:border-white/[.145] dark:text-zinc-300">
            Look again
          </SubmitButton>
          {view.lastDiscoveredAt && (
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              Last looked {view.lastDiscoveredAt.toLocaleDateString()}
            </span>
          )}
        </form>
      )}
    </div>
  );
}

export default async function CatalogPage() {
  return CatalogScreen({ basePath: LEGACY_BUSINESS_BASE });
}
