import Link from "next/link";
import { requireBusinessPage, PERMISSIONS } from "@/lib/permissions";
import { businessBasePath } from "@/lib/dashboard/navConfig";
import { prisma } from "@/lib/prisma";
import { creationAccessFor } from "@/lib/creation/provider";
import { CreationStationClient } from "./CreationStationClient";
import { GarmentShelf } from "./GarmentShelf";
import { CreationPortal } from "./CreationPortal";
import { SupplierStep } from "./SupplierStep";
import { getConnector } from "@/lib/integrations/registry";
import { creationSupplierConfigured, getCreationSuppliers } from "@/lib/creation/registry";
import { connectExecutable } from "@/lib/execution/adapters/integrationExecutable";
import { creatableById, blanksFor, portalItems } from "@/lib/creation/creatables";
import type { Blank, BlankImage } from "@/lib/creation/garment";
import type { ProductDesign } from "@/lib/creation/design";
import type { Asset } from "@/lib/businessModel/entities";
import { libraryFrom, type LibraryAsset } from "@/lib/creation/assetLibrary";
import { savedDesignsFor, loadDesignDraft } from "./actions";
import { SavedDesigns } from "./SavedDesigns";

/**
 * A saved design the owner came back to, as props for the editor.
 *
 * Returns nothing when the draft is gone or belongs to a different blank —
 * reopening a design onto the wrong garment would silently move artwork
 * between print areas that are not the same shape.
 */
async function reopened(
  storeId: string,
  draftId: string,
): Promise<{ initialDraftId?: string; initialDesign?: ProductDesign; initialName?: string; initialPriceInCents?: number | null }> {
  const draft = await loadDesignDraft(storeId, draftId);
  if (!draft) return {};
  return {
    initialDraftId: draftId,
    initialDesign: draft.design,
    initialName: draft.name,
    initialPriceInCents: draft.retailPriceInCents,
  };
}

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

/**
 * The supplier's transparent blanks for one product, and why there are none.
 *
 * ONE MORE REQUEST, AND ONLY THE CANVAS MAKES IT. A shelf of twelve does not
 * need blank imagery, and paying for twelve of these to draw a grid is how the
 * rate limit was hit the first time.
 *
 * ============ THE CATCH THAT HID THE BUG (2026-08-27) ==================
 *
 * This swallowed the error and returned an empty list, so that the designer
 * would survive a picture failing to load. What it actually did was make a
 * broken data path indistinguishable from a supplier who publishes no blanks
 * — and when the first live run produced no blank at all, the screen said
 * nothing was wrong. Sean had told me not to do exactly this, and I did it
 * anyway, one file away from where I wrote the rule down.
 *
 * The reason survives now. A failure still does not take the page down — the
 * canvas falls back to a drawn object — but it arrives WITH the reason, and
 * the screen says which of the two happened.
 */
async function blankImagesFor(
  provider: NonNullable<Awaited<ReturnType<typeof creationAccessFor>>["provider"]>,
  storeId: string,
  externalProductId: string,
): Promise<{ images: BlankImage[]; problem: string | null }> {
  try {
    return { images: await provider.getBlankImages({ storeId, externalProductId }), problem: null };
  } catch (error) {
    return {
      images: [],
      problem: error instanceof Error ? error.message : "Your supplier's blank images could not be read.",
    };
  }
}

/**
 * What the supplier charges, keyed by external variant id.
 *
 * A failure is an empty map rather than a dead page — a price that cannot be
 * fetched leaves the field blank and says "supplier price unavailable", which
 * is the honest version of the $75 that used to appear instead.
 */
async function supplierPricesFor(
  provider: NonNullable<Awaited<ReturnType<typeof creationAccessFor>>["provider"]>,
  storeId: string,
  externalProductId: string,
): Promise<Record<string, number>> {
  try {
    return await provider.getSupplierPrices({ storeId, externalProductId });
  } catch {
    return {};
  }
}

export default async function CreationStationPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ garment?: string; kind?: string; integration_error?: string; design?: string }>;
}) {
  const { slug } = await params;
  const { garment: garmentId, kind, integration_error: integrationError, design: draftId } = await searchParams;
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
  // The second is here: the catalogue call talks to Printful over the network,
  // and anything that throws would have taken the whole page down or, worse,
  // been read as an empty catalogue. Caught, so the failure can say what it
  // actually is.
  //
  // ============ ONE INDEX CALL, NOT FORTY-NINE (2026-08-27) ============
  //
  // This used to build FULL garments — every colour, size and print area, two
  // Printful requests each — for two dozen blanks, on every load of every
  // screen here. The portal used that to show five photographs. The shelf used
  // it to show two hoodies. Printful's answer, in its own words:
  //
  //     Rate limit exceeded. You have 0 out of 120 requests remaining.
  //
  // The index carries id, name, type and a photograph, which is everything
  // both of those screens need. So the index is fetched once, and the
  // expensive call runs only on the blanks somebody is actually about to see.
  let blanks: Blank[] = [];
  let catalogError: string | null = null;
  if (provider) {
    try {
      blanks = await provider.listBlanks({ storeId: store.id });
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
    // ============ THE PORTAL DOES NOT CALL THE SUPPLIER ================
    //
    // It used to fetch a transparent blank per intention — five requests on
    // top of the index — so the doorway could show real Printful imagery.
    // Sean's call after seeing it: the carousel is a Genesis-branded discovery
    // experience, and the real product begins in the editor.
    //
    // That is a better transition AND five fewer requests against a rate limit
    // this screen has already exhausted once. The index is still read, because
    // WHAT CAN BE MADE is a fact about the supplier even when the picture is
    // ours.
    // THE DOORWAY IS WHERE UNFINISHED WORK BELONGS. Somebody arriving at
    // Creation Station having saved a hoodie last week should see it here,
    // before they are asked what they want to make — otherwise the only way
    // back to their own design is to build it again.
    const saved = await savedDesignsFor(store.id);

    return (
      <>
        <CreationPortal
          items={portalItems(blanks)}
          basePath={basePath}
          hasSupplier={provider !== null}
          catalogueUnreadable={catalogError !== null}
        />
        <SavedDesigns
          designs={saved}
          hrefFor={(d) =>
            `${basePath}/studio/create?garment=${encodeURIComponent(d.externalProductId)}&design=${encodeURIComponent(d.draftId)}`
          }
        />
      </>
    );
  }

  // ============ THE SUPPLIER STEP IS PART OF CREATING =================
  //
  // Sean: "The user should never click Make a T-shirt and get dumped into a
  // generic Connections page with no relevant supplier available."
  //
  // Both of these used to send somebody to a directory of twelve integrations
  // to work out which one their T-shirt needed. They now stay in the flow,
  // keep the thing that was chosen on screen, and offer the one connection
  // that matters -- started through the same action the Connections screen
  // uses, so there is one connect path rather than a second that drifts.
  const chosenLabel = kind ? (creatableById(kind)?.label ?? "product") : "product";

  // WHETHER THIS DEPLOYMENT CAN OFFER ANY PRINT SUPPLIER AT ALL, asked of the
  // registry rather than read here, so this page cannot fall out of step with
  // the variables a supplier actually needs. A boolean crosses to the client;
  // the credentials never do.
  //
  // Without it, an unconfigured deployment shows a Connect button that starts
  // the action, fails, and redirects to the connections screen with an error
  // -- the dead end coming back through the one door left open.
  //
  // This named PRINTFUL. One supplier is registered today, so the answer is the
  // same — but it is now the registry's answer, which is the one that stays
  // right when a second is added. See lib/creation/registry.ts.
  const supplierConfigured = creationSupplierConfigured();

  // WHY THE LAST ATTEMPT FAILED, FROM THE RECORD THAT ALREADY HOLDS IT.
  //
  // The callback writes a FAILED ExecutionLog row with the connector's own
  // message and sends the owner back here. Reading that row rather than
  // inventing a sentence means the creation flow and the connections page
  // explain the same failure the same way -- one record, two surfaces.
  //
  // Only read when a failure actually just came back, so an old attempt from
  // last week cannot decorate a fresh screen.
  //
  // WHICH supplier came back failing is read from the callback and matched
  // against the registry, rather than compared to a literal. The parameter is
  // the provider's own name, so this is the one place the value legitimately
  // arrives from outside — what changed is that it is now looked up instead of
  // only ever recognised when it said PRINTFUL.
  let attemptFailed: string | null = null;
  const failedSupplier = integrationError
    ? getCreationSuppliers().find((s) => s.provider === integrationError.toUpperCase()) ?? null
    : null;
  if (failedSupplier) {
    const connector = getConnector(failedSupplier.provider);
    const failure = await prisma.executionLog.findFirst({
      where: {
        storeId: store.id,
        action: connectExecutable(connector).action,
        status: "FAILED",
      },
      orderBy: { createdAt: "desc" },
      select: { message: true },
    });
    attemptFailed = failure?.message ?? `${connector.displayName} didn't finish connecting. Try again.`;
  }

  if (!provider) {
    return (
      <SupplierStep
        slug={slug}
        creatableId={kind ?? ""}
        creatableLabel={chosenLabel}
        configured={supplierConfigured}
        attemptFailed={attemptFailed}
      />
    );
  }

  // CONNECTED, AND SOMETHING WENT WRONG. Naming the supplier and its own
  // message is the difference between a person fixing it and a person
  // reconnecting something that was never disconnected.
  if (catalogError) {
    return (
      <SupplierStep
        slug={slug}
        creatableId={kind ?? ""}
        creatableLabel={chosenLabel}
        configured={supplierConfigured}
        attemptFailed={attemptFailed}
        problem={`${catalogError}${
          status && status !== "CONNECTED" ? ` (last check: ${status.toLowerCase().replace("_", " ")})` : ""
        }`}
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

    return (
      <CreationStationClient
        slug={slug}
        garment={garment}
        assets={await artworkFor(store.id)}
        blanks={await blankImagesFor(provider, store.id, garment.externalProductId)}
        supplierPrices={await supplierPricesFor(provider, store.id, garment.externalProductId)}
        creatableId={kind ?? ""}
        {...(draftId ? await reopened(store.id, draftId) : {})}
      />
    );
  }

  // WHICH BLANK, now that the intention is known. Narrowed to the creatable
  // chosen in the portal, so somebody who said "hoodie" is not handed the
  // whole catalogue back.
  //
  // THE NARROWING HAPPENS ON THE INDEX, BEFORE ANY DETAIL IS FETCHED. Doing it
  // afterwards is what made a two-hoodie shelf cost forty-nine requests.
  const creatable = kind ? creatableById(kind) : null;
  const matchingBlanks = creatable ? blanksFor(blanks, creatable) : blanks;

  // A CEILING ON WHAT ONE SCREEN CAN SPEND. Each of these is two more requests
  // against a 120-per-minute allowance shared with everything else this
  // account does. Twelve is a shelf nobody scrolls past anyway; if a supplier
  // has more, that is worth saying rather than silently paying for.
  const DETAIL_LIMIT = 12;
  let shown: Awaited<ReturnType<NonNullable<typeof provider>["getGarments"]>> = [];
  if (matchingBlanks.length > 0) {
    try {
      shown = await provider.getGarments({
        storeId: store.id,
        externalProductIds: matchingBlanks.slice(0, DETAIL_LIMIT).map((b) => b.externalProductId),
      });
    } catch (error) {
      return (
        <SupplierStep
          slug={slug}
          creatableId={kind ?? ""}
          creatableLabel={chosenLabel}
          configured={supplierConfigured}
          attemptFailed={attemptFailed}
          problem={error instanceof Error ? error.message : "Your supplier could not be reached."}
        />
      );
    }
  }

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
    return (
      <CreationStationClient
        slug={slug}
        garment={shown[0]}
        assets={await artworkFor(store.id)}
        blanks={await blankImagesFor(provider, store.id, shown[0].externalProductId)}
        supplierPrices={await supplierPricesFor(provider, store.id, shown[0].externalProductId)}
        creatableId={kind ?? ""}
      />
    );
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
      <GarmentShelf garments={shown} basePath={basePath} availableCount={matchingBlanks.length} />
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
async function artworkFor(storeId: string): Promise<LibraryAsset[]> {
  const assets = await prisma.businessRecord.findMany({
    where: { storeId, entityType: "asset" },
    orderBy: { syncedAt: "desc" },
    take: 60,
    select: { id: true, data: true },
  });

  // THE LIBRARY IS A VIEW, NOT A SECOND STORE (2026-08-28). Same records J4
  // remembers; the filtering — images, and not removed by the owner — is the
  // only difference between the business brain and the creative workspace.
  // See lib/creation/assetLibrary.ts for why that is a lens rather than a copy.
  //
  // The take went from 24 to 60 because removed assets are filtered AFTER the
  // query: a toolbox someone has tidied should not start losing its oldest
  // items to a limit spent on things they took out.
  return libraryFrom(assets as { id: string; data: Asset }[]);
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
