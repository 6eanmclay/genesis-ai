import Link from "next/link";
import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { declaredRead } from "@/lib/businessModel/declaredReads";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { currentAssetsByRole } from "@/lib/businessModel/assets";
import { AssetSchema } from "@/lib/businessModel/entities";
import { DesignSchema } from "@/lib/businessModel/entities";
import { SURFACES, surfacesByCategory } from "@/lib/design/surfaces";
import { StudioActions, type StudioCategory } from "./StudioActions";
import { uploadBusinessAssetFromChat } from "../ai-actions";

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

// MIGRATED to explicit business context (2026-08-20, BUSINESS_CONTEXT.md Phase
// C). The screen is unchanged. What changed is where it gets its business: a
// `slug` means it was reached at /b/[slug] and that business is authoritative;
// no slug means the legacy /dashboard route, which resolves the account's active
// business exactly as before.
//
// `basePath` is what every link inside uses, so a page rendered for one business
// never links into another.
export async function StudioScreen({ slug, basePath }: { slug?: string; basePath: string }) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);

  const [assetsByRole, designRows, assetRows] = await Promise.all([
    declaredRead("presentation", "the studio lists assets by role; it does not reason", () =>
      currentAssetsByRole(store.id)
    ),
    prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "design" },
      orderBy: { syncedAt: "desc" },
      take: 24,
      select: { id: true, data: true, syncedAt: true },
    }),
    prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "asset" },
      orderBy: { syncedAt: "desc" },
      take: 60,
      select: { id: true, data: true },
    }),
  ]);

  // THE LIBRARY: what J4 has to work with, split by who made it.
  //
  // Sean: "clearly showing what the owner provided versus what J4 created."
  // That split is already in the data — assets record `origin` — so this is a
  // read of the existing model rather than anything new. Blank product bases
  // are excluded: they are scaffolding the compositor generated, not material
  // the owner would recognise as theirs.
  const library = assetRows
    .map((row) => ({ id: row.id, parsed: AssetSchema.safeParse(row.data) }))
    .flatMap((a) => (a.parsed.success ? [{ id: a.id, ...a.parsed.data }] : []))
    .filter((a) => a.fileType === "photo" && !a.role?.startsWith("surface.") && !a.supersededByAssetId);
  const provided = library.filter((a) => a.origin === "uploaded" || a.origin === "backfilled");
  const madeByJ4 = library.filter((a) => a.origin === "generated");

  const designs = designRows
    .map((row) => ({ id: row.id, parsed: DesignSchema.safeParse(row.data) }))
    .flatMap((d) => (d.parsed.success ? [{ id: d.id, ...d.parsed.data }] : []));

  const latest = designs[0] ?? null;
  const earlier = designs.slice(1);
  const assets = Object.entries(assetsByRole);
  const hasLogo = Boolean(assetsByRole["brand.logo"]);

  // WHAT J4 CAN HELP WITH, grouped and ordered (2026-08-18, second pass).
  //
  // BRING YOUR OWN LEADS, on Sean's call: "users need to immediately understand
  // that they can bring their own creative materials into Studio." A workshop
  // where the first thing offered is "let me make you one" reads as a
  // generator; one that opens with "bring what you have" reads as a workshop.
  //
  // Product suggestions are DERIVED FROM THE SURFACE REGISTRY, one chip per
  // garment, never the same surface twice. The first version hardcoded a
  // t-shirt chip and then appended "the next surface", which produced two
  // t-shirt chips whenever the last design happened to be a hoodie. A
  // recommendation list that offers the same action twice is not a list of
  // options, it is a bug with good manners.
  // PRODUCTS OPENS INTO THE CATALOGUE, not a handful of chips. Sean: "Products
  // should open into product categories rather than exposing a handful of
  // hardcoded recommendations." So the visible chips are the CATEGORIES, and
  // More reveals real surfaces within them — all read from the registry, so a
  // new product appears here the day it is added with no change to this file.
  const catalogue = surfacesByCategory();
  const productPrimary = hasLogo
    ? catalogue.slice(0, 3).map((c) => `Put my logo on ${c.surfaces[0].label.toLowerCase()}`)
    : ["Make me a logo first"];
  const productMore = hasLogo
    ? catalogue.flatMap((c) => c.surfaces.slice(1, 3).map((sf) => `Put my logo on a ${sf.label.toLowerCase()}`)).slice(0, 10)
    : [];

  const categories: StudioCategory[] = [
    {
      // Upload chips carry their own label through as the owner's stated
      // intent, so J4 knows whether it received a logo, a product photo or
      // lifestyle imagery rather than just "a file".
      key: "upload",
      label: "Bring your own",
      primary: ["Upload a logo", "Upload product photos", "Upload lifestyle photos"],
      more: ["Upload photos for social", "Upload other business images"],
      // The owner naming what they are uploading is the whole point of the
      // chips: ingestBusinessAsset records role null because a chat upload has
      // nobody saying what it is for, and here somebody has. "Other business
      // images" carries no role deliberately — they did not say.
      roles: {
        "Upload a logo": "logo",
        "Upload product photos": "product",
        "Upload lifestyle photos": "lifestyle",
        "Upload photos for social": "social",
      },
    },
    {
      key: "logo",
      label: "Logo",
      primary: hasLogo
        ? ["Refine my logo", "Show me different directions"]
        : ["Make me a logo", "Show me a couple of directions"],
      more: hasLogo
        ? ["Make me a new logo", "Make it more minimal", "Make it work better at small sizes"]
        : ["I already have a logo I want to use"],
    },
    {
      key: "products",
      label: "Products",
      primary: productPrimary,
      more: productMore,
    },
    {
      key: "website",
      label: "Website",
      primary: ["What would you improve about my store?", "Create a hero section"],
      more: ["Build a product section", "Group my products into collections", "Make the storefront feel more premium"],
    },
    {
      key: "graphics",
      label: "Graphics",
      primary: ["Create a collage", "Make a promotional graphic"],
      more: ["Create a product image for my storefront", "Create social content", "Show me a couple of other directions"],
    },
  ];

  const surfaceLabel = (key: string) => SURFACES[key]?.label ?? key;

  // NO GROUND OF ITS OWN (2026-08-22). The root below painted bg-[#faf9f7] /
  // dark:bg-[#17171a] across its full height, covering the ground
  // DashboardShell had already resolved for the Studio room — so Studio's
  // locked character ("the darkest room, so work in progress is the light
  // source") was never once visible to an owner.
  //
  // Decision 1 of the room architecture prohibits exactly this: "no per-page
  // styling. A screen that painted its own ground is how three rooms quietly
  // become three products." Found by asserting that what the owner SEES is the
  // ground the room resolved — the earlier check only compared rooms to each
  // other, and passed, because a self-painted ground is still distinct.
  //
  // The text colours stay. Those are content, not ground.
  return (
    <div className="min-h-screen pb-32 text-zinc-900 dark:text-zinc-100">
      <div className="mx-auto max-w-5xl px-5 pt-8 lg:px-8">
        {/* ============ THE HIERARCHY CHANGED (2026-08-27) ==============
            Sean, after using this on a phone: Studio reads as a menu of things
            J4 can make, and that is too small a description of what this is.
            "Tell J4 what you want and it does the work" makes asking the whole
            product; the point is that the owner can BUILD here, with J4
            alongside them.

            So creating leads, and everything J4 can do is a way into it rather
            than the definition of it. */}
        <header>
          <h1 className="text-[28px] font-semibold tracking-tight">Studio</h1>
          <p className="mt-1.5 max-w-lg text-[15px] text-zinc-600 dark:text-zinc-400">
            Where you make things for your business. Design them yourself, with J4 alongside you.
          </p>

          <Link
            href={`${basePath}/studio/create`}
            className="mt-5 inline-flex items-center gap-2 rounded-full bg-zinc-900 px-5 py-2.5 text-[15px] font-medium text-white transition hover:opacity-90 dark:bg-white dark:text-black"
          >
            Create something
          </Link>
        </header>

        {/* THE WORK SURFACE. The most recent creation, large. This is the
            answer to "what did J4 just make me" and it should be readable from
            across a room, not a thumbnail in a grid. */}
        <section className="mt-7">
          {latest?.mockupUrl ? (
            /* ============ THE CARD IS THE DOOR (2026-08-27) ==============
               Sean's own words: seeing the generated hoodie and being able to
               tap into the full creation experience is far more intuitive than
               a separate URL nobody knows exists.
       
               So the thing on the bench is not a report any more, it is the way
               in. What it opens is the workspace, where this can be taken
               apart and rebuilt rather than only asked about. */
            <Link
              href={`${basePath}/studio/create`}
              className="group block overflow-hidden rounded-2xl border border-black/[.07] bg-white shadow-[0_1px_2px_rgba(0,0,0,.04),0_12px_32px_-12px_rgba(0,0,0,.18)] transition hover:border-black/20 dark:border-white/[.09] dark:bg-[#222226] dark:hover:border-white/30">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={latest.mockupUrl}
                alt={`${surfaceLabel(latest.surface)} made in Studio`}
                className="aspect-[4/3] w-full bg-white object-contain dark:bg-[#eeeeef]"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-black/[.06] px-5 py-3.5 dark:border-white/[.08]">
                <div className="min-w-0">
                  <p className="text-[15px] font-medium">{surfaceLabel(latest.surface)}</p>
                  <p className="text-[13px] text-zinc-500">
                    Made from {latest.assetIds.length === 1 ? "your logo" : `${latest.assetIds.length} of your assets`}
                    {latest.printFileUrl ? " · print file ready" : ""}
                  </p>
                </div>
                {/* WHAT TAPPING DOES, said plainly. The old copy -- "ask
                    J4 to change it" -- described the only thing that used to
                    be possible, and describing it kept it the only thing. */}
                <span className="rounded-full bg-black/[.05] px-3 py-1 text-[12px] text-zinc-600 transition group-hover:bg-black/[.09] dark:bg-white/[.08] dark:text-zinc-300 dark:group-hover:bg-white/[.14]">
                  Open in Creation Station
                </span>
              </div>
            </Link>
          ) : (
            // The empty state is an invitation, not a report of absence. The
            // old one said "No logo yet", which described a missing file and
            // made this a storage screen.
            <div className="rounded-2xl border border-dashed border-black/[.12] bg-white/70 px-6 py-14 text-center dark:border-white/[.14] dark:bg-white/[.03]">
              <p className="text-[17px] font-medium">Nothing on the bench yet</p>
              <p className="mx-auto mt-2 max-w-md text-[15px] text-zinc-600 dark:text-zinc-400">
                Start something in the Creation Station, or ask J4 — it already knows your business,
                so it can start from what you sell and how you present it.
              </p>
              <Link
                href={`${basePath}/studio/create`}
                className="mt-5 inline-block rounded-full bg-zinc-900 px-5 py-2.5 text-[15px] font-medium text-white dark:bg-white dark:text-black"
              >
                Create something
              </Link>
            </div>
          )}
        </section>

        {/* Real controls now (2026-08-17). Clicking one sends that exact
            sentence into the conversation; there is no hard-coded design
            operation behind any of them, which is what keeps this a workshop
            rather than an editor with a chat box attached. Derived from what
            exists, so J4 is guiding rather than listing commands. */}
        <section className="mt-8">
          {/* SHORTCUTS INTO CREATING, not the description of it. Somebody
              who knows what they want says it here; somebody who wants to
              experiment opens the workspace above. Both are creating. */}
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            Or tell J4 what you want
          </h2>
          <StudioActions
            categories={categories}
            uploadAsset={uploadBusinessAssetFromChat}
            currentPath={`${basePath}/studio`}
          />
        </section>

        {/* What J4 has to work with. One row, not a media library — the asset
            library belongs to the Office, and rebuilding it here would make
            this a file browser with a nicer name. */}
        {/* WHAT J4 CAN WORK WITH, split by who made it. Roles first, because a
            designated asset is the one J4 will reach for by name — "put my logo
            on a hoodie" resolves to whatever holds brand.logo. */}
        <section className="mt-9">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">What J4 can use</h2>
          {assets.length === 0 ? (
            <p className="mt-3 max-w-lg text-[14px] text-zinc-600 dark:text-zinc-400">
              Nothing designated yet. Upload a logo above, or ask J4 to make you one, and it will be
              used everywhere your brand shows up.
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

        {(provided.length > 0 || madeByJ4.length > 0) && (
          <section className="mt-9">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              Your library · {library.length}
            </h2>
            <div className="mt-3 grid gap-6 sm:grid-cols-2">
              {[
                { label: "You provided", items: provided, empty: "Nothing uploaded yet." },
                { label: "J4 created", items: madeByJ4, empty: "Nothing made yet." },
              ].map((group) => (
                <div key={group.label}>
                  <p className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                    {group.label} · {group.items.length}
                  </p>
                  {group.items.length === 0 ? (
                    <p className="mt-2 text-[13px] text-zinc-500">{group.empty}</p>
                  ) : (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {group.items.slice(0, 12).map((asset) => (
                        <figure
                          key={asset.id}
                          className="w-[68px] overflow-hidden rounded-lg border border-black/[.07] bg-white dark:border-white/[.09] dark:bg-white/[.04]"
                          title={`${asset.summary ?? asset.originalFilename}${asset.role ? ` (${asset.role})` : ""}`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={asset.storageUrl} alt={asset.summary ?? asset.originalFilename} className="aspect-square w-full bg-white object-contain" />
                          {asset.role && (
                            <figcaption className="truncate px-1.5 py-1 text-[10px] text-zinc-500">
                              {asset.role.split(".")[1]}
                            </figcaption>
                          )}
                        </figure>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}

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


// The legacy route — resolves the account's ACTIVE business and renders the same
// screen /b/<slug>/studio renders. Preserved rather than redirected: existing
// links and bookmarks point here.
export default async function StudioPage() {
  return StudioScreen({ basePath: LEGACY_BUSINESS_BASE });
}
