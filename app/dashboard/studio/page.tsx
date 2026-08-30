import { PERMISSIONS, requireBusinessPageOrActive } from "@/lib/permissions";
import { declaredRead } from "@/lib/businessModel/declaredReads";
import { LEGACY_BUSINESS_BASE } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { currentAssetsByRole } from "@/lib/businessModel/assets";
import { AssetSchema } from "@/lib/businessModel/entities";
import { DesignSchema } from "@/lib/businessModel/entities";
import { SURFACES } from "@/lib/design/surfaces";
import { CreationCardRow, GRAPHICS_CARDS } from "./StudioCarousels";
import { StudioProductCarousel } from "./StudioProductCarousel";
import { StudioSocialCarousel } from "./StudioSocialCarousel";
import { socialDraftsFor } from "@/app/b/[slug]/studio/social/actions";
import { SOCIAL_PLATFORM_IDS } from "@/lib/social/platforms";
import { SavedDesigns } from "@/app/b/[slug]/studio/create/SavedDesigns";
import { savedDesignsFor } from "@/app/b/[slug]/studio/create/actions";
import { creationAccessFor } from "@/lib/creation/provider";
import { portalItems, savedByCreatable } from "@/lib/creation/creatables";
import { designHref } from "@/lib/creation/creationPresentation";
import type { Blank } from "@/lib/creation/garment";

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
// `basePath` stays on the signature and is deliberately not read any more: every
// link on this page is built from `creationBase`, which comes from the store this
// screen resolved rather than from the route that rendered it. That is what fixed
// the /dashboard/studio/create 404. Callers still pass it, and removing it from
// the type would just make the next surface guess.
export async function StudioScreen({ slug }: { slug?: string; basePath: string }) {
  const { store } = await requireBusinessPageOrActive(PERMISSIONS.STORE_MANAGE, slug);

  // ============ THE CREATION STATION IS BUSINESS-SCOPED (2026-08-27) =====
  //
  // A 404, found by Sean the moment he tapped either entry point.
  //
  // These links were `${basePath}/studio/create`, and basePath is "/dashboard"
  // on the legacy route -- which is where an account with one business
  // actually lands. There is no /dashboard/studio/create and there should not
  // be: the workspace resolves ONE business from the URL, which is the whole
  // reason /b/[slug] exists. /dashboard resolves the account's active business
  // instead, a per-account fact shared by every tab.
  //
  // So the href is built from the store this screen already resolved, and it
  // points into the business tree from both routes. That is the migration
  // direction rather than a workaround -- BUSINESS_CONTEXT.md has /dashboard
  // as legacy, and a new surface should not be added to it.
  // ============ THE CAROUSEL NEEDS THE BUSINESS PATH, NOT basePath ======
  //
  // basePath is "/dashboard" on the legacy route and there is no
  // /dashboard/studio/create — the 404 the comment above records. The portal
  // builds its own links, so it gets the business tree explicitly.
  const creationBase = `/b/${store.slug}`;

  // ============ REAL SUPPLIER INVENTORY, ON STUDIO ENTRY (2026-08-28) ===
  //
  // Sean: "I would rather have the carousel accurately reflect what the user's
  // connected supplier can actually produce than show products Genesis can't
  // fulfill. One supplier call on Studio entry is acceptable."
  //
  // listBlanks is the cheap one — a single request returning the whole
  // catalogue index — and it is the same call the Creation Station's doorway
  // already made. Studio now makes it instead of making the owner tap through
  // to a second screen to find out what can be made.
  //
  // Failure is a REPORTED state, not an empty list: an unreadable catalogue and
  // a supplier who makes nothing are different facts, and the portal says which
  // it is rather than showing a blank row.
  const creation = await creationAccessFor(store.id);
  let blanks: Blank[] = [];
  let catalogueUnreadable = false;
  if (creation.provider) {
    try {
      blanks = await creation.provider.listBlanks({ storeId: store.id });
    } catch {
      catalogueUnreadable = true;
    }
  }
  const savedDesigns = await savedDesignsFor(slug);

  // SAVED WORK, SORTED ONTO THE PRODUCT IT WAS MADE ON.
  //
  // Sean: "I don't think we need a separate 'Saved Designs' area that users
  // have to discover. Put the saved work directly into the creation flow for
  // each product." So the hoodie card offers the unfinished hoodies.
  //
  // `stranded` is the half that must not be dropped. A design whose blank is
  // not in the catalogue belongs to no card — and when the catalogue could not
  // be read at all, that is EVERY design. Rendering only the grouping would let
  // a supplier outage hide the owner's saved work and make the screen look like
  // they had never saved anything.
  const { byCreatable: savedFor, unmatched: stranded } = savedByCreatable(blanks, savedDesigns);

  // SOCIAL DRAFTS, SORTED ONTO THE PLATFORM THEY WERE WRITTEN FOR.
  //
  // The mirror of savedByCreatable, and simpler: a post records its own
  // platform, so there is no catalogue to join through and nothing can be
  // stranded by an outage. A draft whose platform is no longer in the registry
  // is dropped rather than shown under a heading that does not exist — the only
  // way that happens is a platform being removed, which is a deliberate act.
  const socialDrafts = await socialDraftsFor(slug);
  const socialFor: Record<string, typeof socialDrafts> = {};
  for (const draft of socialDrafts) {
    // A PIECE APPEARS UNDER EVERY PLATFORM IT TARGETS. One creation going to
    // three platforms is findable from all three cards, because somebody
    // looking for "the Instagram one" does not remember it was also a TikTok.
    for (const platform of draft.platforms) {
      if (!SOCIAL_PLATFORM_IDS.includes(platform)) continue;
      (socialFor[platform] ??= []).push(draft);
    }
  }

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

  const earlier = designs.slice(1);
  const assets = Object.entries(assetsByRole);
  // THE CHIP CATALOGUE THAT USED TO BE BUILT HERE IS GONE (2026-08-28).
  //
  // Roughly thirty prefilled sentences were derived on every render — one per
  // surface, per logo state, per upload role — to feed a wall of buttons Sean
  // has now taken off this page. The derivation went with them rather than
  // being left computing something nobody reads.
  //
  // StudioActions.tsx and every capability behind it are untouched. See the
  // note where the section used to render.

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
        {/* ============ THE HIERARCHY CHANGED (2026-08-27, again 08-28) ==
            Sean, after using this on a phone: Studio reads as a menu of things
            J4 can make, and that is too small a description of what this is.
            "Tell J4 what you want and it does the work" makes asking the whole
            product; the point is that the owner can BUILD here, with J4
            alongside them.

            So creating leads, and everything J4 can do is a way into it rather
            than the definition of it. The second pass named the place and the
            two paths through it — see the header below. */}
        {/* ============ STUDIO IS THE CREATION EXPERIENCE (2026-08-28) ==
            Sean: "When I tap Studio, I don't think we should land on the
            current 'Create something / Nothing on the bench yet' page at all.
            That page is an unnecessary intermediary... Think of Studio as 'What
            do you want to make?' — not 'Do you want to enter the place where
            you can make something?'"

            So the intermediary is gone: what a person lands on is the things
            they can make. The immersive carousel at /studio/create is
            deliberately UNTOUCHED — Sean: "I don't want to sacrifice that
            experience just to make the Studio landing page work" — and this
            screen is a second presentation of the same catalogue, not a second
            copy of it. Where a card links and whether a supplier can make the
            thing both come from lib/creation/creationPresentation.ts, which the
            doorway reads too.

            What is NOT changed is anything the carousel opens into. Tapping a
            card still pushes ?kind=<id> and reaches the same verified editor,
            with the same composition, flattening, Save and Create underneath
            it. This is an entry-point change. */}
        {/* ============ TWO PRIMARY PATHS, BOTH ABOVE THE FOLD ==========
            Sean: "I don't want the user to have to scroll to discover that
            Studio does BOTH product creation and social-media creation... I
            don't want someone to see the first product carousel and assume
            Studio is only for making merchandise."

            The subtitle carries that on its own, before a single card has been
            read: it names both paths in one sentence, so the answer to "what is
            this place for" does not depend on how tall the first row happens to
            be on somebody's phone. The section headings then make each path
            unmistakable rather than implied. */}
        <header>
          <h1 className="text-[28px] font-semibold tracking-tight">Creation Station</h1>
          <p className="mt-1.5 max-w-lg text-[15px] text-zinc-600 dark:text-zinc-400">
            Create products and social content for your business.
          </p>
        </header>

        {/* ============ THE ORDER IS DATA, NOT LAYOUT (2026-08-28) =======
            Sean: "The adaptive ordering we discussed should still work later —
            J4 can put Social first for a business that primarily uses social
            creation — but regardless of which comes first, both categories
            should be clearly labeled and visible."

            So the categories are a list that gets rendered in the order it is
            in, and reordering them later is a change to this array rather than
            a change to any markup. Each one carries its own heading, so no
            category can become the unlabelled default just by being first.

            NOT IMPLEMENTED YET, deliberately: the order is fixed here, and
            nothing reads usage to choose it. What this buys is that adding the
            adaptive rule later cannot require moving JSX around, which is where
            a labelled section quietly loses its label. */}
        {[
          {
            key: "product",
            title: "Product creation",
            blurb: "Put your artwork on something people can buy.",
            content: (
              <StudioProductCarousel
                items={portalItems(blanks)}
                basePath={creationBase}
                hasSupplier={creation.provider !== null}
                catalogueUnreadable={catalogueUnreadable}
                savedFor={savedFor}
              />
            ),
          },
          {
            key: "social",
            title: "Social creation",
            blurb: "J4 writes it for the platform you pick, not one caption for all of them.",
            content: <StudioSocialCarousel basePath={creationBase} draftsFor={socialFor} />,
          },
          {
            key: "graphics",
            title: "Graphics",
            blurb: "Something to promote, share or print.",
            content: <CreationCardRow cards={GRAPHICS_CARDS} />,
          },
        ].map((section) => (
          <section key={section.key} className="mt-8">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
              {section.title}
            </h2>
            <p className="mt-1 text-[13px] text-zinc-500">{section.blurb}</p>
            {section.content}
          </section>
        ))}

        {stranded.length > 0 && (
          <section className="mt-9">
            {/* ============ ONLY WHAT NO CARD COULD CLAIM ================
                Saved work now lives on the product it was made on, so this is
                normally empty and renders nothing. It exists for the designs
                that could not be matched to a card — which is all of them when
                the supplier's catalogue could not be read.

                That is the whole point of keeping it: without this section, an
                outage at the supplier would make somebody's saved designs
                vanish from the screen with no explanation. Reopening one does
                not need the catalogue, so the work stays reachable. */}
            <SavedDesigns
              designs={stranded}
              hrefFor={(d) => designHref(creationBase, d.externalProductId, d.draftId)}
            />
          </section>
        )}

        {/* ============ THE CHIPS CAME OFF (2026-08-28) =================
            Sean: "The old Studio action sections need to come off this page
            entirely... Do not delete the underlying capabilities. Those are
            things J4 can suggest or initiate contextually. They should not
            clutter the primary Studio navigation. Studio should feel like a
            creation workspace, not a giant list of prompts."

            So roughly thirty prefilled sentences — upload a logo, refine my
            logo, put my logo on a cap, what would you improve about my store —
            are no longer rendered here. Every one of them was a way of TELLING
            J4 something, which is what the conversation is for; a workspace
            that opens with a wall of prompts is a menu of commands wearing a
            workshop's name.

            NOTHING WAS DELETED. StudioActions.tsx still exists, still works and
            still carries the upload-with-a-stated-role behaviour that made the
            chips worth having — the owner naming what they are uploading is a
            real fact the chat path cannot supply. It simply is not this page's
            navigation any more. If those belong anywhere, it is somewhere J4
            offers them because it noticed a reason to. */}

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
              {/* "Upload a logo above" pointed at the chip row, which came off
                  this page on 2026-08-28. A sentence that directs somebody to a
                  control that no longer exists is worse than no sentence. */}
              Nothing designated yet. Ask J4 for a logo, or drop one into the conversation, and it
              will be used everywhere your brand shows up.
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
