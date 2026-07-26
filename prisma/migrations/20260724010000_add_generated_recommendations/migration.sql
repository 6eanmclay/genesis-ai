-- CreateTable
CREATE TABLE "GeneratedRecommendation" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "priority" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "actionLabel" TEXT NOT NULL,
    "actionHref" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GeneratedRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GeneratedRecommendation_storeId_idx" ON "GeneratedRecommendation"("storeId");

-- AddForeignKey
ALTER TABLE "GeneratedRecommendation" ADD CONSTRAINT "GeneratedRecommendation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
