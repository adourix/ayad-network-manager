# syntax=docker/dockerfile:1.7
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY frontend/index.html ./index.html
COPY frontend/vite.config.ts ./vite.config.ts
COPY frontend/tsconfig*.json ./
COPY frontend/src ./src
COPY frontend/public ./public
RUN npm run build

FROM node:22-bookworm-slim AS backend-build
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /src/backend
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY backend/prisma/schema.prisma ./prisma/schema.prisma
COPY backend/prisma.config.ts ./prisma.config.ts
COPY backend/tsconfig.json ./tsconfig.json
COPY backend/src ./src
RUN npm run build

# One-shot migration image: it retains Prisma CLI and the Prisma config,
# but is not part of the long-running backend runtime.
FROM node:22-bookworm-slim AS migration
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=backend-build /src/backend/package*.json ./
COPY --from=backend-build /src/backend/node_modules ./node_modules
COPY --from=backend-build /src/backend/prisma ./prisma
COPY backend/prisma.config.ts ./prisma.config.ts
CMD ["./node_modules/.bin/prisma", "migrate", "deploy", "--schema=./prisma/schema.prisma"]

FROM node:22-bookworm-slim AS backend-production-deps
WORKDIR /src/backend
COPY backend/package*.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    FRONTEND_DIST_PATH=/frontend-dist \
    ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock \
    SYSTEM_CONFIG_PATH=/etc/network-control-system/config.env \
    SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups

COPY --from=backend-production-deps /src/backend/node_modules ./node_modules
COPY --from=backend-build /src/backend/package.json ./package.json
COPY --from=backend-build /src/backend/dist ./dist
COPY --from=frontend-build /src/frontend/dist /frontend-dist

RUN find ./dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.ts.map' \) -delete \
    && mkdir -p /etc/network-control-system /run/network-control /var/lib/network-control/backups /etc/network-control-system/tls \
    && chown -R node:node /app /frontend-dist

USER node
EXPOSE 5000
CMD ["node", "dist/bootstrap.js"]
