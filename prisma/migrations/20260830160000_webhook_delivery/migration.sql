-- Every webhook this platform has ever been handed.
--
-- Today a delivery is verified, handled, and forgotten. Nothing records that it
-- arrived, so there is no answer to "did the provider ever send that", no way to
-- replay one that failed, and no way to notice the same event twice or two
-- events out of order.
--
-- The framework has an IntegrationWebhooks contract and NO CONNECTOR
-- IMPLEMENTS IT: all three live handlers (Stripe, PayPal, EasyPost) are
-- one-off routes that bypass it. Connections month adds providers that all
-- deliver webhooks, so this is the shared record they write to.
--
-- The raw body is kept verbatim. A parsed copy would be this codebase's
-- interpretation of the delivery rather than the delivery, and replay has to
-- start from what the provider actually sent.
CREATE TABLE "WebhookDelivery" (
  "id"              TEXT NOT NULL,
  "provider"        TEXT NOT NULL,
  -- The provider's own event id when it offers one. Null is honest for a
  -- provider that does not.
  "externalEventId" TEXT,
  -- Resolved when the delivery can be attributed to a business; null when the
  -- signature failed or the account matched nothing.
  "storeId"         TEXT,
  -- received | processed | failed | rejected
  "status"          TEXT NOT NULL DEFAULT 'received',
  -- False means the signature did not check out. Recorded rather than dropped:
  -- a burst of them is the shape of a misconfigured secret or an attack, and
  -- either is worth being able to see.
  "signatureValid"  BOOLEAN NOT NULL,
  "payload"         TEXT NOT NULL,
  "headers"         JSONB,
  "error"           TEXT,
  "attempts"        INTEGER NOT NULL DEFAULT 0,
  "receivedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processedAt"     TIMESTAMP(3),
  CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- DUPLICATE DETECTION, where the provider gives us the means. A provider that
-- retries a delivery it already sent reuses its event id, so this turns a
-- replay into a recognisable fact instead of a second unit of work.
--
-- Not a partial index, though the first draft made it one. Postgres treats
-- NULLs as distinct in a unique index, so a provider that sends no event id can
-- still deliver as often as it likes — and a plain index is one Prisma's schema
-- can express, which keeps the migration and the model from drifting apart.
CREATE UNIQUE INDEX "WebhookDelivery_provider_externalEventId_key"
  ON "WebhookDelivery"("provider", "externalEventId");

CREATE INDEX "WebhookDelivery_provider_receivedAt_idx" ON "WebhookDelivery"("provider", "receivedAt");
CREATE INDEX "WebhookDelivery_status_receivedAt_idx" ON "WebhookDelivery"("status", "receivedAt");
CREATE INDEX "WebhookDelivery_storeId_receivedAt_idx" ON "WebhookDelivery"("storeId", "receivedAt");

-- SetNull rather than Cascade: the history of what a provider sent outlives the
-- business it was about, and a deleted store must not erase the record that
-- money moved.
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
