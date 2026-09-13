FROM node:22-bookworm-slim AS build

WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates \
       dnsmasq \
       nftables \
       iproute2 \
       ethtool \
       tcpdump \
       kmod \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /src/backend/package*.json ./
COPY --from=build /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/dist ./dist
COPY --from=build /src/backend/prisma ./prisma

ENV NODE_ENV=production
ENV ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock
ENV SYSTEM_CONFIG_PATH=/etc/network-control/config.env
ENV SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups

RUN mkdir -p /run/network-control /etc/network-control /var/lib/network-control/backups

# The enforcement process intentionally runs as root inside this narrowly
# scoped container. Compose grants only NET_ADMIN and NET_RAW; the container
# is not privileged and the backend remains unprivileged by design.

CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
