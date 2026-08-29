# Linux Network Control System — Implementation Spec

This is the authoritative spec for building this system. It has been through architecture review and live hardware validation (not just theory) — every network-layer decision here was tested on real hardware before being locked in. Build against this document; do not re-derive network topology decisions from first principles, they've already been validated.

---

## 1. Project Summary

A policy-driven network control plane for a home/office Ubuntu gateway. Clients connect through Ubuntu, which enforces per-device policy (block, bandwidth limits, quotas, schedules, port rules) using Linux kernel primitives (nftables, tc), while the actual internet connection, DHCP-for-its-own-segment, and final NAT-to-ISP remain the responsibility of the existing consumer router upstream. A React dashboard and Node.js backend manage policy; the backend never lets the frontend touch Linux networking directly.

**Non-negotiable architectural principle:**
```
Policy (DB) → Backend (services) → Enforcement Layer (the ONLY code allowed to shell out to nft/tc/ip) → Linux kernel
```

---

## 2. Configuration Rule — Nothing Environment-Specific Is Hardcoded

**Applies to every line of code written for this project, no exceptions.** This system will run on hardware other than the reference deployment it was validated on. Any value that could differ between installs must live in config (env vars / config file / DB), never as a literal in source, generated nftables rulesets, tc commands, or dnsmasq configs.

| Value | Config key | Notes |
|---|---|---|
| Client-facing interface name | `CLIENT_INTERFACE` | Interface names (`eth0`, `enp3s0`, `enx...`) vary per machine — must be selected via auto-detection at setup, never assumed |
| Uplink interface name | `UPLINK_INTERFACE` | Same reasoning |
| Client subnet | `CLIENT_SUBNET` (CIDR) | Must avoid colliding with whatever the upstream router already uses — detect the uplink's subnet at setup and pick a non-overlapping range automatically, or let the installer choose |
| Ubuntu's client-gateway IP | `CLIENT_GATEWAY_IP` | Derived from `CLIENT_SUBNET`, don't hardcode |
| Uplink IP | — | **Never stored/hardcoded** — always read live from the interface (`ip addr show`) |
| DHCP pool range | `DHCP_RANGE_START` / `DHCP_RANGE_END` | Derived from `CLIENT_SUBNET` |
| DNS servers | `DNS_SERVERS` (array) | User-configurable, sane default (e.g. 1.1.1.1, 8.8.8.8) |
| Dashboard port | `DASHBOARD_PORT` | User must be able to pick a non-default port (security-through-obscurity is a stated requirement, not a nice-to-have) |
| SSH port | `SSH_PORT` | Default 22, but the enforcement layer must never assume 22 when generating the "always allow management access" nftables rule — read it from config |
| Total uplink bandwidth (for tc root ceiling) | `UPLINK_BANDWIDTH_MBPS` | User's actual ISP speed — needed to size the HTB root class correctly; without this, per-device limits are meaningless |
| Network enforcement mode | `NETWORK_MODE` = `dual-interface` \| `single-interface-ifb` | See Section 4. Set at setup after interface auto-detection, persisted, not re-detected on every boot (avoids flapping if a USB adapter briefly drops) |

**Setup flow requirement**: the installer/setup wizard must enumerate available interfaces (equivalent of `nmcli d` / `ip link show`), let the operator confirm which is uplink vs. client-facing (or auto-select if exactly one of each type is unambiguous), detect the uplink's existing subnet to avoid collisions, and write all of the above to a config file/DB before the enforcement layer starts. No setup step should require the operator to manually edit source code.

---

## 3. Network Topology — Validated Reference Design

### 3.1 Dual-interface mode (primary, preferred when 2 interfaces available)

```
Client (WiFi via AP, or wired) ──→ CLIENT_INTERFACE (Ubuntu) ──→ [enforcement] ──→ UPLINK_INTERFACE (Ubuntu) ──→ Upstream Router (NAT'd, does real internet NAT) ──→ ISP
```

- Two separate, non-overlapping subnets. `CLIENT_INTERFACE` carries `CLIENT_SUBNET` (Ubuntu is the gateway for it). `UPLINK_INTERFACE` sits on the upstream router's existing subnet, unmodified.
- **Ubuntu performs NAT (masquerade) on egress out `UPLINK_INTERFACE`.** This was a deliberate deviation validated against real hardware: many consumer routers (this was confirmed against a Huawei HG630 V2 firmware) have no usable LAN-side static routing UI — their "static routing" screens are WAN/PVC-oriented only. Relying on the upstream router to route back to a new client subnet is not a safe assumption for a general-purpose product; Ubuntu must NAT so the upstream router only ever sees Ubuntu's own uplink IP as the traffic source, requiring zero configuration on the upstream router.
- Upstream router's own DHCP/NAT/internet connection is left completely untouched.
- Ubuntu runs its own DHCP (dnsmasq) scoped **only** to `CLIENT_INTERFACE`, handing out `CLIENT_GATEWAY_IP` as gateway. Must set `bind-interfaces` and check for port 53 conflicts with `systemd-resolved` (use `port=0` in dnsmasq if only DHCP is needed, not DNS resolution).
- tc shaping: **download** = egress shaping on `CLIENT_INTERFACE` (traffic leaving Ubuntu toward clients). **Upload** = egress shaping on `UPLINK_INTERFACE` (traffic leaving Ubuntu toward the upstream router). This direction mapping is confirmed correct and should not be second-guessed by whoever implements it.

### 3.1.1 DHCP Static Reservations (prerequisite for reliable tc filtering)

`tc` filters classify traffic by IP (matching on MAC directly at the tc layer is possible but needlessly complex — see Section 3.3's `tcBuilder.js`). Since DHCP leases are dynamic by default, a device's IP could change and silently detach it from its bandwidth class. To prevent this:

- Every device the system actively manages (has a policy, limit, or block applied) **must** get a DHCP static reservation, keyed by MAC, generated into the dnsmasq config:
  ```
  dhcp-host=<device-mac>,<reserved-ip>
  ```
- The DB (`devices.mac`) remains the source of truth; the reserved IP is looked up/assigned by the enforcement layer, not chosen ad hoc.
- A brand-new, never-seen device (no reservation yet) gets a random IP from the DHCP pool and falls into the default/catch-all tc class until Device Discovery creates a reservation for it — this is the correct fallback behavior, not a bug to fix.
- Reservations must be regenerated as part of `reconcile()` on startup, same as nft/tc state.

### 3.2 Single-interface + IFB mode (fallback, for hardware with only one usable interface)

- Same subnet as the upstream router; Ubuntu still performs NAT (masquerade), which removes the classic ICMP-redirect bypass risk (the upstream router only ever sees Ubuntu's IP as the source, never learns a client is behind it, so it never has grounds to redirect the client to bypass Ubuntu).
- Residual risk (accepted, documented, not solved): a device on the same L2 segment could manually target the upstream router's IP directly (e.g., typing its IP into a browser) since ARP still resolves it. This is a conscious user action, not an automatic/silent bypass of enforcement, and is considered acceptable for this mode.
- **Download/upload shaping problem**: with only one physical interface, both directions egress the same NIC, so plain `tc` egress shaping can't distinguish them. Fix: redirect ingress traffic on the single interface to a virtual `ifb0` device via `tc filter ... action mirred`, then apply normal HTB egress rules on `ifb0` for download, while upload shaping stays as normal egress HTB on the physical interface.

### 3.2.1 Build Order — Single-Interface + IFB Is the First Mode to Implement

**Reverse of what Section 3.3's original phrasing might suggest — build single-interface + IFB first, dual-interface second.** Rationale: single-interface + IFB is the mode that will work on the widest range of user hardware (most machines have exactly one usable NIC), so it's the mode that unblocks the most users if only one gets built initially. Do not start dual-interface-specific work until every core feature in Section 4 is fully working end-to-end on single-interface + IFB. Dual-interface, once started, should mostly be a matter of swapping which device name gets passed into the already-shared `tcBuilder.js` (Section 3.3.1) — it should not require redesigning the HTB logic itself if 3.3.1 is followed correctly.

### 3.3 Enforcement Layer Interface Contract (the abstraction every other module codes against)

**No service outside the enforcement layer may ever reference `CLIENT_INTERFACE`, `UPLINK_INTERFACE`, `ifb0`, or `NETWORK_MODE` directly.** All of that is internal to the enforcement layer. Every other module (DeviceService, QoSService, FirewallService, PolicyEngine, API routes) calls only this contract:

```
enforcementLayer.blockDevice(mac: string): Promise<void>
enforcementLayer.unblockDevice(mac: string): Promise<void>
enforcementLayer.setDeviceLimits(mac: string, downloadMbps: number|null, uploadMbps: number|null): Promise<void>
enforcementLayer.removeDeviceLimits(mac: string): Promise<void>
enforcementLayer.setPortRule(mac: string, rule: PortRule): Promise<void>
enforcementLayer.getDeviceCounters(mac: string): Promise<{rxBytes, txBytes, rxRateBps, txRateBps}>
enforcementLayer.getActiveConnections(mac?: string): Promise<ConnectionInfo[]>
enforcementLayer.getOnlineStatus(mac: string): Promise<boolean>
enforcementLayer.reconcile(): Promise<void>   // rebuilds all nft/tc state from DB on startup — required, not optional
```

Internally, this module picks its implementation based on `NETWORK_MODE` at startup:

```
enforcement/
├── index.js                    # exports the contract above, dispatches to the active mode
├── dualInterfaceImpl.js        # nft/tc commands targeting CLIENT_INTERFACE / UPLINK_INTERFACE separately
├── singleInterfaceIfbImpl.js   # same contract, internally sets up ifb0 + ingress redirect
├── nftBuilder.js                # shared: generates validated nft rulesets (used by both impls)
├── tcBuilder.js                  # shared: generates validated tc command sequences (used by both impls)
└── validate.js                   # MAC/IP regex validation, command allowlisting — the security boundary
```

Every command this layer runs must be validated (`nft -c` check mode before apply) and logged to `audit_log` before/after execution. This is the one place in the codebase allowed to shell out to `nft`/`tc`/`ip` — everywhere else is a bug if it does.

### 3.3.1 `tcBuilder.js` Must Be Device-Agnostic — Do Not Special-Case IFB Inside HTB Logic

**The HTB class-building logic itself must be written once and shared by both implementations, parameterized only by which device name it targets** — it should have no idea whether that device is a real physical NIC or the virtual `ifb0`. This is what keeps the two implementations from becoming two divergent copies of the same shaping logic.

```javascript
// tcBuilder.js — called identically by both dualInterfaceImpl.js and singleInterfaceIfbImpl.js
function buildDownloadShaping(targetDevice, deviceLimits) {
  tc('qdisc', 'add', 'dev', targetDevice, 'root', 'handle 1:', 'htb');
  tc('class', 'add', 'dev', targetDevice, 'parent 1:', 'classid 1:1', 'htb', `rate ${UPLINK_BANDWIDTH_MBPS}mbit`);
  for (const [mac, limit] of deviceLimits) {
    tc('class', 'add', 'dev', targetDevice, 'parent 1:1', `classid 1:${classId(mac)}`, 'htb', `rate ${limit}mbit`);
  }
}
```

Each implementation supplies a different `targetDevice`, and only `singleInterfaceIfbImpl.js` does the one-time extra setup step before calling it:

```javascript
// dualInterfaceImpl.js — download shapes directly on the real client-facing NIC, no IFB involved
buildDownloadShaping(CLIENT_INTERFACE, deviceLimits);

// singleInterfaceIfbImpl.js — one-time redirect setup, then the exact same builder call
setupIfbRedirect(SINGLE_INTERFACE, 'ifb0');
buildDownloadShaping('ifb0', deviceLimits);
```

**Do not route dual-interface's download shaping through IFB "for consistency."** Dual-interface already has a real, dedicated egress point (`CLIENT_INTERFACE`) — forcing an unnecessary ingress→redirect→egress hop through `ifb0` there adds per-packet overhead and complexity with no benefit, since the whole point of IFB is working around the *absence* of a second physical interface, which dual-interface doesn't have a problem with. Unify at the `tcBuilder.js` logic level (one function, parameterized target device), not by forcing both modes onto the same virtual device.

---

## 4. Full Feature List (from original product spec, unchanged, for the agent's reference)

### Core (build first, in this order — matches the phased plan)
1. **Device Management/Discovery** — MAC, IP, hostname (from DHCP lease + reverse DNS where available), online/offline, per-device config page.
2. **Block/Unblock** — enforced via the `blocked_clients` nftables MAC-keyed set (already validated live). Keyed on MAC, not IP, for stability across DHCP renewals.
3. **Speed Limits** — per device download/upload, enable/disable, dynamic changes, via `tc` HTB per Section 3.
4. **Data Quota** — total quota, used/remaining, upload/download split, automatic action on exhaustion.
5. **Live Traffic** — current down/up speed, total traffic, online status, near-real-time (WebSocket, polling nft/tc counters every 1-2s, never per-packet processing in Node).
6. **Usage History** — daily/weekly/monthly, per device, up/down split, charts. Store as periodic aggregated samples (e.g. 1-min buckets rolled up), never per-packet.

### Recommended (after core is stable)
7. **Profiles** — reusable policy bundles (e.g. "Normal": 20/5 Mbps, 100GB/mo; "Guest": 5/2 Mbps, 20GB/mo).
8. **Scheduling** — time-based policy changes (speed changes, block/unblock windows).
9. **Application/Port Control** — TCP/UDP port and protocol rules. Must clearly document to end users that HTTPS/QUIC/CDN traffic limits app-level identification accuracy — port/IP rules work, deep app identification does not reliably.
10. **Advanced Quota** — daily + monthly quotas, auto/manual reset, exhaustion actions (block / throttle / notify-only).
11. **Notifications** — 80%/90%/100% quota thresholds, block-due-to-quota events, important network events.

### Deferred / optional (do not build unless explicitly requested later)
- DNS-based content categorization
- Multi-admin roles/permissions
- mDNS/SSDP device fingerprinting
- Single-interface + IFB mode itself is "build when needed" — dual-interface is the reference implementation to stabilize first, per Section 3.3's noted build order.

---

## 5. Technology Stack

- **Backend**: Node.js, **Fastify** (chosen over Express for schema validation + performance — this backend validates privileged input, that matters more than usual here).
- **DB**: **PostgreSQL** via **Prisma** (not SQLite — this project uses Postgres from the start, connection string driven entirely by config per Section 2, no environment-specific values in the schema itself).
- **Frontend**: React, talks only to the backend REST/WebSocket API — never touches Linux networking, ever.
- **Realtime**: WebSocket (`@fastify/websocket` or `ws`) for live traffic push.
- **Process management**: systemd service units (not pm2) — this runs privileged/root-adjacent, systemd is the standard fit, and the enforcement layer should eventually be its own service unit with a minimal capability set (`CAP_NET_ADMIN`, `CAP_NET_RAW`) rather than running the whole app as root.
- **Auth**: Real login required before shipping anything beyond local dev — this system controls a home/office network, "no auth yet" is not acceptable even for v1.

---

## 6. Database Schema (tables, not exhaustive column lists — agent should flesh out fields per Section 4 features)

```
devices            (id, mac [unique], ip [last known, informational only — enforcement never trusts this alone], hostname, first_seen, last_seen)
device_policies    (device_id, blocked, download_limit_mbps, upload_limit_mbps, quota_bytes, quota_period, quota_action, profile_id, schedule_id)
profiles           (id, name, download_limit_mbps, upload_limit_mbps, quota_bytes, quota_period)
schedules          (id, name)
schedule_rules     (schedule_id, day_of_week, start_time, end_time, action, action_params)
quota_periods      (device_id, period_start, period_end, bytes_used_down, bytes_used_up)
traffic_samples    (device_id, bucket_start, bytes_down, bytes_up)   -- aggregated, e.g. 1-min buckets, rolled up over time
port_rules         (device_id, protocol, port_or_range, action)
notifications      (id, device_id, type, threshold, sent_at)
audit_log          (id, actor, action, target_device_id, params_json, result, timestamp)  -- every enforcement action, per Section 3.3
vpn_config         (id, vmess_link, enabled, last_connected_at)  -- see Section 9, single active row, global on/off, not per-device
```

---

## 6.1 API Structure (REST + WebSocket)

Resource-oriented, matching the services in Section 3.3 / Section 4. Agent should implement these exactly (extend, don't redesign):

```
GET    /api/devices                      list all known devices + current policy summary
GET    /api/devices/:id                  device detail
PATCH  /api/devices/:id/policy           update download/upload limits, quota, profile_id, schedule_id
POST   /api/devices/:id/block
POST   /api/devices/:id/unblock

GET    /api/profiles
POST   /api/profiles
PATCH  /api/profiles/:id
DELETE /api/profiles/:id

GET    /api/schedules
POST   /api/schedules
PATCH  /api/schedules/:id
DELETE /api/schedules/:id

GET    /api/devices/:id/port-rules
POST   /api/devices/:id/port-rules
DELETE /api/port-rules/:id

GET    /api/traffic/live              -- WebSocket upgrade, pushes per-device rate every 1-2s
GET    /api/traffic/history?device_id&range=day|week|month

GET    /api/notifications
POST   /api/notifications/:id/read

GET    /api/audit-log                 -- read-only, per Section 9 security requirement

GET    /api/vpn/status                -- { enabled, connected }
POST   /api/vpn/config                -- body: { vmessLink }
POST   /api/vpn/enable
POST   /api/vpn/disable

POST   /api/auth/login
POST   /api/auth/logout
```

All routes except `/api/auth/login` require authentication (Section 9). All mutating routes (`POST`/`PATCH`/`DELETE`) go through the service layer → enforcement layer contract from Section 3.3, never touch nft/tc directly from a route handler.

---

## 6.2 Deployment: No Reverse Proxy — Backend Serves Directly

**Decision, not an oversight**: this system does not use nginx or any reverse proxy in front of the backend. Fastify serves the API, the WebSocket upgrade, and the built React static files directly, all on `DASHBOARD_PORT` (Section 2), with TLS handled in Node itself (Fastify supports HTTPS natively — generate/use a cert, don't serve plain HTTP given what this system controls).

Rationale: for this project's scale (a single-network control dashboard, not a public-facing multi-tenant service), a reverse proxy adds a component to deploy, configure, and keep in sync with zero functional benefit here — Fastify's built-in HTTPS, static file serving (`@fastify/static`), and rate-limiting plugins (`@fastify/rate-limit`) cover what nginx would have provided. If the agent is tempted to add nginx "for best practice," don't — it's a deliberate simplification, not a gap.

---

## 6.3 Containerization Strategy

The system must be architected from the start so it can later run under Docker/Podman Compose, without requiring a rewrite. Concretely:

- **Frontend + Backend API**: containerize normally, no special privileges. Standard Node image, multi-stage build for the React static assets.
- **Enforcement layer runs as its own component with `network_mode: host` and a narrow capability set** (`CAP_NET_ADMIN`, `CAP_NET_RAW` — not full `--privileged`), communicating with the backend API container over a local Unix socket or loopback connection, not by both processes sharing one container. This keeps the "runs root-adjacent" blast radius contained to one small, auditable piece instead of the whole application.
- **Database**: named Docker volume, persists independently of container restarts/rebuilds.
- **Configuration**: everything from Section 2 comes from environment variables / mounted config, never baked into an image — a rebuilt or redeployed container must pick up the same config it had before without code changes.
- **Reconciliation on container restart is mandatory, not optional**: nftables rules and tc classes do not persist across a container restart any more than they persist across a host reboot. The enforcement layer's `reconcile()` (Section 3.3) must run on every startup, rebuilding kernel state from DB policy state, whether that startup is a host reboot or a container restart.
- Development can and should run directly on the host Ubuntu install (as this reference deployment did) — Compose-based deployment is a later packaging step, not a prerequisite for early development.

---

## 6.4 Self-Lockout Safeguard (required, not optional)

The enforcement layer must prevent a policy change from cutting off the administrator's own access:

- Before applying any nftables ruleset that could affect management access, verify the configured `SSH_PORT` (Section 2) and `DASHBOARD_PORT` remain reachable in the generated ruleset — this is on top of, not instead of, the explicit SSH-allow rule required in Section 9.
- A block/policy action must never be allowed to target the IP/MAC the request itself is currently coming from (prevents an admin from blocking their own device and losing access to un-block it) — validate this in the service layer before the request ever reaches the enforcement layer.
- If a generated ruleset fails its `nft -c` validation check (Section 9), the previous known-good ruleset must remain active — never apply a partially-generated or failed ruleset.

---

## 7. Online/Offline Detection Method (validated approach, do not replace with active polling)

**Passive by default, to avoid network/server load:**
1. Primary signal: `ip neigh show dev $CLIENT_INTERFACE` (ARP/neighbor table — updates naturally from normal device traffic, zero extra cost) cross-checked against the dnsmasq lease file (`/var/lib/misc/dnsmasq.leases`).
2. **Validation rule before trusting a MAC↔IP pairing for enforcement**: the MAC from the DHCP lease must also currently appear in the neighbor table against the same IP. If they disagree (stale lease, ARP spoofing, **or a device sitting behind a range extender/AP that proxies ARP — see Section 13, which adds a resolution path instead of simply discarding this case**), **do not use that mapping for enforcement directly** — this exact check was specified and agreed on, implement it as written:
   ```
   DHCP lease (MAC, IP) → look up Device by MAC in DB →
     is that IP currently present in the neighbor table under the same MAC?
       YES → valid association, update Device.ip
       NO  → do not use this mapping for enforcement directly; run Section 13's resolution instead
   ```
3. Only escalate to active probing (a single `arping`, never ICMP ping loops) for devices whose passive state is ambiguous (gone `STALE` with no recent traffic), and only on a slow interval (30-60s), never per-device-per-second.
4. Log state **transitions** (went offline/online) to an events table — don't poll-and-write on a fixed interval regardless of change.

---

## 8. Known Hardware Caveat (document, do not silently work around)

If the deployment's client-facing adapter negotiates USB Full-Speed (12M) instead of High-Speed (480M) — visible via `lsusb -t` showing `12M` next to the device — this is a **hardware ceiling**, not a config or driver problem, common with cheap DM9601/SR9700-chipset USB-Ethernet adapters mislabeled as "USB 2.0." The system should ideally surface this in a diagnostics/health check (compare `ethtool`-reported link speed against actual measured throughput, flag a mismatch) rather than leave the operator to debug it blind the way it was debugged here.

---

## 9. Optional Feature: Global VPN Egress (on/off switch, not per-device)

An optional, system-wide toggle: when enabled, all client traffic exits through a user-supplied VPN (vmess link) instead of the normal upstream router path. This is a global switch, not a per-device policy — do not build per-device VPN routing, it is explicitly out of scope.

### 9.1 Components
- **Proxy client**: `sing-box` (preferred — actively maintained, supports vmess/vless/trojan/shadowsocks) runs as its own systemd service, generating its runtime config from the stored vmess link.
- **Tunnel interface**: sing-box brings up a TUN interface (e.g. `tun0`) when the VPN is enabled.

### 9.2 How it integrates with the existing enforcement layer
This is implemented as a **change of egress target for the existing NAT rule**, not a parallel routing system:
```
VPN disabled (default):
  nftables postrouting masquerade rule targets UPLINK_INTERFACE
  Client → CLIENT_INTERFACE → [enforcement] → UPLINK_INTERFACE (masquerade) → upstream router → Internet

VPN enabled:
  nftables postrouting masquerade rule targets tun0 instead
  Client → CLIENT_INTERFACE → [enforcement] → tun0 (masquerade) → sing-box tunnel → VPN server → Internet
```
`UPLINK_INTERFACE` itself is never reconfigured — only which interface the masquerade rule targets changes. All per-device policy (block, limits, quota) continues to apply exactly as before; the VPN toggle only changes where traffic exits the box, not any per-device enforcement logic.

### 9.3 Enforcement layer contract additions
```
enforcementLayer.setVpnConfig(vmessLink: string): Promise<void>
enforcementLayer.setVpnEnabled(enabled: boolean): Promise<void>
enforcementLayer.getVpnStatus(): Promise<{enabled: boolean, connected: boolean}>
```

### 9.4 Failure behavior — must be explicit, not assumed
If `vpn_config.enabled = true` but the tunnel is down (server unreachable, expired link, sing-box crashed), the agent implementing this **must pick and document one explicit behavior**, not silently fall back:
- **Fail-closed** (recommended default): if the tunnel is down while enabled, drop egress traffic rather than silently reverting to the normal upstream path — the user opted into "traffic only goes out via VPN," and silently falling back to the unencrypted/direct path could violate the reason they enabled it in the first place.
- **Fail-open** (must be an explicit opt-in setting if offered, never the silent default): automatically revert the masquerade target to `UPLINK_INTERFACE` if the tunnel drops, restoring normal internet access automatically.

Either way, a tunnel state change (connected → disconnected or vice versa) must be logged to `audit_log` and reflected immediately in `GET /api/vpn/status`, since this affects every client on the network at once.

---

## 10. Security Requirements (non-negotiable, apply from the first commit)

- No shell string concatenation with user/DB-sourced input, ever. Structured command building only, through `nftBuilder.js`/`tcBuilder.js`.
- All device identifiers validated as strict MAC/IP regex before touching any command boundary.
- Every enforcement action validated (`nft -c`) before being applied, and logged to `audit_log` regardless of success/failure.
- The nftables base ruleset must always include an explicit allow rule for the configured `SSH_PORT` before any restrictive/default-deny policy is ever applied — this was a real operational risk during live setup and must be handled defensively in code, not left to whoever runs the installer to remember.
- `reconcile()` must run on every service startup — nftables sets and tc classes do not survive reboot, and the system must never come up in a state where policy in the DB doesn't match what's actually enforced in the kernel.
- **All critical systemd units must use `Restart=on-failure`** (`dnsmasq`, the backend, the enforcement layer) — this project hit a real dnsmasq crash during setup (port 53 conflict, Section 12.1); a service that stays down after a transient failure silently breaks the network until someone notices and manually restarts it. Combined with `reconcile()` running on every restart, this makes the system self-healing from transient failures rather than requiring manual intervention.

---

## 11. Setup & Installation Flow

**No environment-specific file (dnsmasq config, nftables ruleset, systemd units) ships as a finished file in the repo.** Every one of these is environment-specific per Section 2's rule (interface names, subnet, bandwidth all differ per install) and must be generated at setup time from templates, not hand-edited or committed as-is.

### 11.1 Setup component (new, sits above the enforcement layer)

```
setup/
├── detectInterfaces.js       # enumerate NICs, classify candidates (equivalent of manual `ip link show` / `nmcli d`)
├── detectSubnetConflict.js   # read uplink's existing subnet, propose a non-overlapping CLIENT_SUBNET
├── renderTemplates.js        # fills in dnsmasq/nftables/systemd templates with values from Section 2's config keys
├── applySystemConfig.js      # installs OS packages, writes rendered files to real system paths, enables services
└── setupRoutes.js            # POST /api/setup — drives the wizard from the frontend, idempotent
```

### 11.2 Flow (first run)

1. **Install OS-level dependencies** (bare-metal only — see 11.4 for the Docker case): `dnsmasq`, `nftables`, `iproute2`, `ethtool`.
2. **Interface detection + operator confirmation**: enumerate interfaces, auto-select if unambiguous (exactly one candidate for uplink, one for client-facing), otherwise prompt. This is the step that replaces the manual `nmcli d` / `ip addr show` session done during initial validation — must not require SSH access to complete.
3. **Subnet conflict check**: read the uplink interface's current subnet, pick a `CLIENT_SUBNET` that doesn't overlap (this project hit a real subnet collision during manual setup — the wizard must not let this recur silently).
4. **Bandwidth input**: `UPLINK_BANDWIDTH_MBPS` cannot be reliably auto-detected — must be entered by the operator, used to size the HTB root class ceiling (Section 3.3.1).
5. **Render + apply config**: template output written to real paths (`/etc/dnsmasq.d/clients.conf`, nftables base ruleset, systemd unit files), services enabled/restarted.
6. **Persist to system config table/`.env`**: this becomes the single source of truth `reconcile()` reads on every future startup — the wizard does not run again automatically once complete.

### 11.3 Re-runnability

The same `applySystemConfig.js` logic must be safe to invoke again later (e.g. a "Reconfigure Network" action in the dashboard, or automatically as part of `reconcile()`) — this is not a separate one-time-only script forked from the setup flow, it's the same code path. A `setup_completed` flag gates whether the wizard UI is shown by default, not whether the underlying apply logic can run.

### 11.4 Handling Prerequisites in the Docker Version

The Docker case changes *where* prerequisites are installed, not *what* they are — the same distinction from Section 6.3 applies: the enforcement layer needs host-level networking access, so its dependencies can't be satisfied the way a normal containerized app's dependencies are.

- **`dnsmasq`, `nftables`, `iproute2`, `ethtool` must be baked into the enforcement layer's own image** at build time (its Dockerfile), not installed at container runtime — a container should never `apt install` on startup, that's slow, fragile, and breaks on restricted networks.
  ```dockerfile
  # enforcement/Dockerfile
  FROM debian:bookworm-slim
  RUN apt-get update && apt-get install -y --no-install-recommends \
      dnsmasq nftables iproute2 ethtool iproute2 \
      && rm -rf /var/lib/apt/lists/*
  ```
- **The enforcement container needs `network_mode: host`** (already specified in Section 6.3) — this is what lets the baked-in `nft`/`tc`/`dnsmasq` binaries actually see and control the host's real interfaces, rather than the container's own isolated network namespace. Without host networking, interface detection (11.2 step 2) would only ever see virtual container interfaces, not the physical NICs the whole system depends on.
- **The frontend + backend API containers need none of the above** — they're normal Node/React containers with no special capabilities, no networking tools baked in, and no host access. Keep the prerequisite footprint isolated to the one container that actually needs it (this is the same "narrow blast radius" reasoning as Section 6.3's capability restriction, applied to the image itself, not just runtime permissions).
- **The setup wizard (11.1-11.3) still runs the same way inside Docker** — `detectInterfaces.js` etc. work identically, since `network_mode: host` gives the enforcement container the same view of interfaces a bare-metal install would have. No Docker-specific branching should be needed in the setup logic itself, only in how the enforcement container is built/launched (Compose file), matching Section 3.3's principle that other layers shouldn't need to know about deployment details.
- **Compose sketch**:
  ```yaml
  services:
    enforcement:
      build: ./enforcement
      network_mode: host
      cap_add: [NET_ADMIN, NET_RAW]
      volumes: [config-data:/etc/app-config]
    backend:
      build: ./backend
      ports: ["${DASHBOARD_PORT}:${DASHBOARD_PORT}"]
      depends_on: [enforcement, db]
    db:
      image: postgres:16
      volumes: [db-data:/var/lib/postgresql/data]
  volumes:
    config-data:
    db-data:
  ```

---

## 12. Portability Requirements — Running Correctly on Any New Server

These are prerequisites the setup flow (Section 11) must handle automatically, not leave for the operator to discover the way they were discovered during this project's own manual setup.

### 12.1 Pre-flight compatibility check (must run before setup applies anything)

- **Port 53 conflict**: check whether `systemd-resolved` (or any other process) already holds port 53 before configuring dnsmasq. This project hit this exact failure (`dnsmasq` failed to start: `Address already in use`) — the setup flow must detect it automatically and configure dnsmasq DHCP-only (`port=0`) rather than surface the raw error and expect the operator to diagnose it.
- **Existing firewall conflicts**: detect if `ufw` (or another firewall front-end) is active before applying the nftables base ruleset — a competing firewall manager can silently override or conflict with the rules this system installs.
- **IFB kernel module availability**: verify `modprobe ifb` succeeds before committing to single-interface + IFB mode (Section 3.2) — fail the setup step clearly if the running kernel doesn't support it, rather than let it fail later inside `tcBuilder.js`.
- **Root/sudo privileges**: confirm the setup process has the privileges it needs before starting, not partway through — a setup that fails halfway through system file changes is worse than one that refuses to start.

### 12.2 Backup and rollback of existing system state

Before the setup flow touches anything (nftables ruleset, dnsmasq config, interface configuration), it must snapshot the current state (e.g. `nft list ruleset > backup/nftables.bak`, copy existing dnsmasq configs). If any setup step fails partway through, the system must be able to restore the pre-setup state rather than leave the server in a half-configured condition. This applies to both the bare-metal setup flow and any Docker-based install.

### 12.3 Post-setup health check (do not report success on exit-code alone)

After setup completes, run an automated verification pass equivalent to what was done manually during this project's own validation — a successful command exit code is not sufficient evidence the system actually works:
- Client-side interface reachable (ping the configured `CLIENT_GATEWAY_IP`)
- DHCP actually issuing leases (verify a lease appears in the dnsmasq lease file, or perform a test lease request)
- NAT/masquerade actually working (a real outbound connectivity test from the client-side path, not just confirming the nftables rule was added)

Setup should only report success once these checks pass, and should report specifically which check failed if one doesn't — not a generic failure.

### 12.4 Time synchronization requirement

The Scheduling feature (Section 4, item 8) depends entirely on correct system time. The pre-flight check (12.1) must confirm `systemd-timesyncd` or `chrony` is active and the clock is synced, and warn clearly (both during setup and as an ongoing dashboard health indicator) if it isn't — a schedule silently firing at the wrong time due to clock drift is a hard-to-diagnose failure mode that should be caught structurally, not left for the operator to notice.

### 12.5 Data retention policy for `traffic_samples`

Without a defined retention/rollup policy, this table grows unbounded on any server that stays up for a meaningful length of time. Define and implement from the start (not as a later optimization):
- Keep raw fine-grained samples (e.g. 1-minute buckets) for a bounded recent window (e.g. 48 hours).
- Roll up older samples into coarser aggregates (hourly, then daily) matching the daily/weekly/monthly history views required in Section 4, item 6.
- Run this rollup/pruning as a scheduled background job, not as an afterthought triggered manually.

---

## 13. Device Identity Behind a MAC-Proxying AP/Range Extender

### 13.1 The problem

A device connected through a WiFi range extender/AP that proxies ARP on behalf of its stations will show up in `ip neigh` under the **extender's MAC**, not the real device's MAC — even though the extender is transparently forwarding the device's actual traffic. Section 7's DHCP↔ARP cross-check correctly *detects* this mismatch, but simply discarding the mapping (the original behavior) throws away a real, enforceable device — it just becomes invisible to enforcement while still consuming bandwidth.

**Why DHCP alone isn't fully reliable here either**: the DHCP lease's `chaddr` (client hardware address) field is set by the device's own DHCP client software and is normally passed through unmodified by a transparent L2 extender — so it's usually correct even when ARP is proxied. But this is a *usually*, not a guarantee for every extender firmware, so it should be treated as the strongest available signal, not an infallible one.

### 13.2 Third signal: `BroadcastCaptureReader` (passive, near-zero cost)

Add a third identity source that listens directly to broadcast/multicast traffic on `CLIENT_INTERFACE` (DHCP Discover packets, ARP requests originated by devices themselves) rather than relying only on the gateway's *response* to an ARP query. This traffic is emitted by the device itself, and a transparent extender forwards it without rewriting the source MAC — so it reveals the real device MAC even when the extender proxies replies to queries directed *at* it.

```typescript
// src/discovery/BroadcastCaptureReader.ts
//
// Passive only — never sends any packet, adds no network load. Costs a
// small, bounded amount of CPU on Ubuntu itself to filter the broadcast/
// multicast traffic that already crosses the wire. Must use a narrow
// capture filter (DHCP + ARP only) — an unfiltered capture would needlessly
// process every packet on the interface, including bulk device traffic.

import { spawn } from 'child_process';

export interface CapturedIdentity {
  mac: string;
  sourceIp?: string;      // present for DHCP Discover, absent for some ARP requests
  capturedAt: Date;
}

export class BroadcastCaptureReader {
  private readonly listeners: ((identity: CapturedIdentity) => void)[] = [];

  constructor(private readonly iface: string) {}

  start(): void {
    // Narrow BPF filter: DHCP client broadcasts + ARP only — nothing else.
    const filter = '(udp port 67 or udp port 68) or arp';
    const proc = spawn('tcpdump', ['-i', this.iface, '-l', '-n', '-e', filter]);

    proc.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) {
        const identity = this.parseLine(line);
        if (identity) this.listeners.forEach(fn => fn(identity));
      }
    });
  }

  onIdentity(fn: (identity: CapturedIdentity) => void): void {
    this.listeners.push(fn);
  }

  private parseLine(line: string): CapturedIdentity | null {
    // Extract source MAC from tcpdump's -e ethernet header output.
    // Exact parsing depends on tcpdump output format for DHCP vs ARP lines —
    // implementer should validate against real captures on CLIENT_INTERFACE
    // rather than assume a fixed format across tcpdump versions.
    const macMatch = line.match(/([0-9a-f]{2}(:[0-9a-f]{2}){5})/i);
    if (!macMatch) return null;
    return { mac: macMatch[1].toLowerCase(), capturedAt: new Date() };
  }
}
```

### 13.3 How this integrates with `IdentityResolutionService`

`BroadcastCaptureReader`'s output becomes a **third vote**, not a replacement for DHCP or ARP:

```
For a given IP, compare:
  - DHCP lease chaddr           (strong signal)
  - ip neigh MAC for that IP    (weak when behind a proxying AP)
  - BroadcastCaptureReader MAC  (strong — captured directly from the device's own traffic)

If DHCP MAC == BroadcastCapture MAC, but ip neigh shows a different MAC:
  → confirmed AP-proxy situation, not a stale/spoofed entry
  → trust the DHCP/BroadcastCapture MAC as the device's real identity
  → mark Device.l2Visible = false, Device.proxyMac = <the ip neigh MAC>
  → enforcement for this device falls back to IP-based rules (per the
    BlockedDevice/IpBinding design already discussed), since MAC-based
    nftables rules will never match frames whose L2 source is the extender
```

If `BroadcastCaptureReader` hasn't captured anything for a given device yet (it only observes traffic as it happens, so there's a warm-up period), fall back to the Section 7 behavior (flag and don't enforce on the mismatched mapping) until a capture confirms one way or the other — don't guess ahead of actual evidence.

### 13.4 What this deliberately does NOT do

This should **not** be implemented as ARP spoofing, MITM interception, or anything that injects packets to trick devices into revealing themselves — those techniques are a fundamentally different (and often legally problematic) approach used by consumer tools like SelfishNet/NetCut, which work by *impersonating* the gateway to unmanaged third-party devices. This system already *is* the legitimate gateway for its network, so there is no need to deceive anything — `BroadcastCaptureReader` only reads traffic that already legitimately crosses the interface this box owns and operates.

### 13.5 Device Schema Additions (formalizing what 13.3 references)

```prisma
// Additions to the existing Device model (Section 6)
model Device {
  // ...existing fields unchanged...
  identitySource  IdentitySource  @default(DHCP)
  l2Visible       Boolean         @default(true)
  proxyMac        String?         // set only when l2Visible = false; the MAC
                                    // currently answering ARP for this device's
                                    // IP, NOT this device's own identity
}

enum IdentitySource {
  DHCP                    // DHCP lease MAC confirmed, l2Visible = true
  DHCP_CONFIRMED_PROXY    // DHCP MAC confirmed via BroadcastCaptureReader
                          // despite an ARP mismatch (Section 13.3's success path)
  STATIC_ARP              // no DHCP lease; promoted via ObservedNeighborTracker
                          // debounce (Section 13.6)
  PROXY_UNCONFIRMED        // DHCP lease exists, ARP mismatch persists, and
                          // BroadcastCaptureReader has NOT independently
                          // confirmed the DHCP-asserted MAC (Section 13.7)
  PROXY_ACCEPTED_BY_ADMIN  // explicit, audited admin override of an
                          // unconfirmed identity (Section 13.7)
}
```

**Re-evaluation rule**: `l2Visible`/`proxyMac`/`identitySource` are current-state fields, re-computed every discovery cycle, not set once — an AP later reconfigured into a real transparent bridge should cause a device to naturally transition back toward `DHCP`/`l2Visible: true` on its own, without any manual action.

**Hard invariant, enforced in code, not just documented here**: a MAC that has ever been recorded as a `proxyMac` value on any `Device` must never itself receive a `Device` row, and must be rejected if ever passed to a block/policy action (`FirewallService`/`BlockedDeviceService` must check a live "known proxy MACs" set before accepting any MAC-targeting request). This closes the risk identified in the AP-proxy design discussion: the AP itself must never become an enforcement target, accidentally or otherwise.

### 13.6 Static-IP Device Discovery (no DHCP lease exists)

Formalizes the debounce mechanism referenced above and in Section 7 as the counterpart to DHCP-based discovery, for devices configured with a manually-assigned static IP that never generates a DHCP lease at all.

```
ObservedNeighborTracker (per-device, DB-backed, survives restarts):
  - records every (mac, ip, neighborState) sighting from ip neigh each cycle
  - only counts sightings where neighborState ∈ {REACHABLE, STALE, PERMANENT}
    (never FAILED/INCOMPLETE — these must never count toward promotion)
  - a (mac, ip) pair is promotable to a Device once it has been observed in
    a trusted state for N consecutive discovery cycles (N = 3, matching the
    threshold already used elsewhere for confidence-building) AND has no
    corresponding DHCP lease for that MAC
  - on promotion: Device.identitySource = STATIC_ARP, l2Visible = true
    (by definition — this path only exists because the MAC was directly
    observed in ARP, so there's no proxy ambiguity for this identity source)
```

This does not interact with the AP-proxy problem (Section 13.7) — a static-IP device is, by construction, one whose real MAC *is* visible in `ip neigh`. If a static-IP device were later found behind a proxying AP such that its own MAC never appeared in `ip neigh` either, it would have no discovery path at all under the current signals (DHCP doesn't apply, ARP is proxied, and `BroadcastCaptureReader` has nothing DHCP-shaped to correlate against) — this specific sub-case is **out of scope** and not solved by this document; flag it if it's ever observed in practice rather than assuming Section 13.7's resolution covers it, since Section 13.7 depends on a DHCP lease existing.

### 13.7 Fully-Proxying AP — Design Gap and Resolution

**The authoritative spec, prior to this section, has a design gap for fully-proxying APs.** Section 13.1–13.3 assumed an AP that proxies ARP *replies* while still transparently forwarding a client's own broadcast traffic (DHCP Discover, self-originated ARP requests) — the case `BroadcastCaptureReader` was built to catch. Live validation on the reference deployment found an AP that re-originates a client's outbound broadcast/ARP traffic under **its own MAC as L2 source**, meaning the client's real MAC never appears on the wire in any broadcast frame, even though a valid DHCP lease for the real MAC already exists in `dnsmasq.leases` (acquired at some point in the past, not observed live).

**Decision, and why the alternatives were rejected:**

- Trusting the DHCP lease alone once a live ARP mismatch is observed (treating "lease + stable IP" as sufficient) was considered and **rejected** — it removes the only independent corroboration this system has for DHCP-asserted identity, reopening exactly the risk Section 13.1 already flagged as a caveat, not a guarantee, for less-common extender firmware. Blocking has real consequences if it lands on the wrong device; automatic trust here fails the same bar already applied elsewhere in this project (e.g., MAC-randomization device-merging was deliberately kept manual, never automatic, for the same reason).
- No other signal already present elsewhere in this document (DHCP static reservations, hostname, online/offline detection) provides independent corroboration once an AP is confirmed to re-originate even broadcast traffic under its own MAC.
- Therefore: **make the unresolvable state explicit and non-enforceable by default**, with a narrow, audited, manual path to enforceability — rather than silently degrading to weaker automatic evidence.

**New discovery state**: `PROXY_UNCONFIRMED` (added to `IdentitySource`, Section 13.5).

**Entry condition (debounced, to avoid false positives from transient discovery-cycle gaps)**:
```
A device enters PROXY_UNCONFIRMED only when ALL of the following hold:
  1. A DHCP lease exists for MAC A at IP X.
  2. ip neigh shows a different MAC (B) for IP X, persisting across
     N ≥ 3 consecutive discovery cycles (same debounce threshold as
     Section 13.6, applied for consistency, not because the MD requires
     an identical number — this is an implementation decision).
  3. BroadcastCaptureReader has NOT independently observed MAC A during
     that window, INCLUDING at least one window where a DHCP lease
     renewal was either naturally captured or explicitly triggered
     (e.g. via an operator-initiated "recheck identity" action that
     prompts a fresh DHCP renewal attempt on the client side) — a
     device must not be declared PROXY_UNCONFIRMED solely because no
     renewal happened to occur during passive observation.
```

**Enforcement eligibility while `PROXY_UNCONFIRMED`**: not enforceable at all, by MAC or IP. Visible in the device list with a clear label (e.g. "Identity unconfirmed — device is behind a fully-proxying access point"). Any block/limit action against it is rejected by the API with an explicit reason — this matches behavior already observed and confirmed correct during live validation (`POST /api/devices/:id/block` correctly returned "Device identity is not validated" for this exact case).

**The only path to enforceability — explicit, audited admin override**:
```
POST /api/devices/:id/accept-unconfirmed-identity
```
- Requires the admin to acknowledge a specific, displayed risk statement (not a generic confirmation), e.g.: *"This device's identity is asserted by its DHCP lease only and has not been independently confirmed, because the access point it connects through does not expose its real hardware address. Enforcement will follow this device's current IP address only. If its IP changes unexpectedly before the system observes the change, enforcement may briefly lag behind."*
- Transitions `identitySource` to `PROXY_ACCEPTED_BY_ADMIN`.
- Written to `audit_log` (Section 10) with actor, timestamp, and the exact acknowledgment text shown — this is a security-relevant decision and must be auditable like any other enforcement action.
- Enforcement for a `PROXY_ACCEPTED_BY_ADMIN` device uses **IP-based rules only** (`blocked_ips`, via the `IpBinding` model in Section 13.8) — its MAC must never enter `blocked_macs`, since that MAC was never independently confirmed, only DHCP-asserted.
- The system continues attempting `BroadcastCaptureReader` confirmation in the background even after override. If genuine confirmation succeeds later, silently upgrade to `DHCP_CONFIRMED_PROXY` — upgrading assurance never requires admin re-approval, only downgrading does.

### 13.8 `BlockedDevice` / `IpBinding` — Formal Model

Formalizes the design referenced by name in Section 13.3 but not previously specified in this document. This is the mechanism that makes MAC-permanent / IP-dynamically-rebound blocking concrete for any device with `l2Visible = false` (both `DHCP_CONFIRMED_PROXY` and `PROXY_ACCEPTED_BY_ADMIN`).

```prisma
model BlockedDevice {
  id          Int          @id @default(autoincrement())
  deviceId    Int          @unique
  mac         String       @unique   // populated only if identitySource is
                                      // NOT PROXY_ACCEPTED_BY_ADMIN — never
                                      // written for an unconfirmed-then-overridden
                                      // identity, per 13.7
  active      Boolean      @default(true)
  reason      String?
  createdAt   DateTime     @default(now())
  updatedAt   DateTime     @updatedAt
  ipBindings  IpBinding[]

  device      Device       @relation(fields: [deviceId], references: [id])
}

model IpBinding {
  id              Int            @id @default(autoincrement())
  blockedDeviceId Int
  ip              String
  active          Boolean        @default(true)
  boundAt         DateTime       @default(now())
  releasedAt      DateTime?
  releaseReason   String?        // e.g. "ip_reassigned_to_other_mac"

  blockedDevice   BlockedDevice  @relation(fields: [blockedDeviceId], references: [id])

  @@index([ip, active])
}
```

**Core rules**:
- `blocked_macs` (nftables set) is written **only** for devices with a confirmed MAC identity (`DHCP`, `DHCP_CONFIRMED_PROXY`, `STATIC_ARP`) — this is the permanent block record, removed only by explicit unblock.
- Whenever a blocked device has `l2Visible = false` (regardless of which proxy-related `identitySource` it has), its current IP must also be added to `blocked_ips` — MAC-based nftables rules structurally cannot match traffic whose L2 source is the proxying AP, so IP-based enforcement is the only rule that actually takes effect on the wire for these devices.
- **IP-reuse safety (the rule that closes the original reconciliation bug)**: an active `IpBinding` is released **only** on positive evidence — a *different* MAC's DHCP lease claiming that same IP. Absence of a lease, or the bound device going quiet, is explicitly **not** a release trigger. This must replace any prior reconciliation logic that deleted `blocked_ips` entries simply because they were missing from a current discovery snapshot.
- When a blocked device's IP changes (new DHCP lease, same MAC), the active `IpBinding` is released and a new one is created for the new IP — this rebind is a deliberate "follow the device" action, not something reconciliation infers from absence.
- For `PROXY_ACCEPTED_BY_ADMIN` devices specifically: `BlockedDevice.mac` must remain unset/null (see schema comment above) — the block is recorded as an audited manual action against a `Device`, but never promoted into a permanent MAC-keyed enforcement record, since that MAC was never independently confirmed.

### 13.9 Additional Required Tests (Sections 13.5–13.8)

- `IdentityResolutionService`: given DHCP-only, ARP-only, DHCP+matching-capture, DHCP+conflicting-capture-with-confirmation, and DHCP+conflicting-capture-with-no-confirmation-after-a-forced-renewal-attempt — assert the correct `identitySource`/`l2Visible`/`proxyMac` output for each, including that only the last case produces `PROXY_UNCONFIRMED`.
- Debounce test: a single mismatched discovery cycle must never produce `PROXY_UNCONFIRMED` — only a persisted mismatch across the full threshold.
- API test: `POST /api/devices/:id/block` on a `PROXY_UNCONFIRMED` device is rejected with an explicit reason; the same call on a `PROXY_ACCEPTED_BY_ADMIN` device succeeds and results in an `IpBinding`, never a `blocked_macs` entry.
- Regression test: the AP's own MAC (recorded as a `proxyMac`) must never appear as a `Device.mac` value anywhere in the system, and must be rejected if ever passed directly to a block action.
- IP-reuse test under `PROXY_ACCEPTED_BY_ADMIN`, same shape as the original ten-step walkthrough: device changes IP → binding follows; a different device later claims the old IP → old binding releases via positive evidence, new device is never blocked.
- Audit test: `accept-unconfirmed-identity` produces an `audit_log` row containing actor, timestamp, and the exact risk-acknowledgment text.
