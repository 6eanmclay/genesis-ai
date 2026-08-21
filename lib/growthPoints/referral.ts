import { randomBytes } from "crypto";
import { prisma } from "@/lib/prisma";
import { resolveBusiness } from "@/lib/businessContext";

// Growth Points Economy (Chapter 2) — referrals. A real shareable code
// (User.referralCode, generated lazily here on first access — most users
// never share one, so this never runs at signup) plus a Referral row per
// redeemed relationship. Reward fires on a real completion signal
// (Store.firstMeetingCompletedAt, the same "onboarding genuinely finished"
// moment Meeting with J4 already established — see
// app/onboarding/meeting/actions.ts's completeFirstMeeting), never bare
// signup, to avoid a trivially-gamed reward. Reward amount comes from
// Plan.referralRewardPoints, which is null (honest no-op) until Sean sets
// it — same "wired but inert until real values exist" shape as
// lib/growthPoints/catalog.ts and lib/growthPoints/refresh.ts.

function generateCode(): string {
  // 8 chars of base32-ish alphabet, human-shareable — collisions retried
  // by the caller via the unique constraint, not guarded against here.
  return randomBytes(5).toString("hex").toUpperCase().slice(0, 8);
}

export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { referralCode: true } });
  if (user.referralCode) return user.referralCode;

  // Extremely unlikely collision, retried a bounded number of times rather
  // than looping forever.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generateCode();
    try {
      await prisma.user.update({ where: { id: userId }, data: { referralCode: code } });
      return code;
    } catch {
      // Unique constraint violation — another user already holds this
      // code; try again with a fresh one.
    }
  }
  throw new Error("Could not generate a unique referral code");
}

// Called at signup time (app/api/register/route.ts) when a new account
// arrives via a valid ?ref= code. Creates a PENDING Referral row; does
// nothing else yet — the actual reward waits for a real completion signal
// (see rewardReferralIfEligible below). Silently no-ops on an invalid code
// or a self-referral rather than blocking signup over it.
export async function recordReferralSignup(code: string, referredUserId: string): Promise<void> {
  const referrer = await prisma.user.findUnique({ where: { referralCode: code }, select: { id: true } });
  if (!referrer || referrer.id === referredUserId) return;

  await prisma.referral.create({
    data: {
      referrerUserId: referrer.id,
      referredUserId,
      code,
    },
  });
}

// Called from completeFirstMeeting() — the referred user's own store just
// reached the same real "onboarding genuinely finished" signal Meeting
// with J4 already established. Idempotent by construction: status flips
// PENDING -> REWARDED exactly once (guarded by the where clause below), so
// a re-run (the meeting route can't re-trigger completion, but this stays
// safe even if it ever did) never double-rewards.
export async function rewardReferralIfEligible(
  referredUserId: string,
  /**
   * The business the referred owner just finished onboarding.
   *
   * PASSED IN, NOT PICKED (2026-08-21). This used to resolve by
   * most-recently-updated, and the comment it replaced said so plainly: "a
   * defensible answer, not a correct one". Growth Points are per-business, so a
   * wrong pick credits real points to the wrong balance — and recency is exactly
   * the mechanism BUSINESS_CONTEXT.md removed everywhere else.
   *
   * The caller already has this store resolved: completeFirstMeeting passes the
   * same one to grantBusinessPartnerTrialIfEligible on the very next line. The
   * business whose onboarding just completed is the business the reward is for.
   */
  referredStoreId: string
): Promise<void> {
  const referral = await prisma.referral.findFirst({
    where: { referredUserId, status: "PENDING" },
    select: { id: true, referrerUserId: true },
  });
  if (!referral) return;

  // THE REFERRER IS NOT HERE. Nobody is holding a session for them, so their
  // business cannot be passed in — it has to be resolved. resolveBusiness gives
  // the one they explicitly chose, or their only one, and ASKS rather than
  // guessing when an account reaches several and has chosen none.
  //
  // Ambiguous means the reward is not granted and the referral stays PENDING,
  // which is the honest outcome: crediting an arbitrary business would be the
  // recency defect wearing a different hat, and flipping it to REWARDED without
  // paying would silently lose their reward.
  //
  // KNOWN AND NOT SOLVED HERE: nothing retries a PENDING referral today, so an
  // ambiguous referrer's reward waits for a retry that does not exist yet. Named
  // rather than papered over — it is unreachable for every production account,
  // all of which hold exactly one business.
  const referrerResolution = await resolveBusiness(referral.referrerUserId);
  if (referrerResolution.kind !== "resolved") return;

  const referrerStore = { id: referrerResolution.storeId, planId: referrerResolution.store.planId };
  const referredStore = await prisma.store.findUnique({
    where: { id: referredStoreId },
    select: { id: true, planId: true },
  });
  if (!referrerStore || !referredStore) return;

  const referrerPlan = referrerStore.planId
    ? await prisma.plan.findUnique({ where: { id: referrerStore.planId }, select: { referralRewardPoints: true } })
    : null;
  const rewardPoints = referrerPlan?.referralRewardPoints;

  // No configured plan/reward amount yet — the real production state
  // today. Still flip the referral to REWARDED so it doesn't stay
  // perpetually pending once real values exist; nothing to grant.
  if (!rewardPoints) {
    await prisma.referral.updateMany({
      where: { id: referral.id, status: "PENDING" },
      data: { status: "REWARDED", rewardedAt: new Date() },
    });
    return;
  }

  const flipped = await prisma.referral.updateMany({
    where: { id: referral.id, status: "PENDING" },
    data: { status: "REWARDED", rewardedAt: new Date() },
  });
  if (flipped.count === 0) return; // already rewarded elsewhere (a real race, not a bug)

  for (const storeId of [referrerStore.id, referredStore.id]) {
    await prisma.$transaction(async (tx) => {
      const updated = await tx.store.update({
        where: { id: storeId },
        data: { growthPointBalance: { increment: rewardPoints } },
        select: { growthPointBalance: true },
      });
      await tx.growthPointTransaction.create({
        data: {
          storeId,
          type: "REFERRAL_REWARD",
          amount: rewardPoints,
          balanceAfter: updated.growthPointBalance,
          description: "Referral reward",
        },
      });
    });
  }
}
