import { PERMISSIONS, requireStorePageAccess } from "@/lib/permissions";
import { DEFAULT_THEME, themeCssVars, type Theme } from "@/lib/theme";
import { prisma } from "@/lib/prisma";
import { ASSET_ROLES, resolveCurrentAsset } from "@/lib/businessModel/assets";
import { DesignSchema } from "@/lib/businessModel/entities";
import { SURFACES } from "@/lib/design/surfaces";

// The Studio — the workbench (2026-08-16).
//
// Sean: "The owner should be able to describe what they want and J4 should do
// the work... not operating a traditional design editor." So this page has NO
// design controls. No canvas, no layer panel, no placement handles. It shows
// what J4 and the owner have made and what J4 can make next, and the making
// happens in conversation through the orb that is already on every page.
//
// That is not a simplification to be filled in later. A control here is a
// control the owner has to learn, and every one of them is a way of saying
// "actually, you do it" to someone who was told J4 would.
//
// Everything on this page is real: designs are `design` BusinessRecords
// written by lib/design/createDesign.ts, and the logo is the designated
// brand.logo Asset. Nothing is a placeholder — if there is nothing here, the
// page says so plainly rather than showing an example of what might appear.

export default async function StudioPage() {
  const { store } = await requireStorePageAccess(PERMISSIONS.STORE_MANAGE);
  const theme = (store.theme as Theme | null) ?? DEFAULT_THEME;

  const [logo, designRows] = await Promise.all([
    resolveCurrentAsset(store.id, ASSET_ROLES.brandLogo),
    prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "design" },
      orderBy: { syncedAt: "desc" },
      take: 24,
      select: { id: true, data: true },
    }),
  ]);

  const designs = designRows
    .map((row) => ({ id: row.id, parsed: DesignSchema.safeParse(row.data) }))
    .filter((d): d is { id: string; parsed: { success: true; data: import("zod").infer<typeof DesignSchema> } } => d.parsed.success)
    .map((d) => ({ id: d.id, ...d.parsed.data }));

  return (
    <div style={themeCssVars(theme)} className="min-h-screen p-6 pb-32 lg:min-h-0 lg:p-8">
      <h1 className="text-2xl font-semibold text-black dark:text-zinc-50">Studio</h1>
      <p className="mt-2 max-w-xl text-sm text-zinc-600 dark:text-zinc-400">
        Where you and J4 make things. Ask for what you want and J4 does the work.
      </p>

      {/* What J4 has to work with. One line, not a media manager — the asset
          library is Office's concern, and duplicating it here would make this
          a file browser with a nicer name. */}
      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">What J4 can use</h2>
        <div className="mt-3 flex items-center gap-3 rounded-xl border border-black/[.08] bg-black/[.02] p-4 dark:border-white/[.145] dark:bg-white/[.03]">
          {logo ? (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={logo.url}
                alt="Your brand logo"
                className="h-12 w-12 shrink-0 rounded-lg object-cover"
              />
              <div className="min-w-0">
                <p className="text-sm font-medium text-black dark:text-zinc-50">Your logo</p>
                <p className="text-xs text-zinc-500">Ready to use. Say &ldquo;put my logo on a t-shirt&rdquo; and J4 will.</p>
              </div>
            </>
          ) : (
            <div>
              <p className="text-sm font-medium text-black dark:text-zinc-50">No logo yet</p>
              {/* The offer, stated once and never repeated. See WORK_STUDIO.md's
                  no-pressure rule: this is a sentence the owner can ignore. */}
              <p className="text-xs text-zinc-500">
                Ask J4 to make one and it will use what it already knows about your business.
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          What you&apos;ve made {designs.length > 0 ? `· ${designs.length}` : ""}
        </h2>

        {designs.length === 0 ? (
          <p className="mt-3 max-w-xl text-sm text-zinc-500">
            Nothing yet. Tap J4 and tell it what you want to make — {Object.values(SURFACES)
              .map((s) => s.label.toLowerCase())
              .join(", ")}{" "}
            to start with, and more surfaces as they arrive.
          </p>
        ) : (
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {designs.map((design) => (
              <figure
                key={design.id}
                className="overflow-hidden rounded-xl border border-black/[.08] bg-black/[.02] dark:border-white/[.145] dark:bg-white/[.03]"
              >
                {design.mockupUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={design.mockupUrl}
                    alt={`${SURFACES[design.surface]?.label ?? design.surface} design`}
                    className="aspect-square w-full object-cover"
                  />
                ) : (
                  <div className="aspect-square w-full bg-black/[.04] dark:bg-white/[.06]" />
                )}
                <figcaption className="p-3">
                  <p className="text-sm font-medium text-black dark:text-zinc-50">
                    {SURFACES[design.surface]?.label ?? design.surface}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {design.assetIds.length === 1 ? "1 asset" : `${design.assetIds.length} assets`}
                    {design.printFileUrl ? " · print file ready" : ""}
                  </p>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
