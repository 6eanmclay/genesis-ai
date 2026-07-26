-- AlterTable
ALTER TABLE "ApprovalRequest" ADD COLUMN     "decisionMode" TEXT NOT NULL DEFAULT 'human',
ADD COLUMN     "delegatedAuthorityId" TEXT;

-- CreateTable
CREATE TABLE "DelegatedAuthority" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "actionType" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "grantedByUserId" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "DelegatedAuthority_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DelegatedAuthority_storeId_actionType_key" ON "DelegatedAuthority"("storeId", "actionType");

-- AddForeignKey
ALTER TABLE "DelegatedAuthority" ADD CONSTRAINT "DelegatedAuthority_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
