/*
  Warnings:

  - You are about to drop the column `usedBytes` on the `quota_periods` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "quota_periods" DROP COLUMN "usedBytes",
ADD COLUMN     "usedDownloadBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "usedUploadBytes" BIGINT NOT NULL DEFAULT 0;
