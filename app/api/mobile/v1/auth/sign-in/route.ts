import { NextResponse } from "next/server";
import { z } from "zod";
import { guard } from "@/lib/http/guard";
import { verifyCredentialSignIn } from "@/lib/auth/credentialSignIn";
import { issueMobileSession } from "@/lib/auth/mobileSession";

// SIGNING IN TO J4 ON THE PHONE (MOBILE_SIGN_IN_CONTRACT.md, approved 2026-09-27).
//
// The same checks as the website's login, because it is the same function:
// verifyCredentialSignIn runs the throttle, the password, the second factor and
// the security history exactly as NextAuth's authorize does. What differs is
// only what a success hands back — a key for the phone's Keychain instead of a
// browser cookie.
//
// Not rate limited here, for the reason API_BOUNDARY.md gives for the website's
// auth handler: sign-in throttling lives inside the check, where it can see
// success and failure, and the phone shares the website's buckets rather than
// getting an allowance of its own.

const SignInBody = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  /** Empty or absent for the majority of accounts, which have no second factor. */
  code: z.string().max(64).optional(),
});

/**
 * ONE MESSAGE FOR EVERY REFUSAL, word for word the website's. Saying "that code
 * was wrong" would confirm to somebody holding a stolen password that they had
 * the right one and only needed the phone.
 */
const REFUSAL = "That didn't work. Check your email, password, and code if you use one.";

export async function POST(request: Request): Promise<NextResponse> {
  const checked = await guard(request, {
    surface: "mobile.sign-in",
    maxBytes: 4 * 1024,
    schema: SignInBody,
  });
  if (!checked.ok) return checked.response;

  const { email, password, code } = checked.body;
  const user = await verifyCredentialSignIn({ email, password, token: code ?? "" }, request.headers);
  if (!user) {
    return NextResponse.json({ error: REFUSAL }, { status: 401 });
  }

  const { key } = await issueMobileSession({ userId: user.id, device: user.device });

  // The key, once. Only the name and address besides — the verified user object
  // carries the password hash, and none of it leaves this function.
  return NextResponse.json({
    token: key,
    user: { name: user.name, email: user.email },
  });
}
