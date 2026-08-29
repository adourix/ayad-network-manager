ALTER TABLE "notifications" ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "notifications" ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "notifications" ADD COLUMN "deliveredAt" TIMESTAMP(3);
ALTER TABLE "notifications" ADD COLUMN "lastDeliveryError" TEXT;
CREATE INDEX "notifications_deliveredAt_nextAttemptAt_idx" ON "notifications"("deliveredAt", "nextAttemptAt");
