FROM node:22-bookworm-slim AS build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Runtime has only the minimum OS packages needed by the enforcement agent.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock \
    SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env \
    SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates dnsmasq-base nftables iproute2 ethtool tcpdump kmod \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY --from=build /src/backend/package*.json ./
COPY --from=build /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/prisma ./prisma

RUN mkdir -p /run/network-control /etc/network-control-system /var/lib/network-control/backups

# Compose grants only NET_ADMIN and NET_RAW; never use --privileged.
CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
