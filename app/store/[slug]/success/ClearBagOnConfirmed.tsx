"use client";

import { useEffect, useRef } from "react";
import { clearBagAfterConfirmedPurchase } from "./clearBagAction";

/**
 * Asks the server to empty the bag once, after a confirmed purchase.
 *
 * RENDERS NOTHING. There is no message, no spinner and no button: the bag
 * emptying is not news to a customer who has just been told their order is
 * confirmed, and a failure here is not something to worry them with — their
 * order is already placed either way.
 *
 * ONCE PER MOUNT. React runs effects twice in development's strict mode, and
 * a customer may refresh the page. The clear is idempotent server-side, but
 * the ref keeps this from making the round trip more than once regardless.
 *
 * WHY A CLIENT COMPONENT AT ALL. Cookies cannot be written while a Server
 * Component renders, so something has to invoke a Server Function. This is
 * the smallest thing that can.
 */
export function ClearBagOnConfirmed({
  slug,
  sessionId,
  orderId,
}: {
  slug: string;
  sessionId: string | null;
  orderId: string | null;
}) {
  const asked = useRef(false);

  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    // Deliberately unawaited and swallowed. The customer's order is complete;
    // a bag that failed to empty is a cosmetic annoyance, and surfacing it
    // here would turn a successful purchase into an error message.
    void clearBagAfterConfirmedPurchase(slug, sessionId, orderId).catch(() => {});
  }, [slug, sessionId, orderId]);

  return null;
}
