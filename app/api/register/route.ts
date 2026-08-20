import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { recordReferralSignup } from "@/lib/growthPoints/referral";
import { checkPassword } from "@/lib/auth/passwordPolicy";

export async function POST(request: Request) {
  try {
    const { name, email, password, ref } = await request.json();

    if (!email || !password) {
      return NextResponse.json(
        { error: "Email and password are required" },
        { status: 400 }
      );
    }

    // There was no requirement here at all until 2026-08-20 — "a" was a valid
    // password on a platform that holds connected Stripe accounts. Checked
    // before the existing-user lookup so the rules are enforced identically
    // whether or not the email is already taken.
    const passwordCheck = checkPassword(password);
    if (!passwordCheck.ok) {
      return NextResponse.json({ error: passwordCheck.message }, { status: 400 });
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "An account with this email already exists" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });

    // Growth Points Economy (Chapter 2) — records the relationship only;
    // the actual reward waits for a real completion signal (see
    // rewardReferralIfEligible). Never blocks or fails signup over an
    // invalid/missing code.
    if (typeof ref === "string" && ref.trim()) {
      await recordReferralSignup(ref.trim(), user.id).catch(() => {});
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