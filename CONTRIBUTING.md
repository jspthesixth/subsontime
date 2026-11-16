# Contributing

## Setup

You need Node 24 and pnpm 11 (`corepack enable` picks the version from `package.json`).

```sh
pnpm install
cp .env.example .env.local
pnpm dev
```

Set `SECRET` and `INSTALL_SALT` in `.env.local` to two different strings of at least 32 characters, then open `http://localhost:7000/stremio`.

## Checks

```sh
pnpm check
```

It runs oxfmt, oxlint, tsc and vitest, the same as CI. `pnpm format` fixes formatting, `pnpm vitest run <file> -t "<test name>"` runs one test, and `pnpm test:perf` runs the slower performance tests. Tests that need `ffmpeg` skip without it, and database tests skip without `DATABASE_URL_TEST`.

## Conventions

[AGENTS.md](AGENTS.md) has the full list. In short:

- A bug fix starts with a failing test, and tests assert literal values on real cases.
- No comments by default, no nested ternaries, `===` only, blank lines between groups of statements.
- The platform and installed dependencies before hand-written helpers.
- Environment variables are read only in `src/config/env.ts`.
- Commit titles are one plain action phrase, such as "Read the release from trailing parentheses", with no body or prefix.

## Adding a subtitle source

SubDL is a good example to follow.

- `src/sources/<name>.ts` - the source, implementing `Source` from `src/sources/source.ts`, with `<name>.test.ts` beside it reading recorded responses from `test/fixtures/sources/`.
- `src/sources/limits.test.ts` - add the source to the download size limit cases.
- `src/config/config.ts` - its settings in the addon configuration schema.
- `src/sources/from-config.ts` - build the source from those settings.
- `src/web/setup-page.ts` - its entry on the setup page; `src/web/source-check-route.ts` when it takes a key the page should check.
- `src/config/env.ts` and `src/cli/main.ts` - its credential for the command line, also listed in `.env.example` and the README.
- `scripts/probes/<name>.ts` - a script that runs the source against the live API.

## Plugins

`plugins/jellyfin/` is the Jellyfin plugin and `plugins/jellyfin.Tests/` its tests. They need the .NET 10 SDK; the same container image the release uses works without installing it:

```sh
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp --volume "$PWD:/repo" --workdir /repo mcr.microsoft.com/dotnet/sdk:10.0.404 dotnet test plugins/jellyfin.Tests
docker run --rm --user "$(id -u):$(id -g)" --env HOME=/tmp --volume "$PWD:/repo" --workdir /repo mcr.microsoft.com/dotnet/sdk:10.0.404 dotnet publish plugins/jellyfin/Jellyfin.Plugin.SubsOnTime.csproj --configuration Release --output dist/jellyfin
```

`plugins/bazarr-plus/` is the Bazarr+ provider. Its tests use only the Python standard library:

```sh
cd plugins/bazarr-plus
python -m unittest discover -s tests
```

## Releases

1. Set `version` in `package.json` and merge it.
2. Push a tag `v<version>`, for example `v0.2.0`.

`.github/workflows/release.yml` fails when the tag does not equal `v` plus the `package.json` version. Otherwise it:

- builds the command line for Linux (glibc and musl) and macOS on x64 and arm64 and for Windows on x64,
- builds the Jellyfin plugin zip and the Bazarr+ provider zip,
- publishes all of them with `SHA256SUMS` as a GitHub release,
- adds the plugin version to `plugins/jellyfin/releases.json` on the default branch, which `/jellyfin/manifest.json` serves,
- pushes the Docker image `ghcr.io/jspthesixth/subsontime` for `linux/amd64` and `linux/arm64`, tagged `<version>` and `latest`.

## Security issues

Do not open a public issue. [SECURITY.md](SECURITY.md) explains how to report one.
