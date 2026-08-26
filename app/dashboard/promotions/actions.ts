"use server";

import { revalidatePath } from "next/cache";
import { unstable_rethrow } from "next/navigation";
import { RecoverableError, toActionState, type ActionState } from "@/lib/actionState";
import { PERMISSIONS, requireBusinessOrActive } from "@/lib/permissions";
import { execute } from "@/lib/execution/engine";
import {
  createPromotionExecutable,
  updatePromotionExecutable,
  deletePromotionExecutable,
} from "@/lib/execution/executables/promotions";
import { normalizeCode } from "@/lib/promotions/eligibility";

// THE MERCHANT'S SIDE OF A PROMOTION.
//
// Everything here parses and refuses; the executables write. A promotion that
// cannot say how much it takes off, or a code that is only whitespace, is
// stopped at the form with a sentence rather than reaching Postgres and coming
// back as a constraint violation the merchant cannot read.

/** 1–100, whole. A 0% sale takes nothing off and a 150% one is a typo. */
function parsePercent(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RecoverableError("Enter the percentage as a whole number.");
  }
  if (value <= 0 || value > 100) {
    throw new RecoverableError("A percentage discount has to be between 1 and 100.");
  }
  return value;
}

/** Dollars in, cents stored — the unit every other price in Genesis uses. */
function parseAmountOff(raw: string): number {
  const value = Number(raw.trim());
  if (!Number.isFinite(value) || value <= 0) {
    throw new RecoverableError("Enter an amount greater than zero.");
  }
  return Math.round(value * 100);
}

/**
 * A date the merchant typed, at the start of that day in their own reading.
 *
 * Blank is a real answer: a sale with no dates runs until it is switched off,
 * which is the common case and should not require inventing a far-future date.
 */
function parseDate(raw: string, field: string): Date | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const date = new Date(trimmed);
  if (Number.isNaN(date.getTime())) {
    throw new RecoverableError(`That ${field} isn't a date we can read.`);
  }
  return date;
}

export async function createPromotion(
  slug: string | undefined,
  _prevState: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);

    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new RecoverableError("Give this promotion a name.");

    const kind = formData.get("kind") === "CODE" ? "CODE" : "SALE";

    let code: string | null = null;
    if (kind === "CODE") {
      code = normalizeCode(String(formData.get("code") ?? ""));
      if (!code) throw new RecoverableError("Enter the code customers will type.");
    }

    const discountType = formData.get("discountType") === "FIXED_AMOUNT" ? "FIXED_AMOUNT" : "PERCENTAGE";
    const percentOff = discountType === "PERCENTAGE" ? parsePercent(String(formData.get("percentOff") ?? "")) : null;
    const amountOffInCents =
      discountType === "FIXED_AMOUNT" ? parseAmountOff(String(formData.get("amountOff") ?? "")) : null;

    const scope = formData.get("scope") === "SELECTED_PRODUCTS" ? "SELECTED_PRODUCTS" : "ALL_PRODUCTS";
    const productIds = formData.getAll("productIds").map(String).filter(Boolean);
    if (scope === "SELECTED_PRODUCTS" && productIds.length === 0) {
      throw new RecoverableError("Choose at least one product, or make this a store-wide sale.");
    }

    const startsAt = parseDate(String(formData.get("startsAt") ?? ""), "start date");
    const endsAt = parseDate(String(formData.get("endsAt") ?? ""), "end date");
    // Checked here as well as by the database, so the merchant gets a sentence
    // rather than a constraint name.
    if (startsAt && endsAt && startsAt >= endsAt) {
      throw new RecoverableError("The end date has to come after the start date.");
    }

    await execute(
      createPromotionExecutable,
      {
        name,
        kind,
        code,
        discountType,
        percentOff,
        amountOffInCents,
        scope,
        productIds,
        active: formData.get("active") !== "off",
        startsAt,
        endsAt,
      },
      { storeId }
    );
  } catch (error) {
    unstable_rethrow(error);
    // A duplicate code is the one database error a merchant will actually hit,
    // and "Unique constraint failed" is not a sentence anybody should read.
    if (error instanceof Error && /Unique constraint/i.test(error.message)) {
      return toActionState(new RecoverableError("That code is already in use in this business."), formData);
    }
    return toActionState(error, formData);
  }

  revalidatePath("/dashboard/promotions");
  return { ok: true };
}

export async function setPromotionActive(
  slug: string | undefined,
  promotionId: string,
  active: boolean
): Promise<void> {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  // Passed explicitly rather than toggled from a value read a moment ago: two
  // tabs open on this page would otherwise flip each other back and forth.
  await execute(updatePromotionExecutable, { promotionId, active }, { storeId });
  revalidatePath("/dashboard/promotions");
}

export async function deletePromotion(slug: string | undefined, promotionId: string): Promise<void> {
  const { storeId } = await requireBusinessOrActive(PERMISSIONS.PRODUCTS_MANAGE, slug);
  await execute(deletePromotionExecutable, { promotionId }, { storeId });
  revalidatePath("/dashboard/promotions");
}
