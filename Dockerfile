FROM node:24-alpine AS build
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY scripts scripts
COPY src src
RUN pnpm build

FROM node:24-alpine
RUN corepack enable && corepack prepare pnpm@11.18.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --prod --frozen-lockfile
COPY src src
COPY wasm wasm
COPY --from=build /app/public public
USER node
ENV NODE_ENV=production PORT=7000
EXPOSE 7000
HEALTHCHECK --interval=30s --timeout=3s CMD wget -q -O /dev/null http://localhost:7000/health || exit 1
CMD ["node", "--experimental-strip-types", "src/server.ts"]
