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
    MAX_SESSIONS=3 \
    CREATES_PER_IP_PER_HOUR=3

# Set at run time, not baked in: BASE_PATH, REPORT_BASE_URL, LEADS_ENDPOINT,
# SMTP_HOST, SMTP_PORT, SMTP_SECURE, SMTP_USER, SMTP_PASS, MAIL_FROM,
# MAIL_REPLY_TO, MAIL_CURRENCY. SMTP_PASS is a Google Workspace app password —
# pass it from the host's env file, never build it into the image.

# Session data is ephemeral by design, but DATA_DIR also holds reports.db,
# which is NOT ephemeral — mount a volume for it or stored reports die with
# the container.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000

# Liveness that matches /health: a 503 (dead SMTP) is unhealthy, because the
# report is emailed and nowhere else. No curl in the image — node has fetch.
HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const u='http://127.0.0.1:'+(process.env.PORT||3000)+(process.env.BASE_PATH||'')+'/health';fetch(u).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js", "serve"]
