import { NextResponse, type NextRequest } from "next/server";
import { isPlatformAdmin } from "@/lib/platformAdmin";
import { buildLedgerStorageReport } from "@/lib/storage/ledgerReport";

// THE OPERATOR STORAGE VIEW — read only.
//
//   GET /api/storage/ledger            what the ledger believes
//   GET /api/storage/ledger?drift=1    and whether the provider agrees
//
// ============ WHY A SECOND ROUTE (2026-08-30) ==========================
//
// /api/storage/report already exists and stays untouched. It lists every blob
// and re-sweeps every text and JSON column in the schema to find what still
// references each one — the right tool for deciding what is safe to delete, and
// slow for exactly that reason.
//
// This one reads the ledger: per-store usage, file counts, the objects nobody
// owns, and drift. Two routes because they answer two questions, and because
// changing what an existing operator endpoint returns is a worse trade than
// adding the one that answers the new question.
//
// ============ PLATFORM ADMIN, FOR THE SAME REASON AS THE OTHER ========
//
// Blob storage is one namespace for the whole deployment, so a per-store
// breakdown necessarily crosses tenants. A business owner reading this would
// learn the file counts and byte totals of every other business on the
// platform. The answer requires seeing across businesses, so only somebody
// entitled to see across them may ask.
//
// 404 rather than 403: an operator endpoint should not confirm its own
// existence to somebody who may not use it.
//
// ============ DRIFT IS OPT-IN =========================================
//
// It costs a full provider listing. Without it this is two indexed aggregates
// and cheap enough to look at whenever; with it, it is the honest answer to
// "is the ledger still right". Defaulting it on would make the everyday view
// slow enough to stop being used.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!(await isPlatformAdmin())) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const includeDrift = request.nextUrl.searchParams.get("drift") === "1";

  try {
    return NextResponse.json(await buildLedgerStorageReport({ includeDrift }), { status: 200 });
  } catch (error) {
    // THE REAL REASON, to an administrator who is the only one who can see it
    // and the only one who could act on it. A diagnostic whose failure mode is
    // a generic message is a diagnostic nobody can diagnose.
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
