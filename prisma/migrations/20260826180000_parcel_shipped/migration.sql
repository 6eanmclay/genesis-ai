-- THE PARCEL A LABEL WAS ACTUALLY BOUGHT FOR (2026-08-26)
--
-- Product.weightOz and Product.lengthIn/widthIn/heightIn are the owner's
-- ESTIMATE, entered once and reused for every order. What a label was actually
-- purchased against is a different fact and, until now, was recorded nowhere:
-- an owner who packed a heavier box and typed the real weight into the label
-- form got the right postage and left no trace of what shipped.
--
-- Additive and nullable. Every existing order reads as "we did not record the
-- parcel", which is exactly what was true.

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "parcelWeightOz" DOUBLE PRECISION,
ADD COLUMN     "parcelLengthIn" DOUBLE PRECISION,
ADD COLUMN     "parcelWidthIn" DOUBLE PRECISION,
ADD COLUMN     "parcelHeightIn" DOUBLE PRECISION;
