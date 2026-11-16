FROM node:26.13.1-alpine@sha256:6bd9ab43c0ec0190ca7b2d193906cb8b7edf6e7f4afa43ddeccd6452710bffb5 AS base
WORKDIR /app
COPY package.json ./

FROM base AS pnpm
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN npm install --global "$(node -p 'require("./package.json").packageManager')"

FROM pnpm AS install
RUN pnpm install --prod --frozen-lockfile

FROM pnpm AS build
RUN pnpm install --frozen-lockfile
COPY scripts scripts
COPY src src
COPY public public
RUN pnpm build

FROM base AS runtime
COPY --from=install /app/node_modules node_modules
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
