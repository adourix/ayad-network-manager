CREATE TABLE "blocked_devices" (
  "id" SERIAL NOT NULL,
  "deviceId" INTEGER NOT NULL,
  "mac" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "reason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "blocked_devices_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "blocked_devices_deviceId_key" ON "blocked_devices"("deviceId");
CREATE UNIQUE INDEX "blocked_devices_mac_key" ON "blocked_devices"("mac");
CREATE INDEX "blocked_devices_active_idx" ON "blocked_devices"("active");
ALTER TABLE "blocked_devices" ADD CONSTRAINT "blocked_devices_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ip_bindings" (
  "id" SERIAL NOT NULL,
  "blockedDeviceId" INTEGER NOT NULL,
  "ip" TEXT NOT NULL,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "boundAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "releasedAt" TIMESTAMP(3),
  "releaseReason" TEXT,
  CONSTRAINT "ip_bindings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ip_bindings_ip_active_idx" ON "ip_bindings"("ip", "active");
CREATE UNIQUE INDEX "ip_bindings_blockedDeviceId_ip_active_key" ON "ip_bindings"("blockedDeviceId", "ip", "active");
ALTER TABLE "ip_bindings" ADD CONSTRAINT "ip_bindings_blockedDeviceId_fkey" FOREIGN KEY ("blockedDeviceId") REFERENCES "blocked_devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
