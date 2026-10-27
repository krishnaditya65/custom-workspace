# -----------------------------------------------------------------------
# apps/web/Dockerfile - multi-stage build producing a static nginx-served
# bundle.
#
# Build stage compiles the Vite/SolidJS SPA; the runtime stage is just
# nginx serving the resulting static files, with a fallback to index.html
# for client-side routing (see nginx.conf) since @solidjs/router uses the
# History API.
#
# Build-time env vars (VITE_API_URL / VITE_WS_URL / VITE_LIVEKIT_URL) are
# baked into the bundle at `vite build` time - pass them as --build-arg /
# Docker build args if they differ from apps/web/.env.example's defaults.
# -----------------------------------------------------------------------

# ---- deps + build ----
FROM node:20-alpine AS build
WORKDIR /app

# Enable pnpm via corepack (this app lives in a pnpm workspace).
RUN corepack enable

# Copy just the workspace manifests first for better layer caching.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json

RUN pnpm install --frozen-lockfile --filter @workspace/web...

COPY apps/web apps/web

ARG VITE_API_URL=http://localhost:4000
ARG VITE_WS_URL=ws://localhost:1234
ARG VITE_LIVEKIT_URL=
ENV VITE_API_URL=$VITE_API_URL
ENV VITE_WS_URL=$VITE_WS_URL
ENV VITE_LIVEKIT_URL=$VITE_LIVEKIT_URL

WORKDIR /app/apps/web
RUN pnpm run build

# ---- runtime ----
FROM nginx:1.27-alpine AS runtime

COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
