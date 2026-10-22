FROM oven/bun:1.4.2-alpine
WORKDIR /app
COPY package.json tsconfig.json ./
# Standalone install: catalog versions are resolved here because the root workspace isn't in this context.
RUN sed -i -e 's/"hono": "catalog:"/"hono": "4.10.7"/' -e 's/"catalog:"/"*"/g' package.json \
 && bun install --production --ignore-scripts
COPY src ./src
USER bun
EXPOSE 3001
CMD ["sh", "-c", "bun src/migrate.ts && exec bun src/index.ts"]
