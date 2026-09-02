import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { normalizeEmail } from "@/lib/auth/normalizeEmail";
import { recordReferralSignup } from "@/lib/growthPoints/referral";
import { checkPassword } from "@/lib/auth/passwordPolicy";
import { guard } from "@/lib/http/guard";

// CREATING AN ACCOUNT — THE ONE UNAUTHENTICATED ENDPOINT THAT WRITES.
//
// ============ WHAT IT ACCEPTED BEFORE (2026-08-30) =====================
//
// Anything, at any rate. `const { name, email, password, ref } = await
// request.json()` with no shape, no size limit and no throttle, on an endpoint
// that inserts a row and runs a bcrypt hash at cost 10 — about a tenth of a
// second of CPU per call, which a script gets for free as often as it likes.
// A missing email format check also meant "A@b.com" and "a@b.com" became two
// separate accounts on a column that is unique but not normalised.
//
// ============ THE LIMITS, AND WHY THERE ARE TWO =======================
//
// The same reasoning lib/auth/attemptThrottle.ts already applies to sign-in,
// because they stop different things:
//
//   per address   somebody creating accounts in bulk from one place.
//   per email     somebody hammering one address — which never trips an
//                 address limit if they spread the requests around.
//
// Both are generous enough that a family behind one router, or a person who
// mistypes their password twice, never notices.

const RegisterBody = z.object({
  // ============ NORMALISED (2026-09-02, E11) =========================
  //
  // This deliberately did NOT lowercase, and the comment it replaces was
  // right at the time: auth.ts looked users up exactly as typed, so
  // normalising this side alone would have locked out every existing
  // mixed-case account. What was missing was the measurement.
  //
  // Production holds 40 accounts, 0 of them with any uppercase character
  // and 0 case-insensitive collisions, so no existing row changes meaning
  // — and auth.ts and the reset path normalise in this same deploy, which
  // is the condition EXTERNAL_BLOCKERS.md E11 set. The rate limit was
  // already case-insensitive (bucketFor lowercases before hashing) and is
  // unaffected.
  email: z.string().trim().email("That does not look like an email address.")
    .transform(normalizeEmail),
  // A password rule exists in lib/auth/passwordPolicy and stays the authority;
  // this only bounds the length so bcrypt is never handed a megabyte.
  password: z.string().min(1).max(200),
  name: z.string().trim().max(100).optional(),
  ref: z.string().trim().max(64).optional(),
});

export async function POST(request: Request) {
  const checked = await guard(request, {
    surface: "register",
    // Four fields of text. Anything larger is not a registration.
    maxBytes: 4 * 1024,
    schema: RegisterBody,
    limits: (body, address) => [
      { kind: "register:ip", value: address, max: 10 },
      { kind: "register:email", value: body.email, max: 5 },
    ],
  });
  if (!checked.ok) return checked.response;

  const { name, email, password, ref } = checked.body;

  try {
    // There was no requirement here at all until 2026-08-20 — "a" was a valid
    // password on a platform that holds connected Stripe accounts. Checked
    // before the existing-user lookup so the rules are enforced identically
    // whether or not the email is already taken.
    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
      return NextResponse.json({ error: passwordCheck.message }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({ where: { email } });

    if (existingUser) {
      // ============ THIS TELLS AN ATTACKER SOMETHING ==============
      //
      // "An account with this email already exists" is account enumeration: a
      // script can learn which addresses are registered here. It is kept,
      // deliberately, because the alternative — pretending to succeed and
      // sending a "you already have an account" email — needs an email
      // provider this platform does not yet have (EXTERNAL_BLOCKERS.md E1),
      // and silently doing nothing would leave a real person stuck on a form
      // that appears to work.
      //
      // The rate limit above is what makes it expensive to enumerate at scale.
      // Recorded here so the trade is a decision rather than an oversight.
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: { name, email, password: hashedPassword },
    });

    // Growth Points Economy (Chapter 2) — records the relationship only;
    // the actual reward waits for a real completion signal (see
    // rewardReferralIfEligible). Never blocks or fails signup over an
    // invalid/missing code.
    if (ref) {
      await recordReferralSignup(ref, user.id).catch(() => {});
    }

    return NextResponse.json(
      { id: user.id, email: user.email, name: user.name },
      { status: 201 }
    );
  } catch (error) {
    console.error("Registration error:", error);
    return NextResponse.json(
      { error: "Something went wrong" },
      { status: 500 }
    );
  }
}
