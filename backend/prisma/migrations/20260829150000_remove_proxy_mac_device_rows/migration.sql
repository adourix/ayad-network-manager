-- Historical discovery versions could persist an AP's proxy MAC as a device.
-- Remove only rows proven to be proxy observations; related policy/telemetry
-- is removed by the Device relation's cascade rules.
DELETE FROM "devices" d
WHERE EXISTS (
  SELECT 1 FROM "devices" owner
  WHERE owner."proxyMac" IS NOT NULL
    AND lower(owner."proxyMac") = lower(d."mac")
    AND owner."id" <> d."id"
);
