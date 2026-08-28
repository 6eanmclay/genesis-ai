import { NextResponse } from "next/server";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { buildStorageReport } from "@/lib/storage/report";

// WHAT IS CONSUMING STORAGE — read only.
//
// ============ EVIDENCE BEFORE DELETION (2026-08-28) ====================
//
// Sean: "Before we start deleting anything from the Vercel dashboard, I want
// the read-only usage report you proposed. Build that first... That gives us
// evidence before we touch anything."
//
// It cannot delete. Not "does not" — the storage interface it reads through has
// no delete operation at all, deliberately, until the reference checking that
// would guard one is built.
//
// ============ PLATFORM ADMIN, NOT BUSINESS OWNER ======================
//
// The reference scan must cross tenants: blob storage is one namespace for the
// whole deployment, so a file referenced by ANY store is unsafe to delete, and
// a scan restricted to one business would report another's product image as
// unreferenced. The answer therefore requires seeing across businesses, so the
// question may only be asked by somebody entitled to see across them. A
// business owner would otherwise learn the filenames of every other business
// on the platform.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await isPlatformAdmin())) {
    // 404 rather than 403: an operator endpoint should not confirm its own
    // existence to somebody who may not use it.
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  try {
    return NextResponse.json(await buildStorageReport(), { status: 200 });
  } catch (error) {
    // THE REAL REASON. A diagnostic whose failure mode is a generic message
    // sends whoever is using it to look for the fault somewhere else — which
    // has already cost this project one investigation into a production
    // deployment that was working perfectly.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
