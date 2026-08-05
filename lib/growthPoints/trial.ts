import { prisma } from "@/lib/prisma";

// Business Partner Preview — a real, once-per-store 7-day trial of
// Business Partner's unlimited-1-point-action tier (ARCHITECTURE.md's
// "Business Partner Preview" section, frozen 2026-08-05). Granted from
// completeFirstMeeting() (app/onboarding/meeting/actions.ts), the same
// real "onboarding genuinely finished" signal referral rewards already
// wait for — never bare store creation.
export const TRIAL_DURATION_DAYS = 7;

// Called from completeFirstMeeting() alongside rewardReferralIfEligible.
// Idempotent (a store that already has a grant row is skipped) and
// enforces Sean's own explicit guard: only one active trial per account
// at a time, checked against BusinessPartnerTrialGrant (not Store), so it
// stays correct even if an earlier trialing store has since been deleted.
export async function grantBusinessPartnerTrialIfEligible(
  userId: string,
  store: { id: string; name: string }
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const existingGrantForStore = await tx.businessPartnerTrialGrant.findFirst({
      where: { storeId: store.id },
      select: { id: true },
    });
    if (existingGrantForStore) return;

    const activeElsewhere = await tx.businessPartnerTrialGrant.findFirst({
      where: { userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    if (activeElsewhere) return;

    const expiresAt = new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000);

    await tx.businessPartnerTrialGrant.create({
      data: { userId, storeId: store.id, storeName: store.name, expiresAt },
    });
    await tx.store.update({
      where: { id: store.id },
      data: { businessPartnerTrialEndsAt: expiresAt },
    });
  });
}
