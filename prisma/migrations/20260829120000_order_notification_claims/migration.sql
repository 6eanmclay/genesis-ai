-- Two more notification claims on Order, for the two events that had none.
--
-- Delivery and refund were both ingested end to end and neither told the
-- customer. These are the same shape as confirmationSentAt / shipmentNotifiedAt
-- / ownerNotifiedAt, and for the same reason: idempotency is a CLAIM won by a
-- conditional update, not a check followed by a send.
--
-- Additive and nullable. Nothing is backfilled: an order delivered before this
-- existed was never notified, and writing a timestamp would claim it had been.
ALTER TABLE "Order" ADD COLUMN "deliveryNotifiedAt" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "refundNotifiedAt" TIMESTAMP(3);
