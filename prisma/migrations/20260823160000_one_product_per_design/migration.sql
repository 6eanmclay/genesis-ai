-- D3: the same design cannot become two products.
--
-- approve_design_as_product was the one genuinely non-idempotent path in the
-- whole tool surface. Two concurrent approvals — a double-click, a retried
-- turn, the chat path and a button at once — both read the design, both passed
-- every check, and both created a product. The owner ends up selling the same
-- thing twice and pays growth points twice for it.
--
-- ENFORCED BY THE DATABASE, not by a check somebody has to remember. The design
-- id already lives in Product.richContent as provenance, so this needs no new
-- column and creates no second representation of where a product came from —
-- it makes the fact already recorded there unique.
--
-- Scoped per store: two businesses can hold designs with different ids anyway,
-- but scoping it keeps the constraint honest about what it means rather than
-- relying on cuid collision-freedom for correctness.
--
-- PARTIAL, because almost every product has no design. Only products made in
-- Studio carry designId, and a plain unique index over the extracted NULLs
-- would collapse every other product in the store into one another.
--
-- One design becomes one product on purpose: a Design already records the
-- surface it is for, so "the same design as a mug as well" is a second design,
-- not a second product from this one.
CREATE UNIQUE INDEX "Product_one_per_design"
  ON "Product" ("storeId", (("richContent"->>'designId')))
  WHERE "richContent"->>'designId' IS NOT NULL;
