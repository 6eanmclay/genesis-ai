import { NextResponse } from "next/server";
import { authenticateMobile, endMobileSession } from "@/lib/auth/mobileSession";

// THE PHONE SIGNING ITSELF OUT.
//
// Always 204, including for a key that was already dead: the phone is about to
// forget its key either way, and "you were already signed out" is not something
// it needs to be told. A database failure is the one case that says otherwise,
// so the app knows the key may still be live and can try again.
export async function POST(request: Request): Promise<Response> {
  const result = await authenticateMobile(request);
  if (!result.ok) {
    return result.reason === "unavailable"
      ? NextResponse.json({ error: "unavailable" }, { status: 503 })
      : new Response(null, { status: 204 });
  }
  await endMobileSession({ userId: result.userId, sessionInstanceId: result.sessionInstanceId });
  return new Response(null, { status: 204 });
}
