-- CreateTable
CREATE TABLE "devices" (
    "id" SERIAL NOT NULL,
    "mac" TEXT NOT NULL,
    "ip" TEXT,
    "hostname" TEXT,
    "firstSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "devices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_policies" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "blocked" BOOLEAN NOT NULL DEFAULT false,
    "downloadLimit" BIGINT,
    "uploadLimit" BIGINT,
    "quota" BIGINT,
    "quotaPeriod" TEXT,
    "quotaAction" TEXT,
    "profileId" INTEGER,
    "scheduleId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "device_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "profiles" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedule_rules" (
    "id" SERIAL NOT NULL,
    "scheduleId" INTEGER NOT NULL,
    "dayOfWeek" INTEGER NOT NULL,
    "startTime" TEXT NOT NULL,
    "endTime" TEXT NOT NULL,
    "downloadLimit" BIGINT,
    "uploadLimit" BIGINT,
    "blocked" BOOLEAN,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "schedule_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "port_rules" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "protocol" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "port_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quota_periods" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "periodType" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "usedBytes" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quota_periods_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "traffic_samples" (
    "id" BIGSERIAL NOT NULL,
    "deviceId" INTEGER NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL,
    "downloadBytes" BIGINT NOT NULL,
    "uploadBytes" BIGINT NOT NULL,
    "downloadRate" BIGINT,
    "uploadRate" BIGINT,

    CONSTRAINT "traffic_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" SERIAL NOT NULL,
    "deviceId" INTEGER,
    "type" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" BIGSERIAL NOT NULL,
    "deviceId" INTEGER,
    "action" TEXT NOT NULL,
    "mac" TEXT,
    "details" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "devices_mac_key" ON "devices"("mac");

-- CreateIndex
CREATE INDEX "devices_lastSeen_idx" ON "devices"("lastSeen");

-- CreateIndex
CREATE UNIQUE INDEX "device_policies_deviceId_key" ON "device_policies"("deviceId");

-- CreateIndex
CREATE INDEX "device_policies_profileId_idx" ON "device_policies"("profileId");

-- CreateIndex
CREATE INDEX "device_policies_scheduleId_idx" ON "device_policies"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "profiles_name_key" ON "profiles"("name");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_name_key" ON "schedules"("name");

-- CreateIndex
CREATE INDEX "schedule_rules_scheduleId_idx" ON "schedule_rules"("scheduleId");

-- CreateIndex
CREATE INDEX "port_rules_protocol_port_idx" ON "port_rules"("protocol", "port");

-- CreateIndex
CREATE INDEX "quota_periods_deviceId_periodEnd_idx" ON "quota_periods"("deviceId", "periodEnd");

-- CreateIndex
CREATE UNIQUE INDEX "quota_periods_deviceId_periodType_periodStart_key" ON "quota_periods"("deviceId", "periodType", "periodStart");

-- CreateIndex
CREATE INDEX "traffic_samples_deviceId_timestamp_idx" ON "traffic_samples"("deviceId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "traffic_samples_deviceId_timestamp_key" ON "traffic_samples"("deviceId", "timestamp");

-- CreateIndex
CREATE INDEX "notifications_deviceId_idx" ON "notifications"("deviceId");

-- CreateIndex
CREATE INDEX "notifications_createdAt_idx" ON "notifications"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_deviceId_idx" ON "audit_log"("deviceId");

-- CreateIndex
CREATE INDEX "audit_log_mac_idx" ON "audit_log"("mac");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- AddForeignKey
ALTER TABLE "device_policies" ADD CONSTRAINT "device_policies_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_policies" ADD CONSTRAINT "device_policies_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_policies" ADD CONSTRAINT "device_policies_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedule_rules" ADD CONSTRAINT "schedule_rules_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "schedules"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quota_periods" ADD CONSTRAINT "quota_periods_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "traffic_samples" ADD CONSTRAINT "traffic_samples_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
