-- Brute-force protection for the auth endpoints.
--
-- There was none at all: login, signup and password-reset requests could be
-- hammered without limit.
--
-- A table rather than in-memory counters because this runs on serverless. An
-- in-process Map resets on every cold start and is not shared between
-- concurrent instances — it would look like protection and provide none.
--
-- `bucket` holds a HASH of what is being limited, never the email or IP itself.
-- A table full of plaintext addresses typed by attackers — belonging to real
-- people who never signed up here — would be a liability created in the name of
-- security.
CREATE TABLE "AuthAttempt" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuthAttempt_pkey" PRIMARY KEY ("id")
);

-- Serves both the count-within-window query and the expiry sweep.
CREATE INDEX "AuthAttempt_bucket_occurredAt_idx" ON "AuthAttempt"("bucket", "occurredAt");
