# Subs On Time

Subtitles that fit the file you are playing. A Stremio addon that retimes every subtitle to your exact video.

## Run with Docker

```sh
docker run -e SECRET=<at least 32 random characters> -e INSTALL_SALT=<at least 32 other random characters> -p 7000:7000 ghcr.io/jspthesixth/subsontime
```

To build the image yourself:

```sh
docker build -t subsontime .
docker run -e SECRET=<at least 32 random characters> -e INSTALL_SALT=<at least 32 other random characters> -p 7000:7000 subsontime
```

Open `http://localhost:7000/stremio` to configure the addon and get its install link.

## Command line

For video files on disk, the `subsontime` command finds subtitles, times them to the exact file and writes `<video name>.<language>.srt` next to the video. It never overwrites a subtitle: when that name is taken it writes `<video name>.<language>.subsontime.srt`.

```sh
node bin/subsontime.js fix "Example.Movie.2024.1080p.WEB-DL-GROUP.mkv" --lang hr,en --audio
```

It takes a file or a folder (one level deep, or every level with `--recursive`; samples and files under 50 MB are left out). `--audio` aligns to the soundtrack and needs `ffmpeg` (or `SUBSONTIME_FFMPEG` pointing at one). Fixes it times are shared with Open Timings under a random install id kept in `SUBSONTIME_CONFIG_DIR` when set, else in your config folder, else in `subsontime-<uid>` in the temp folder. For Bazarr in a linuxserver.io image, set `SUBSONTIME_CONFIG_DIR=/config/subsontime` on the container: its user cannot write its home folder. `--private` makes no contact with Open Timings at all. `--offline` makes no network call and needs both `--subtitle <path>` (the subtitle to align) and `--audio`. `OPENSUBTITLES_APP_KEY`, `TITLOVI_USERNAME` and `TITLOVI_PASSWORD`, `SUBDL_API_KEY` and `SUBSOURCE_API_KEY` add sources. Run `node bin/subsontime.js --help` for every option.

It exits with 0 when it wrote at least one subtitle, 1 when it wrote none, 2 on a usage error and 3 when `--audio` was given without ffmpeg.

## Environment variables

`.env.example` lists them in the same groups. `src/config/env.ts` reads them.

### Server

| Variable             | Required | Purpose                                                         |
| -------------------- | -------- | --------------------------------------------------------------- |
| `PORT`               | no       | Port to listen on. Defaults to 7000.                            |
| `PUBLIC_URL`         | no       | Public address of the server, used for the links it hands out.  |
| `TRUST_PROXY`        | no       | Set to `1` to take the client address from `X-Forwarded-For`.   |
| `ALLOW_LOCAL_ADDONS` | no       | Set to `1` to accept addon URLs on private and local addresses. |

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

## Self-hosting notes

Set `TRUST_PROXY=1` when the server runs behind a reverse proxy, so rate limits apply per client instead of per proxy. Leave it unset when the server is reachable directly, because clients could then spoof the header.

Set `ALLOW_LOCAL_ADDONS=1` only for development. It lets a configuration point at addons on your own network.

Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (or `KV_REST_API_URL` and `KV_REST_API_TOKEN`) when more than one instance serves the addon, as on Vercel. Without them every instance keeps this state in its own memory, which is right for a single server.

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

## License

GPL-3.0-or-later
