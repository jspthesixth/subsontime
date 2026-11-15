# Bazarr end to end

Radarr and Bazarr share one media folder with two public-domain films. Bazarr runs `subsontime bazarr` after every subtitle it downloads, and the subtitle's fix lands in a local Open Timings (our server and its Postgres). `run.ts` configures everything through the apps' HTTP APIs, starts the search and checks the result.

- Night of the Living Dead (tt0063350): https://archive.org/download/NightOfTheLivingDead-MPEG/NightOfTheLivingDead_512kb.mp4
- Plan 9 from Outer Space (tt0052077): https://archive.org/download/plan-9-from-outer-space_202011/Plan%209%20from%20Outer%20Space%20%20%20Ed%20Wood%20%28full%20movie%29.mp4

`run.ts` downloads them into `MEDIA_DIR` when they are missing (about 520 MB) and removes the subtitles left beside them by an earlier run.

## The binary

Bazarr runs the linux-musl build for your machine's architecture. Build it in a glibc Node container with the Node binary from the Alpine image (this is the arm64 one; on x64, name the output `subsontime-linux-musl-x64`):

```sh
docker create --name alpine-node node:24.14.0-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114
docker cp alpine-node:/usr/local/bin/node <build>/alpine-node && docker rm alpine-node
git archive HEAD | tar -x -C <build>
docker run --rm -v <build>:/src -w /src node:24.14.0-bookworm-slim sh -c 'corepack enable && corepack prepare pnpm@11.18.0 --activate && pnpm install --frozen-lockfile && node scripts/build-sea.ts --node ./alpine-node --out subsontime-linux-musl-arm64'
```

## Run

```sh
export MEDIA_DIR=<an empty folder outside the repo> SUBSONTIME_BINARY=<build>/subsontime-linux-musl-arm64
docker compose -f e2e/library/docker-compose.yml up -d --build
node e2e/library/run.ts
docker compose -f e2e/library/docker-compose.yml down -v
```

The search uses keyless providers. Set `OPENSUBTITLES_USERNAME` and `OPENSUBTITLES_PASSWORD` to add OpenSubtitles. The apps listen on `127.0.0.1:57878` (Radarr), `:56767` (Bazarr) and `:57000` (Open Timings). The server shares Bazarr's network, so the post-processing command reaches it as `http://127.0.0.1:7000`.
