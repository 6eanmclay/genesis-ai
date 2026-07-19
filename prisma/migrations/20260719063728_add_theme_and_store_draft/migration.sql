-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "theme" JSONB;

-- CreateTable
CREATE TABLE "StoreDraft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "businessDescription" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "theme" JSONB,
    "productsDraft" JSONB,
    "blueprint" JSONB,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StoreDraft_userId_key" ON "StoreDraft"("userId");

-- AddForeignKey
ALTER TABLE "StoreDraft" ADD CONSTRAINT "StoreDraft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
