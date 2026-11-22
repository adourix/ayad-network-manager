# Runtime, Storage and Performance Audit

Date: 2026-11-22

Scope: targeted source review of runtime traffic accounting, discovery, enforcement IPC, auditing, quota actions, database indexes, Docker runtime files, and background workers. This is not a claim that every method in the repository has been exhaustively reviewed or that gateway behavior has been validated on hardware.

## Findings addressed on this branch

### High-volume accounting and discovery

- Traffic accounting previously fetched each device from the database and asked the nft reader to dump the full named-counter table once per device per sampling cycle. Added optional bulk device lookup and batch counter reads. The sampling service now reads known device rows only for discovered MACs, and a single counter snapshot is shared by the cycle.
- Discovery was called independently by accounting, sync, live monitoring and enforcement reconciliation. Added a 1-second short cache and in-flight request coalescing so concurrent consumers share one DHCP/neighbor snapshot.
- Neighbor observations previously performed read-then-upsert and resetMissing loaded the entire table into application memory. Replaced with a parameterized atomic SQL upsert and timestamp-based updateMany; stale observation rows older than 30 days are pruned hourly.

### Database and persistent storage

- Reviewed traffic-history index redundancy. The unique composite indexes remain the source of truth; no migration is included in this PR, so existing database indexes/data are left untouched.
- Traffic history rollup is serialized, catches failures and retries on the next interval. Legacy raw samples older than the hourly window are rolled through hourly into daily aggregates before pruning.
- Added batched audit-log retention (90 days by default; configurable with `AUDIT_RETENTION_DAYS`). Cleanup is capped to 20 batches of 5,000 rows per run to limit pressure.
- Terminal notification history older than the same retention window is pruned in batches; pending and retryable notifications are preserved.
- Docker service logs rotate at 5 MB with 2 files per service.
- Docker builds use BuildKit npm cache mounts and copy only build-required source; backend runtime removes TypeScript declarations and source maps.
- Enforcement runtime installs only its minimal `dotenv` dependency and copies only its entrypoint and command executor, rather than shipping the full backend runtime dependency tree.

### Enforcement IPC and audit behavior

- Read-only kernel probes no longer create audit rows. Previously every read was recorded before and after, including output; high-frequency polling could grow the audit table dramatically.
- Mutation audit entries no longer store command output.
- sing-box configuration payloads are redacted from audit details; only destination path and payload byte count are retained.
- Post-mutation audit failure no longer turns an already-successful kernel mutation into a reported command failure. Pre-mutation audit failure still prevents the mutation.
- Unix enforcement socket is set to mode 0660 and group GID configurable (Docker defaults to Node runtime group 1000); request size and priority/background queue lengths are bounded.

### Quota and worker reliability

- Threshold-notification persistence failure is isolated so it cannot prevent quota enforcement after usage has already been recorded.
- Quota-period creation uses upsert on the unique period key to avoid concurrent first-use races.
- Schedule reconciliation timer catches background failures rather than creating unhandled promise rejections.
- Notification worker catches outer process failures and is wired into runtime when a webhook is configured.

### Frontend/runtime hygiene

- WebSocket reconnect uses capped exponential backoff instead of retrying every second indefinitely when the backend is unavailable.
- REST polling was relaxed to 3–5 seconds while live monitoring remains on WebSocket/5-second server snapshots.
- Removed unused React/Vite starter SVG assets.

## Remaining blockers and limits

- Docker gateway setup is not production-ready: setup still performs host file writes and host service operations from backend paths. The enforcement broker does not yet implement the complete typed host-setup protocol. Do not deploy the Compose gateway as a fresh host installation until this is implemented.
- Docker first-admin bootstrap still needs a secure one-time flow for a fresh database.
- CI image builds are not a substitute for real gateway integration tests (DHCP lease acquisition, NAT, nftables, TC/IFB upload/download shaping, VPN fail-closed behavior, SSH/dashboard preservation, rollback, and restart reconciliation).
- Audit retention deletes rows but does not physically shrink PostgreSQL data files. PostgreSQL VACUUM can reclaim space for reuse; physical disk shrink requires a deliberate maintenance operation such as VACUUM FULL or pg_repack, with additional space and downtime/locking considerations. Do not automatically run VACUUM FULL in the gateway runtime.
- Docker named volumes do not have portable size caps in standard Compose. Use filesystem quotas/monitoring on the host if a hard storage cap is required.
- Actual image sizes, database size under realistic traffic, CPU/memory utilization, and long-duration traffic-accounting accuracy must be measured on the target host.

## Validation

- CI is being run on this branch for backend, frontend, Compose validation and Docker image targets. The newest commit must be checked before merging.
- Added unit tests for batched nft counter reads, audit read-vs-mutation behavior, sing-box secret redaction, and discovery snapshot coalescing.
- No local Docker daemon or target gateway is available from this editing session; runtime measurements and host-level tests remain unverified.

## Production acceptance gate

1. Backend/frontend CI pass on the final commit.
2. Docker Compose config validates and runtime, migration, enforcement images all build.
3. Empty DB migrations complete, initial administrator is created securely, and the setup wizard completes.
4. Host setup uses the narrow enforcement broker; backend is not privileged and host `/etc` is not broadly mounted.
5. DHCP, client gateway, NAT and outbound internet are tested from a real client.
6. Download shaping is verified on client-interface egress; upload shaping is verified through IFB egress with real traffic.
7. Block/unblock, port rules, quota actions, schedule transitions and VPN fail-closed transitions are tested.
8. Restart/reboot reconciliation is tested without losing policies or exposing management access.
9. Audit and traffic retention are observed over days; disk usage and PostgreSQL vacuum behavior are measured.
