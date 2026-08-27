import Link from "next/link";
import { requireBusinessPage, PERMISSIONS } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { creationProviderFor } from "@/lib/creation/provider";
import { CreationStationClient } from "./CreationStationClient";
import { GarmentShelf } from "./GarmentShelf";

// THE CREATION STATION, FOR ONE BUSINESS.
//
// ============ EVERY GARMENT HERE IS A REAL ONE ==========================
//
// The blanks, their colours, their sizes and their print areas all come from
// the supplier this business has actually connected. There is no seeded
// catalogue and no placeholder T-shirt: a business with no print supplier gets
// told so, with the way to fix it, rather than a design tool that produces
// something nobody can order.
//
// That is the same rule lib/sourcing/aliexpress.ts holds about inventing a
// catalogue, and it is why this page can be empty. An empty state that names
// its cause is worth more than a populated one that lies.

export const metadata = { title: "Creation Station" };

export default async function CreationStationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ garment?: string }>;
}) {
  const { slug } = await params;
  const { garment: garmentId } = await searchParams;
  const { store } = await requireBusinessPage(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const basePath = businessBasePath(slug);

  const provider = await creationProviderFor(store.id);

  if (!provider) {
    return (
      <Empty
        title="Connect a print supplier to start designing"
        body="The Creation Station works from your supplier's real catalogue — their blanks, their colours, their print areas. Connect one and every garment they make becomes something you can design on."
        actionHref={`${basePath}/connections`}
        actionLabel="Go to connections"
      />
    );
  }

  // One garment in full when the owner has chosen one; otherwise the shelf.
  if (garmentId) {
    const garment = await provider.getGarment({ storeId: store.id, externalProductId: garmentId });
    if (!garment) {
      return (
        <Empty
          title="That blank isn't available"
          body="Your supplier no longer lists it, or it can't be printed on. Pick another one."
          actionHref={`${basePath}/studio/create`}
          actionLabel="Choose a garment"
        />
      );
    }

    // The business's own artwork — real uploaded assets, nothing generated
    // here. An owner with none is told so rather than shown stock graphics.
    const assets = await prisma.businessRecord.findMany({
      where: { storeId: store.id, entityType: "asset" },
      orderBy: { syncedAt: "desc" },
      take: 24,
      select: { id: true, data: true },
    });

    const artwork = assets
      .map((record) => {
        const data = record.data as { storageUrl?: string; originalFilename?: string; fileType?: string } | null;
        if (!data?.storageUrl || data.fileType !== "photo") return null;
        return { id: record.id, url: data.storageUrl, name: data.originalFilename ?? "Artwork" };
      })
      .filter((a): a is { id: string; url: string; name: string } => a !== null);

    return <CreationStationClient slug={slug} garment={garment} assets={artwork} />;
  }

  const garments = await provider.listGarments({ storeId: store.id });

  if (garments.length === 0) {
    return (
      <Empty
        title="No printable blanks came back"
        body="Your supplier is connected but returned nothing that can be designed on. That is their catalogue rather than a problem here — try again shortly."
        actionHref={`${basePath}/studio`}
        actionLabel="Back to the studio"
      />
    );
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8">
      <h1 className="text-[22px] font-semibold">What do you want to make?</h1>
      {/* CHOOSING IS PART OF CREATING. The shelf filters by the supplier's own
          garment type and manufacturer, so picking a blank is a decision about
          what you are making rather than scrolling until something looks
          right. Both facts are theirs — see GarmentShelf. */}
      <GarmentShelf garments={garments} basePath={basePath} />
    </div>
  );
}

function Empty({
  title,
  body,
  actionHref,
  actionLabel,
}: {
  title: string;
  body: string;
  actionHref: string;
  actionLabel: string;
}) {
  return (
    <div className="mx-auto w-full max-w-lg px-5 py-16 text-center">
      <h1 className="text-[20px] font-semibold">{title}</h1>
      <p className="mt-2 text-[14px] text-zinc-600 dark:text-zinc-400">{body}</p>
      <Link
        href={actionHref}
        className="mt-6 inline-block rounded-full bg-[var(--brand-accent,#6366f1)] px-5 py-2.5 text-[14px] font-medium text-white"
      >
        {actionLabel}
      </Link>
    </div>
  );
}
