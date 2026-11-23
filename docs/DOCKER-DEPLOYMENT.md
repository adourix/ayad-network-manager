# Docker Deployment (Hybrid Host + Docker Backend)

## Supported deployment architecture

The unified installer provides a hybrid deployment:
- PostgreSQL remains installed and managed on the Debian/Ubuntu host. The backend container uses host networking and connects to PostgreSQL at 127.0.0.1.
- The enforcement agent remains a host-native systemd service and owns nftables, tc/IFB, host network changes and the Unix socket.
- The web/API backend runs in Docker as a non-root user with a read-only root filesystem.
- First-run gateway setup is completed by the host/native installer before the backend switches to Docker. Docker mode intentionally does not expose setup mutation routes because those operations would target the container instead of the host.

This is not a fully containerized deployment: PostgreSQL and enforcement are host services.

## Installer flow

The unified installer:
1. Installs host packages, PostgreSQL, Node.js, sing-box and enforcement prerequisites.
2. Creates or preserves database/admin configuration.
3. Runs first-time host setup using the native wizard if needed.
4. Applies Prisma migrations and builds the host runtime used by enforcement.
5. Builds and starts the Docker backend service.
6. Waits for HTTPS health using the local self-signed certificate (verification disabled only for the loopback probe).
7. Attempts rollback to the native backend if Docker health fails.
8. After health succeeds, prunes native backend development dependencies and removes frontend node_modules. Frontend build output and enforcement runtime remain available for native rollback.

Existing completed setup, PostgreSQL data, admin credentials and network configuration are preserved.

## Storage lifecycle

- Raw traffic samples: about 48 hours.
- Hourly rollups: about 30 days.
- Daily rollups: retained long-term.
- Audit logs: 90 days by default, bounded batch deletion.
- Notifications: 90 days by default. Old delivered/exhausted notifications are removed; pending webhook deliveries are preserved when webhook delivery is configured.
- Quota periods: 90 days by default, bounded batch deletion of expired periods.
- Docker backend logs: 10 MiB per file, 3 files.
- A daily log-only storage monitor reports database size and filesystem free space; defaults warn at 2 GiB database size or 10% free. It does not delete files or perform host changes.

Retention and monitoring values can be set in the installer-owned .env: AUDIT_RETENTION_DAYS, NOTIFICATION_RETENTION_DAYS, QUOTA_HISTORY_RETENTION_DAYS, DATABASE_SIZE_WARNING_MB, and DISK_FREE_WARNING_PERCENT.

## Docker security and resource behavior

- Backend runs as the unprivileged node user.
- Container root filesystem is read-only; /tmp uses tmpfs.
- Backend receives no NET_ADMIN, NET_RAW, or privileged mode.
- Enforcement remains host-native and limited by its systemd capability set.
- Docker JSON logs are rotated (10 MiB, 3 files).
- Build dependencies and Prisma CLI are excluded from the backend runtime image.
- Healthcheck uses HTTPS, with self-signed TLS accepted only for the loopback probe.

## Reset scripts

scripts/docker-reset.sh --db-only removes only the Compose db-data volume, reapplies committed Prisma migrations and restarts the backend while preserving setup state.

scripts/docker-reset.sh --full-state removes four named application volumes after exact-name confirmation and stops after migrations. Re-run host setup before starting backend after full-state reset.

Never use docker compose down -v for routine resets; it removes all declared named volumes.

## Verification gates

CI now checks shell syntax, Compose config, backend tests and builds backend runtime, migration and enforcement images. These checks are not a substitute for a real host test.

Before a clean gateway reinstall, verify:
- Host wizard completes and SETUP_COMPLETED=true is present.
- PostgreSQL and enforcement service are healthy; enforcement socket exists with correct group.
- Docker backend health reports healthy over HTTPS.
- Dashboard authentication works.
- DHCP leases, NAT, block/unblock, shaping, quota and schedule enforcement work with a real client.
- Reboot persistence is verified for Docker backend, host enforcement, dnsmasq, PostgreSQL and nftables.
- Native rollback is tested before removing the old application deployment.

This remains a hybrid deployment. Network setup after deployment must use the supported native/host setup path rather than the Docker backend.
