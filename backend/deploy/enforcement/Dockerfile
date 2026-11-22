FROM node:22-bookworm-slim AS build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Install only host networking tools required by the enforcement boundary.
FROM debian:bookworm-slim AS enforcement-runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       dnsmasq-base \
       nftables \
       iproute2 \
       ethtool \
       tcpdump \
       kmod \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock \
    SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env \
    SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
WORKDIR /app

COPY --from=build /src/backend/package*.json ./
COPY --from=build /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/prisma ./prisma

# The enforcement agent is a narrow privileged boundary. Keep required
# system binaries/libraries, but do not install the complete Debian toolchain.
COPY --from=enforcement-runtime /usr/bin/nft /usr/bin/nft
COPY --from=enforcement-runtime /usr/sbin/tc /usr/sbin/tc
COPY --from=enforcement-runtime /usr/sbin/ip /usr/sbin/ip
COPY --from=enforcement-runtime /usr/sbin/dnsmasq /usr/sbin/dnsmasq
COPY --from=enforcement-runtime /usr/bin/tcpdump /usr/bin/tcpdump
COPY --from=enforcement-runtime /usr/sbin/ethtool /usr/sbin/ethtool
COPY --from=enforcement-runtime /usr/sbin/modprobe /usr/sbin/modprobe
COPY --from=enforcement-runtime /lib /lib
COPY --from=enforcement-runtime /usr/lib /usr/lib

RUN mkdir -p /run/network-control /etc/network-control-system /var/lib/network-control/backups

# Compose grants only NET_ADMIN and NET_RAW; never use --privileged.
CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
