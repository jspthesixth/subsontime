import { randomBytes, randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename } from "node:path";
import { parseArgs } from "node:util";
import packageJSON from "../../package.json" with { type: "json" };
import { ffmpegFound } from "../audio/ffmpeg.ts";
import type { SourceSettings } from "../config/config.ts";
import { readGroup, sourcesSchema } from "../config/env.ts";
import { defaultConfig, openSubtitlesAddonURL } from "../config/default-config.ts";
import { memorySharedState } from "../jobs/shared-state.ts";
import { fromLocales, toISO6391, toISO6392 } from "../languages.ts";
import { sourcesFromConfig, type SourceSet } from "../sources/from-config.ts";
import { tokenCacheFor } from "../sources/token-cache.ts";
import { bazarr } from "./bazarr.ts";
import {
  abandonWrites,
  ansiPaint,
  exists,
  field,
  findVideos,
  fixVideo,
  plainPaint,
  type Sharing,
} from "./fix.ts";
import { configDirOf, fallbackConfigDir, installIdFrom } from "./install-id.ts";
import { defaultAPIURL, timingsClient } from "./timings-client.ts";

type Env = Record<string, string | undefined>;

export type CLIDeps = {
  print: (text: string) => void;
  printError: (text: string) => void;
  color: boolean;
  env: Env;
  configDir: string;
  fallbackConfigDir?: string;
  locales: readonly string[];
  sources?: SourceSet;
};

class UsageError extends Error {}

const sourceNames = ["opensubtitles", "titlovi", "subdl", "subsource"];
const missingFFmpeg = "ffmpeg is needed for --audio. Install it and try again.";
const usage = `Usage: subsontime fix <file-or-folder> [options]

Finds subtitles for each video, times them to the exact file and writes
<video name>.<language>.srt next to it.

As Bazarr's post-processing command, syncs the subtitle Bazarr wrote:
  subsontime bazarr --video {{episode}} --subtitle {{subtitles}} --lang {{subtitles_language_code3}}

Options:
  --lang <codes>      Languages, ISO 639-1 or 639-2, comma separated (default: yours and English)
  --audio             Align to the soundtrack (needs ffmpeg)
  --private           Make no contact with Open Timings (no lookup, no sharing)
  --offline           Make no network call (needs --subtitle and --audio)
  --subtitle <path>   Time this subtitle instead of searching (one --lang)
  --imdb <tt...>      The IMDb id, when the file name does not find the title
  --sources <names>   Only these sources: ${sourceNames.join(", ")}
  --recursive         Walk sub-folders too
  --out <folder>      Write the subtitles into this folder
  --api <url>         Open Timings address (default: ${defaultAPIURL})
  -h, --help          Show this help
  --version           Show the version
`;

const options = {
  lang: { type: "string" },
  audio: { type: "boolean" },
  private: { type: "boolean" },
  offline: { type: "boolean" },
  subtitle: { type: "string" },
  imdb: { type: "string" },
  sources: { type: "string" },
  recursive: { type: "boolean" },
  out: { type: "string" },
  api: { type: "string" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

const listOf = (text: string) =>
  text
    .split(",")
    .map((each) => each.trim().toLowerCase())
    .filter((each) => each !== "");

const languagesOf = (text: string | undefined, locales: readonly string[]) => {
  if (text === undefined) {
    return fromLocales([...locales, "en"]);
  }

  const codes = listOf(text).map((code) => ({ code, lang: toISO6392(toISO6391(code) ?? code) }));
  const unknown = codes.find(({ lang }) => lang === undefined);

  if (codes.length === 0 || unknown !== undefined) {
    throw new UsageError(`Unknown language code ${unknown?.code ?? text}`);
  }

  return [...new Set(codes.flatMap(({ lang }) => lang ?? []))];
};

const sourcesOf = (env: Env, text: string | undefined): SourceSet => {
  const chosen = text === undefined ? sourceNames : listOf(text);
  const unknown = chosen.find((name) => !sourceNames.includes(name));

  if (unknown !== undefined) {
    throw new UsageError(`Unknown source ${unknown}. Use ${sourceNames.join(", ")}`);
  }

  const settings: [string, SourceSettings | undefined][] = [
    ["opensubtitles", { kind: "stremio-addon", url: openSubtitlesAddonURL }],
    [
      "titlovi",
      env["TITLOVI_USERNAME"] && env["TITLOVI_PASSWORD"]
        ? { kind: "titlovi", username: env["TITLOVI_USERNAME"], password: env["TITLOVI_PASSWORD"] }
        : undefined,
    ],
    ["subdl", env["SUBDL_API_KEY"] ? { kind: "subdl", apiKey: env["SUBDL_API_KEY"] } : undefined],
    [
      "subsource",
      env["SUBSOURCE_API_KEY"]
        ? { kind: "subsource", apiKey: env["SUBSOURCE_API_KEY"] }
        : undefined,
    ],
  ];
  const config = {
    ...defaultConfig(["eng"]),
    sources: settings.flatMap(([name, each]) =>
      each !== undefined && chosen.includes(name) ? [each] : [],
    ),
  };

  return sourcesFromConfig(config, {
    tokens: tokenCacheFor(memorySharedState(), randomUUID(), randomBytes(32)),
    openSubtitlesAppKey: chosen.includes("opensubtitles")
      ? readGroup(sourcesSchema, env).openSubtitlesAppKey
      : undefined,
  });
};

const sharingOf = (values: { offline?: boolean; private?: boolean }): Sharing => {
  if (values.offline === true) {
    return "offline";
  }

  return values.private === true ? "private" : "on";
};

const parse = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, options, allowPositionals: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Unreadable arguments");
  }
};

const isFolder = async (path: string) => (await stat(path)).isDirectory();

const run = async (argv: string[], deps: CLIDeps) => {
  const { values, positionals } = parse(argv);

  if (values.help === true) {
    deps.print(usage);

    return 0;
  }

  if (values.version === true) {
    deps.print(`${packageJSON.version}\n`);

    return 0;
  }

  const [command, path, ...rest] = positionals;
  const languages = languagesOf(values.lang, deps.locales);
  const sharing = sharingOf(values);

  if (command !== "fix" || path === undefined || rest.length > 0) {
    throw new UsageError("Give one file or folder to fix");
  }

  if (values.offline === true && (values.subtitle === undefined || values.audio !== true)) {
    throw new UsageError("--offline needs --subtitle and --audio");
  }

  if (values.subtitle !== undefined && languages.length !== 1) {
    throw new UsageError("Give one --lang for --subtitle");
  }

  if (values.imdb !== undefined && !/^tt\d+$/.test(values.imdb)) {
    throw new UsageError("Give --imdb as tt followed by digits");
  }

  if (values.api !== undefined && !URL.canParse(values.api)) {
    throw new UsageError("Give --api as a full address");
  }

  if (values.out !== undefined && values.recursive === true) {
    throw new UsageError("--out cannot be used with --recursive");
  }

  const sources = deps.sources ?? sourcesOf(deps.env, values.sources);

  for (const each of [path, values.subtitle, values.out]) {
    if (each !== undefined && !(await exists(each))) {
      throw new UsageError(`${basename(each)} was not found`);
    }
  }

  if ((values.imdb !== undefined || values.subtitle !== undefined) && (await isFolder(path))) {
    throw new UsageError("--imdb and --subtitle need one video, not a folder");
  }

  if (values.audio === true && !ffmpegFound()) {
    deps.printError(`${missingFFmpeg}\n`);

    return 3;
  }

  const { videos, links } = await findVideos(path, values.recursive === true);
  const paint = deps.color ? ansiPaint : plainPaint;
  const context = {
    languages,
    audio: values.audio === true,
    sharing,
    sources,
    timings: sharing === "on" ? timingsClient(values.api ?? defaultAPIURL) : undefined,
    installId: () => installIdFrom(deps.configDir, deps.fallbackConfigDir),
    paint,
    named: videos.length > 1,
    imdbId: values.imdb,
    subtitle: values.subtitle,
    out: values.out,
  };
  let written = 0;

  if (links.length > 0) {
    deps.print(
      `${links.map((link) => field(paint, "skipped", `${basename(link)} · a symbolic link`)).join("\n")}\n\n`,
    );
  }

  if (videos.length === 0) {
    deps.printError("No videos found. A folder's videos must be 50 MB or more and not samples.\n");
  }

  for (const video of videos) {
    const result = await fixVideo(video, context).catch((error: unknown) => ({
      text: [
        basename(video),
        field(paint, "skipped", error instanceof Error ? error.message : "Failed"),
      ].join("\n"),
      written: 0,
    }));

    deps.print(`${result.text}\n\n`);
    written += result.written;
  }

  return written > 0 ? 0 : 1;
};

export const defaultDeps = (): CLIDeps => ({
  print: (text) => process.stdout.write(text),
  printError: (text) => process.stderr.write(text),
  color: process.stdout.isTTY === true && !process.env["NO_COLOR"],
  env: process.env,
  configDir: configDirOf(process.platform, process.env, homedir()),
  fallbackConfigDir: fallbackConfigDir(tmpdir(), process.getuid?.()),
  locales: [Intl.DateTimeFormat().resolvedOptions().locale],
});

export const main = async (argv: string[], deps: CLIDeps = defaultDeps()) => {
  if (argv[0] === "bazarr") {
    return bazarr(argv.slice(1), deps);
  }

  try {
    return await run(argv, deps);
  } catch (error) {
    if (error instanceof UsageError) {
      deps.printError(`${error.message}\n\n${usage}`);

      return 2;
    }

    deps.printError(`subsontime: ${error instanceof Error ? error.message : "failed"}\n`);

    return 1;
  }
};

const stopAfter = (code: number) => () => {
  abandonWrites();
  process.exit(code);
};

export const runFromShell = async () => {
  process.once("SIGINT", stopAfter(130));
  process.once("SIGTERM", stopAfter(143));
  process.exitCode = await main(process.argv.slice(2));
};
