# Public free-tool deployment (multi-tenant serve mode).
# Build:  docker build -t wa-lead-audit .
# Run:    docker run -p 3000:3000 -e MAX_SESSIONS=10 wa-lead-audit
FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries for linux x64/arm64 glibc; the
# toolchain below is only a fallback if a prebuild is unavailable.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
RUN npm run build && npm prune --omit=dev

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/data \
    SESSION_TTL_MIN=120 \
    MAX_SESSIONS=10 \
    CREATES_PER_IP_PER_HOUR=3

# Session data is ephemeral by design — no volume needed; mounting one anyway
# is harmless (sessions are purged on boot).
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

CMD ["node", "dist/index.js", "serve"]
