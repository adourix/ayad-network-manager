CREATE TABLE "vpn_config" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "vmessLink" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "connected" BOOLEAN NOT NULL DEFAULT false,
  "lastConnectedAt" TIMESTAMP(3),
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "vpn_config_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "profiles" ADD COLUMN "downloadLimit" BIGINT;
ALTER TABLE "profiles" ADD COLUMN "uploadLimit" BIGINT;
ALTER TABLE "profiles" ADD COLUMN "quota" BIGINT;
ALTER TABLE "profiles" ADD COLUMN "quotaPeriod" TEXT;

ALTER TABLE "notifications" ADD COLUMN "readAt" TIMESTAMP(3);

ALTER TABLE "port_rules" ADD COLUMN "deviceId" INTEGER;
UPDATE "port_rules" SET "deviceId" = (SELECT "id" FROM "devices" ORDER BY "id" LIMIT 1);
ALTER TABLE "port_rules" ALTER COLUMN "deviceId" SET NOT NULL;
ALTER TABLE "port_rules" ADD CONSTRAINT "port_rules_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
CREATE INDEX "port_rules_deviceId_idx" ON "port_rules"("deviceId");
