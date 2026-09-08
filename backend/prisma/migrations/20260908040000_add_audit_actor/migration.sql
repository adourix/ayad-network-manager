ALTER TABLE "audit_log" ADD COLUMN "actor" TEXT;
CREATE INDEX "audit_log_actor_idx" ON "audit_log"("actor");
