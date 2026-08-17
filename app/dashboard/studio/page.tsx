import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { prisma } from "@/lib/prisma";
import { currentAssetsByRole } from "@/lib/businessModel/assets";
import { DesignSchema } from "@/lib/businessModel/entities";
import { SURFACES } from "@/lib/design/surfaces";

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
// STILL NO CONTROLS. No toolbar, no handles, no sliders. The owner talks to J4
// through the orb that is already on every page, and this surface shows the
// result. The example phrases below are TEXT, not buttons, precisely because a
// button here that only opened a chat box would be a control pretending to be
// a capability.
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
  const earlier = designs.slice(1);
  const assets = Object.entries(assetsByRole);
  const surfaceLabel = (key: string) => SURFACES[key]?.label ?? key;

  return (
    <div className="min-h-screen bg-[#faf9f7] pb-32 text-zinc-900 dark:bg-[#17171a] dark:text-zinc-100">
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

        {/* What the owner can say. TEXT, not buttons — see the file comment.
            Written as things a person would actually say, and covering more
            than apparel so the room does not read as a t-shirt printer. */}
        <section className="mt-8">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Things to ask J4</h2>
          <ul className="mt-3 flex flex-wrap gap-2">
            {[
              "Make me a logo",
              "Put my logo on a t-shirt",
              "Try it on a hoodie instead",
              "Make the logo smaller",
              "Make this more minimal",
              "Show me a couple of other directions",
              "Create a product image for my storefront",
            ].map((phrase) => (
              <li
                key={phrase}
                className="rounded-full border border-black/[.08] bg-white px-3.5 py-1.5 text-[13px] text-zinc-700 dark:border-white/[.1] dark:bg-white/[.05] dark:text-zinc-300"
              >
                &ldquo;{phrase}&rdquo;
              </li>
            ))}
          </ul>
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
