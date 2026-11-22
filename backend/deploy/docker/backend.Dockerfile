# Build the frontend independently so its toolchain never enters the runtime image.
FROM node:22-bookworm-slim AS frontend-build
WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

# Build the backend and generate Prisma Client against the locked schema.
FROM node:22-bookworm-slim AS backend-build
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

# Keep Prisma CLI and build tooling out of the runtime dependency tree.
FROM node:22-bookworm-slim AS backend-production-deps
WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

# Runtime image: production node_modules, compiled code, migrations and assets only.
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

# Migrations run in a dedicated deployment step, not on every restart.
CMD ["node", "dist/bootstrap.js"]
