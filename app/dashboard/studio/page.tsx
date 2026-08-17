import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { currentAssetsByRole } from "@/lib/businessModel/assets";
import { DesignSchema } from "@/lib/businessModel/entities";
import { SURFACES } from "@/lib/design/surfaces";
import { StudioPrompts } from "./StudioPrompts";

// The Studio — a creative workshop, not a file manager (2026-08-17).
//
// Sean, on the first version: "the current black page with 'No logo yet' makes
// Studio feel like an empty file-storage/upload screen. That's not the product
// we are building." He is right, and the fix is not a restyle — it is a
// different idea of what the page is FOR.
//
// So this page is a WORK SURFACE. The largest thing on it is the most recent
// thing J4 made, shown big enough to judge. Everything else is secondary: what
// J4 has to work with, and what came before. Someone opening it should think
// "this is where I make things with J4", never "this is where my logo file
// lives".
//
// DELIBERATELY LIGHT. Every other dashboard surface is dark; this one is not,
// and that is the point rather than an inconsistency. A workshop is lit so the
// work is the brightest thing in the room — a dark page makes a mockup glow
// like a screenshot in a viewer instead of a thing sitting on a bench.
//
// NO DESIGN CONTROLS. No toolbar, no handles, no sliders. The suggestion chips
// are real controls now that the capabilities behind them are real, but each
// one only SENDS A SENTENCE to J4 — there is no hard-coded "make it smaller"
// path, and there must never be. The moment a chip calls something the
// conversation cannot, this is a design editor with a chat box attached.
//
// NOT HARD-CODED AROUND T-SHIRTS. Surfaces come from the registry, so a hat or
// a storefront graphic appears here the day its surface is added, with no
// change to this file.

export default async function StudioPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);

  const [assetsByRole, designRows] = await Promise.all([
    currentAssetsByRole(store.id),
    prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "design" },
      orderBy: { syncedAt: "desc" },
      take: 24,
      select: { id: true, data: true, syncedAt: true },
    }),
  ]);

  const designs = designRows
    .map((row) => ({ id: row.id, parsed: DesignSchema.safeParse(row.data) }))
    .flatMap((d) => (d.parsed.success ? [{ id: d.id, ...d.parsed.data }] : []));

  const latest = designs[0] ?? null;
  const latestDesign = latest;
  const earlier = designs.slice(1);
  const assets = Object.entries(assetsByRole);
  const hasLogo = Boolean(assetsByRole["brand.logo"]);
  const otherSurfaces = Object.values(SURFACES).filter((sf) => sf.key !== latestDesign?.surface);

  // WHAT J4 RECOMMENDS NEXT, from what actually exists (2026-08-17). Sean:
  // "the Studio should feel like J4 is guiding someone through creating their
  // business's visual catalog, not presenting a list of arbitrary commands."
  //
  // So the list is derived, never fixed. Before a logo there is one sensible
  // thing to do; once a logo exists the useful move is putting it on
  // something; once a design exists the useful moves are refining it, trying
  // another surface, or selling it. Each phrase is one a person would actually
  // say, because it is sent verbatim into the conversation.
  const prompts: string[] = [];
  if (!hasLogo) {
    prompts.push("Make me a logo");
  } else if (!latestDesign) {
    prompts.push("Put my logo on a t-shirt", "Try it on a hoodie", "Show me a couple of other directions");
  } else {
    prompts.push("Make the logo smaller", "Make this more minimal", "Show me a couple of other directions");
    for (const sf of otherSurfaces.slice(0, 1)) prompts.push(`Try it on a ${sf.label.toLowerCase()} instead`);
    prompts.push("Add it to my store");
  }
  const surfaceLabel = (key: string) => SURFACES[key]?.label ?? key;

  // Bottom padding clears the docked J4 session (42vh) plus the tab bar.
  // Studio is always docked on a phone, so this is unconditional rather than a
  // guess — see J4Overlay's "docked" mode. Desktop docks to the side instead,
  // so it keeps the ordinary padding.
  return (
    <div className="min-h-screen bg-[#faf9f7] pb-[calc(42vh+9rem)] text-zinc-900 md:pb-32 dark:bg-[#17171a] dark:text-zinc-100">
      <div className="mx-auto max-w-5xl px-5 pt-8 lg:px-8">
        <header>
          <h1 className="text-[28px] font-semibold tracking-tight">Studio</h1>
          <p className="mt-1.5 max-w-lg text-[15px] text-zinc-600 dark:text-zinc-400">
            Where you and J4 make things for your business. Tell J4 what you want and it does the work.
          </p>
        </header>

        {/* THE WORK SURFACE. The most recent creation, large. This is the
            answer to "what did J4 just make me" and it should be readable from
            across a room, not a thumbnail in a grid. */}
        <section className="mt-7">
          {latest?.mockupUrl ? (
            <figure className="overflow-hidden rounded-2xl border border-black/[.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_32px_-12px_rgba(0,0,0,.18)] dark:border-white/[.09] dark:bg-[#222226]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={latest.mockupUrl}
                alt={`${surfaceLabel(latest.surface)} made in Studio`}
                className="aspect-[4/3] w-full bg-white object-contain dark:bg-[#eeeeef]"
              />
              <figcaption className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[.06] px-5 py-3.5 dark:border-white/[.08]">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium">{surfaceLabel(latest.surface)}</p>
                  <p className="text-[13px] text-zinc-500">
                    Made from {latest.assetIds.length === 1 ? "your logo" : `${latest.assetIds.length} of your assets`}
                    {latest.printFileUrl ? " · print file ready" : ""}
                  </p>
                </div>
                {/* Honest about where this is in its life. Approving and
                    sending it to the Storefront is the next real capability
                    (WORK_STUDIO.md) — this says so plainly rather than showing
                    a button that cannot yet do it. */}
                <span className="rounded-full bg-black/[.05] px-3 py-1 text-[12px] text-zinc-600 dark:bg-white/[.08] dark:text-zinc-300">
                  Ask J4 to change it, or to make another version
                </span>
              </figcaption>
            </figure>
          ) : (
            // The empty state is an invitation, not a report of absence. The
            // old one said "No logo yet", which described a missing file and
            // made this a storage screen.
            <div className="rounded-2xl border border-dashed border-black/[.12] bg-white/70 px-6 py-14 text-center dark:border-white/[.14] dark:bg-white/[.03]">
              <p className="text-[17px] font-medium">Nothing on the bench yet</p>
              <p className="mx-auto mt-2 max-w-md text-[15px] text-zinc-600 dark:text-zinc-400">
                Tap J4 and ask for something. It already knows your business, so it can start from
                what you sell and how you present it.
              </p>
            </div>
          )}
        </section>

        {/* Real controls now (2026-08-17). Clicking one sends that exact
            sentence into the conversation; there is no hard-coded design
            operation behind any of them, which is what keeps this a workshop
            rather than an editor with a chat box attached. Derived from what
            exists, so J4 is guiding rather than listing commands. */}
        <section className="mt-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            What J4 suggests next
          </h2>
          <StudioPrompts prompts={prompts} />
        </section>

        {/* What J4 has to work with. One row, not a media library — the asset
            library belongs to the Office, and rebuilding it here would make
            this a file browser with a nicer name. */}
        <section className="mt-9">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What J4 can use</h2>
          {assets.length === 0 ? (
            <p className="mt-3 max-w-lg text-[14px] text-zinc-600 dark:text-zinc-400">
              Nothing designated yet. Ask J4 to make you a logo, or upload one you already have and
              tell J4 it&apos;s yours — it will work with that one from then on.
            </p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-3">
              {assets.map(([role, asset]) => (
                <div
                  key={role}
                  className="flex items-center gap-3 rounded-xl border border-black/[.07] bg-white p-2.5 pr-4 dark:border-white/[.09] dark:bg-white/[.04]"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={asset.url} alt={role} className="h-11 w-11 rounded-lg bg-white object-contain" />
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium">{role === "brand.logo" ? "Your logo" : role}</p>
                    <p className="text-[12px] text-zinc-500">{asset.origin === "generated" ? "Made with J4" : "Yours"}</p>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* EVERYTHING EVER MADE, INCLUDING SUPERSEDED DIRECTIONS. Sean:
            "never destroy the original simply because J4 generated another
            direction." Nothing here is filtered out for being older — a
            direction the owner did not pick is still something they can point
            at and ask J4 to come back to. */}
        {earlier.length > 0 && (
          <section className="mt-9">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Everything you&apos;ve made · {designs.length}
            </h2>
            <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
              {earlier.map((design) => (
                <figure
                  key={design.id}
                  className="overflow-hidden rounded-xl border border-black/[.07] bg-white dark:border-white/[.09] dark:bg-white/[.04]"
                >
                  {design.mockupUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={design.mockupUrl}
                      alt={`${surfaceLabel(design.surface)} design`}
                      className="aspect-square w-full bg-white object-contain"
                    />
                  ) : (
                    <div className="aspect-square w-full bg-black/[.03] dark:bg-white/[.06]" />
                  )}
                  <figcaption className="px-3 py-2.5">
                    <p className="truncate text-[13px] font-medium">{surfaceLabel(design.surface)}</p>
                    <p className="text-[12px] text-zinc-500">
                      {design.assetIds.length === 1 ? "1 asset" : `${design.assetIds.length} assets`}
                    </p>
                  </figcaption>
                </figure>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
