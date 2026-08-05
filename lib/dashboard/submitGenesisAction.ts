import { unstable_rethrow } from "next/navigation";

// Reliability hardening (post-incident, 2026-08-05) — real evidence traced
// via Sentry breadcrumbs: a genuine 42-61s hang between a chat submit and a
// client-side "TypeError: Failed to fetch," far past Vercel's own function
// timeout. A network-level failure on a Server Action call is a rejected
// Promise at the BROWSER level — it never reaches callGenesisModel()'s own
// try/catch (that code never even ran, or its response never arrived), so
// it's invisible to every existing provider-error classification. The only
// place this is catchable at all is here, at the actual call site.
//
// Every real caller of this ends in one of two shapes: a FormData action
// that terminates in Next's own redirect() (sendStoreMessage, and friends),
// or a plain value-returning action with no redirect (submitMeetingTurn).
// unstable_rethrow handles both uniformly — it only ever re-throws Next's
// own internal control-flow signals (redirect()/notFound()) and is a no-op
// for a genuine error, so this works correctly regardless of which shape
// the caller uses; a redirect-terminated action still redirects exactly as
// before, nothing here changes for it.
export const GENESIS_NETWORK_FAILURE_MESSAGE =
  "Genesis couldn't complete that — the connection may have dropped, or it took longer than expected. Nothing you've already done was lost; please try again.";

export type GenesisActionOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

export async function callGenesisAction<T>(
  action: () => Promise<T>
): Promise<GenesisActionOutcome<T>> {
  try {
    const value = await action();
    return { ok: true, value };
  } catch (err) {
    unstable_rethrow(err);
    return { ok: false, message: GENESIS_NETWORK_FAILURE_MESSAGE };
  }
}
