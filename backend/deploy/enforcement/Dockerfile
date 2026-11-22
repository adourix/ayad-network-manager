FROM node:22-bookworm-slim AS build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# The enforcement agent only imports dotenv and local executor code; it does not
# use Prisma, Fastify, PostgreSQL, TypeScript or tsx at runtime.
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock \
    SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env \
    SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups
WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       ca-certificates nftables iproute2 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*

COPY --from=build /src/backend/node_modules/dotenv ./node_modules/dotenv
COPY --from=build /src/backend/dist/infrastructure/enforcement/EnforcementAgent.js ./dist/infrastructure/enforcement/EnforcementAgent.js
COPY --from=build /src/backend/dist/infrastructure/enforcement/LinuxSystemCommandExecutor.js ./dist/infrastructure/enforcement/LinuxSystemCommandExecutor.js
RUN printf '{"type":"module"}\n' > package.json \
    && mkdir -p /run/network-control /etc/network-control-system /var/lib/network-control/backups

# Compose grants only NET_ADMIN and NET_RAW; never use --privileged.
CMD ["node", "dist/infrastructure/enforcement/EnforcementAgent.js"]
