# syntax=docker/dockerfile:1

# Lean headless REST API runtime (Node 24 executes server .ts directly; web-ui/ builds & serves separately)
FROM node:24-slim AS runtime
LABEL org.opencontainers.image.source="https://github.com/rouing/doorking-api" \
      org.opencontainers.image.description="Headless REST API and DKS Cloud worker for DoorKing telephone-entry gates"
WORKDIR /app

# ffmpeg is used for Dahua/Amcrest camera snapshots, video clips and live view.
# tzdata enables the TZ environment variable for scheduled transfers and camera local time.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates ffmpeg tzdata \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY index.ts cli.ts config.example.json ./
COPY src ./src
COPY sql ./sql
COPY docs/MANUAL.md docs/PRIVACY.md docs/openapi.json docs/ResidentInstructions.pdf ./docs/
COPY web/app.ts web/auth.ts web/context.ts web/data.ts web/editing.ts \
     web/jobs.ts web/mail.ts web/migrations.ts web/modules.ts \
     web/push.ts web/requests.ts web/routing.ts web/server.ts \
     web/snapshots.ts web/webhooks.ts ./web/
COPY web/routes ./web/routes

# Persistent runtime data: doorking.key, media/, logs/, and optional config.json (/app stays read-only to node)
RUN mkdir -p /data/media /data/logs && chown -R node:node /data

USER node

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    TRUST_PROXY=true \
    MEDIA_DIR=/data/media \
    LOGS_DIR=/data/logs \
    KEY_FILE=/data/doorking.key

EXPOSE 8080
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "web/server.ts"]
