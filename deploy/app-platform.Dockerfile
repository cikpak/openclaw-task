FROM node:24.20.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /messenger
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/backend/package.json apps/backend/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN --mount=type=cache,id=app-platform-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @messenger/backend... --filter @messenger/frontend...
COPY packages/contracts packages/contracts
COPY apps/backend apps/backend
COPY apps/frontend apps/frontend
RUN pnpm --filter @messenger/backend... --filter @messenger/frontend... build

FROM caddy:2.10.2-alpine AS caddy

FROM ghcr.io/openclaw/openclaw:2026.10.1
USER root
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
COPY --from=build /messenger /messenger
COPY --from=build /messenger/apps/frontend/dist /srv
COPY deploy/app-platform.Caddyfile /etc/caddy/Caddyfile
COPY deploy/app-platform-start.mjs deploy/openclaw-start.mjs deploy/bootstrap-policy.mjs /messenger/
RUN install -d -m 0700 -o node -g node /data /home/node/.openclaw \
    && install -d -m 0755 -o node -g node /bootstrap
ENV NODE_ENV=production
USER node
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=240s --retries=6 \
    CMD node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Keep the upstream tini/activation entrypoint and its /app runtime intact.
CMD ["node", "/messenger/app-platform-start.mjs"]
