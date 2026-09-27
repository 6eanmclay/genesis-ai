import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveBusiness } from "@/lib/businessContext";
import { authenticateMobile, mobileAuthFailure } from "@/lib/auth/mobileSession";

// WHO THE PHONE IS SIGNED IN AS — its first proof that the key works, and what
// the signed-in screen shows: the person and the business they're working in.
//
// The business comes from resolveBusiness, the website's single answer to
// "which one", so the phone and the dashboard can never disagree about it.
// Ambiguous is reported as such rather than resolved here: choosing a business
// is website work for now, and picking one on the owner's behalf is the exact
// failure that module exists to prevent.
export async function GET(request: Request): Promise<NextResponse> {
  const result = await authenticateMobile(request);
  if (!result.ok) return mobileAuthFailure(result);

  const [user, business] = await Promise.all([
    prisma.user.findUnique({ where: { id: result.userId }, select: { name: true, email: true } }),
    resolveBusiness(result.userId),
  ]);
  if (!user) return NextResponse.json({ error: "signed_out" }, { status: 401 });

  return NextResponse.json({
    user: { name: user.name, email: user.email },
    business:
      business.kind === "resolved"
        ? { name: business.store.name, role: business.role }
        : null,
    /** True when the account has several businesses and none is active yet. */
    needsBusinessChoice: business.kind === "ambiguous",
  });
}
