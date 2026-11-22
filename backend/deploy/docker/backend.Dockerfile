FROM node:22-bookworm-slim AS frontend-build
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm-slim AS backend-build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# CLI-only stage for one-shot schema deployment; not included in backend runtime.
FROM node:22-bookworm-slim AS migration
WORKDIR /app
COPY --from=backend-build /src/backend/package*.json ./
COPY --from=backend-build /src/backend/node_modules ./node_modules
COPY --from=backend-build /src/backend/prisma ./prisma
CMD ["./node_modules/.bin/prisma", "migrate", "deploy", "--schema=./prisma/schema.prisma"]

FROM node:22-bookworm-slim AS backend-production-deps
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

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
COPY --from=backend-build /src/backend/prisma ./prisma
COPY --from=frontend-build /src/frontend/dist /frontend-dist

RUN mkdir -p /etc/network-control-system /run/network-control /var/lib/network-control/backups /etc/network-control-system/tls \
    && chown -R node:node /app /frontend-dist

USER node
EXPOSE 5000
CMD ["node", "dist/bootstrap.js"]
