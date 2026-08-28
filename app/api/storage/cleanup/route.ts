import { NextRequest, NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { cleanupUnreferenced } from "@/lib/storage/cleanup";

// RECLAIMING STORAGE THAT NOTHING NEEDS.
//
// ============ A DRY RUN UNLESS TOLD OTHERWISE (2026-08-28) =============
//
// Sean, authorising a temporary cleanup: "Before deleting a large batch, show
// me the proposed deletion list/count and estimated storage recovery." So the
// default is a proposal, and the proposal is produced by the same code path as
// the deletion — the list shown is by construction the list that would go.
//
//   GET /api/storage/cleanup                      what would go, and how much
//   GET /api/storage/cleanup?prefixes=printfiles,mockups   narrowed to leftovers
//   GET /api/storage/cleanup?confirm=yes&max=200           actually delete
//
// Nothing is deleted on the strength of the list. The reference scan runs again
// inside the deletion, and anything a record still points at is refused however
// explicitly it was named — a report is a photograph of a moment, and between
// reading one and acting on it somebody can finish a design or set a logo.
//
// Platform admin only, for the same reason the report is: the scan crosses
// tenants because blob storage is one namespace for the whole deployment.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const params = request.nextUrl.searchParams;
  const prefixes = params.get("prefixes")?.split(",").map((p) => p.trim()).filter(Boolean);
  const max = Number(params.get("max"));

  try {
    const result = await cleanupUnreferenced({
      // Explicit and positive. A missing parameter, a typo, or a link somebody
      // pasted must all mean "show me", never "delete".
      confirm: params.get("confirm") === "yes",
      prefixes,
      max: Number.isFinite(max) && max > 0 ? max : undefined,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
