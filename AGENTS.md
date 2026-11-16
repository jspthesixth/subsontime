# AGENTS.md

Subs On Time finds subtitles for the exact video file and retimes them to it. It runs as a Stremio addon (a Hono server, also deployed on Vercel) and as the `subsontime` command line, which Bazarr can call.

## Commands

| Task                       | Command                                                      |
| -------------------------- | ------------------------------------------------------------ |
| Install                    | `pnpm install`                                               |
| Format, lint, types, tests | `pnpm check`                                                 |
| One test file or test      | `pnpm vitest run src/timing/retime.test.ts -t "<test name>"` |
| Performance tests          | `pnpm test:perf`                                             |
| Format in place            | `pnpm format`                                                |
| Run the server locally     | `pnpm dev` (reads `.env.local`, see `.env.example`)          |
| Run the command line       | `node bin/subsontime.js --help`                              |
| Local Postgres for timings | `pnpm db:up && pnpm db:migrate`                              |
| Build the web client       | `pnpm build`                                                 |
| Build the single binary    | `pnpm build:cli`                                             |
| Rebuild the alass wasm     | `pnpm build:wasm` (Rust and wasm-pack, see the README)       |

Tests that need `ffmpeg` skip when neither `SUBSONTIME_FFMPEG` nor the `PATH` has one. Database tests skip without `DATABASE_URL_TEST`.

## Map

- `src/app.ts`, `src/server.ts` - the Hono app and the Node server; `api/index.ts` is the Vercel entry.
- `src/stremio/` - addon manifest, subtitle and file routes, Open Timings lookups.
- `src/sources/` - subtitle sources (OpenSubtitles, Titlovi, SubDL, SubSource, other addons) behind `Source`.
- `src/subtitles/` - decoding, parsing, writing and scoring subtitles, release name parsing.
- `src/timing/` - retiming: alass alignment, speech detection, reference selection.
- `src/timings/` - Open Timings: the shared fix database, its API and confirmation.
- `src/audio/` - alignment to the soundtrack through ffmpeg.
- `src/cli/` - the `subsontime` command, `fix` and `bazarr`.
- `src/config/` - environment (`env.ts`), the sealed addon configuration.
- `src/jobs/` - shared state (Redis or memory) and single-flight jobs.
- `src/web/` - server-rendered pages, setup and check routes; `client/` is the browser code.
- `crates/alass-wasm/` builds `wasm/`; `migrations/` is the Postgres schema; `scripts/` holds builds, probes and evaluations; `e2e/` the Bazarr end to end run.

## Conventions

`pnpm check` enforces formatting and lint (oxfmt, oxlint with `lint/plugin.ts`): blank lines after destructuring, around `if` blocks and before `return`, `===` only, no nested ternaries. Beyond that:

- Group related statements, one blank line between groups.
- No comments by default, in code, types and tests. No JSDoc. A rare one is a few words on one `//` line. No commented-out code.
- Build collections with `map`, `filter`, `flatMap`, `Object.fromEntries`, not loops.
- No duplicated logic. KISS: no abstraction with one caller, no option nobody passes.
- Descriptive names. camelCase constants, never SCREAMING_SNAKE_CASE. Acronyms stay uppercase: `publicURL`, `toURL`, `CLIDeps`.
- Battle-tested first: the platform (`Intl`, `node:*`), installed dependencies, then a maintained package, before a hand-written helper, table or parser. Why a hand-written one stays goes in the commit, not a comment.
- Environment variables are read only in `src/config/env.ts`.
- Tests check behavior on real cases and assert literal values, never a value computed from the code under test.
- Only regular hyphens "-", in prose and code. American English in docs.
- Never print or log secrets, install links or sealed configurations. Credentials come only from the environment.

## Workflow

- A bug fix starts with a failing test.
- Run `pnpm check` before committing.
- Commit titles are one plain action phrase ("Read the release from trailing parentheses"): no body, no `feat:`/`fix:` prefix, no co-author or tool attribution lines.
- Never commit secrets or `.env.local`. Plans and scratch notes stay out of git.

See [README.md](README.md) for running and configuring the addon and [CONTRIBUTING.md](CONTRIBUTING.md) for contributing.
