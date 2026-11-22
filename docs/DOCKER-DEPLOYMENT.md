# Docker Deployment Status and Known Integration Blocker

## Current status

The repository has Docker build targets for the frontend/backend runtime, a dedicated Prisma migration target, and a separate enforcement image. Docker CI validates the Compose model and builds all three image targets.

**This is not yet a production-ready Docker gateway deployment.** A successful image build only proves the images can be assembled; it does not prove that the container can safely configure and operate the host network.

## Architecture that must be preserved

- PostgreSQL remains the system of record and uses the named `db-data` volume.
- Backend runs without `NET_ADMIN`, `NET_RAW`, or `--privileged`.
- Only the enforcement component may execute privileged `nft`, `tc`, and `ip` operations.
- The enforcement agent is exposed to the backend through the Unix socket.
- Host-specific network configuration must remain outside the application image.
- `reconcile()` must reconstruct runtime kernel state from PostgreSQL after restart.
- Keep the single-interface + IFB implementation as the current MVP topology.

## Blocking issue: setup is not yet fully brokered through the enforcement agent

`backend/src/infrastructure/setup/LinuxSetupProbe.ts` currently constructs a local privileged executor and runs setup-time `nft`, `tc`, and `ip` commands in the backend process. `SetupService` also writes host-specific files and expects to restart/enable host services. In a normal backend container:

- `/etc/dnsmasq.d`, `/etc/nftables.d`, `/etc/modules-load.d`, `/etc/systemd/system`, `/var/lib/misc`, and the host's dnsmasq lease file are not the container's host paths.
- `systemctl` inside a normal container does not manage the host systemd manager.
- Mounting the entire host `/etc` and `/var/lib` into the backend or granting the backend host networking/root capabilities would violate the privilege-isolation requirement.

### Required implementation before calling Docker deployment complete

1. Extend the enforcement-agent protocol with explicit, typed setup operations, not generic arbitrary filesystem access or generic shell execution.
2. Allowlist each operation and each destination path in the agent. Validate interface names, subnet, ports, DNS addresses, file templates and service-unit names.
3. Move host file snapshot/write/atomic-replace/rollback, `modprobe ifb`, and service reload/restart operations behind this broker.
4. Make setup probes query host state through the broker (interfaces, routes, port 53, IFB, UFW, NTP, DHCP leases and link diagnostics).
5. Keep the backend process unprivileged and mount only the shared Unix socket plus the application-owned config volume.
6. Add unit tests for every setup protocol operation and denial cases; add an integration test on a disposable Linux VM with host networking.
7. Verify post-setup DHCP lease issuance, client gateway assignment, NAT, firewall management-port preservation, upload shaping through IFB, download shaping on client-interface egress, and rollback.

## Database recreation

`scripts/docker-reset.sh --db-only` removes only the Compose `db-data` volume, reapplies committed Prisma migrations, then restarts the backend while preserving setup-owned state.

`scripts/docker-reset.sh --full-state` removes the four named application volumes after two explicit confirmations. It intentionally stops after database migrations and does not start the backend: a clean first-run wizard must not be skipped while the host-setup broker is incomplete.

Never add `docker compose down -v` to routine reset instructions. It removes every declared named volume, not just PostgreSQL data.

## Image-size optimization notes

- Frontend build dependencies do not enter the backend runtime image.
- Prisma CLI and TypeScript build tooling do not enter the backend runtime image; Prisma migrations use a dedicated build target.
- Runtime backend dependencies are installed with `npm ci --omit=dev`.
- `.dockerignore` excludes source-control metadata, installed dependencies, build outputs, local certificates and environment files.
- Enforcement image packages use `--no-install-recommends` and purge apt metadata.
- Do not copy selected binaries between Debian images unless their complete shared-library and runtime-data closure is verified; the current enforcement image installs required packages directly in a slim runtime base.

## Verification gates

Image/Compose CI does not prove host-network functionality. Before production:

- [ ] Docker Compose config validates with the real `.env` shape.
- [ ] Runtime, migration and enforcement images build successfully.
- [ ] Prisma migrations apply against an empty disposable PostgreSQL volume.
- [ ] Backend runs as a non-root user with a read-only root filesystem.
- [ ] Enforcement agent starts with only `NET_ADMIN` and `NET_RAW`, not `--privileged`.
- [ ] Setup broker can safely configure host files/services and roll back.
- [ ] Host firewall preserves SSH and dashboard management access.
- [ ] DHCP, NAT, nftables, download shaping and IFB upload shaping work from a real test client.
- [ ] Container restart causes enforcement reconciliation from desired database state.
- [ ] Traffic retention and identity-safety tests remain green.

Until the setup broker gates pass, use the supported bare-metal installer for real gateway deployment; use Compose only for build and integration development.
