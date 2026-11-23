-- Support efficient bounded retention queries by period end timestamp.
CREATE INDEX "quota_periods_periodEnd_idx" ON "quota_periods"("periodEnd");
