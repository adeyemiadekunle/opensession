# OpenSession web app (packages/app): built with Vite, served as static files by nginx.
# Build from the repository root (the app uses workspace packages):
#   docker build -f packages/app/Dockerfile \
#     --build-arg VITE_OPENSESSION_GATEWAY_URL=https://api.example.com \
#     --build-arg VITE_OPENSESSION_AUTH_URL=https://auth.example.com .
# Both values are compiled into the page (both are public by design).

FROM oven/bun:1.4.2 AS build
WORKDIR /src
COPY . .
# Scripts are skipped: the only one fixes node-pty for the local server, which the page doesn't use.
RUN bun install --frozen-lockfile --ignore-scripts
ARG VITE_OPENSESSION_GATEWAY_URL
ARG VITE_OPENSESSION_AUTH_URL
RUN test -n "$VITE_OPENSESSION_GATEWAY_URL" && test -n "$VITE_OPENSESSION_AUTH_URL" \
    || (echo "set VITE_OPENSESSION_GATEWAY_URL and VITE_OPENSESSION_AUTH_URL" >&2; exit 1)
RUN cd packages/app && OPENCODE_CHANNEL=prod NODE_OPTIONS=--max-old-space-size=4096 bun run build

FROM nginx:1.27-alpine
COPY packages/app/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/packages/app/dist /usr/share/nginx/html
EXPOSE 80
