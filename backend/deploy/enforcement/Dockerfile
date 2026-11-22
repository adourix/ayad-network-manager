# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /src/backend
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY backend/prisma/schema.prisma ./prisma/schema.prisma
COPY backend/prisma.config.ts ./prisma.config.ts
COPY backend/tsconfig.json ./tsconfig.json
COPY backend/src ./src
RUN npm run build

# Enforcement runs compiled JavaScript only. Dev dependencies and Prisma CLI
# are intentionally excluded from its production dependency layer.
FROM node:22-bookworm-slim AS production-deps
WORKDIR /src/backend
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

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

COPY --from=production-deps /src/backend/node_modules ./node_modules
COPY --from=build /src/backend/package.json ./package.json
COPY --from=build /src/backend/dist ./dist

RUN mkdir -p /run/network-control /etc/network-control-system /var/lib/network-control/backups

# Compose grants only NET_ADMIN and NET_RAW; never use --privileged.
CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
