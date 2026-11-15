import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { uniqueLines } from "../subtitles/lines.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { shiftOf } from "../timing/retime.ts";
import {
  alignToSpeech,
  audioDecisionOf,
  speechShareOf,
  windowOf,
  type AudioAlignment,
  type AudioDecision,
  type Heard,
} from "./align-audio.ts";

export const judgeEnvironmentKey = "SUBSONTIME_EVAL_SPLIT_TEST";
export const labelOffsetMs = 0;
export const correctTiming = { medianMs: 250, p90Ms: 1000 };
export const mislistedShare = 0.5;

const CueSchema = v.object({ start: v.number(), end: v.number(), text: v.optional(v.string(), "") });

const ManifestSchema = v.object({
  files: v.array(
    v.object({ sha256: v.string(), split: v.string(), imdbId: v.string(), spans: v.string() }),
  ),
  subtitles: v.array(
    v.object({ id: v.string(), titles: v.array(v.string()), normalized: v.optional(v.string()) }),
  ),
});

const LabelsSchema = v.object({
  entries: v.array(
    v.object({
      file: v.string(),
      subtitle: v.string(),
      status: v.string(),
      cues: v.optional(v.string()),
    }),
  ),
});

const HardNegativesSchema = v.object({
  pairs: v.array(
    v.object({
      category: v.string(),
      subtitle: v.string(),
      file: v.string(),
      identityUnverified: v.optional(v.boolean()),
    }),
  ),
  excluded: v.array(v.object({ subtitle: v.string(), file: v.string() })),
});

const HeardSchema = v.object({ spans: v.array(CueSchema), audioMs: v.number() });

export type Pair = {
  subtitle: string;
  file: string;
  fileTitle: string;
  truth: "positive" | "negative";
  trusted?: string;
  category?: string;
  identityUnverified?: boolean;
};

export type Row = Pair & {
  decision: AudioDecision;
  alignment: AudioAlignment["kind"];
  speechShare: number;
  coverage: number;
  contrast?: number;
  score?: number;
  offsetScore?: number;
  speedRatio?: number;
  offsetMs?: number;
  startDiffsMs?: number[];
  mislistedBy?: string;
};

export type Outcome =
  | "accept"
  | "false-accept"
  | "false-mismatch"
  | "mismatch"
  | "not-clear"
  | "mislisted";

type Labelled = { id: string; cues: Cue[] };

type Loader = {
  heard: (file: string) => Promise<Heard>;
  cues: (subtitle: string) => Promise<Cue[]>;
  trusted: (path: string) => Promise<Cue[]>;
  labelled: (file: string) => Promise<Labelled[]>;
};

const readJSON = async <T extends v.GenericSchema>(path: string, schema: T) =>
  v.parse(schema, JSON.parse(await readFile(path, "utf8")));

const splitOf = (name: string, env: NodeJS.ProcessEnv) => {
  if (name === "test" && env[judgeEnvironmentKey] !== "judge") {
    throw new Error(`The test split is for the judging seat only (${judgeEnvironmentKey}=judge).`);
  }

  if (name !== "train" && name !== "test") {
    throw new Error(`Unknown split ${name}: use train or test.`);
  }

  return name;
};

const pairKey = (subtitle: string, file: string) => `${subtitle} ${file}`;

export const pairsOf = async (root: string, name: string, env: NodeJS.ProcessEnv) => {
  const split = splitOf(name, env);
  const manifest = await readJSON(join(root, "manifest.json"), ManifestSchema);
  const { entries } = await readJSON(join(root, "labels.json"), LabelsSchema);
  const hard = await readJSON(join(root, "hard-negatives.json"), HardNegativesSchema);

  const labels = new Map(entries.map((label) => [pairKey(label.subtitle, label.file), label]));
  const hardPairs = new Map(hard.pairs.map((pair) => [pairKey(pair.subtitle, pair.file), pair]));
  const excluded = new Set(hard.excluded.map((pair) => pairKey(pair.subtitle, pair.file)));
  const usable = manifest.subtitles.filter((subtitle) => subtitle.normalized !== undefined);

  const all = manifest.files
    .filter((file) => file.split === split)
    .flatMap((file) =>
      usable.map((subtitle) => ({
        subtitle: subtitle.id,
        file: file.sha256,
        fileTitle: file.imdbId,
        own: subtitle.titles.includes(file.imdbId),
        key: pairKey(subtitle.id, file.sha256),
      })),
    );
  const candidates = all.filter(({ key }) => !excluded.has(key));

  const pairs = candidates.flatMap(({ own, key, ...pair }): Pair[] => {
    const label = labels.get(key);
    const hardPair = hardPairs.get(key);

    if (own) {
      return label?.status === "labelled" && label.cues !== undefined
        ? [{ ...pair, truth: "positive", trusted: label.cues }]
        : [];
    }

    return [
      {
        ...pair,
        truth: "negative",
        ...(hardPair === undefined ? {} : { category: hardPair.category }),
        ...(hardPair?.identityUnverified === true ? { identityUnverified: true } : {}),
      },
    ];
  });

  return {
    pairs,
    skipped: {
      unlabelled:
        candidates.filter(({ own }) => own).length -
        pairs.filter((pair) => pair.truth === "positive").length,
      excluded: all.length - candidates.length,
    },
  };
};

export const labelledByFile = (pairs: Pair[]) =>
  new Map(
    [
      ...Map.groupBy(
        pairs.filter((pair) => pair.truth === "positive"),
        (pair) => pair.file,
      ),
    ].map(([file, positives]) => [file, positives.map((pair) => pair.subtitle)]),
  );

const memoized = <T>(load: (key: string) => Promise<T>) => {
  const loaded = new Map<string, Promise<T>>();

  return (key: string) => {
    const known = loaded.get(key) ?? load(key);

    loaded.set(key, known);

    return known;
  };
};

export const loaderOf = (root: string, labelled: Map<string, string[]>): Loader => {
  const cues = async (subtitle: string) =>
    parseSubtitle(decodeSubtitle(await readFile(join(root, "subs", "norm", `${subtitle}.srt`))));
  const labelledCues = memoized(async (subtitle) => ({ id: subtitle, cues: await cues(subtitle) }));

  return {
    heard: memoized((file) => readJSON(join(root, "spans", `${file}.json`), HeardSchema)),
    cues,
    trusted: async (path) => readJSON(join(root, path), v.array(CueSchema)),
    labelled: async (file) => Promise.all((labelled.get(file) ?? []).map(labelledCues)),
  };
};

const quantile = (values: number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Infinity;
};

const startDiffsOf = (aligned: Cue[], trusted: Cue[]) => {
  if (aligned.length !== trusted.length) {
    throw new Error(`${aligned.length} cues against ${trusted.length} trusted cues`);
  }

  return aligned.map((cue, index) => Math.round(cue.start - (trusted[index]?.start ?? 0)));
};

export const mislistedBy = (cues: Cue[], labelled: Labelled[]) => {
  const lines = [...uniqueLines(cues).keys()];

  return labelled.find(({ cues: own }) => {
    const ownLines = uniqueLines(own);

    return (
      lines.length > 0 &&
      lines.filter((line) => ownLines.has(line)).length / lines.length >= mislistedShare
    );
  })?.id;
};

const measured = async (pair: Pair, heard: Heard, cues: Cue[], load: Loader): Promise<Row> => {
  const alignment = await alignToSpeech(heard, cues);
  const decision = audioDecisionOf(alignment);
  const { start, end } = windowOf(cues);
  const row: Row = {
    ...pair,
    decision,
    alignment: alignment.kind,
    speechShare: speechShareOf(heard),
    coverage: (end - start) / Math.max(heard.audioMs, 1),
  };

  if (alignment.kind !== "aligned") {
    return row;
  }

  const { contrast, score, offsetScore, speedRatio, cues: aligned } = alignment;
  const mislisted =
    pair.truth === "negative" && decision === "accept"
      ? mislistedBy(cues, await load.labelled(pair.file))
      : undefined;

  return {
    ...row,
    contrast,
    score,
    offsetScore,
    speedRatio,
    offsetMs: shiftOf(cues, aligned, speedRatio).offsetMs,
    ...(pair.trusted === undefined
      ? {}
      : { startDiffsMs: startDiffsOf(aligned, await load.trusted(pair.trusted)) }),
    ...(mislisted === undefined ? {} : { mislistedBy: mislisted }),
  };
};

export const evaluateSubtitle = async (pairs: Pair[], load: Loader) => {
  const [first] = pairs;

  if (first === undefined) {
    return [];
  }

  const cues = await load.cues(first.subtitle);

  return Promise.all(
    pairs.map(async (pair) => measured(pair, await load.heard(pair.file), cues, load)),
  );
};

const isTimed = (diffs: number[], offsetMs: number) => {
  const errors = diffs.map((diff) => Math.abs(diff - offsetMs));

  return (
    quantile(errors, 0.5) <= correctTiming.medianMs && quantile(errors, 0.9) <= correctTiming.p90Ms
  );
};

export const outcomeOf = (row: Row, offsetMs: number): Outcome => {
  if (row.decision === "not-clear") {
    return "not-clear";
  }

  if (row.truth === "negative" && row.decision === "mismatch") {
    return "mismatch";
  }

  if (row.truth === "negative") {
    return row.mislistedBy === undefined ? "false-accept" : "mislisted";
  }

  if (row.decision === "mismatch") {
    return "false-mismatch";
  }

  return isTimed(row.startDiffsMs ?? [], offsetMs) ? "accept" : "false-accept";
};

export const upperBound95 = (failures: number, pairs: number) => {
  if (pairs === 0) {
    return 1;
  }

  const atMost = (p: number) => {
    let logTerm = pairs * Math.log1p(-p);
    let logSum = logTerm;

    for (let k = 0; k < failures; k += 1) {
      logTerm += Math.log((pairs - k) / (k + 1)) + Math.log(p / (1 - p));
      logSum = Math.max(logSum, logTerm) + Math.log1p(Math.exp(-Math.abs(logSum - logTerm)));
    }

    return Math.exp(logSum);
  };

  let low = failures / pairs;
  let high = 1;

  for (let step = 0; step < 100; step += 1) {
    const middle = (low + high) / 2;

    if (atMost(middle) > 0.05) {
      low = middle;
    } else {
      high = middle;
    }
  }

  return high;
};

type Classified = { row: Row; outcome: Outcome };

const tallyOf = (classified: Classified[]) => ({
  pairs: classified.length,
  ...Object.fromEntries(
    [...Map.groupBy(classified, ({ outcome }) => outcome)].map(([outcome, group]) => [
      outcome,
      group.length,
    ]),
  ),
});

const boundOf = (classified: Classified[]) => {
  const failures = classified.filter(({ outcome }) => outcome === "false-accept").length;

  return { failures, pairs: classified.length, upper: upperBound95(failures, classified.length) };
};

const countOf = (classified: Classified[], outcome: Outcome) =>
  classified.filter((entry) => entry.outcome === outcome).length;

export const summaryOf = (rows: Row[], offsetMs: number) => {
  const classified = rows.map((row) => ({ row, outcome: outcomeOf(row, offsetMs) }));
  const unverified = classified.filter(({ row }) => row.identityUnverified === true);
  const counted = classified.filter(
    ({ row, outcome }) => row.identityUnverified !== true && outcome !== "mislisted",
  );
  const negatives = counted.filter(({ row }) => row.truth === "negative");
  const positives = counted.filter(({ row }) => row.truth === "positive");

  return {
    offsetMs,
    pairs: counted.length,
    falseAccepts: {
      negatives: countOf(negatives, "false-accept"),
      positives: countOf(positives, "false-accept"),
    },
    bound: boundOf(counted),
    negativesBound: boundOf(negatives),
    falseMismatches: countOf(positives, "false-mismatch"),
    recall: {
      accepts: countOf(positives, "accept"),
      positives: positives.length,
      share: countOf(positives, "accept") / Math.max(positives.length, 1),
    },
    negatives: tallyOf(negatives),
    positives: tallyOf(positives),
    hard: Object.fromEntries(
      [...Map.groupBy(negatives, ({ row }) => row.category ?? "")]
        .filter(([category]) => category !== "")
        .map(([category, group]) => [category, tallyOf(group)]),
    ),
    identityUnverified: tallyOf(unverified),
    mislisted: classified
      .filter(({ outcome }) => outcome === "mislisted")
      .map(
        ({ row }) => `${row.subtitle} on ${row.file}: shares unique lines with ${row.mislistedBy}`,
      ),
  };
};

const spreadOf = (values: number[]) => ({
  pairs: values.length,
  p10: quantile(values, 0.1),
  p25: quantile(values, 0.25),
  median: quantile(values, 0.5),
  p75: quantile(values, 0.75),
  p90: quantile(values, 0.9),
});

export const offsetsOf = (rows: Row[]) => {
  const signed = rows.flatMap((row) =>
    row.startDiffsMs === undefined || row.identityUnverified === true
      ? []
      : [
          {
            title: row.fileTitle,
            accepted: row.decision === "accept",
            ms: quantile(row.startDiffsMs, 0.5),
          },
        ],
  );
  const accepted = signed.filter((entry) => entry.accepted);

  return {
    all: spreadOf(signed.map((entry) => entry.ms)),
    accepted: spreadOf(accepted.map((entry) => entry.ms)),
    acceptedByTitle: Object.fromEntries(
      [...Map.groupBy(accepted, (entry) => entry.title)].map(([title, group]) => [
        title,
        spreadOf(group.map((entry) => entry.ms)),
      ]),
    ),
  };
};
