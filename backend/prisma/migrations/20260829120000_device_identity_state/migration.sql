ALTER TABLE "devices"
  ADD COLUMN "l2Visible" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "proxyMac" TEXT,
  ADD COLUMN "identityValidated" BOOLEAN NOT NULL DEFAULT true;

CREATE INDEX "devices_proxyMac_idx" ON "devices"("proxyMac");
