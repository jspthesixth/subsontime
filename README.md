# Subs On Time

Subtitles that fit the file you are playing. Subs On Time finds subtitles for the exact video file and retimes each one to it, by a subtitle made for that file or by the soundtrack. Every fix goes to Open Timings, a shared database, so the next person with the same file gets it at once.

It runs as a Stremio addon, a Jellyfin plugin, a Bazarr+ provider and a command line for Bazarr or any player.

## Install in Stremio

Open [subsontime.com/stremio](https://subsontime.com/stremio), pick your languages and sources, and choose Install in Stremio. The install link carries your settings, sealed, so there is no account.

## Integrations

The Jellyfin plugin and the Bazarr+ provider ask for an install link: make one on the setup page above and paste it in their settings.

- **Jellyfin**: in the Dashboard, open Plugins, Repositories, and add `https://subsontime.com/jellyfin/manifest.json`. Install Subs On Time from the Catalog and restart Jellyfin.
- **Bazarr+**: download [`subsontime-bazarr-plus.zip`](https://github.com/jspthesixth/subsontime/releases/latest/download/subsontime-bazarr-plus.zip) from the latest release, upload it in Provider Hub and restart Bazarr+.
- **Bazarr** (Sonarr and Radarr): install the command on the machine or container that runs Bazarr with `curl -fsSL https://subsontime.com/install.sh | sh`. In Settings, Subtitles, Post-Processing, turn on custom post-processing and paste:

  ```sh
  subsontime bazarr --video {{episode}} --subtitle {{subtitles}} --lang {{subtitles_language_code3}}
  ```

### Command line

For video files on disk, the `subsontime` command finds subtitles, times them to the exact file and writes `<video name>.<language>.srt` next to the video. It never overwrites a subtitle: when that name is taken it writes `<video name>.<language>.subsontime.srt`.

```sh
subsontime fix "Example.Movie.2024.1080p.WEB-DL-GROUP.mkv" --lang hr,en --audio
```

It takes a file or a folder (one level deep, or every level with `--recursive`; samples and files under 50 MB are left out). `--audio` aligns to the soundtrack and needs `ffmpeg` (or `SUBSONTIME_FFMPEG` pointing at one). Fixes it times are shared with Open Timings under a random install id kept in `SUBSONTIME_CONFIG_DIR` when set, else in your config folder, else in `subsontime-<uid>` in the temp folder. For Bazarr in a linuxserver.io image, set `SUBSONTIME_CONFIG_DIR=/config/subsontime` on the container: its user cannot write its home folder. `--private` makes no contact with Open Timings at all. `--offline` makes no network call and needs both `--subtitle <path>` (the subtitle to align) and `--audio`. `OPENSUBTITLES_APP_KEY`, `TITLOVI_USERNAME` and `TITLOVI_PASSWORD`, `SUBDL_API_KEY` and `SUBSOURCE_API_KEY` add sources. Run `subsontime --help` for every option.

It exits with 0 when it wrote at least one subtitle, 1 when it wrote none, 2 on a usage error and 3 when `--audio` was given without ffmpeg.

## Self-hosting

The image `ghcr.io/jspthesixth/subsontime` runs on `linux/amd64` and `linux/arm64`. It needs two secrets, each at least 32 characters and different from each other (`openssl rand -hex 32` makes one):

```sh
docker run -e SECRET=<secret> -e INSTALL_SALT=<other secret> -p 7000:7000 ghcr.io/jspthesixth/subsontime
```

To build the image from a checkout instead, run `docker build -t subsontime .` and use `subsontime` as the image name. Open `http://localhost:7000/stremio` to configure the addon and get its install link. Without a database, Open Timings keeps fixes in memory and loses them on restart.

### Docker Compose with Postgres

Put `SECRET` and `INSTALL_SALT` in a `.env` file next to `compose.yaml`, with any other variable from the tables below:

```yaml
services:
  subsontime:
    image: ghcr.io/jspthesixth/subsontime:latest
    restart: unless-stopped
    env_file: .env
    environment:
      DATABASE_URL: postgres://subsontime:subsontime@postgres:5432/subsontime
    ports:
      - "7000:7000"
    depends_on:
      postgres:
        condition: service_healthy

  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: subsontime
      POSTGRES_PASSWORD: subsontime
      POSTGRES_DB: subsontime
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U subsontime"]
      interval: 2s
      retries: 20

volumes:
  postgres-data:
```

Apply the database migrations from the image before the first start and after each upgrade:

```sh
docker compose run --rm subsontime node --experimental-strip-types scripts/migrate.ts
docker compose up -d
```

A single server keeps rate limits, logins and running jobs in memory. When more than one instance serves the addon, they share that state through Redis behind an Upstash-compatible REST proxy. Add `REDIS_TOKEN=<secret>` to `.env`, save this as `compose.redis.yaml` and start with `docker compose -f compose.yaml -f compose.redis.yaml up -d`:

```yaml
services:
  subsontime:
    environment:
      UPSTASH_REDIS_REST_URL: http://redis-http
      UPSTASH_REDIS_REST_TOKEN: ${REDIS_TOKEN}

  redis:
    image: redis:7-alpine
    restart: unless-stopped

  redis-http:
    image: hiett/serverless-redis-http:0.0.10
    restart: unless-stopped
    environment:
      SRH_MODE: env
      SRH_TOKEN: ${REDIS_TOKEN}
      SRH_CONNECTION_STRING: redis://redis:6379
    depends_on:
      - redis
```

Set `TRUST_PROXY=1` when the server runs behind a reverse proxy, so rate limits apply per client instead of per proxy. Leave it unset when the server is reachable directly, because clients could then spoof the header. Set `PUBLIC_URL` to the address people reach it at.

Set `ALLOW_LOCAL_ADDONS=1` only for development. It lets a configuration point at addons on your own network.

## Environment variables

`.env.example` lists them in the same groups. `src/config/env.ts` reads them.

### Server

| Variable             | Required | Purpose                                                                       |
| -------------------- | -------- | ----------------------------------------------------------------------------- |
| `PORT`               | no       | Port to listen on. Defaults to 7000.                                          |
| `PUBLIC_URL`         | no       | Public address of the server, used for the links it hands out.                |
| `TRUST_PROXY`        | no       | Set to `1` to take the client address from `X-Forwarded-For`.                 |
| `ALLOW_LOCAL_ADDONS` | no       | Set to `1` to accept addon URLs on private and local addresses.               |
| `VERCEL`             | no       | Set by Vercel. `1` turns on Vercel Analytics and Speed Insights on the pages. |

### Secrets

| Variable       | Required | Purpose                                                                           |
| -------------- | -------- | --------------------------------------------------------------------------------- |
| `SECRET`       | yes      | Key that seals the addon configuration. At least 32 characters.                   |
| `INSTALL_SALT` | yes      | Hashes install ids for Open Timings. At least 32 characters, other than `SECRET`. |

### Sources

| Variable                        | Required | Purpose                                                                                                    |
| ------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------- |
| `OPENSUBTITLES_APP_KEY`         | no       | App key for the OpenSubtitles source. With it, a file's hash finds the subtitles made for it.              |
| `OPENSUBTITLES_DAILY_DOWNLOADS` | no       | OpenSubtitles API downloads allowed per UTC day across the server. Defaults to 4, below the free plan's 5. |
| `TITLOVI_USERNAME`              | no       | Titlovi username for the command line. With the password, adds the Titlovi source.                         |
| `TITLOVI_PASSWORD`              | no       | Titlovi password for the command line.                                                                     |
| `SUBDL_API_KEY`                 | no       | SubDL API key for the command line. Adds the SubDL source.                                                 |
| `SUBSOURCE_API_KEY`             | no       | SubSource API key for the command line. Adds the SubSource source.                                         |

With the app key, a file without a hash takes its timing references from the OpenSubtitles addon listing, not the OpenSubtitles API, so it spends none of the daily downloads. The downloads go only to subtitles made for the file that the addon does not list.

### Database

| Variable                | Required | Purpose                                                                                          |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `DATABASE_URL`          | no       | Postgres connection string for Open Timings.                                                     |
| `DATABASE_URL_UNPOOLED` | no       | Direct Postgres connection string. `pnpm db:migrate` uses it instead of `DATABASE_URL` when set. |

### Shared state

| Variable                   | Required | Purpose                                                                                                                          |
| -------------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `UPSTASH_REDIS_REST_URL`   | no       | Upstash Redis REST address. With the token, rate limits, logins, running jobs and served subtitles are shared between instances. |
| `UPSTASH_REDIS_REST_TOKEN` | no       | Upstash Redis REST token.                                                                                                        |
| `KV_REST_API_URL`          | no       | Used when `UPSTASH_REDIS_REST_URL` is unset. The Vercel Marketplace Upstash integration sets it.                                 |
| `KV_REST_API_TOKEN`        | no       | Used when `UPSTASH_REDIS_REST_TOKEN` is unset. The Vercel Marketplace Upstash integration sets it.                               |

### Data dumps

| Variable                | Required | Purpose                                                                                                                   |
| ----------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| `BLOB_READ_WRITE_TOKEN` | no       | Vercel Blob token. With it, the daily cron writes the Open Timings dump and `/api/v1/dump` redirects to it.               |
| `CRON_SECRET`           | no       | Bearer secret the daily cron sends to `/api/cron/dump`, letters and digits only. Without it the route refuses every call. |

### CLI

| Variable                | Required | Purpose                                                            |
| ----------------------- | -------- | ------------------------------------------------------------------ |
| `NO_COLOR`              | no       | Set to anything to print without color.                            |
| `SUBSONTIME_CONFIG_DIR` | no       | Folder that keeps the install id.                                  |
| `APPDATA`               | no       | Windows config folder, used when `SUBSONTIME_CONFIG_DIR` is unset. |
| `XDG_CONFIG_HOME`       | no       | Linux config folder, used when `SUBSONTIME_CONFIG_DIR` is unset.   |

### Audio

| Variable             | Required | Purpose                                                             |
| -------------------- | -------- | ------------------------------------------------------------------- |
| `SUBSONTIME_FFMPEG`  | no       | Path to `ffmpeg` for `--audio`. Defaults to `ffmpeg` on the `PATH`. |
| `SUBSONTIME_FFPROBE` | no       | Path to `ffprobe`. Defaults to the one next to `ffmpeg`.            |

### Tests

| Variable            | Required | Purpose                                                                                 |
| ------------------- | -------- | --------------------------------------------------------------------------------------- |
| `DATABASE_URL_TEST` | no       | Postgres connection string the database tests run against. They are skipped without it. |

## Open Timings data

Every fix is public. `GET https://subsontime.com/api/v1/fixes?video=<hash>:<size>` returns the known fixes for one file, and the [Open Timings page](https://subsontime.com/timings#api) documents the API. `https://subsontime.com/api/v1/dump` redirects to the daily dump of every file with a fix or a hidden subtitle, as gzipped JSON Lines. The data and the dumps are [CC0-1.0](DATA-LICENSE.md).

A self-hosted server writes its own dump only with `BLOB_READ_WRITE_TOKEN` and a daily `GET /api/cron/dump` sent with `Authorization: Bearer <CRON_SECRET>`. Without the token `/api/v1/dump` returns 404.

## Support

Subs On Time is free, with no ads and no accounts. If it saved a film night, you can help pay for hosting on [Ko-fi](https://ko-fi.com/jspthesixth).

## Privacy

Submissions carry no account and no address. A daily-changing code makes it harder for one connection to confirm its own fix or hide a subtitle; it cannot be traced back after that day.

## Development

```sh
pnpm install
pnpm dev
pnpm check
pnpm build:wasm
```

`pnpm dev` reads `.env.local`. To run against Redis locally, start `docker compose --profile redis up -d` and set `UPSTASH_REDIS_REST_URL=http://localhost:8079` and `UPSTASH_REDIS_REST_TOKEN=local-dev-token`. The shared state tests run against it when both are set. `pnpm build:wasm` rebuilds the committed alass module and needs Rust 1.100 and wasm-pack 0.15.1.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the checks, the conventions and how releases are cut.

## License

The code is GPL-3.0-or-later, see [LICENSE](LICENSE). Open Timings data is CC0-1.0, see [DATA-LICENSE.md](DATA-LICENSE.md). Report security issues as [SECURITY.md](SECURITY.md) describes.
