-- Which relationships a projection owns, so it can take them back.
--
-- THE DEFECT THIS FIXES, stated plainly: as shipped four hours ago, projection
-- only ever ADDED. An invoice whose contactId changed from A to B produced an
-- edge to B and left the edge to A standing forever, so "who is this invoice
-- for?" would answer "two people" and both would look equally stated. A graph
-- that cannot forget is worse than no graph, because it is confidently wrong
-- rather than absent.
--
-- Reconciliation needs to know which edges are ITS to remove, and the table
-- could not say. An edge projected from a challenge's relatedGoalIds and an
-- edge an owner drew by hand are both OWNER provenance, both `blocks`, and both
-- between the same two records -- provenance answers "who said it", never "what
-- maintains it". Those are different questions and the second one has no answer
-- without this column.
--
-- NOT a boolean. `projectedFrom` names the exact record whose data produced the
-- edge, which is what makes the `reversed` projections work: a goal listing its
-- challenges stores the edge pointing challenge -> goal, so neither endpoint
-- identifies the record that has to reconcile it. A boolean would have forced a
-- guess about which end was responsible, and the reversed case is precisely
-- where that guess is wrong.
--
-- NULL means nobody projected it: an edge somebody stated deliberately. Those
-- are never touched by a sync, which is the whole point of separating them --
-- a connector re-syncing an invoice must not quietly delete a connection the
-- owner drew.

ALTER TABLE "RecordRelationship"
  ADD COLUMN "projectedFrom" TEXT;

-- Reconciliation deletes by (storeId, projectedFrom) on every write of that
-- record, so it is the hot path for the graph and needs its own index.
CREATE INDEX "RecordRelationship_storeId_projectedFrom_idx"
  ON "RecordRelationship"("storeId", "projectedFrom");
