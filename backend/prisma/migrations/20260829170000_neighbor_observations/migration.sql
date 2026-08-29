CREATE TABLE "neighbor_observations" (
  "id" BIGSERIAL NOT NULL,
  "mac" TEXT NOT NULL,
  "ip" TEXT NOT NULL,
  "neighborState" TEXT NOT NULL,
  "consecutiveCount" INTEGER NOT NULL DEFAULT 1,
  "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "neighbor_observations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "neighbor_observations_mac_ip_key" ON "neighbor_observations"("mac", "ip");
CREATE INDEX "neighbor_observations_lastSeen_idx" ON "neighbor_observations"("lastSeen");
