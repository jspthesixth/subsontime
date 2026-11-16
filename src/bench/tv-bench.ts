import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { Cue } from "../subtitles/cue.ts";
import { normalizedLine } from "../subtitles/lines.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import type { BenchFile, FileResult, Fingerprint, Listed, Run } from "./stremio-bench.ts";
import { requestModes, tiers, type RequestMode } from "./stremio-bench.ts";

const TruthTrackSchema = v.object({
  lang: v.string(),
  source: v.picklist(["embedded", "sidecar"]),
  stream: v.optional(v.number()),
  path: v.string(),
  cues: v.number(),
});

const EpisodeSchema = v.object({
  show: v.string(),
  path: v.string(),
  filename: v.string(),
  hash: v.string(),
  size: v.number(),
  imdbId: v.string(),
  season: v.number(),
  episode: v.number(),
  episodeName: v.optional(v.string()),
  durationMs: v.number(),
  truth: v.array(TruthTrackSchema),
  excluded: v.optional(v.string()),
});

export const TVDatasetSchema = v.object({ episodes: v.array(EpisodeSchema) });

export type Episode = v.InferOutput<typeof EpisodeSchema>;

export type TVFile = BenchFile & {
  show: string;
  source: Episode["truth"][number]["source"];
  fingerprint: Fingerprint;
};

export const loadTVDataset = async (root: string) => {
  const dir = join(root, "tv");
  const { episodes } = v.parse(
    TVDatasetSchema,
    JSON.parse(await readFile(join(dir, "dataset.json"), "utf8")),
  );

  const kept = episodes.filter((episode) => episode.excluded === undefined);

  const files = await Promise.all(
    kept.map(async ({ show, path, hash, size, imdbId, truth }): Promise<TVFile> => ({
      sha256: hash,
      kind: "episode",
      imdbId,
      path,
      show,
      source: truth[0]?.source ?? "embedded",
      fingerprint: { hash, size },
      verified: await Promise.all(
        truth.map(async ({ lang, source, stream, path: track }) => ({
          id: `${source}${stream === undefined ? "" : `:${stream}`}`,
          lang,
          cues: parseSubtitle(
            decodeSubtitle(new Uint8Array(await readFile(join(dir, track))), lang),
          ),
        })),
      ),
    })),
  );

  return {
    split: "tv",
    seeds: new Map<string, string>(),
    files,
    excluded: episodes.filter((episode) => episode.excluded !== undefined),
  };
};

const minimumCuesPerMinute = 2;
const maximumCuesPerMinute = 40;
const minimumCoverage = 0.75;
const endSlackMs = 2000;

export const truthProblem = (cues: Cue[], durationMs: number) => {
  const minutes = durationMs / 60_000;
  const lastEnd = Math.max(0, ...cues.map(({ end }) => end));
  const perMinute = cues.length / Math.max(minutes, 1);

  if (cues.length === 0) {
    return "no cues";
  }

  if (perMinute < minimumCuesPerMinute || perMinute > maximumCuesPerMinute) {
    return `${cues.length} cues in ${Math.round(minutes)} min`;
  }

  if (lastEnd > durationMs + endSlackMs) {
    return `last cue ends at ${Math.round(lastEnd / 1000)} s, after the ${Math.round(durationMs / 1000)} s video`;
  }

  return lastEnd < durationMs * minimumCoverage
    ? `last cue ends at ${Math.round(lastEnd / 1000)} s of ${Math.round(durationMs / 1000)} s`
    : undefined;
};

const nameTokenShare = 0.6;

const squashed = (text: string) => text.replaceAll(" ", "");

export const namesMatch = (filename: string, name: string) => {
  const file = normalizedLine(filename);
  const tokens = normalizedLine(name).split(" ");
  const fileTokens = new Set(file.split(" "));

  return (
    squashed(file).includes(squashed(normalizedLine(name))) ||
    tokens.filter((token) => fileTokens.has(token)).length >= nameTokenShare * tokens.length
  );
};

export const pickEvenly = <T>(items: T[], count: number) =>
  items.length <= count
    ? items
    : Array.from(
        { length: count },
        (_, index) => items[Math.floor(((index + 0.5) * items.length) / count)] as T,
      );

export const classes = [
  "correct",
  "constant-offset",
  "drift",
  "partial",
  "other",
  "wrong-title",
  "unmeasurable",
  "nothing",
] as const;

export type TVClass = (typeof classes)[number];

const partialOnTimeShare = 0.5;

export const classOf = ({ outcome, truth }: Pick<Run, "outcome" | "truth">): TVClass => {
  if (outcome !== "wrong-timing") {
    return outcome;
  }

  const kind = truth?.shape?.kind;

  if (kind === "offset") {
    return "constant-offset";
  }

  if (kind === "frame-rate" || kind === "drift") {
    return "drift";
  }

  return kind === "steps" || (truth?.onTimeShare ?? 0) >= partialOnTimeShare ? "partial" : "other";
};

export type TVResult = FileResult & {
  show: string;
  source: TVFile["source"];
  season: number;
  episode: number;
};

type TVRun = Run & { result: TVResult };

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;

const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted.length === 0 ? undefined : sorted[Math.floor(sorted.length / 2)];
};

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

const classRow = (label: string, runs: TVRun[]) => {
  const counted = runs.map(classOf);
  const onTime = median(runs.flatMap(({ truth }) => truth?.onTimeShare ?? []));
  const offset = median(runs.flatMap(({ truth }) => truth?.medianMs ?? []));

  return row([
    label,
    runs.length,
    ...classes.map((each) => {
      const count = counted.filter((one) => one === each).length;

      return `${count} (${percent(count, runs.length)})`;
    }),
    onTime === undefined ? "-" : `${Math.round(100 * onTime)}%`,
    offset === undefined ? "-" : `${Math.round(offset)} ms`,
  ]);
};

const servedOf = ({ servedRef, candidates }: Pick<Run, "servedRef" | "candidates">) =>
  candidates.find(({ sourceName, ref }) => sourceName === servedRef?.n && ref === servedRef.r);

const describeServed = (served: Listed | undefined) =>
  served === undefined
    ? "-"
    : `${served.sourceName} ${served.releaseName ?? served.ref}${served.hashMatch === true ? " (hash match)" : ""}`;

const severity = (run: Run) => (classOf(run) === "correct" ? 1 : (run.truth?.onTimeShare ?? 0) - 1);

const header = [
  row(["", "runs", ...classes, "on time (median)", "offset (median)"]),
  row(Array.from({ length: classes.length + 4 }, () => "---")),
];

const groups = (label: string, of: (run: TVRun) => string | undefined, from: TVRun[]) =>
  [...Map.groupBy(from, (run) => of(run) ?? "-")]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => classRow(`${label} ${key}`, members));

const worstRows = (runs: TVRun[]) =>
  runs
    .toSorted(
      (a, b) => severity(a) - severity(b) || (b.truth?.medianMs ?? 0) - (a.truth?.medianMs ?? 0),
    )
    .slice(0, 10)
    .map((run) =>
      row([
        `${run.result.show} S${run.result.season}E${run.result.episode}`,
        run.lang,
        classOf(run),
        run.truth?.onTimeShare === undefined ? "-" : `${Math.round(100 * run.truth.onTimeShare)}%`,
        run.truth?.medianMs === undefined ? "-" : `${Math.round(run.truth.medianMs)} ms`,
        run.truth?.p90Ms === undefined ? "-" : `${Math.round(run.truth.p90Ms)} ms`,
        run.tier ?? "-",
        run.truth?.method ?? "-",
        describeServed(servedOf(run)),
      ]),
    );

const modeSection = (mode: RequestMode, runs: TVRun[]) => {
  const headline = runs.filter(({ result }) => result.source === "embedded");

  return [
    "",
    `## Mode ${mode}: ${modeLabels[mode]}`,
    "",
    ...header,
    ...groups("show", ({ result }) => result.show, runs),
    ...groups("language", ({ lang }) => lang, headline),
    ...tiers.flatMap((tier) => {
      const inTier = headline.filter((run) => run.tier === tier);

      return inTier.length === 0 ? [] : [classRow(`tier ${tier}`, inTier)];
    }),
    ...groups("method", ({ truth }) => truth?.method, headline),
    "",
    "Worst runs:",
    "",
    row(["episode", "lang", "class", "on time", "median", "p90", "tier", "method", "served"]),
    row(Array.from({ length: 9 }, () => "---")),
    ...worstRows(runs),
  ];
};

const modeLabels: Record<RequestMode, string> = {
  hash: "videoHash, videoSize and filename",
  filename: "filename only",
  bare: "the bare episode id",
};

export const tvTables = (results: TVResult[], excluded: Episode[]) => {
  const runs = results.flatMap((result) => result.runs.map((run) => ({ ...run, result })));
  const ofMode = (mode: RequestMode) => runs.filter((run) => (run.mode ?? "hash") === mode);

  return [
    "Headline rows judge episodes against their embedded subtitle track. Sidecar truth is listed apart and never summed in.",
    "",
    ...header,
    ...requestModes.flatMap((mode) => [
      classRow(
        `${mode}: embedded truth`,
        ofMode(mode).filter(({ result }) => result.source === "embedded"),
      ),
      classRow(
        `${mode}: sidecar truth`,
        ofMode(mode).filter(({ result }) => result.source === "sidecar"),
      ),
    ]),
    ...requestModes.flatMap((mode) => modeSection(mode, ofMode(mode))),
    "",
    `Excluded episodes: ${excluded.length}`,
    "",
    ...excluded.map(({ filename, excluded: reason }) => `- ${filename}: ${reason}`),
  ].join("\n");
};
