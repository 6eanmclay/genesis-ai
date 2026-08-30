"use server";

// ============ "Store not found", every time (2026-08-28) ===============
//
// Every action in this file began with
//
//     requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, slug)
//
// and that second parameter is a STORE ID, not a slug. resolveBusiness looks
// up an id, finds nothing for "cubit-coil", and — deliberately, so a caller
// that named a business never silently gets a different one — refuses to fall
// back to the active business. requireStorePermission then throws "Store not
// found".
//
// So saving a design, creating a product, reading the cost, adding an upload
// and removing one all threw on their first line, for everybody, always. It is
// why Save "looked correct but did not save": the action threw, and until the
// handlers were given a catch, the button simply reset.
//
// It is also the reason the upload never completed. That had a second, real
// defect — the bare filename — and fixing it did not help, because the record
// write behind it was throwing here.
//
// requireBusiness(permission, slug) is the slug-taking one. Both parameters are
// strings and both are called something plausible, so nothing in the type
// system could tell them apart; scripts/verify-creation-catalog.ts now asserts
// this file never passes a slug to the id-taking helper.

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { ingestBusinessAsset } from "@/lib/businessAssets/ingest";
import type { Asset } from "@/lib/businessModel/entities";
import { removedFromLibrary, restoredToLibrary } from "@/lib/creation/assetLibrary";
import { PERMISSIONS } from "@/lib/permissions";
import { requireBusiness, requireBusinessOrActive, requireStorePermission } from "@/lib/permissions";
import { usedPlacements, type ProductDesign } from "@/lib/creation/design";
import { saveDesignAsProduct } from "@/lib/creation/saveDesign";
import { creationProviderFor } from "@/lib/creation/provider";
import { persistSyncedRecords } from "@/lib/businessModel/sync";
import { DesignSchema } from "@/lib/businessModel/entities";
import { toDraft, toDesign } from "@/lib/creation/designDraft";
import { blankFor } from "@/lib/creation/garment";
import { randomUUID } from "crypto";
import { execute } from "@/lib/execution/engine";
import { growthPointCostFor } from "@/lib/growthPoints/catalog";
import {
  growthPointDecision,
  rememberSkipGrowthPointConfirmation,
  spendSummary,
  type GrowthPointDecision,
} from "@/lib/growthPoints/confirmation";
import { createProductFromDesignExecutable } from "@/lib/execution/executables/productFromDesign";

// TURNING A DESIGN INTO SOMETHING THE STORE SELLS.
//
// ============ THE SERVER ASKS THE SAME QUESTION THE BUTTON DID ==========
//
// designProblem() is the one definition of whether a design can be made, and
// both the disabled button and this action call it. A rule duplicated in a
// component is a rule that disagrees with its action the first time either
// changes — and here the disagreement would be an owner told they could add
// something that is then refused.
//
// ============ WHAT IS AND IS NOT SENT TO THE SUPPLIER ==================
//
// This writes a real Product with the design frozen onto it, and it does NOT
// create the product at Printful. That is deliberate rather than unfinished:
// lib/fulfillment/printful.ts's createProduct takes a single imageUrl and has
// no placement model at all, so calling it with a two-sided design would send
// the front artwork and silently drop the back.
//
// Wiring multi-placement creation is a change to that connector against a live
// account, and doing it blind — with no Printful connection to verify against —
// is how a supplier ends up printing something nobody previewed. So the design
// is stored complete, the provider placements are computed and stored with it,
// and the supplier call is the next step rather than a guess made now.
//
// ============ AND THE PRODUCT SAYS SO (2026-08-28) =====================
//
// That reasoning was right and the product record did not carry it. It was
// written ACTIVE, marked PRINT_ON_DEMAND, with a Printful provider and a
// catalogue id — indistinguishable, to every other part of Genesis, from a
// product a supplier could actually make. The button said "Add to my store"
// and the note said "Added to your store."
//
// Two states, and they are not the same thing:
//
//   I have designed this
//   this product has been created with my supplier and is ready to sell
//
// Only the first is true today, so only the first is claimed: active false,
// supplierProductCreated false on the design, and copy that says which one it
// is. Nothing about the design is thrown away — when the supplier contract is
// wired and verified, this becomes a transition rather than a rebuild.

export interface AddToStoreResult {
  ok: boolean;
  error?: string;
}

export async function addDesignToStore(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number },
): Promise<AddToStoreResult> {
  const store = await prisma.store.findUnique({ where: { slug }, select: { id: true } });
  if (!store) return { ok: false, error: "Store not found." };

  // Permission first, and through the same gate every other write uses.
  await requireStorePermission(PERMISSIONS.PRODUCTS_MANAGE, store.id);

  const provider = await creationProviderFor(store.id);
  if (!provider) {
    return { ok: false, error: "Connect a print supplier before adding a designed product." };
  }

  // THE GARMENT IS RE-READ, not trusted from the browser. The print areas that
  // position the artwork have to be the supplier's own, and a client that sent
  // its own would be choosing where its design prints.
  const garment = await provider.getGarment({ storeId: store.id, externalProductId: design.externalProductId });
  if (!garment) return { ok: false, error: "That blank is no longer available from your supplier." };

  // THE DECISION AND THE WRITE LIVE IN lib/creation/saveDesign.ts, which a
  // suite can call with a garment of its own. What stays here is what only an
  // action can do: the permission check, and asking the supplier what the blank
  // actually is. See that file for why the split exists.
  const result = await saveDesignAsProduct({
    storeId: store.id,
    design,
    meta,
    garment,
  });
  if (!result.ok) return { ok: false, error: result.error };

  revalidatePath(`/b/${slug}/products`);
  revalidatePath(`/b/${slug}/studio`);
  return { ok: true };
}

// ============ SAVE IS A DESIGN STATE, NOT A PRODUCT (2026-08-28) ========
//
// Sean, after testing the live deployment: "Save = save the current design as a
// design/draft so the user can leave, come back later, and continue editing it.
// No product creation and no Growth Points spent... The user should be able to
// save something 10 times while working on it without paying Growth Points
// every time."
//
// What Save did before was call addDesignToStore, which wrote a PRODUCT row
// carrying a designSpec blob. The trace found the reason it felt like nothing
// happened: `designSpec` HAS NO READERS ANYWHERE. Nothing listed it, nothing
// loaded it, no route reopened it. The design went into a field that is only
// ever written.
//
// A save now writes a `design` BusinessRecord — the entity that already exists,
// that createDesign writes, and that productFromDesign consumes — so there is
// one design system with two ways into it rather than two.

/** The source name this Creation Station's drafts are written under. */
const DRAFT_SOURCE = "genesis_creation";

// ============ A THROWN SERVER ACTION TELLS THE OWNER NOTHING ===========
//
// Next replaces a Server Action's error with "An error occurred in the Server
// Components render. The specific message is omitted in production builds" and
// keeps the real one on the server. That is the correct default — a stack trace
// is not for a customer — but it means every failure in this file arrives as
// the same sentence, and the owner and I both have to guess.
//
// It has cost this session three rounds already: "Store not found" hid behind
// it, the supplier rate limit hid behind it, and now a save is failing with two
// layers on one placement and the message says nothing about either.
//
// So these actions RETURN their failure instead of throwing it. A returned
// value is data, crosses to the client intact, and can be shown. The error is
// still logged server-side by the platform; what changes is that the person
// looking at the screen can also see it.
//
// REDIRECTS MUST STILL PROPAGATE. Next signals navigation by throwing, so
// catching indiscriminately would swallow a redirect and leave the owner on a
// page that thinks it failed. Those are re-thrown untouched.
function isControlFlow(error: unknown): boolean {
  const digest = (error as { digest?: unknown } | null)?.digest;
  return typeof digest === "string" && (digest.startsWith("NEXT_REDIRECT") || digest === "NEXT_NOT_FOUND");
}

/** The message an owner should see, or a rethrow for Next's own signals. */
function reportable(error: unknown): string {
  if (isControlFlow(error)) throw error;
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message || "Something went wrong and did not say what.";
}

export interface SaveDraftResult {
  ok: boolean;
  error?: string;
  /** The draft's id, so the next save updates rather than duplicates. */
  designId?: string;
  /**
   * The design saved, but something secondary did not.
   *
   * ============ SAVED IS NOT THE SAME AS SAVED PERFECTLY ============
   *
   * Sean: "I don't want the interface to silently imply success or give me a
   * generic failure when something more specific is known." Recording the
   * supplier's blank is best effort, and when it fails the work is still saved
   * — but saying only "Saved" would hide that the product's photograph will
   * later fall back to the print file. This is that middle state, which had no
   * way to be reported at all.
   */
  warning?: string;
}

/**
 * Save the design the owner is working on. Free, repeatable, recoverable.
 *
 * UPSERT BY draftId, which is the whole reason it is a parameter. Ten saves of
 * one design must leave one draft, not ten — persistSyncedRecords keys on
 * (storeId, entityType, sourceProvider, externalId), so passing the id back in
 * updates the same record. The first save has no id and gets one.
 */
export async function saveDesignDraft(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number | null; draftId?: string | null },
): Promise<SaveDraftResult> {
  try {
    return await saveDesignDraftOrThrow(slug, design, meta);
  } catch (error) {
    return { ok: false, error: `That design could not be saved: ${reportable(error)}` };
  }
}

async function saveDesignDraftOrThrow(
  slug: string,
  design: ProductDesign,
  meta: { name: string; retailPriceInCents: number | null; draftId?: string | null },
): Promise<SaveDraftResult> {
  const { store, userId } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);

  const provider = await creationProviderFor(store.id);
  if (!provider) return { ok: false, error: "Connect a print supplier before saving a design." };

  // THE GARMENT IS RE-READ, for the same reason addDesignToStore re-reads it:
  // the print areas frozen onto a draft have to be the supplier's own.
  const garment = await provider.getGarment({ storeId: store.id, externalProductId: design.externalProductId });
  if (!garment) return { ok: false, error: "That blank is no longer available from your supplier." };

  const draftId = meta.draftId || randomUUID();

  // Carried forward so re-saving a draft that has already been created does not
  // make it look uncreated — which would offer a second paid Create for a
  // product that already exists.
  const existing = meta.draftId
    ? await prisma.businessRecord.findFirst({
        where: {
          storeId: store.id,
          entityType: "design",
          sourceProvider: DRAFT_SOURCE,
          externalId: draftId,
        },
        select: { data: true },
      })
    : null;
  const previous = existing ? DesignSchema.safeParse(existing.data) : null;

  // WHICH BLANK EACH SIDE WAS SHOWING, so the product's photograph can later be
  // rebuilt as the owner saw it.
  //
  // ============ AND WHY SAVE NO LONGER WAITS ON IT (2026-08-28) ========
  //
  // Sean: "Save design currently looks correct but does not actually save.
  // Create product currently looks correct but does not actually complete."
  //
  // One cause, both buttons. This called provider.getBlankImages(), which pages
  // through Printful's /images endpoint — the heaviest and most rate-limited
  // call the provider makes, capped at twenty per page and walked until it
  // ends. A 429 or a slow answer threw, the throw came back through the Server
  // Action, and nothing caught it: the button reset and the design was gone.
  // Create failed identically because Create saves first.
  //
  // Saving is meant to be free and instant. It is the thing an owner reaches
  // for when they are NOT finished, so it must not depend on a supplier being
  // reachable, awake, or under its rate limit.
  //
  // So the blanks are now best effort in two ways. Reused from the last save
  // when the colourway has not changed, which makes the common case — saving
  // repeatedly while working — cost the supplier nothing at all. And wrapped,
  // so a failure records no blanks rather than losing the work. What that
  // costs is a mockup falling back to the print file later, which is visible
  // and recoverable; what it saves is the design itself.
  const variant = garment.variants.find((v) => v.externalVariantId === design.externalVariantId) ?? null;
  const used = Object.entries(design.placements)
    .filter(([, layers]) => layers.length > 0)
    .map(([placement]) => placement);

  const carried = previous?.success ? previous.data.placement : null;
  const sameColourway = carried?.externalVariantId === design.externalVariantId;
  const alreadyKnown = sameColourway && used.every((placement) => carried?.blanks[placement]);

  let blanks: Record<string, string> = sameColourway ? { ...(carried?.blanks ?? {}) } : {};
  let blanksUnavailable = false;
  if (!alreadyKnown) {
    try {
      const blankImages = await provider.getBlankImages({
        storeId: store.id,
        externalProductId: design.externalProductId,
      });
      for (const placement of used) {
        const blank = blankFor(blankImages, placement, variant?.colorHex ?? null, variant?.color ?? null);
        if (blank.url) blanks[placement] = blank.url;
      }
    } catch {
      // The supplier could not be read. The design is still the owner's work
      // and is still saved; only its future photograph is affected, and that
      // is recomposed from the draft whenever Create runs. REPORTED, not
      // swallowed — see SaveDraftResult.warning.
      blanks = sameColourway ? { ...(carried?.blanks ?? {}) } : {};
      blanksUnavailable = used.length > 0;
    }
  }

  const data = toDraft(design, {
    garment,
    name: meta.name,
    retailPriceInCents: meta.retailPriceInCents,
    blanks,
  }, previous?.success ? previous.data.placement : null);

  const result = await persistSyncedRecords(store.id, DRAFT_SOURCE, [
    { entityType: "design", externalId: draftId, data },
  ], {
    // THE OWNER MADE THIS. They positioned every layer themselves, so the
    // provenance is theirs rather than GENERATED — which is what createDesign
    // records for a composition J4 produced. The distinction is the same one
    // J4_BUSINESS_UNDERSTANDING_MODEL.md draws everywhere else.
    provenance: "OWNER",
    provenanceDetail: "creation station",
    statedById: userId,
    modelExtracted: false,
  });
  if (result.errors.length > 0) {
    return { ok: false, error: "That design could not be saved." };
  }

  revalidatePath(`/b/${slug}/studio`);
  return {
    ok: true,
    designId: draftId,
    warning: blanksUnavailable
      ? "Your design is saved. We couldn't reach your supplier for the preview image, so the product photo may fall back to the artwork itself."
      : undefined,
  };
}

/** One saved design, as the doorway shows it. */
export interface SavedDesignRow {
  draftId: string;
  recordId: string;
  externalProductId: string;
  name: string;
  summary: string;
  updatedAt: string | null;
  created: boolean;
  /** The first piece of artwork on it, or null for a design with none yet. */
  thumbnailUrl: string | null;
  color: string | null;
  /** Which sides carry work — "front", "back". */
  sides: string[];
}

/** The first artwork on a design, front preferred, for the list's thumbnail. */
function firstArtwork(placements: Record<string, { assetUrl: string }[]>): string | null {
  const front = placements.front?.[0]?.assetUrl;
  if (front) return front;
  for (const layers of Object.values(placements)) {
    if (layers[0]?.assetUrl) return layers[0].assetUrl;
  }
  return null;
}

/**
 * Every design the owner has saved and not yet turned into a product.
 *
 * ============ THE STORE ID IS NOT A PARAMETER (2026-08-30) ============
 *
 * It used to be, and this action returned whatever business the caller named.
 * A server action is a POST endpoint with a generated id — the page that calls
 * it having already checked access protects the page, not the action, and an
 * authenticated user is not the same fact as an authorised one.
 *
 * The fix is not a check on the argument. The argument is GONE: the business
 * comes from requireBusinessOrActive, so there is no longer any way to express
 * the request "read that other business". A slug still names one, and that
 * helper is what proves the caller may have it — and records the attempt when
 * they may not.
 */
export async function savedDesignsFor(slug?: string): Promise<SavedDesignRow[]> {
  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const rows = await prisma.businessRecord.findMany({
    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE },
    select: { id: true, externalId: true, data: true },
    orderBy: { syncedAt: "desc" },
    take: 40,
  });

  const drafts: SavedDesignRow[] = [];
  for (const row of rows) {
    const parsed = DesignSchema.safeParse(row.data);
    if (!parsed.success || !parsed.data.placement) continue;
    const p = parsed.data.placement;
    drafts.push({
      draftId: row.externalId ?? row.id,
      recordId: row.id,
      // WHICH BLANK IT WAS DESIGNED ON. Carried so reopening can land in the
      // editor: the create page needs ?garment= to open one at all, and a link
      // with only ?design= would drop the owner back at the doorway they were
      // trying to leave.
      externalProductId: p.externalProductId,
      name: p.productName ?? "Untitled design",
      summary: draftSummaryOf(p.color, p.placements),
      updatedAt: p.updatedAt,
      created: p.productId !== null,
      // ENOUGH TO RECOGNISE IT WITHOUT OPENING IT. Sean asked for a thumbnail,
      // the garment, the colour, which sides have work on them and when it was
      // last touched — because a list of names is not something anybody can
      // pick their own half-finished hoodie out of.
      //
      // The thumbnail is the first piece of artwork rather than a rendered
      // mockup: composing one costs a supplier fetch and an image pass PER SAVE,
      // and saving has to stay free and instant. The artwork is what the owner
      // recognises anyway.
      thumbnailUrl: firstArtwork(p.placements),
      color: p.color,
      sides: Object.entries(p.placements).filter(([, l]) => l.length > 0).map(([k]) => k),
    });
  }
  return drafts;
}

/**
 * A saved design, ready to go back into the editor.
 *
 * The business comes from the guard, never the caller — see savedDesignsFor.
 * The draft id stays a parameter and is safe as one BECAUSE the query is still
 * scoped to the authorised store: naming another business's draft id finds
 * nothing rather than returning it.
 */
export async function loadDesignDraft(
  draftId: string,
  slug?: string,
): Promise<{ design: ProductDesign; name: string; retailPriceInCents: number | null; created: boolean } | null> {
  const { store } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const row = await prisma.businessRecord.findFirst({
    where: { storeId: store.id, entityType: "design", sourceProvider: DRAFT_SOURCE, externalId: draftId },
    select: { data: true },
  });
  if (!row) return null;
  const parsed = DesignSchema.safeParse(row.data);
  if (!parsed.success) return null;
  const design = toDesign(parsed.data);
  if (!design) return null;
  return {
    design,
    name: parsed.data.placement?.productName ?? "",
    retailPriceInCents: parsed.data.placement?.retailPriceInCents ?? null,
    // Reopening something already made must not offer to make it again.
    created: parsed.data.placement?.productId != null,
  };
}

/** The one-line description shown in the saved list. Kept beside its reader. */
function draftSummaryOf(color: string | null, placements: Record<string, unknown[]>): string {
  const sides = Object.entries(placements).filter(([, l]) => l.length > 0).map(([k]) => k);
  const where = sides.length === 0 ? "nothing on it yet" : sides.join(" and ");
  return `${color ? `${color}, ` : ""}${where}`;
}

// ============ CREATE IS THE COMMITMENT (2026-08-28) =====================
//
// Sean: "Create = 2 Growth Points. This is the actual commitment. It must take
// the saved/current design, create the product with the connected print
// supplier using the exact variant/color/size and all selected placements, and
// then make that product available in the owner's Genesis storefront."
//
// Everything that makes that true lives in the executable, not here: the
// supplier call, the read-back that proves the placements exist, the Product
// row, and the link back to the design. This function's whole job is to save
// the current state first and then hand the design's id to the engine.
//
// THROUGH execute(), which is what makes the 2 points real. The engine checks
// the balance, deducts on a non-FAILED outcome, and writes the ExecutionLog —
// so a supplier refusal costs nothing, because the deduction never happens on a
// failure. Charging here by hand would have to reimplement all three.

export interface CreateProductResult {
  ok: boolean;
  error?: string;
  productId?: string;
  /** The placements the supplier confirmed it holds. */
  placements?: string[];
  message?: string;
  /** "Created ✓ · 2 Growth Points used · 22 remaining" — always shown. */
  summary?: string;
}

/**
 * Turn the design on screen into a real product.
 *
 * SAVES FIRST, ALWAYS. The owner may have moved something since their last
 * save, and creating a product from a stale draft would put a different design
 * in the shop than the one they were looking at.
 */
export async function createProductFromDesign(
  slug: string,
  design: ProductDesign,
  meta: {
    name: string;
    retailPriceInCents: number;
    draftId?: string | null;
    /** They ticked "don't ask me again" on the confirmation they just answered. */
    dontAskAgain?: boolean;
  },
): Promise<CreateProductResult> {
  try {
    return await createProductFromDesignOrThrow(slug, design, meta);
  } catch (error) {
    // The engine turns a failed RUN into a FAILED result rather than a throw,
    // so reaching here means something broke before or around it — which still
    // means nothing was charged, and that is the first thing to say.
    return {
      ok: false,
      error: `We couldn't create this product. Your Growth Points were not used. ${reportable(error)}`,
    };
  }
}

async function createProductFromDesignOrThrow(
  slug: string,
  design: ProductDesign,
  meta: {
    name: string;
    retailPriceInCents: number;
    draftId?: string | null;
    dontAskAgain?: boolean;
  },
): Promise<CreateProductResult> {
  const { store, userId } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);
  const balanceBefore = (
    await prisma.store.findUnique({ where: { id: store.id }, select: { growthPointBalance: true } })
  )?.growthPointBalance ?? 0;
  const quotedCost = growthPointCostFor("create_product_from_design") ?? 0;

  if (!Number.isFinite(meta.retailPriceInCents) || meta.retailPriceInCents <= 0) {
    return { ok: false, error: "Give it a price before creating the product." };
  }

  const saved = await saveDesignDraft(slug, design, {
    name: meta.name,
    retailPriceInCents: meta.retailPriceInCents,
    draftId: meta.draftId ?? null,
  });
  if (!saved.ok || !saved.designId) {
    return { ok: false, error: saved.error ?? "That design could not be saved." };
  }

  // The record id, which is what the executable takes — the draft id is the
  // externalId the owner's URL carries, and the two are deliberately different
  // things.
  const record = await prisma.businessRecord.findFirst({
    where: {
      storeId: store.id,
      entityType: "design",
      sourceProvider: DRAFT_SOURCE,
      externalId: saved.designId,
    },
    select: { id: true },
  });
  if (!record) return { ok: false, error: "That design could not be found after saving." };

  // WITH THE ACTION, not before it. A confirmation that was cancelled taught us
  // nothing, and a preference saved on opening the question would outlive a
  // decision that was never made.
  if (meta.dontAskAgain && userId) {
    await rememberSkipGrowthPointConfirmation(userId, quotedCost);
  }

  const result = await execute(
    createProductFromDesignExecutable,
    { designId: record.id, name: meta.name, priceInCents: meta.retailPriceInCents },
    { storeId: store.id, actionType: "create_product_from_design" },
  );

  if (result.status === "FAILED") {
    // ============ A SENTENCE, NOT A STACK TRACE (2026-08-28) ==========
    //
    // Sean: "Don't expose internal function names/errors like
    // create_product_from_design failed." The engine's message is the
    // executable's own throw, which is written for a person — but it arrives
    // without the two things somebody needs first: that they were not charged,
    // and which part of it stopped.
    return { ok: false, error: humanFailure(result.message) };
  }

  revalidatePath(`/b/${slug}/products`);
  revalidatePath(`/b/${slug}/studio`);

  // ============ THE ACCOUNTING IS NOT THE QUESTION (2026-08-28) ======
  //
  // "The preference means skip recurring cost confirmation, not hide Growth
  // Point accounting. After successful execution, show a lightweight result
  // such as 'Posted ✓ · 1 Growth Point used · 23 remaining.'"
  //
  // So this is reported whether or not they were asked, and the balance is
  // re-read AFTER the deduction rather than arithmetic on the number from
  // before — the engine may cover an action under an unlimited plan, in which
  // case nothing was spent and the honest line says so.
  const after = await prisma.store.findUnique({
    where: { id: store.id },
    select: { growthPointBalance: true },
  });
  // MEASURED, NOT ASSUMED. What actually left the balance — which is zero when
  // an unlimited plan or an active trial covered the action, and the honest
  // line then says so rather than claiming points were spent.
  const spent = Math.max(0, balanceBefore - (after?.growthPointBalance ?? 0));

  return {
    ok: true,
    productId: result.metadata?.productId,
    placements: result.metadata?.placements,
    message: result.message,
    summary: spendSummary({
      verb: "Created",
      cost: spent,
      remaining: after?.growthPointBalance ?? 0,
    }),
  };
}

/**
 * Whether creating this product should ask first, and what it would cost.
 *
 * ============ THE RULE IS NOT THIS FEATURE'S (2026-08-28) ============
 *
 * Sean: "This should be a global Genesis behavior for every Growth Point-
 * consuming action, not something implemented separately for Creation Station,
 * Social, or individual features."
 *
 * So this asks lib/growthPoints/confirmation.ts and reports the answer. It
 * decides nothing itself — not when to ask, not what counts as a material
 * change, not whether the preference applies. The Creation Station is the first
 * caller of that rule and deliberately not the owner of it.
 */
export async function creationCost(slug: string): Promise<GrowthPointDecision> {
  const { store, userId } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);
  return growthPointDecision({
    storeId: store.id,
    userId,
    actionType: "create_product_from_design",
  });
}

/**
 * The failure, as a person needs to read it.
 *
 * Leads with the money, because that is the first question — Growth Points are
 * deducted only on a non-FAILED outcome, so reaching here means nothing was
 * charged, and saying so removes the worry before explaining the rest.
 *
 * Then WHERE it stopped, in the owner's terms. The stages are the real ones:
 * composing the artwork, asking the supplier to make it, and confirming the
 * supplier holds every side. An internal name would tell them nothing they
 * could act on.
 */
function humanFailure(message: string | null | undefined): string {
  const said = (message ?? "").trim();
  const stage = /did not record the/i.test(said)
    ? "Your supplier made the product but did not confirm every side of the design, so we stopped rather than putting a half-printed product in your store."
    : /supplier|printful|print/i.test(said)
      ? "We couldn't finish creating the product with your print supplier."
      : /artwork could not be read|compose/i.test(said)
        ? "We couldn't prepare the artwork files for your supplier."
        : "We couldn't create this product.";

  // The supplier's own words are kept when they are specific enough to act on
  // — a rejected file or an unavailable variant is worth reading verbatim.
  const detail = said && said.length < 300 ? ` ${said}` : "";
  return `${stage} Your Growth Points were not used.${detail}`;
}

/** What the owner is about to add, for the confirmation line. */
export async function describeDesign(design: ProductDesign): Promise<string> {
  const sides = usedPlacements(design);
  return sides.length === 0 ? "nothing yet" : sides.join(" and ");
}

// ============ THE CREATION STATION'S ASSET LIBRARY (2026-08-28) =========
//
// Three actions, and the shape of them is the guarantee. Sean: "Deleting it
// from the creation library should not accidentally erase something J4 needs
// to remember about the business."
//
// So there is no delete here. Removing writes a date onto the record J4
// already holds; restoring clears it. Neither touches role, origin,
// classification, supersession or the file itself, and no code path in this
// file can remove a BusinessRecord even by mistake — the capability is simply
// absent rather than guarded.

/**
 * Bring an uploaded file into the business's assets and its Creation Station.
 *
 * REUSES ingestBusinessAsset RATHER THAN WRITING A SECOND STORE. That function
 * already writes the permanent record, sets origin "uploaded", and now measures
 * the file's real alpha. An upload made here and an upload made in chat produce
 * the same asset, which is the point: the library is a lens over J4's memory,
 * not a parallel collection.
 */
export async function addAssetToLibrary(
  slug: string,
  uploaded: { url: string; originalFilename: string; contentType: string },
): Promise<{ ok: boolean; error?: string }> {
  const { store } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);
  if (!uploaded?.url || !uploaded.url.startsWith("https://")) {
    return { ok: false, error: "That upload did not complete." };
  }

  await ingestBusinessAsset(store.id, uploaded);
  revalidatePath(`/b/${slug}/studio/create`);
  return { ok: true };
}

/**
 * Take an asset out of the Creation Station. J4 still remembers it.
 *
 * The record is read, one field is set, and it is written back — so anything
 * else on it survives untouched, including fields added after this was written.
 */
export async function removeAssetFromLibrary(
  slug: string,
  recordId: string,
): Promise<{ ok: boolean; error?: string }> {
  return setLibraryMembership(slug, recordId, false);
}

/** Put it back. The exact inverse — removal was never destructive. */
export async function restoreAssetToLibrary(
  slug: string,
  recordId: string,
): Promise<{ ok: boolean; error?: string }> {
  return setLibraryMembership(slug, recordId, true);
}

async function setLibraryMembership(
  slug: string,
  recordId: string,
  present: boolean,
): Promise<{ ok: boolean; error?: string }> {
  const { store } = await requireBusiness(PERMISSIONS.PRODUCTS_MANAGE, slug);

  // SCOPED TO THE BUSINESS, not just to the id. A record id from another store
  // must not resolve here — the same rule every other read of these records
  // follows.
  const record = await prisma.businessRecord.findFirst({
    where: { id: recordId, storeId: store.id, entityType: "asset" },
    select: { id: true, data: true },
  });
  if (!record) return { ok: false, error: "That asset is not in this business." };

  const asset = record.data as unknown as Asset;
  const next = present ? restoredToLibrary(asset) : removedFromLibrary(asset);

  // STORE-SCOPED ON THE WRITE, not only on the read (2026-08-28).
  //
  // The findFirst above already proved this record belongs to this business,
  // and updating by id alone would still have been a bare cross-tenant write —
  // one refactor away from losing the check that made it safe. The tenant
  // isolation extension refused it, correctly, the first time this ran.
  await prisma.businessRecord.update({
    where: { id: record.id, storeId: store.id },
    data: { data: next as unknown as Prisma.InputJsonValue },
  });

  revalidatePath(`/b/${slug}/studio/create`);
  return { ok: true };
}
