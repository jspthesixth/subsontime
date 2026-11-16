FROM node:24-alpine AS base
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN corepack enable && corepack install

FROM base AS install
RUN pnpm install --prod --frozen-lockfile

FROM base AS build
RUN pnpm install --frozen-lockfile
COPY scripts scripts
COPY src src
COPY public public
RUN pnpm build

FROM install AS runtime
COPY src src
COPY wasm wasm
COPY migrations migrations
COPY scripts/migrate.ts scripts/migrate.ts
COPY plugins/jellyfin/releases.json plugins/jellyfin/releases.json
COPY --from=build /app/public public

ENV NODE_ENV=production
ENV PORT=7000
EXPOSE 7000

USER node
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://localhost:${PORT}/health || exit 1
CMD ["node", "--experimental-strip-types", "src/server.ts"]
