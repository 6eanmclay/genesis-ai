import { getBusinessUnderstanding } from "@/lib/businessModel/understanding";
import { readOwnerFactsWithProvenance } from "@/lib/businessModel/ownerFacts";
import { businessMap, DOMAIN_LABEL } from "@/lib/businessModel/businessMap";
import { connectableServices, whatItAdds } from "@/lib/businessModel/connectionDomains";
import { prisma } from "@/lib/prisma";
import Link from "next/link";
import { signupFor } from "@/lib/businessModel/signupDestinations";
import { CONNECTOR_CATALOG } from "@/lib/integrations/catalog";
import { SOCIAL_PLATFORMS } from "@/lib/social/platforms";
import type { MapProspect } from "@/lib/businessModel/mapBranches";
import { BusinessMapCanvas, type MapService, type DomainDestination } from "./BusinessMapCanvas";
import type { MapDomainKey } from "@/lib/businessModel/businessMap";

// THE FRONT DOOR, ASSEMBLED.
//
// ============ WHERE THIS SITS (2026-09-01) ============================
//
// Sean: "Genesis welcome/initialization experience -> Business Map / Business
// Home -> Existing overview content underneath."
//
// So this renders at the TOP of HomeWorkspace and the existing snapshot, J4
// Noticed and everything below it are untouched. The arrival overlay is a
// separate full-screen layer that plays over the whole page and is not
// implicated at all — it still runs exactly as it did.
//
//   Business Map = understand the business
//   Overview     = quickly see what is happening
//
// ============ NO SECOND UNDERSTANDING MODEL ==========================
//
// Sean: "Do not create a second Business Understanding model. Do not create new
// persistence for the derived map."
//
// This calls the same getBusinessUnderstanding every other consumer calls and
// hands it to the same pure businessMap() built in phase 2. Nothing is stored,
// nothing is cached, and there is no second answer to "what does J4 know".

export async function BusinessMapSection({
  storeId,
  storeSlug,
  ownerName,
  basePath,
}: {
  storeId: string;
  storeSlug: string;
  ownerName: string | null;
  basePath: string;
}) {
  // DESIGNS ARE NOT IN THE PROFILE, so they are counted here rather than
  // invented inside the assembler. Creation is Cubit & Coil's largest real
  // body of work and a Creation branch that ignored it would be wrong.
  const [understanding, facts, designCount, integrations] = await Promise.all([
    getBusinessUnderstanding(storeId),
    readOwnerFactsWithProvenance(storeId),
    prisma.businessRecord.count({ where: { storeId, entityType: "design" } }),
    prisma.storeIntegration.findMany({
      where: { storeId, status: "CONNECTED" },
      select: { provider: true },
    }),
  ]);

  const map = businessMap({ understanding, facts, slug: storeSlug, designCount });

  // ============ WHAT EACH SERVICE BRINGS, IN THE CATALOGUE'S OWN WORDS ===
  //
  // Sean: "The exact copy should be based on capabilities that actually exist
  // or are explicitly planned. Do not claim data J4 cannot currently access."
  //
  // So the description is read off CONNECTOR_CATALOG rather than written here.
  // Those lines were authored per provider and already carry their own limits —
  // TikTok's says outright that audience demographics are not available through
  // its standard API. A list invented in this file would lose that.
  const descriptions = new Map(CONNECTOR_CATALOG.map((e) => [e.id, e.description]));
  const connectedProviders = integrations.map((i) => i.provider);
  const fromCatalog: MapService[] = connectableServices(connectedProviders).map((s) => ({
    ...s,
    description: descriptions.get(s.id) ?? "",
    signupUrl: signupFor(s.id, s.available)?.url ?? null,
    manage: null,
  }));

  // ============ A CONNECTED SYSTEM ALWAYS APPEARS (2026-09-01) =========
  //
  // FOUND BY THE FINAL STATE CHECK. The Connections branch counts what is
  // really connected -- for Cubit & Coil that is Printful, PayPal and Stripe --
  // but its children were built only from CONNECTOR_CATALOG, which contains
  // neither payment rail. So the branch said three and tapping it showed one.
  //
  // The rails are not a gap in the catalogue: they are connected through
  // Payments, which is a different screen and a different flow. So they are
  // added here with the destination that actually fits their state, rather
  // than being offered a Connect button that would take an owner somewhere
  // they cannot connect them.
  const PAYMENT_RAIL_NAMES: Record<string, string> = { STRIPE: "Stripe", PAYPAL: "PayPal" };
  const inCatalog = new Set(
    CONNECTOR_CATALOG.map((e) => e.provider).filter((p): p is NonNullable<typeof p> => p !== null),
  );
  const rails: MapService[] = connectedProviders
    .filter((p) => !inCatalog.has(p) && PAYMENT_RAIL_NAMES[p])
    .map((p) => ({
      id: `rail:${p.toLowerCase()}`,
      name: PAYMENT_RAIL_NAMES[p],
      domain: "financials" as const,
      available: true,
      connected: true,
      // NO INVENTED CAPABILITY. What is true and checkable is that it is
      // connected and where it is managed.
      description: "Connected through Payments.",
      signupUrl: null,
      manage: { label: "View Payments", href: `${basePath}/payments` },
    }));

  const services: MapService[] = [...rails, ...fromCatalog];

  // ============ WHAT COULD INFORM A BRANCH, FROM REAL REGISTRIES =======
  //
  // Sean: "At the top level: J4 -> Social. Selecting Social reveals Instagram ·
  // Facebook · TikTok · X as connected child nodes... If TikTok isn't
  // connected: Not connected / Not yet known."
  //
  // Social had no children at all, because `profile.socialAccounts` is empty
  // for every business today -- so the branch said "not known yet" and opening
  // it showed nothing to do about that. These four are not invented: they are
  // SOCIAL_PLATFORMS, the registry the Studio already publishes from.
  //
  // X CARRIES ITS OWN TRUTH. Its `publishProvider` is null and that file says
  // why in its own words: "NO CONNECTOR EXISTS. Adding one means a new
  // IntegrationProvider value and a migration; leaving this null is what stops
  // the interface implying otherwise." So X appears, and appears as something
  // Genesis cannot connect -- which is more useful to an owner than pretending
  // it is not a platform they use.
  const connectedSet = new Set(connectedProviders);
  const socialProspects: MapProspect[] = SOCIAL_PLATFORMS.map((platform) => {
    const provider = platform.publishProvider;
    const catalogEntry = CONNECTOR_CATALOG.find((e) => e.provider === provider);
    return {
      id: platform.id,
      label: platform.label,
      // Connectable only when a connector actually exists for it.
      available: provider !== null && catalogEntry?.connector != null,
      connected: provider !== null && connectedSet.has(provider),
      // THE PROVIDER'S OWN WORDS where the catalogue has them, and nothing at
      // all where it does not. No capability is written here.
      detail: catalogEntry?.description ?? "",
      serviceId: catalogEntry?.id ?? null,
    };
  });

  const connectionProspects: MapProspect[] = services.map((s) => ({
    id: s.id,
    label: s.name,
    available: s.available,
    connected: s.connected,
    detail: s.description,
    serviceId: s.id,
  }));

  const prospects: Partial<Record<MapDomainKey, MapProspect[]>> = {
    social: socialProspects,
    connections: connectionProspects,
  };

  // ============ WHERE A BRANCH GOES WHEN THERE IS A REAL SCREEN =========
  //
  // Sean: "Every meaningful node/domain should have a way to go deeper when a
  // full screen already exists." The operative clause is the last one — a
  // domain with no screen behind it gets no button rather than a link to
  // somewhere approximate. Goals and Learned have none today, and saying so by
  // omission is more honest than sending an owner to a page that will not
  // answer them.
  const destinations: Partial<Record<MapDomainKey, DomainDestination>> = {
    business: { label: "View Identity", href: `${basePath}/brand` },
    commerce: { label: "View Commerce", href: `${basePath}/orders` },
    customers: { label: "View Customers", href: `${basePath}/customers` },
    financials: { label: "View Money", href: `${basePath}/finances` },
    social: { label: "View Social", href: `${basePath}/studio/social` },
    creation: { label: "View Studio", href: `${basePath}/studio` },
    connections: { label: "View Connections", href: `${basePath}/connections` },
  };

  const known = map.domains.filter((d) => d.certainty !== "unknown").length;

  return (
    <section className="mb-10">
      {/* The greeting the map sits under. The arrival overlay says the same
          thing first and more slowly; this is what remains on the page after
          it clears, so somebody who scrolls back still knows whose business
          they are looking at. */}
      <h1 className="font-[var(--font-heading)] text-2xl font-semibold text-black dark:text-zinc-50">
        Welcome back{ownerName ? `, ${ownerName.split(" ")[0]}` : ""}.
      </h1>
      <p className="mt-1 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
        This is {map.business.name}, and what J4 understands about it. {known} of{" "}
        {map.domains.length} branches have something behind them today — the rest fill in as your
        business grows.
      </p>

      <div className="mt-4">
        <BusinessMapCanvas
          map={map}
          services={services}
          prospects={prospects}
          destinations={destinations}
        />
      </div>

      {/* ---- what a connection would add ------------------------------------
          Compact and below the map, so the map stays the visual experience.
          Every line names the BRANCH a service feeds, never a capability
          Genesis has not verified. `available: false` comes straight from the
          catalogue's own `connector: null`. */}
      <details className="group mt-3">
        <summary className="cursor-pointer list-none text-xs text-zinc-600 marker:content-[''] hover:underline dark:text-zinc-400">
          What could J4 know next? ({services.filter((s) => !s.connected && s.available).length}{" "}
          services Genesis can connect)
        </summary>
        {/* ============ CONNECT OR CREATE (2026-09-01) ====================
            Sean: "We should never make the user leave Genesis and search for a
            service if they don't already have an account... If they have it,
            connect it. If they don't, help them create it. If they don't need
            it, leave it alone."

            So each card offers both doors, and the Create door only exists
            where a signup destination was actually FETCHED and confirmed — see
            signupDestinations.ts. A provider Genesis cannot connect gets
            neither button, because creating an account nobody can connect
            afterwards is the homework this idea removes.

            Compact by construction: one line of reason, two small controls, in
            a disclosure that is closed by default. The map stays the visual
            experience and this never becomes an integrations catalogue. */}
        <ul className="mt-3 grid gap-3 sm:grid-cols-2">
          {services.map((service) => {
            const signup = signupFor(service.id, service.available);
            return (
              <li
                key={service.id}
                className="rounded-xl border border-black/[.07] px-3.5 py-3 dark:border-white/[.10]"
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-sm font-medium text-black dark:text-zinc-50">
                    {service.name}
                  </span>
                  {service.connected && (
                    <span className="shrink-0 text-xs font-medium text-emerald-700 dark:text-emerald-400">
                      ✓ Connected
                    </span>
                  )}
                </div>
                <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                  {service.available
                    ? whatItAdds(service, DOMAIN_LABEL[service.domain])
                    : "Not something Genesis can connect yet."}
                </p>
                {service.connected ? (
                  <p className="mt-2 text-xs text-zinc-500">
                    J4 can use this in your Business Map.
                  </p>
                ) : service.available ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <Link
                      href={`${basePath}/connections`}
                      className="rounded-full border border-black/[.12] px-3 py-1 text-xs text-black transition-colors hover:bg-black/[.04] dark:border-white/[.20] dark:text-zinc-50 dark:hover:bg-white/[.06]"
                    >
                      Connect
                    </Link>
                    {signup ? (
                      <a
                        href={signup.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="rounded-full px-3 py-1 text-xs text-zinc-600 underline underline-offset-2 dark:text-zinc-400"
                      >
                        Create
                      </a>
                    ) : (
                      // NOT A GUESSED LINK. See signupDestinations.ts — a
                      // destination we could not confirm is reported as one we
                      // do not have, never as one we invented.
                      <span className="text-xs text-zinc-500">
                        No signup link we could verify.
                      </span>
                    )}
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 max-w-2xl text-xs text-zinc-500">
          Connecting a service tells J4 where to look. It does not change what your business is —
          it changes how much of it J4 can see. Everything it reads stays your data.
        </p>
      </details>

      <div className="mt-8 border-t border-black/[.06] pt-6 dark:border-white/[.08]">
        <h2 className="text-lg font-semibold text-black dark:text-zinc-50">
          What&apos;s happening right now
        </h2>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          The map is how J4 understands {map.business.name}. Below is what it is doing today.
        </p>
      </div>
    </section>
  );
}
