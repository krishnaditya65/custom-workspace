# syntax=docker/dockerfile:1

# ---- deps ---------------------------------------------------------------
# Installs full (dev + prod) workspace deps needed to build the monorepo
# packages this app depends on (@workspace/db, @workspace/shared) plus itself.
FROM node:20-slim AS deps
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile

# ---- build ---------------------------------------------------------------
FROM node:20-slim AS build
WORKDIR /repo
RUN corepack enable
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
RUN pnpm --filter @workspace/db run generate
RUN pnpm --filter @workspace/api run build

# ---- production install ---------------------------------------------------
# Re-install with only production deps for a lean runtime image.
FROM node:20-slim AS prod-deps
WORKDIR /repo
RUN corepack enable
COPY pnpm-workspace.yaml package.json ./
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY apps/api/package.json apps/api/package.json
RUN pnpm install --frozen-lockfile --prod

# ---- runtime ---------------------------------------------------------------
FROM node:20-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user for defense in depth.
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nestjs

COPY --from=prod-deps /repo/node_modules ./node_modules
COPY --from=build /repo/packages/db/generated ./packages/db/generated
COPY --from=build /repo/packages/shared ./packages/shared
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/package.json

USER nestjs
WORKDIR /app/apps/api

EXPOSE 4000
CMD ["node", "dist/main.js"]
