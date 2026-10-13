FROM node:24.20.0-bookworm-slim AS build
RUN corepack enable && corepack prepare pnpm@10.29.3 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY apps/backend/package.json apps/backend/package.json
RUN --mount=type=cache,id=messenger-pnpm-store,target=/pnpm/store pnpm install --frozen-lockfile --store-dir /pnpm/store --filter @messenger/backend...
COPY packages/contracts packages/contracts
COPY apps/backend apps/backend
RUN pnpm --filter @messenger/backend... build
RUN install -d -m 0700 -o node -g node /data && install -d -m 0755 -o node -g node /bootstrap
ENV NODE_ENV=production
USER node
EXPOSE 3000
CMD ["node", "apps/backend/dist/apps/backend/src/main.js"]
