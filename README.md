# Subs On Time

Subtitles that fit the file you are playing. A Stremio addon that retimes every subtitle to your exact video.

## Run with Docker

```sh
docker run -e SECRET=<at least 32 random characters> -p 7000:7000 ghcr.io/jspthesixth/subsontime
```

To build the image yourself:

```sh
docker build -t subsontime .
docker run -e SECRET=<at least 32 random characters> -p 7000:7000 subsontime
```

Open `http://localhost:7000/stremio` to configure the addon and get its install link.

## Environment variables

| Variable                | Required | Purpose                                                         |
| ----------------------- | -------- | --------------------------------------------------------------- |
| `SECRET`                | yes      | Key that seals the addon configuration. At least 32 characters. |
| `OPENSUBTITLES_APP_KEY` | no       | App key for the OpenSubtitles source.                           |
| `PUBLIC_URL`            | no       | Public address of the server, used for the links it hands out.  |
| `PORT`                  | no       | Port to listen on. Defaults to 7000.                            |
| `TRUST_PROXY`           | no       | Set to `1` to take the client address from `X-Forwarded-For`.   |
| `ALLOW_LOCAL_ADDONS`    | no       | Set to `1` to accept addon URLs on private and local addresses. |

## Self-hosting notes

Set `TRUST_PROXY=1` when the server runs behind a reverse proxy, so rate limits apply per client instead of per proxy. Leave it unset when the server is reachable directly, because clients could then spoof the header.

Set `ALLOW_LOCAL_ADDONS=1` only for development. It lets a configuration point at addons on your own network.

## Development

```sh
pnpm install
pnpm dev
pnpm check
pnpm build:wasm
```

`pnpm dev` reads `.env.local`. `pnpm build:wasm` rebuilds the committed alass module and needs Rust 1.100 and wasm-pack 0.15.1.

## License

GPL-3.0-or-later
