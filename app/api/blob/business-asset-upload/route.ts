import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { hasPermission, PERMISSIONS } from "@/lib/permissions";
import { resolveBusiness } from "@/lib/businessContext";
import { ALLOWED_CONTENT_TYPES, MAX_UPLOAD_BYTES } from "@/lib/businessAssets/uploadAssetFile";
import { ALLOWED_VOICE_MEMO_CONTENT_TYPES, MAX_VOICE_MEMO_BYTES } from "@/lib/voice/voiceMemoFile";

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
        // AMBIGUOUS IS ITS OWN ANSWER (2026-08-21). resolveUserStore returned
        // null for both "no business" and "more than one and nothing says
        // which", so the two were indistinguishable here. Both still refuse —
        // failing closed is right — but they are no longer the same fact, and
        // nothing silently picks a business to upload into.
        const resolution = await resolveBusiness(session.user.id);
        if (resolution.kind === "ambiguous") {
          throw new Error("Choose which business this is for before uploading.");
        }
        if (resolution.kind === "none" || !hasPermission(resolution.role, PERMISSIONS.GENESIS_CHAT)) {
          throw new Error("You don't have permission to do this.");
        }
        return {
          // J4 Voice Memos — this one token-issuing endpoint now covers
          // both real upload kinds (photo/document and voice memo); the
          // real per-kind content-type check still happens again
          // server-side at record-creation time (finalizeUploadedAssetFile
          // / uploadVoiceMemo), same defense-in-depth this already had.
          allowedContentTypes: [...Object.keys(ALLOWED_CONTENT_TYPES), ...Object.keys(ALLOWED_VOICE_MEMO_CONTENT_TYPES)],
          maximumSizeInBytes: Math.max(MAX_UPLOAD_BYTES, MAX_VOICE_MEMO_BYTES),
          addRandomSuffix: false,
        };
      },
    });
    return NextResponse.json(jsonResponse);
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
