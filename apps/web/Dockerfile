# OpenSession web app: built with Vite, served as static files by nginx.
# Build from the repository root (the app uses workspace packages):
#   docker build -f apps/web/Dockerfile \
#     --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_... --build-arg VITE_GATEWAY_URL=https://api.example.com .
# The two VITE_ values are compiled into the page (both are public by design).

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json turbo.json ./
COPY apps/web/package.json apps/web/
COPY packages/api-client/package.json packages/api-client/
COPY packages/ui/package.json packages/ui/
RUN pnpm install --frozen-lockfile --filter @opensession/web...
COPY apps/web apps/web
COPY packages/api-client packages/api-client
COPY packages/ui packages/ui
ARG VITE_CLERK_PUBLISHABLE_KEY
ARG VITE_GATEWAY_URL
# Optional: the GitHub repository with the releases (Download page). Default in App.tsx.
ARG VITE_RELEASES_REPO
RUN test -n "$VITE_CLERK_PUBLISHABLE_KEY" && test -n "$VITE_GATEWAY_URL" \
    || (echo "set VITE_CLERK_PUBLISHABLE_KEY and VITE_GATEWAY_URL" >&2; exit 1)
RUN pnpm --filter @opensession/web build

FROM nginx:1.27-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/apps/web/dist /usr/share/nginx/html
EXPOSE 80
