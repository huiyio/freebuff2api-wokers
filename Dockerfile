FROM node:24-alpine

WORKDIR /app

# wget is only used for explicitly enabled, SHA-256-pinned worker updates.
RUN apk add --no-cache wget

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY account-proxy.js account-manager.js account-store.js admin-auth.js admin-server.js \
  credential-vault.js import-credentials.js server-utils.js server.js worker.js docker-entrypoint.sh ./
COPY admin-ui ./admin-ui
COPY migrations ./migrations
RUN chmod +x /app/docker-entrypoint.sh

# Application code stays root-owned. Only the SQLite volume and the explicitly
# replaceable, hash-pinned worker module are writable by the runtime user.
RUN mkdir -p /app/credentials /app/data \
  && chown -R node:node /app/data \
  && chown node:node /app/worker.js

USER node
EXPOSE 8787 8788
VOLUME ["/app/data"]

ENTRYPOINT ["/app/docker-entrypoint.sh"]
