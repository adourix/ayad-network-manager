PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL UNIQUE, ip TEXT, hostname TEXT,
  l2Visible BOOLEAN NOT NULL DEFAULT 1, proxyMac TEXT, identityValidated BOOLEAN NOT NULL DEFAULT 1,
  identitySource TEXT NOT NULL DEFAULT 'DHCP', firstSeen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  lastSeen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS devices_lastSeen_idx ON devices(lastSeen);

CREATE TABLE IF NOT EXISTS neighbor_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mac TEXT NOT NULL, ip TEXT NOT NULL, neighborState TEXT NOT NULL,
  consecutiveCount INTEGER NOT NULL DEFAULT 1, lastSeen DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(mac, ip)
);
CREATE INDEX IF NOT EXISTS neighbor_observations_lastSeen_idx ON neighbor_observations(lastSeen);

CREATE TABLE IF NOT EXISTS profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
  downloadLimit INTEGER, uploadLimit INTEGER, quota INTEGER, quotaPeriod TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, description TEXT,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS schedule_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, scheduleId INTEGER NOT NULL, dayOfWeek INTEGER NOT NULL,
  startTime TEXT NOT NULL, endTime TEXT NOT NULL, downloadLimit INTEGER, uploadLimit INTEGER, blocked BOOLEAN,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(scheduleId) REFERENCES schedules(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS schedule_rules_scheduleId_idx ON schedule_rules(scheduleId);

CREATE TABLE IF NOT EXISTS device_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL UNIQUE, blocked BOOLEAN NOT NULL DEFAULT 0,
  downloadLimit INTEGER, uploadLimit INTEGER, quota INTEGER, quotaPeriod TEXT, quotaAction TEXT,
  quotaEnforcedAction TEXT, profileId INTEGER, scheduleId INTEGER,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE,
  FOREIGN KEY(profileId) REFERENCES profiles(id) ON DELETE SET NULL,
  FOREIGN KEY(scheduleId) REFERENCES schedules(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS device_policies_profileId_idx ON device_policies(profileId);
CREATE INDEX IF NOT EXISTS device_policies_scheduleId_idx ON device_policies(scheduleId);

CREATE TABLE IF NOT EXISTS port_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL, name TEXT NOT NULL,
  protocol TEXT NOT NULL, port INTEGER NOT NULL, action TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS port_rules_protocol_port_idx ON port_rules(protocol, port);
CREATE INDEX IF NOT EXISTS port_rules_deviceId_idx ON port_rules(deviceId);

CREATE TABLE IF NOT EXISTS quota_periods (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL, periodType TEXT NOT NULL,
  periodStart DATETIME NOT NULL, periodEnd DATETIME NOT NULL, usedDownloadBytes INTEGER NOT NULL DEFAULT 0,
  usedUploadBytes INTEGER NOT NULL DEFAULT 0, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE,
  UNIQUE(deviceId, periodType, periodStart)
);
CREATE INDEX IF NOT EXISTS quota_periods_deviceId_periodEnd_idx ON quota_periods(deviceId, periodEnd);

CREATE TABLE IF NOT EXISTS traffic_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL, timestamp DATETIME NOT NULL,
  downloadBytes INTEGER NOT NULL, uploadBytes INTEGER NOT NULL, downloadRate INTEGER, uploadRate INTEGER,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE, UNIQUE(deviceId, timestamp)
);
CREATE INDEX IF NOT EXISTS traffic_samples_deviceId_timestamp_idx ON traffic_samples(deviceId, timestamp);

CREATE TABLE IF NOT EXISTS traffic_rollups (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL, bucketStart DATETIME NOT NULL,
  granularity TEXT NOT NULL, downloadBytes INTEGER NOT NULL, uploadBytes INTEGER NOT NULL,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE, UNIQUE(deviceId, bucketStart, granularity)
);
CREATE INDEX IF NOT EXISTS traffic_rollups_deviceId_bucketStart_idx ON traffic_rollups(deviceId, bucketStart);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER, type TEXT NOT NULL, message TEXT NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, readAt DATETIME, deliveryAttempts INTEGER NOT NULL DEFAULT 0,
  nextAttemptAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, deliveredAt DATETIME, lastDeliveryError TEXT,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS notifications_deviceId_idx ON notifications(deviceId);
CREATE INDEX IF NOT EXISTS notifications_createdAt_idx ON notifications(createdAt);
CREATE INDEX IF NOT EXISTS notifications_deliveredAt_nextAttemptAt_idx ON notifications(deliveredAt, nextAttemptAt);

CREATE TABLE IF NOT EXISTS vpn_config (
  id INTEGER PRIMARY KEY DEFAULT 1, vmessLink TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT 0,
  connected BOOLEAN NOT NULL DEFAULT 0, lastConnectedAt DATETIME,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER, action TEXT NOT NULL, mac TEXT, actor TEXT,
  details JSONB, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS audit_log_deviceId_idx ON audit_log(deviceId);
CREATE INDEX IF NOT EXISTS audit_log_mac_idx ON audit_log(mac);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log(actor);
CREATE INDEX IF NOT EXISTS audit_log_createdAt_idx ON audit_log(createdAt);

CREATE TABLE IF NOT EXISTS blocked_devices (
  id INTEGER PRIMARY KEY AUTOINCREMENT, deviceId INTEGER NOT NULL UNIQUE, mac TEXT UNIQUE,
  active BOOLEAN NOT NULL DEFAULT 1, reason TEXT, createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(deviceId) REFERENCES devices(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS blocked_devices_active_idx ON blocked_devices(active);

CREATE TABLE IF NOT EXISTS ip_bindings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, blockedDeviceId INTEGER NOT NULL, ip TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT 1, boundAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  releasedAt DATETIME, releaseReason TEXT,
  FOREIGN KEY(blockedDeviceId) REFERENCES blocked_devices(id) ON DELETE CASCADE,
  UNIQUE(blockedDeviceId, ip, active)
);
CREATE INDEX IF NOT EXISTS ip_bindings_ip_active_idx ON ip_bindings(ip, active);


CREATE TABLE IF NOT EXISTS auth_users (
  id INTEGER PRIMARY KEY DEFAULT 1,
  username TEXT NOT NULL UNIQUE,
  passwordHash TEXT NOT NULL,
  passwordSalt TEXT NOT NULL,
  mustChangePassword BOOLEAN NOT NULL DEFAULT 1,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO auth_users
  (id, username, passwordHash, passwordSalt, mustChangePassword)
VALUES
  (1, 'admin', '618977eb21ef16a2f69b9d2e7388b6075d36b1d6fc0eb8ccd1af1ab20330be83', 'cba76db026471119d185c33b742a21bc', 1);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, tokenHash TEXT NOT NULL UNIQUE, expiresAt DATETIME NOT NULL,
  createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS auth_sessions_expiresAt_idx ON auth_sessions(expiresAt);
