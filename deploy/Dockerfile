FROM node:22-bookworm-slim AS build
WORKDIR /src
ENV WRANGLER_SEND_METRICS=false
RUN npm install -g pnpm@10.15.0
COPY . .
RUN --mount=type=cache,id=zero-pnpm,target=/pnpm/store pnpm install --store-dir /pnpm/store --frozen-lockfile --ignore-scripts
RUN pnpm --filter @zero/server exec wrangler deploy --dry-run --config wrangler.compose.json --outdir /worker
ENV ZERO_COMPOSE_BUILD=true VITE_PUBLIC_SELF_HOSTED=true VITE_PUBLIC_SELF_HOSTED_AUTH=required
RUN pnpm --filter @zero/mail build

FROM node:22-bookworm-slim AS api
WORKDIR /app
COPY deploy/runtime/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY deploy/runtime/ ./
COPY --from=build /worker /app/worker
COPY apps/server/src/db/migrations /app/migrations
COPY integrations/mail-sync/schema.sql /app/sync-schema.sql
RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node","server.mjs"]

FROM node:22-bookworm-slim AS sync
WORKDIR /app
COPY integrations/mail-sync/package*.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY integrations/mail-sync/src ./src
COPY integrations/mail-sync/schema.sql ./schema.sql
USER node
CMD ["node","src/worker.mjs"]

FROM nginx:1.28-alpine AS web
COPY --from=build /src/apps/mail/build/client /usr/share/nginx/html
COPY deploy/nginx/http.conf /etc/nginx/conf.d/default.conf
RUN if [ -f /usr/share/nginx/html/__spa-fallback.html ]; then cp /usr/share/nginx/html/__spa-fallback.html /usr/share/nginx/html/index.html; fi
