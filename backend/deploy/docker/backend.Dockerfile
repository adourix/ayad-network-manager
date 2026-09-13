FROM node:22-bookworm AS frontend-build

WORKDIR /src/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM node:22-bookworm AS backend-build

WORKDIR /src/backend
COPY backend/package*.json ./
RUN npm ci
COPY backend/ ./
RUN npm run build

FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production

COPY --from=backend-build /src/backend/package*.json ./
COPY --from=backend-build /src/backend/node_modules ./node_modules
COPY --from=backend-build /src/backend/dist ./dist
COPY --from=backend-build /src/backend/prisma ./prisma
COPY --from=frontend-build /src/frontend/dist /frontend-dist

ENV FRONTEND_DIST_PATH=/frontend-dist
ENV ENFORCEMENT_SOCKET_PATH=/run/network-control/enforcement.sock
ENV SYSTEM_CONFIG_PATH=/etc/network-control/config.env
ENV SETUP_SNAPSHOT_DIR=/var/lib/network-control/backups

RUN mkdir -p /etc/network-control /run/network-control /var/lib/network-control/backups /etc/network-control/certs

EXPOSE 5000

CMD ["sh", "-c", "npx prisma migrate deploy && exec node dist/bootstrap.js"]
