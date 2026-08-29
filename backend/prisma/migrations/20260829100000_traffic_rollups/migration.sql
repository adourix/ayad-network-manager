CREATE TABLE "traffic_rollups" (
  "id" BIGSERIAL NOT NULL,
  "deviceId" INTEGER NOT NULL,
  "bucketStart" TIMESTAMP(3) NOT NULL,
  "granularity" TEXT NOT NULL,
  "downloadBytes" BIGINT NOT NULL,
  "uploadBytes" BIGINT NOT NULL,
  CONSTRAINT "traffic_rollups_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "traffic_rollups_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "traffic_rollups_deviceId_bucketStart_granularity_key" ON "traffic_rollups"("deviceId", "bucketStart", "granularity");
CREATE INDEX "traffic_rollups_deviceId_bucketStart_idx" ON "traffic_rollups"("deviceId", "bucketStart");
