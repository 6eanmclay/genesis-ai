import { head } from "@vercel/blob";
import {
  recordActualByPathname,
  reserveClientUpload,
  splitPathname,
  PREFIX_LIFECYCLE,
} from "./ledger";
import { reportIssue } from "@/lib/observability/reportIssue";

// THE ONE ACCOUNTING PATH FOR DIRECT-TO-PROVIDER UPLOADS.
//
// ============ WHY THIS IS SHARED, NOT COPIED INTO BOTH ROUTES ==========
//
// There are two token routes — business assets and product images — and Sean's
// instruction was explicit: handle them "as part of the approved Slice 3
// batch-preflight/reservation mechanism rather than creating a second
// accounting path." Two routes each with their own reserve-and-record logic is
// exactly that second path, and it would drift the first time one of them was
// changed alone. So both call the same two functions, below.
//
// ============ WHERE THE BYTES ACTUALLY GET COUNTED =====================
//
// The browser PUTs straight to the provider; this application never sees the
// file. So there are exactly two moments available to us:
//
//   onBeforeGenerateToken — before any byte moves. The reservation goes here,
//                           and the ceiling it grants is handed to the provider
//                           as maximumSizeInBytes, which is what makes the
//                           ceiling real rather than advisory.
//   onUploadCompleted     — the provider's webhook, after the bytes landed.
//                           The actual size replaces the reservation here.
//
// ============ AND WHY THE WEBHOOK IS NOT TRUSTED TO BE THE ONLY ONE ====
//
// onUploadCompleted is delivered to a publicly reachable URL. It does not fire
// against localhost, and a webhook is a network call that can simply not
// arrive. If it were the only place the actual size were recorded, every missed
// delivery would leave a reservation holding space forever for an upload that
// in fact succeeded.
//
// So reconciliation carries a backstop: a reservation whose blob is present in
// the provider listing is recorded from the listing itself. The webhook is the
// fast path, not the correctness guarantee. See scripts/reconcile-storage.ts.

/** What a token route needs to know to reserve, kept in one place per route. */
export interface ClientUploadKind {
  /** "asset.upload" — ends up in StorageObject.source. */
  source: string;
  /** The already-enforced per-kind maximum this route grants. */
  maximumSizeInBytes: number;
}

/**
 * Reserve the key the browser asked for, and say how big it may be.
 *
 * Returns the ceiling to hand the provider. A reservation failure is NEVER
 * allowed to stop the upload while enforcement is off — see the throw in
 * reserveClientUpload, which only fires when enforcement is on.
 */
export async function reserveForClientUpload(params: {
  storeId: string;
  pathname: string;
  kind: ClientUploadKind;
  contentType?: string;
}): Promise<{ maximumSizeInBytes: number; tokenPayload: string }> {
  const { prefix } = splitPathname(params.pathname);
  if (!PREFIX_LIFECYCLE[prefix]) {
    // STORAGE.md item 7: a path nobody declared. The upload is not blocked —
    // that would be a storage decision breaking a working feature — but it is
    // reported, because an undeclared prefix means a lifecycle nobody chose.
    reportIssue(`client upload to an undeclared prefix: ${params.pathname}`, null, {
      subsystem: "storage",
      stage: "clientUpload.undeclaredPrefix",
      storeId: params.storeId,
    });
  }

  const reservation = await reserveClientUpload(params.storeId, {
    pathname: params.pathname,
    source: params.kind.source,
    ceilingBytes: params.kind.maximumSizeInBytes,
    contentType: params.contentType,
  });

  return {
    maximumSizeInBytes: reservation.ceilingBytes,
    // Carried by the provider and handed back to onUploadCompleted, so the
    // completion knows which store it belonged to without re-authenticating a
    // request that comes from the provider rather than the person.
    tokenPayload: JSON.stringify({ storeId: params.storeId, pathname: reservation.pathname }),
  };
}

/**
 * The upload landed. Replace the reservation with what actually arrived.
 *
 * Never throws. This runs inside a provider webhook, and an exception here
 * would make the provider retry an upload that already succeeded — so a failure
 * is reported and left for the reconciliation backstop to correct.
 */
export async function recordCompletedClientUpload(blob: {
  pathname: string;
  url: string;
  contentType?: string;
}): Promise<void> {
  try {
    // ============ THE SIZE COMES FROM THE PROVIDER ==================
    //
    // PutBlobResult carries url, pathname and contentType — and no size. The
    // two wrong ways to fill that gap would be to trust a number the browser
    // sends, or to keep the reservation's ceiling as though it were the truth.
    // Both would put a figure in sizeInBytes that nobody measured. `head` asks
    // the only party that actually knows.
    const meta = await head(blob.url);
    await recordActualByPathname({
      pathname: blob.pathname,
      url: blob.url,
      sizeInBytes: meta.size,
      contentType: meta.contentType ?? blob.contentType,
    });
  } catch (error) {
    reportIssue(`could not record completed upload ${blob.pathname}`, error, {
      subsystem: "storage",
      stage: "clientUpload.record",
    });
  }
}
