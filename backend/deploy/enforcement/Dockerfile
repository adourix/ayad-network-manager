FROM node:22-bookworm-slim AS build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Keep the required host networking utilities in a dedicated, minimal image.
# Copying individual executables into another distro can miss shared libraries
# and package data, so the final image uses Debian slim as its runtime base.
FROM debian:bookworm-slim AS system-tools
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

FROM debian:bookworm-slim
ENV NODE_ENV=production \
    ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock \
    SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env \
    SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
WORKDIR /app

# Install the matching Node.js major runtime on Debian Bookworm.
COPY --from=node:22-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:22-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm

COPY --from=build /src/backend/package*.json ./
COPY --from=build /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/prisma ./prisma

# Copy the Debian packages' installed trees, including their shared libraries
# and runtime data. This avoids incomplete single-binary COPY optimizations.
COPY --from=system-tools /usr/bin /usr/bin
COPY --from=system-tools /usr/sbin /usr/sbin
COPY --from=system-tools /lib /lib
COPY --from=system-tools /usr/lib /usr/lib
COPY --from=system-tools /etc/dnsmasq.d /etc/dnsmasq.d
COPY --from=system-tools /usr/share /usr/share

RUN mkdir -p /run/network-control /etc/network-control-system /var/lib/network-control/backups

# Compose grants only NET_ADMIN and NET_RAW; never use --privileged.
CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
