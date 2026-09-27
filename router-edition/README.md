# LNCS Router Edition — OpenWrt

This directory is the OpenWrt deployment fork of Ayad Network Manager (LNCS).

The core Debian/Ubuntu implementation remains authoritative for everything that this
fork does not explicitly override. Router Edition does not replace or modify the
core deployment path.

## Explicit Router Edition changes

- PostgreSQL -> SQLite + Prisma
- systemd -> OpenWrt procd
- Debian dnsmasq leases -> `/tmp/dhcp.leases`
- Network configuration source -> OpenWrt UCI/netifd
- Setup networking -> LuCI/UCI, with an LNCS policy onboarding step
- libc target -> OpenWrt musl

The enforcement contract and single-interface-IFB traffic design remain unchanged in
intent.

## Validation status

This fork is scaffolded, but it is **not declared hardware-validated**.

The first blocking validation is:

1. Flash stock OpenWrt on the chosen target.
2. Confirm Node 22 starts on the target architecture/libc.
3. Confirm a compatible Prisma SQLite runtime exists.
4. Only then continue with backend migration and enforcement integration.

Do not treat successful TypeScript compilation on a development host as proof that
the target router is supported.

## Target hardware floor

Initial target: >=128 MB RAM and >=16 MB flash. Prefer >=256 MB RAM / >=128 MB
flash until real resource measurements justify a smaller target.

64 MB-class routers are explicitly out of scope for the first hardware bring-up.

## Layout

- `prisma-sqlite/` — SQLite schema variant
- `procd-init/` — OpenWrt service supervision
- `dhcp-lease-reader-patch/` — OpenWrt dnsmasq lease reader
- `uci-onboarding/` — derive LNCS network values from UCI
- `opkg-package/` — initial package metadata/build skeleton

## First hardware milestone

The repository should not claim Router Edition is working until a real OpenWrt
device completes the documented flash -> boot -> configure -> enforce cycle.
