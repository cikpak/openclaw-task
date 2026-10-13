FROM node:24.20.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/frontend/package.json apps/frontend/package.json
RUN --mount=type=cache,id=messenger-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @messenger/frontend...
COPY packages/contracts packages/contracts
COPY apps/frontend apps/frontend
RUN pnpm --filter @messenger/frontend... build
FROM caddy:2.10.2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/apps/frontend/dist /srv
