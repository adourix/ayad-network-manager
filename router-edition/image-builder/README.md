# LNCS Router Edition — bootable OpenWrt image

Router Edition is delivered as an OpenWrt firmware image. There is no LNCS
installer and there is no first-boot `install.sh`.

## Build model

1. Select the exact OpenWrt release, target, subtarget, and device profile for
   the physical router.
2. Build the `lncs-router-edition` package with the Router Edition backend,
   generated Prisma client, frontend dist, and target-compatible native
   SQLite dependency.
3. Use the matching OpenWrt ImageBuilder to bake that package and the files in
   this directory into the firmware image.
4. Flash the generated factory/sysupgrade image using the router's normal
   OpenWrt flashing path.

The ImageBuilder itself is responsible for assembling the final filesystem;
LNCS does not run an installer after flashing.

## Required runtime contract

The image must contain:

- Node.js 22-compatible runtime.
- Prisma SQLite adapter and its target-compatible native SQLite driver.
- `nftables-json`.
- `tc-full`.
- `kmod-ifb`, `kmod-sched-core`, and `kmod-sched-flower`.
- dnsmasq.
- procd/ujail.
- the LNCS backend and generated Prisma client.
- the built React frontend.

OpenWrt's package ecosystem varies by release and target. In particular, do not
blindly assume the generic `node` package is Node 22; verify `node --version`
on the selected build/target. The Router Edition spec explicitly requires Node
22.

## Persistent state

The immutable firmware contains code and defaults. Runtime state belongs in
OpenWrt's writable overlay:

- `/etc/lncs/router.env`
- `/etc/lncs/lncs.db`
- `/etc/lncs/dhcp-reservations.conf`
- `/var/run/network-control/`

UCI remains authoritative for LAN/WAN configuration. The backend re-derives the
interfaces and LAN subnet from UCI at process start.

## No parallel network setup

Do not add an LNCS setup wizard that writes LAN/WAN addresses. Configure WAN/LAN
through OpenWrt/LuCI. LNCS only consumes that configuration.

## Validation gate before real flashing

The image is not hardware-validated merely because it builds. The first target
must pass:

- Node 22 startup on its exact CPU/libc.
- Prisma SQLite connection on that exact target.
- fw4 coexistence and reconciliation after `fw4 reload`.
- IFB + flower + mirred traffic shaping with real LAN/WAN traffic.
- procd respawn/reload behavior.
- reboot persistence and DB durability.



## Initial administrator credentials

The image seeds the first administrator account as:

- Username: `admin`
- Password: `admin`

On the first login, LNCS forces the administrator to change the password from **Settings**. The replacement password is stored as a scrypt hash in the persistent SQLite database. No password hash or salt needs to be supplied to the ImageBuilder.
