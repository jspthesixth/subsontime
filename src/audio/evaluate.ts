import { join } from "node:path";
import * as v from "valibot";
import {
  contrastFrom,
  decisionOf,
  isPlausibleSpeech,
  prefersSplit,
  usableShifts,
  type AudioDecision,
} from "./align-audio.ts";
import { bestFit, readJSON, shiftGridMs, type Features } from "./features.ts";

export const judgeEnvironmentKey = "SUBSONTIME_EVAL_SPLIT_TEST";
export const labelOffsetMs = 0;
export const correctTiming = { medianMs: 250, p90Ms: 1000 };

const ManifestSchema = v.object({
  files: v.array(
    v.object({ sha256: v.string(), split: v.string(), imdbId: v.string(), spans: v.string() }),
  ),
  subtitles: v.array(
    v.object({
      id: v.string(),
      titles: v.array(v.string()),
      normalized: v.optional(v.string()),
      normalizedSha256: v.optional(v.string()),
    }),
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

export type Pair = {
  subtitle: string;
  subtitleSha: string;
  file: string;
  fileTitle: string;
  truth: "positive" | "negative";
  trusted?: string;
  category?: string;
  identityUnverified?: boolean;
};

export type Rule = (features: Features) => AudioDecision;

export type Row = Pair & {
  decision: AudioDecision;
  contrast?: number;
  score: number;
  offsetScore: number;
  speedRatio: number;
  offsetMs: number;
  speechShare: number;
  coverage: number;
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
  const usable = manifest.subtitles.flatMap(({ normalized, normalizedSha256, ...subtitle }) =>
    normalized === undefined || normalizedSha256 === undefined
      ? []
      : [{ ...subtitle, sha: normalizedSha256 }],
  );

  const all = manifest.files
    .filter((file) => file.split === split)
    .flatMap((file) =>
      usable.map((subtitle) => ({
        subtitle: subtitle.id,
        subtitleSha: subtitle.sha,
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

const quantile = (values: number[], q: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? Infinity;
};

const shiftScoreOf = (features: Features, shift: number) => {
  const score = features.shifts.scores[shiftGridMs.indexOf(shift)];

  if (score === undefined) {
    throw new Error(`No score at ${shift} ms`);
  }

  return score;
};

export const headContrastOf = (features: Features) => {
  const { rigid } = features;
  const { speedRatio, offsetMs, score } = bestFit(rigid);

  if (rigid.speechSpans === 0 || !isPlausibleSpeech(rigid.speechShare)) {
    return undefined;
  }

  const window = {
    start: Math.round(rigid.window.start / speedRatio + offsetMs),
    end: Math.round(rigid.window.end / speedRatio + offsetMs),
  };

  return contrastFrom(score, usableShifts(window, rigid.speechWindow), (shift) =>
    shiftScoreOf(features, shift),
  );
};

export const headRule: Rule = (features) => decisionOf(headContrastOf(features));

export const rowsOf = (features: Features[], rule: Rule): Row[] =>
  features.map(({ rigid, shifts, thirds, mislisting, timing, split, ...pair }) => {
    const fit = bestFit(rigid);
    const decision = rule({ ...pair, rigid, shifts, thirds });
    const refined =
      decision === "accept" &&
      split !== undefined &&
      prefersSplit(fit.withinScore, split.withinScore)
        ? split
        : undefined;
    const startDiffsMs = refined?.diffsMs ?? timing?.diffsMs;
    const contrast = headContrastOf({ ...pair, rigid, shifts, thirds });
    const mislistedBy = pair.truth === "negative" && decision === "accept" ? mislisting?.by : null;

    return {
      ...pair,
      decision,
      ...(contrast === undefined ? {} : { contrast }),
      score: fit.score,
      offsetScore: fit.withinScore,
      speedRatio: fit.speedRatio,
      offsetMs: refined?.offsetMs ?? fit.offsetMs,
      speechShare: rigid.speechShare,
      coverage: (rigid.window.end - rigid.window.start) / Math.max(rigid.audioMs, 1),
      ...(startDiffsMs === undefined ? {} : { startDiffsMs }),
      ...(mislistedBy === null || mislistedBy === undefined ? {} : { mislistedBy }),
    };
  });

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
