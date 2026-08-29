# Single-Interface + IFB Continuation Checkpoint

Date: 2026-08-29

Continuation update: backend Single-Interface + IFB work only.

Live-validation continuation: 2026-08-29.

## Implemented

### Live discovery/AP-proxy fix (2026-08-29)

- Root cause: unresolved DHCP/neighbor mismatches were emitted as `deferred`, but `DeviceService` omitted them from `/api/devices` and `DeviceDiscoverySyncService` only updated an existing row. A new real DHCP identity was therefore not represented.
- Root cause: the validator did not quarantine a mismatching neighbor MAC from the static-IP branch, so the historical AP/proxy MAC could be rediscovered as an independent validated device.
- Root cause: `LiveMonitoringService` was constructed but never started, and its old implementation keyed live devices by neighbor MAC rather than the validated DHCP identity.
- Fix: DHCP MAC A is now persisted and returned as a deferred/non-enforceable device with IP X, `l2Visible=false`, `proxyMac=B`, and `identityValidated=false` until broadcast evidence confirms the mismatch. Proxy MAC B is excluded from current static discovery and historical rows are quarantined without deletion or policy changes. Live monitoring uses the shared discovery result and correlates reachability by IP.
- Exact runtime result after restart and synchronization: `/api/devices` returned A=`90:2e:16:4c:e0:fd`, X=`192.168.1.98`, `l2Visible=false`, `proxyMac=92:9a:4a:0f:86:ce`, `identityValidated=false`; B was absent from current API output. `/api/devices/live` returned A at X with `state=REACHABLE`, `online=true`, and the same identity state. Read-only DB verification showed A persisted with that state and historical B retained at `.251` with `identityValidated=false`.
- Regression coverage: exact A/X/B mismatch topology, including exclusion of the proxy from current discovery. `npm test` passed 22/22 and `npm run build` passed.

### Identity implementation audit (2026-08-29)

- `BroadcastCaptureReader` now extracts the Ethernet source MAC as the only authoritative L2 identity. IPv4 source metadata is parsed only from the IPv4 payload, and ARP uses the `tell` sender rather than the `who-has` target. DHCP/ARP packets with `0.0.0.0` therefore remain valid MAC-only observations.
- Neighbor-state admission is conservative (`REACHABLE`, `STALE`, `DELAY`, `PROBE`, `PERMANENT`); malformed, unknown, failed, incomplete, no-ARP, and out-of-subnet observations are not static-IP ownership evidence.
- Invalid capture IP metadata cannot confirm a DHCP/neighbor mismatch. Confirmed mismatches continue to persist the DHCP MAC with `l2Visible=false` and `proxyMac` set to the shared neighbor MAC; unresolved mismatches remain deferred.
- Discovery reconciliation quarantines any historical device row whose MAC is identified as a shared proxy, without deleting rows or modifying policy records. This prevents an AP MAC from becoming an enforceable client identity.
- IP-block reconciliation treats dnsmasq `expiry=0` as active consistently with discovery and never treats a known shared proxy MAC as positive reassignment evidence. Temporary lease disappearance still retains the old IP binding.

### AP/proxy identity and discovery continuation (2026-08-29)

- Implemented the authoritative three-signal identity path: DHCP lease identity, current usable neighbor observation, and passive broadcast-capture evidence.
- DHCP remains the canonical client MAC. A mismatched neighbor MAC is never promoted to a client device identity.
- Confirmed AP/proxy identities persist `l2Visible=false`, `proxyMac=<neighbor MAC>`, and `identityValidated=true`; unresolved mismatches and leases without usable neighbor evidence are deferred and are not created or enforced.
- Reworked `BroadcastCaptureReader` to use the Ethernet source MAC from tcpdump `-e` output and protocol-specific source-IP extraction. ARP `tell` and DHCP/IPv4 source fields are handled without selecting arbitrary first MAC/IP tokens; packets with no usable client IPv4 remain valid observations.
- Static-IP discovery accepts only valid, usable neighbor states and uses the neighbor MAC/IP directly. `FAILED`, `INCOMPLETE`, `NOARP`, `NONE`, malformed, and out-of-subnet entries are ignored.
- Device persistence and `/api/devices` now expose `l2Visible`, `proxyMac`, and `identityValidated`. Identity fields reconcile on each accepted discovery cycle, and deferred known devices are marked ineligible rather than silently retained as enforceable.
- AP/proxy blocking uses the validated current IP fallback while retaining the DHCP MAC as the database identity; tc remains IP-based. Deferred identities are rejected by block and shaping service entry points.
- Positive DHCP/neighbor ownership remains the only trigger for removing an old blocked-IP binding; temporary lease disappearance does not release it.

- Single-Interface + IFB startup guard; Dual-Interface is rejected and has not been started.
- IFB download HTB shaping, physical-interface upload HTB shaping, configurable quota throttle, and safe IFB/ingress cleanup.
- DHCP/neighbor discovery, broadcast identity evidence, MAC/IP block reconciliation, NAT masquerade, management-port allow rules, and static DHCP reservation regeneration with backup.
- PostgreSQL persistence for policies, quotas, traffic samples/rollups, profiles, schedules, device-owned port rules, notifications, audit records, and VPN configuration.
- REST APIs for devices, limits, quotas, profiles, schedules, port rules, live traffic WebSocket, history, notifications, audit log, setup preflight, authentication, and VPN.
- Schedule/profile reconciliation loops, quota threshold notifications, 48-hour raw retention, hourly rollups, and daily rollups.
- VPN config backup/rendering and fail-closed NAT/drop enforcement when the configured tunnel is enabled but unavailable.
- Bidirectional TCP/UDP port-rule enforcement for upload and return traffic, including enabled-state handling, deletion of both generated rules, and startup reapplication from DB.
- Shared before/after audit wrapping for privileged `tc`, `ip`, and executor-backed `nft` commands, with success/failure details; port-rule operations also emit operation-level audit records.
- Schedule reconciliation now restores the persisted device policy outside an active schedule window instead of leaving the previous scheduled state applied.
- Backend setup service now provides read-only interface/default-route/subnet inspection, Single-Interface subnet compatibility checks, atomic config/dnsmasq rendering, pre-apply nft/config snapshots, rollback, and post-apply interface/gateway/DHCP/outbound health checks; authenticated setup network/apply/rollback routes are available.
- Authentication now rate-limits failed login attempts per source and production startup requires TLS certificate/key configuration.
- Setup detector was validated read-only on the host and correctly identified `eno1` (`192.168.1.254/24`) as the default uplink; no live setup apply was performed.
- Profile assignment now inherits profile limits/quota immediately and applies inherited traffic limits synchronously; controlled-time schedule tests verify active-window application and restoration of the base policy.
- Backend hardware diagnostics now report negotiated link speed/duplex and USB bus speed with Full-Speed warnings; the live host reports `eno1` at 100 Mbps/full-duplex and USB 480M with no warnings.

## Live-tested

- `npm run build`: passed.
- `npm test`: 11/11 passed.
- Prisma schema validation, migrations, and database status: passed; 5 migrations applied.
- Active client `92:9a:4a:0f:86:ce` / `192.168.1.251`:
  - temporary 1 Mbps download limit produced IFB HTB class and ingress redirect;
  - temporary 2 Mbps upload limit produced physical `eno1` HTB class;
  - removing limits removed IFB, HTB state, and ingress qdisc.
- Real block/unblock inserted and removed the client from nft `blocked_macs`; desired DB policy was restored to unblocked.
- Startup reconciliation preserved Docker/Tailscale rules and generated NAT, management rules, and DHCP reservations.
- Authenticated API smoke tests passed for profiles, schedules, notifications, VPN status, preflight, history, and live devices.
- Backend unit tests: 7/7 passed, including port-rule upload/return rule generation and disabled-rule behavior.
- `npm run build`: passed after the continuation changes.
- `npm test`: 9/9 passed after setup and security changes.
- Live PostgreSQL read-only check: 6 audit rows, 0 traffic samples, 0 traffic rollups, and 2 notifications.
- Setup detector was run read-only against the real host and identified `eno1` (`192.168.1.254/24`) as the default uplink; no live setup apply was performed.
- Live PostgreSQL read-only check returned 6 audit rows, 0 raw traffic samples, 0 rollups, and 2 notifications.
- Read-only live checks reached `192.168.1.1`, `192.168.1.251`, and external HTTPS via `eno1`; no live policy or service state was changed.
- Live sing-box check: binary/config absent, unit not-found/inactive; VPN validation was not performed.
- Live DHCP check: dnsmasq is active but the lease file is empty; no client DHCP/NAT/throughput test was forced.
- Rollup fixture validation: temporary samples produced hourly `4000` download / `600` upload bytes and daily `5000` download / `600` upload bytes; all temporary rows/device were removed afterward.
- Post-test kernel/database verification: `eno1` remained UP at `192.168.1.254/24` with its original `fq_codel` root, `ifb0` remained absent, and traffic sample/rollup counts returned to zero.
- Final verification after this continuation: `npm run build` passed and `npm test` passed 11/11.
- Identity continuation verification: `npm test` passed 19/19; `npm run build` passed; `prisma validate`, `prisma generate`, and `prisma migrate status` passed with the additive device-identity migration applied.
- Unit coverage now includes DHCP/neighbor equality, unresolved mismatch deferral, confirmed AP/proxy resolution, shared proxy MACs, ARP/DHCP parsing with no usable IPv4, invalid neighbor states, and static-IP discovery.
- Latest focused suite: `npm test` passed 22/22; `npm run build`, `prisma validate`, and `prisma generate` passed. `prisma migrate status` reports the database is up to date with the additive device-identity migration.

## Exact remaining gaps

- No React frontend exists yet; dashboard/static serving, HTTPS/TLS, and rate limiting are incomplete.
- Setup backend path covers interface/default-route inspection, Single-Interface subnet compatibility, atomic config/dnsmasq rendering, nft/config snapshots, rollback, and post-apply health checks. Real apply/reconfiguration remains unvalidated on this host; nft/systemd template installation, package installation, runtime backend reload, and real DHCP/NAT health remain incomplete.
- Port-rule behavior is implemented in both directions, but live client-traffic validation and controlled schedule transition tests remain outstanding.
- Privileged commands routed through the shared executor and legacy nft helper are audited before/after execution; the live database contains audit rows, but full startup/reconciliation coverage cannot be verified while the backend service is inactive.
- Quota exhaustion/actions, threshold notifications, and history populated by real client traffic remain unvalidated. Synthetic rollup SQL behavior passed and was cleaned up, but it is not evidence of real client accounting.
- VPN does not yet install/verify a complete production sing-box systemd deployment or validate generated configuration with sing-box.
- DHCP lease issuance remains unvalidated because the lease file is empty and no isolated client is available. Host-to-gateway/client reachability and host-originated HTTPS passed, but these do not prove client NAT or throughput enforcement.
- Online/offline transition event persistence, active-ambiguity `arping`, hardware diagnostics, and systemd enforcement-service separation remain incomplete.
- Profile assignment/inheritance is immediate; profile edits still reconcile asynchronously and require live enforcement validation.
- The backend and sing-box services are inactive/not-installed in the current environment. No service restart, setup apply, DHCP client invocation, VPN installation, or live policy change was performed during this continuation.
- Latest live identity validation: read-only checks found lease `90:2e:16:4c:e0:fd -> 192.168.1.98`, neighbor `192.168.1.98 -> 92:9a:4a:0f:86:ce REACHABLE`, and the same proxy MAC shared by multiple neighbor IPs. A five-second passive tcpdump captured ARP with Ethernet source `92:9a:4a:0f:86:ce`; no DHCP renew/release was performed. The backend service was inactive, so no live discovery/API cycle was run. Read-only PostgreSQL inspection showed the identity columns are present and current rows were not modified.
- The current host has `eno1` UP with its original `fq_codel` root and no `ifb0`; dnsmasq is active. These checks were observational only.
- Live read-only enforcement check: `ifb0` was absent, `eno1` retained its `fq_codel` root, and project `blocked_macs`/`blocked_ips` sets were empty. No destructive network test was performed.

## Current safe kernel/network state

- `eno1` is UP at `192.168.1.254/24` and uses its original `fq_codel` root qdisc.
- `ifb0` does not exist; no project ingress filters or device HTB classes remain.
- Project-owned nft state includes Single-Interface NAT on `192.168.1.0/24` out `eno1`, `blocked_macs`, `blocked_ips`, and management allows for configured SSH/dashboard ports; this remained unchanged after validation.
- Docker, Tailscale, and unrelated nftables rules were not flushed or replaced.
- PostgreSQL is reachable and migration status is up to date.

## Exact next priorities

1. Validate setup apply/reconfiguration only on a disposable or explicitly approved gateway state; current host was intentionally not modified.
2. Provide an isolated client (physical client or approved test VLAN/namespace) and run DHCP lease, NAT, download/upload throughput, quota exhaustion/action, populated history, port-rule, and notification tests with before/after kernel snapshots.
3. Install/configure sing-box only with explicit approval and a known test VMESS endpoint, then validate fail-closed behavior and restore the direct path.
4. Complete online/offline transition events, ambiguity probing, and remaining backend notification coverage.
6. Keep React frontend and Dual-Interface explicitly deferred and out of scope for this session; do not begin Dual-Interface until backend Single-Interface gaps are closed and revalidated.

## Scope status

- React/frontend remains deferred and out of scope.
- Dual-Interface remains deferred and out of scope.
