-- Whether the customer was actually told.
--
-- Genesis tracked three things about an order — payment status, the owner's
-- fulfilment acknowledgment, and whether a shipping label existed — and none of
-- them answered "has the person who paid heard anything?". That question had no
-- representation at all, which meant a webhook replay could send the same
-- notification twice and nothing could distinguish a notified order from one
-- that had been silently missed.
--
-- Both columns are the CLAIM half of a claim-then-send: set before the attempt
-- so a concurrent delivery cannot also send, cleared again if the send fails so
-- a later retry can. See lib/orders/orderConfirmation.ts.
--
-- Additive and nullable. NULL means "not yet told", which is correctly true of
-- every order that already exists — none of them was ever notified, because no
-- confirmation path existed to notify them.
ALTER TABLE "Order" ADD COLUMN "confirmationSentAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "shipmentNotifiedAt" TIMESTAMP(3);
