# Ayad Network Manager

Ayad Network Manager is a Linux gateway/network-control platform for managing client devices, access policies, bandwidth, quotas, traffic visibility, and optional VPN routing from a web dashboard.

The project is designed around a strict separation between the application control plane and the Linux enforcement plane. PostgreSQL stores desired policy state; the Linux kernel is the source of truth for live enforcement state; the enforcement layer reconciles the two.

> **Project status:** the single-interface + IFB architecture is the MVP target. Docker packaging is included below, but the Docker setup path must not be considered production-ready until the clean-host Docker E2E gate is passed. In particular, the existing setup implementation still contains host-file/system-service operations that must be delegated through the enforcement boundary rather than performed inside the backend container.

## What it does

- Device discovery using DHCP leases and Linux neighbor/ARP state
- Device inventory with MAC, IP, hostname, first-seen and last-seen data
- Block / unblock devices
- Per-device download and upload bandwidth limits
- Quota/accounting support
- Live traffic statistics
- Usage/history views
- Policy reconciliation after service/container restart
- Profiles and schedules in the broader architecture
- Port/application rules in the broader architecture
- Optional sing-box VPN integration
- WebSocket-based live updates
- Responsive PWA dashboard
- PostgreSQL + Prisma persistence

## Architecture

```text
                         Browser / PWA
                              |
                              | HTTPS / WebSocket
                              v
                    +----------------------+
                    | Fastify Backend API   |
                    | React static assets   |
                    | Service / Policy      |
                    +----------+-----------+
                               |
                         Unix socket
                               |
                               v
                    +----------------------+
                    | Enforcement Agent     |
                    | nftables / tc / ip     |
                    | dnsmasq / sing-box     |
                    +----------+-----------+
                               |
                         Linux kernel
                               |
                 +-------------+-------------+
                 |                           |
              nftables                    traffic qdiscs
                 |                           |
                 +-------------+-------------+
                               |
                         LAN clients

                    +----------------------+
                    | PostgreSQL            |
                    | desired policy state  |
                    +----------------------+
```

### Enforcement boundary

Only the enforcement layer is allowed to execute `nft`, `tc`, and `ip`. Application services call the enforcement contract instead of shelling out directly. This keeps privileged networking operations in one small, auditable component.

For the MVP topology:

- Download shaping: client-facing interface egress
- Upload shaping: client ingress redirected to `ifb0`, then shaped on IFB egress
- nftables performs blocking, NAT and policy enforcement
- dnsmasq provides DHCP for the client-facing network

## Network topology

The first implementation target is **single-interface + IFB**. The gateway can use one physical NIC with the client traffic distinguished by the configured LAN/client subnet.

The deployment must never assume a fixed interface name, subnet, gateway address, WAN address, or dashboard port. These values are discovered or supplied during setup and persisted as environment/system configuration.

Dual-interface support is intentionally deferred until the single-interface + IFB path is stable end-to-end.

## Repository layout

```text
.
├── backend/
│   ├── src/
│   ├── prisma/
│   └── deploy/
│       ├── bare-metal/
│       │   └── install.sh
│       ├── enforcement/
│       │   └── Dockerfile
│       ├── docker/
│       │   └── backend.Dockerfile
│       └── systemd/
├── frontend/
├── docker-compose.yml
├── .env.docker.example
├── .dockerignore
└── README.md
```

## Technology stack

| Area | Technology |
|---|---|
| Backend | Node.js 22, Fastify, TypeScript |
| Frontend | React, TypeScript, Vite |
| Database | PostgreSQL 16 |
| ORM | Prisma |
| Firewall | nftables |
| Traffic control | tc / iproute2 / HTB / IFB |
| DHCP | dnsmasq |
| VPN | sing-box (optional) |
| Live updates | WebSocket |
| Deployment | Debian/Ubuntu bare metal, Docker/Compose packaging |

## Requirements

### Bare metal

The supported host family is Debian/Ubuntu. The gateway must have the privileges required to configure Linux networking.

The bare-metal installer is intentionally a single entry point:

```text
backend/deploy/bare-metal/install.sh
```

It is responsible for installing dependencies, preparing PostgreSQL, building the application, starting the temporary setup server, running the setup wizard, and transitioning to the production services.

### Docker

Docker Engine and the Compose plugin are required.

The Docker deployment deliberately uses different privilege levels:

- `backend`: normal application container; no network capabilities
- `db`: PostgreSQL container with a named persistent volume
- `enforcement`: host networking plus only `NET_ADMIN` and `NET_RAW`

The enforcement container is **not** run with `--privileged`.

## Unified installation

Run the unified entry point and choose native or Docker:

```bash
git clone https://github.com/adourix/ayad-network-manager.git
cd ayad-network-manager
sudo bash install.sh
```

- **Native**: the original bare-metal installer; backend and enforcement remain systemd services.
- **Docker**: full Host/Gateway provisioning and setup wizard run first using the original installer. After setup, the backend switches to Docker; the enforcement agent remains Host-native under systemd. This hybrid keeps privileged network operations out of the application container.

The legacy Docker command remains supported:

```bash
sudo bash docker-install.sh
```

### Docker topology

- Backend application: Docker, host networking, no network-admin capabilities.
- Enforcement: Host-native `network-control-enforcement.service`.
- PostgreSQL, dnsmasq, nftables, tc/IFB and sing-box: provisioned on the Host.
- Setup Wizard: completed through the original Host-native setup server before the backend switch.
- Docker backend mounts only the enforcement socket, Host setup config, TLS and setup backup directory.

## Bare-metal installation

For the reference bare-metal path:

```bash
sudo bash install.sh native
```

The intended flow is:

```text
installer
   |
   +--> OS dependencies
   +--> PostgreSQL
   +--> Node.js 22
   +--> npm ci
   +--> frontend build
   +--> Prisma migrations
   |
   v
temporary setup server
   |
   v
/setup wizard
   |
   +--> detect interfaces
   +--> check subnet conflicts
   +--> enter uplink bandwidth
   +--> apply gateway configuration
   +--> health checks
   |
   v
SETUP_COMPLETED=true
   |
   v
clean production build
   |
   v
systemd services
   |
   v
runtime + reconciliation
```

## Setup wizard

The setup flow must be safe to re-run. A setup-completed flag controls whether the wizard is shown by default; it does not make the underlying configuration logic one-time-only.

The effective network configuration includes values such as:

```text
CLIENT_INTERFACE
UPLINK_INTERFACE
CLIENT_SUBNET
CLIENT_GATEWAY_IP
DHCP_RANGE_START
DHCP_RANGE_END
DNS_SERVERS
DASHBOARD_PORT
SSH_PORT
UPLINK_BANDWIDTH_MBPS
NETWORK_MODE
SETUP_COMPLETED
```

The gateway address is derived from the selected client subnet rather than being hardcoded.

### Pre-flight checks

A correct installation must check at least:

1. Port 53 conflicts before configuring dnsmasq
2. Existing firewall managers such as UFW
3. IFB kernel support
4. Required privileges
5. Existing network configuration conflicts
6. Time synchronization for scheduling

### Rollback

Before changing firewall/network state, setup should snapshot the relevant state. A failed setup step must be able to restore the previous known-good configuration rather than leaving the gateway half-configured.

### Post-setup verification

Successful command exit codes are not enough. The setup health pass should verify:

- client-side gateway reachability
- DHCP lease issuance
- actual NAT/outbound connectivity
- nftables validation
- SSH access
- dashboard access
- block/unblock
- download shaping
- upload shaping through IFB
- quota/accounting
- live traffic
- reconciliation after restart

## Configuration model

There are two important categories of configuration.

### Installer/application configuration

Database credentials, authentication material, paths and static application settings are supplied through environment variables.

### Setup-owned network configuration

Interface names, client subnet, gateway address, DHCP ranges, bandwidth and other environment-specific network values are persisted by setup and loaded by the runtime.

Do not bake environment-specific values into images.

## Desired state vs actual state

PostgreSQL is the persistent policy source of truth. Linux runtime state is ephemeral and must be rebuilt.

```text
PostgreSQL desired policy
          |
          v
     Policy Engine
          |
          v
 Enforcement Layer
          |
          v
 nftables / tc / kernel
```

On startup/restart, reconciliation compares desired policy against live kernel state and restores missing or stale enforcement state.

This is required because nftables rules and traffic-control state do not survive every restart/reboot scenario.

## Security model

The project controls network access, so security is part of the architecture rather than an optional hardening step.

### Privilege isolation

Only the enforcement component receives network administration capabilities. The backend does not need `NET_ADMIN`, `NET_RAW`, or `--privileged`.

### Command validation

The enforcement agent validates command names, arguments, interfaces, IP addresses, ports, nftables objects and managed rule forms before execution.

### Self-lockout protection

The enforcement path must preserve configured SSH and dashboard access and must reject attempts that would block the administrator's own current device.

### Firewall validation

Generated nftables rules should be checked with `nft -c` before applying them. A failed validation must leave the previous known-good ruleset active.

### Identity safety

Device enforcement must not blindly trust a stale MAC/IP association. DHCP lease information is cross-checked with the Linux neighbor table before an association is treated as authoritative for enforcement.

## Traffic shaping model

For the single-interface + IFB MVP:

```text
DOWNLOAD
Internet -> gateway -> client-facing interface egress -> client
                         |
                         +--> HTB class by destination IP

UPLOAD
client -> client-facing interface ingress
          |
          +--> redirect to ifb0
                    |
                    +--> HTB class by source IP
                    |
                    v
                 uplink path
```

The shared HTB builder is direction-aware and device-agnostic. The topology-specific IFB redirect belongs to the single-interface implementation.

## nftables model

The project uses managed nftables chains/sets rather than rebuilding a giant unrestricted FORWARD rule list for every action.

The blocked-MAC path uses the managed set/chain and places the blocking rule before permissive forwarding rules. Management access rules are explicitly preserved.

## Live device detection

The preferred online/offline method is passive:

```text
ip neigh show dev <CLIENT_INTERFACE>
        +
DHCP lease file
        |
        v
validated MAC <-> IP association
```

This avoids active polling of every device and reduces network, CPU and database load.

## Database

PostgreSQL is mandatory for this project. SQLite is not the project database.

Prisma handles the database schema and migrations.

For Docker deployment, PostgreSQL is external to Compose and must be provisioned on the Host. The installer tests the supplied connection but does not create the database, roles, or schema.

## Logs and troubleshooting

### View all services

```bash
docker compose ps
docker compose logs -f --tail=200
```

### Backend logs

```bash
docker compose logs -f backend
```

### Enforcement logs

```bash
docker compose logs -f enforcement
```

### PostgreSQL logs (Host)

```bash
sudo journalctl -u postgresql -f
```

### Verify the enforcement socket

```bash
docker compose exec backend sh -lc 'test -S /run/network-control/enforcement.sock && echo socket-ok'
```

### Rebuild from scratch

```bash
docker compose down

docker compose build --no-cache

docker compose up -d
```

Docker Compose no longer manages the database volume. Application configuration and runtime state are kept in named volumes.

## Operational safety

This software is a gateway. Applying its network configuration can disconnect clients or the administrator if the host topology is wrong.

Before the first installation:

- keep a local/console recovery path to the server
- know which NIC is connected to the uplink and which path serves clients
- verify the current subnet does not collide with the proposed client subnet
- keep SSH access available
- do not test firewall changes over the only management connection without the self-lockout safeguards

## Validation gate

A deployment should not be called production-ready until the following clean-host checks pass:

```text
[ ] OS prerequisites / container prerequisites
[ ] Node.js 22 build
[ ] PostgreSQL
[ ] database migrations
[ ] frontend build
[ ] temporary setup server
[ ] interface detection
[ ] subnet conflict detection
[ ] dynamic client subnet/gateway
[ ] IFB availability
[ ] dnsmasq DHCP-only mode
[ ] port 53 conflict handling
[ ] DHCP lease issuance
[ ] client gateway assignment
[ ] NAT
[ ] nftables validation
[ ] SSH access
[ ] dashboard access
[ ] block/unblock
[ ] download shaping
[ ] upload shaping through ifb0
[ ] quota/accounting
[ ] live traffic
[ ] reconciliation after restart
[ ] current compiled enforcement artifact
[ ] sing-box integration
[ ] rollback after deliberately failed setup step
[ ] service restart/self-healing
```

## Non-regression rules

Future changes must not:

1. hardcode interfaces, subnets, gateway IPs, uplink IPs or ports
2. move nft/tc/ip execution outside the enforcement layer
3. restore the old download ingress-to-IFB design
4. replace managed nftables structures with giant runtime enumeration
5. switch PostgreSQL back to SQLite
6. make nginx a required reverse proxy
7. silently fail open when an enabled VPN policy requires fail-closed behavior
8. remove identity/proxy safeguards
9. enforce stale/unverified MAC-IP associations
10. introduce a second independent bare-metal installer
11. begin dual-interface work before the single-interface + IFB MVP is stable

## Development

Backend:

```bash
cd backend
npm ci
npm run build
npm test
```

Frontend:

```bash
cd frontend
npm ci
npm run build
```

For early development, running directly on the Linux gateway host is preferred because the enforcement layer needs real kernel networking state. Compose is the deployment packaging path and must preserve the same architecture rather than bypass it.

## License

No license is currently declared in this repository. Treat the repository's existing project ownership and access controls as authoritative until a license file is added.
