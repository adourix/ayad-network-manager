# LNCS package contract

The ImageBuilder consumes an OpenWrt package named `lncs-router-edition`.

The package must install:

- `/usr/lib/lncs/backend/dist/**`
- `/usr/lib/lncs/frontend/dist/**`
- `/etc/lncs/router.env`
- `/etc/capabilities/lncs-enforcement.json`
- `/etc/init.d/lncs-enforcement`
- `/etc/init.d/lncs-backend`
- `/usr/lib/lncs/backend/schema.prisma` for build/runtime diagnostics; Router boot initializes the SQLite schema from the packaged SQL file.

The package build is target-specific because Prisma's SQLite adapter uses a
native SQLite driver. The resulting Node native addon must match the router's
CPU ABI and musl environment. Do not copy a host x86_64 `node_modules` into an
ARM/MIPS router image.
