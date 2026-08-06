import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { resolveUserStore, hasPermission, PERMISSIONS } from "@/lib/permissions";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";

// Beta 1 bug #2 (2026-08-06) — issues short-lived Vercel Blob client tokens
// so the browser can PUT a business-asset file straight to Blob storage,
// never through this app's own Server Action body. This route's own request
// body is tiny (JSON metadata only, no file bytes) regardless of the real
// file's size, so it never touches the platform-level Serverless Function
// payload ceiling that broke real iPhone photos even after next.config.ts's
// bodySizeLimit was raised. Real auth/permission checks run here, inside
// onBeforeGenerateToken, before any token — and therefore any byte — is
// issued; this is the same GENESIS_CHAT gate uploadBusinessAssetFromChat
// (app/dashboard/ai-actions.ts) already enforces for the record-creation
// half of the flow.
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
        if (!resolved || !hasPermission(resolved.role, PERMISSIONS.GENESIS_CHAT)) {
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
