import Link from "next/link";
import { requireBusinessPage, PERMISSIONS } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { creationAccessFor } from "@/lib/creation/provider";
import { CreationStationClient } from "./CreationStationClient";
import { GarmentShelf } from "./GarmentShelf";
import { CreationPortal } from "./CreationPortal";
import { creatableById, garmentsFor, portalItems } from "@/lib/creation/creatables";

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
  searchParams: Promise<{ garment?: string; kind?: string }>;
}) {
  const { slug } = await params;
  const { garment: garmentId, kind } = await searchParams;
  const { store } = await requireBusinessPage(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const basePath = businessBasePath(slug);

  const { provider, status } = await creationAccessFor(store.id);

  // ============ A CATALOGUE CALL THAT FAILS IS NOT "NO SUPPLIER" ========
  //
  // Sean, explicitly: do not send somebody to the connect screen when a
  // supplier is already connected. Two things were doing that.
  //
  // The first was creationAccessFor requiring status CONNECTED, which is
  // fixed at its source -- a NEEDS_ATTENTION integration still holds real
  // credentials and is worth trying.
  //
  // The second is here: listGarments talks to Printful's v2 catalogue over
  // the network, and anything that throws would have taken the whole page
  // down or, worse, been read as an empty catalogue. Caught, so the failure
  // can say what it actually is.
  let garments: Awaited<ReturnType<NonNullable<typeof provider>["listGarments"]>> = [];
  let catalogError: string | null = null;
  if (provider) {
    try {
      garments = await provider.listGarments({ storeId: store.id });
    } catch (error) {
      catalogError = error instanceof Error ? error.message : "Your supplier could not be reached.";
    }
  }

  // ============ THREE SCREENS, IN THE ORDER SOMEBODY THINKS ============
  //
  //   nothing named   the portal      "what do you want to create?"
  //   ?kind=          the blanks      "which hoodie?"
  //   ?garment=       the designer    "let's make it"
  //
  // Sean's distinction, and it is the whole shape of this page: the Creation
  // Station is not the designer. It is the doorway. The first question is
  // about intent and the second is about a product; collapsing them is what
  // made this open into an editor nobody had chosen to be in.
  //
  // The portal comes FIRST, before the supplier check, deliberately. "What do
  // you want to make?" is a question about intention, and a T-shirt is a
  // T-shirt whether or not this account has connected somebody who prints
  // them. What must stay honest is INVENTORY -- so the portal shows real
  // supplier photographs where there are any, says plainly where there are
  // none, and the supplier check happens at the step that actually needs one.
  if (!garmentId && !kind) {
    return (
      <CreationPortal items={portalItems(garments)} basePath={basePath} hasSupplier={provider !== null} />
    );
  }

  // NO CREDENTIALS AT ALL is the only case that means "connect one".
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

  // CONNECTED, AND SOMETHING WENT WRONG. Naming the supplier and its own
  // message is the difference between a person fixing it and a person
  // reconnecting something that was never disconnected.
  if (catalogError) {
    return (
      <Empty
        title="Your supplier didn't answer"
        body={`Printful is connected${
          status && status !== "CONNECTED" ? ` but its last check reported ${status.toLowerCase().replace("_", " ")}` : ""
        }. It said: ${catalogError}`}
        actionHref={`${basePath}/connections`}
        actionLabel="Check the connection"
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

    return <CreationStationClient slug={slug} garment={garment} assets={await artworkFor(store.id)} />;
  }

  // WHICH BLANK, now that the intention is known. Narrowed to the creatable
  // chosen in the portal, so somebody who said "hoodie" is not handed the
  // whole catalogue back.
  const creatable = kind ? creatableById(kind) : null;
  const shown = creatable ? garmentsFor(garments, creatable) : garments;

  if (shown.length === 0) {
    return (
      <Empty
        title={creatable ? `No ${creatable.label.toLowerCase()} blanks came back` : "No printable blanks came back"}
        body={
          creatable
            ? "Your supplier is connected but does not have this one, or does not print on it. Pick something else and we will carry on."
            : "Your supplier is connected but returned nothing that can be designed on. That is their catalogue rather than a problem here."
        }
        actionHref={`${basePath}/studio/create`}
        actionLabel="Choose something else"
      />
    );
  }

  // EXACTLY ONE MEANS THE QUESTION IS ALREADY ANSWERED. Showing a shelf of one
  // is asking somebody to choose between a single option.
  if (shown.length === 1) {
    return <CreationStationClient slug={slug} garment={shown[0]} assets={await artworkFor(store.id)} />;
  }

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-8">
      <h1 className="text-[22px] font-semibold">
        {creatable ? `Which ${creatable.label.toLowerCase()}?` : "What do you want to make?"}
      </h1>
      {/* CHOOSING IS PART OF CREATING. The shelf filters by the supplier's own
          garment type and manufacturer, so picking a blank is a decision about
          what you are making rather than scrolling until something looks
          right. Both facts are theirs — see GarmentShelf. */}
      <GarmentShelf garments={shown} basePath={basePath} />
    </div>
  );
}

/**
 * The business's own artwork.
 *
 * REAL UPLOADED ASSETS, nothing generated here and nothing stock. An owner
 * with none is told so in the workspace rather than handed graphics that are
 * not theirs.
 */
async function artworkFor(storeId: string): Promise<{ id: string; url: string; name: string }[]> {
  const assets = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    take: 24,
    select: { id: true, data: true },
  });

  return assets
    .map((record) => {
      const data = record.data as { storageUrl?: string; originalFilename?: string; fileType?: string } | null;
      if (!data?.storageUrl || data.fileType !== "photo") return null;
      return { id: record.id, url: data.storageUrl, name: data.originalFilename ?? "Artwork" };
    })
    .filter((a): a is { id: string; url: string; name: string } => a !== null);
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
