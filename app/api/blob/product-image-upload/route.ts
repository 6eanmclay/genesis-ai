import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveUserStore, hasPermission, PERMISSIONS } from "@/lib/permissions";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/imageProviders/uploadProvider";

// Product media upload fix (2026-08-08) — same real fix as
// app/api/blob/business-asset-upload/route.ts's own, applied to product
// photos: issues a short-lived Vercel Blob client token so the browser can
// PUT image bytes straight to Blob storage, never through this app's own
// Server Action body. Confirmed via real evidence (production
// ExecutionLog query, zero FAILED product.create rows despite a real
// mobile failure) and Vercel's own current docs: a Vercel Function's
// request body is hard-capped at 4.5MB at the platform level, a ceiling
// next.config.ts's serverActions.bodySizeLimit ("10mb") cannot raise —
// that config only governs Next's own layer, underneath Vercel's lower,
// non-configurable one. CreateProductForm and the Products list's own
// photo form previously sent raw file bytes directly in the Server Action
// body; a real phone photo clearing 4.5MB failed silently at the platform
// layer, before any application code (and therefore any error message or
// log) ever ran. This route's own body is tiny (JSON metadata only,
// regardless of the real file's size), so it never touches that ceiling.
// Real auth/permission checks run here, inside onBeforeGenerateToken,
// before any token — and therefore any byte — is issued.
export async function POST(request: Request): Promise<NextResponse> {
  const body = (await request.json()) as HandleUploadBody;

  try {
    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => {
        const session = await auth();
        if (!session?.user) {
          throw new Error("Not authenticated.");
        }
        const resolved = await resolveUserStore(session.user.id);
        if (!resolved || !hasPermission(resolved.role, PERMISSIONS.PRODUCTS_MANAGE)) {
          throw new Error("You don't have permission to do this.");
        }
        return {
          allowedContentTypes: Object.keys(ALLOWED_CONTENT_TYPES),
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          addRandomSuffix: false,
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
