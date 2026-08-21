-- Genesis's own "I wouldn't recommend this, and here's why", made durable.
--
-- Until now it existed only inside the return value of one discovery run, so
-- being able to say "I already looked at that and ruled it out" was true for
-- exactly as long as the request that produced it. That sentence is most of what
-- separates a partner from a search box.
--
-- Additive. ADD VALUE IF NOT EXISTS because Postgres enum values cannot be
-- removed and a re-run must be harmless.

ALTER TYPE "SourcedProductStatus" ADD VALUE IF NOT EXISTS 'RULED_OUT';
