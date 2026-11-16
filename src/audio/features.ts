import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { uniqueLines } from "../subtitles/lines.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { alignOffset, bestScoredRatio, offsetCues, scoreOf, speedRatios } from "../timing/alass.ts";
import {
  speechShareOf,
  windowFitsOf,
  windowOf,
  withinSpeech,
  wrongShiftsMs,
  type Heard,
} from "./align-audio.ts";
import type { Pair } from "./evaluate.ts";

export const shiftGridMs = [
  ...new Set([
    ...wrongShiftsMs,
    ...Array.from({ length: 19 }, (_, index) => (index + 2) * 15_000).flatMap((ms) => [-ms, ms]),
  ]),
].toSorted((a, b) => a - b);

export const CueSchema = v.object({
  start: v.number(),
  end: v.number(),
  text: v.optional(v.string(), ""),
});

const HeardSchema = v.object({ spans: v.array(CueSchema), audioMs: v.number() });

const WindowSchema = v.object({ start: v.number(), end: v.number() });

const FitSchema = v.object({
  speedRatio: v.number(),
  offsetMs: v.number(),
  withinScore: v.number(),
  score: v.number(),
});

export const primitiveSchemas = {
  rigid: v.object({
    audioMs: v.number(),
    speechSpans: v.number(),
    speechShare: v.number(),
    window: WindowSchema,
    speechWindow: WindowSchema,
    fits: v.array(FitSchema),
  }),
  shifts: v.object({ scores: v.array(v.number()) }),
  windows: v.object({ cues: v.number(), windowOffsetsMs: v.array(v.nullable(v.number())) }),
  mislisting: v.object({ by: v.nullable(v.string()) }),
  timing: v.object({ diffsMs: v.array(v.number()) }),
};

export const primitiveVersions = {
  rigid: 1,
  shifts: 1,
  windows: 3,
  mislisting: 1,
  timing: 1,
} satisfies Record<keyof typeof primitiveSchemas, number>;

export type Primitive = keyof typeof primitiveSchemas;

type Values = { [P in Primitive]: v.InferOutput<(typeof primitiveSchemas)[P]> };

export type Rigid = Values["rigid"];

export type Cache = { [P in Primitive]: Map<string, Values[P]> };

export type Features = Pair & Pick<Values, "rigid" | "shifts" | "windows"> & Partial<Values>;

export const primitives = Object.keys(primitiveVersions) as Primitive[];

export const judgeEnvironmentKey = "SUBSONTIME_EVAL_SPLIT_TEST";

export const splitOf = (name: string, env: NodeJS.ProcessEnv) => {
  if (name === "test" && env[judgeEnvironmentKey] !== "judge") {
    throw new Error(`The test split is for the judging seat only (${judgeEnvironmentKey}=judge).`);
  }

  if (name !== "train" && name !== "test") {
    throw new Error(`Unknown split ${name}: use train or test.`);
  }

  return name;
};

type Target = { key: string; file: string; trusted?: string; negative: boolean };

const appliesTo: Record<Primitive, (target: Target) => boolean> = {
  rigid: () => true,
  shifts: () => true,
  windows: () => true,
  mislisting: (target) => target.negative,
  timing: (target) => target.trusted !== undefined,
};

export type Job = {
  subtitle: string;
  targets: (Target & { needs: Primitive[]; rigid?: Rigid })[];
};

export type Computed = { key: string; values: Partial<Values> };

type Labelled = { id: string; lines: Set<string> };

export type Loader = {
  heard: (file: string) => Promise<Heard>;
  cues: (subtitle: string) => Promise<Cue[]>;
  trusted: (path: string) => Promise<Cue[]>;
  labelled: (file: string) => Promise<Labelled[]>;
};

export const readJSON = async <T extends v.GenericSchema>(path: string, schema: T) =>
  v.parse(schema, JSON.parse(await readFile(path, "utf8")));

export const featureKey = (pair: Pick<Pair, "subtitleSha" | "file">) =>
  `${pair.subtitleSha} ${pair.file}`;

export const featurePath = (
  root: string,
  split: string,
  primitive: Primitive,
  env: NodeJS.ProcessEnv,
) =>
  join(
    root,
    "features",
    splitOf(split, env),
    `${primitive}-v${primitiveVersions[primitive]}.jsonl`,
  );

export const openIfPresent = async (path: string, flags = "r") => {
  try {
    return await open(path, flags);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }

    throw error;
  }
};

const tailChunkBytes = 65_536;

export const trimCutLine = async (path: string) => {
  const handle = await openIfPresent(path, "r+");

  if (handle === undefined) {
    return;
  }

  try {
    const { size } = await handle.stat();

    let end = size;

    while (end > 0) {
      const start = Math.max(end - tailChunkBytes, 0);
      const { buffer, bytesRead } = await handle.read(
        Buffer.alloc(end - start),
        0,
        end - start,
        start,
      );

      const newline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);

      if (newline >= 0) {
        await handle.truncate(start + newline + 1);

        return;
      }

      end = start;
    }

    await handle.truncate(0);
  } finally {
    await handle.close();
  }
};

const CacheLineSchema = v.object({
  key: v.string(),
  version: v.number(),
  sha: v.string(),
  value: v.unknown(),
});

const memoized = <T>(load: (key: string) => Promise<T>) => {
  const loaded = new Map<string, Promise<T>>();

  return (key: string) => {
    const known = loaded.get(key) ?? load(key);

    loaded.set(key, known);

    return known;
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

export const loaderOf = (root: string, labelled: Map<string, string[]>): Loader => {
  const cues = async (subtitle: string) =>
    parseSubtitle(decodeSubtitle(await readFile(join(root, "subs", "norm", `${subtitle}.srt`))));
  const linesOf = memoized(async (subtitle) => ({
    id: subtitle,
    lines: new Set(uniqueLines(await cues(subtitle)).keys()),
  }));

  return {
    heard: memoized((file) => readJSON(join(root, "spans", `${file}.json`), HeardSchema)),
    cues,
    trusted: async (path) => readJSON(join(root, path), v.array(CueSchema)),
    labelled: async (file) => Promise.all((labelled.get(file) ?? []).map(linesOf)),
  };
};

const cacheLinesOf = async function* (path: string) {
  const handle = await openIfPresent(path);

  if (handle === undefined) {
    return;
  }

  try {
    let unread: string | undefined;

    for await (const line of handle.readLines()) {
      if (unread !== undefined) {
        throw new Error(`Unreadable line in ${path}: ${unread.slice(0, 80)}`);
      }

      const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), CacheLineSchema), line);

      if (parsed.success) {
        yield parsed.output;
      } else {
        unread = line;
      }
    }
  } finally {
    await handle.close();
  }
};

export const readCache = async (
  root: string,
  split: string,
  env: NodeJS.ProcessEnv,
  sha: string,
): Promise<Cache> => {
  const judged = splitOf(split, env) === "test";

  const read = async <P extends Primitive>(primitive: P) => {
    const values: Cache[P] = new Map();

    for await (const line of cacheLinesOf(featurePath(root, split, primitive, env))) {
      if (judged && (line.sha !== sha || sha.endsWith("-dirty"))) {
        throw new Error(`The ${primitive} cache was computed at ${line.sha}, not at ${sha}.`);
      }

      values.set(line.key, v.parse(primitiveSchemas[primitive], line.value) as never);
    }

    return values;
  };

  return {
    rigid: await read("rigid"),
    shifts: await read("shifts"),
    windows: await read("windows"),
    mislisting: await read("mislisting"),
    timing: await read("timing"),
  };
};

export const jobsOf = (pairs: Pair[], cache: Cache): Job[] => {
  const planned = [...Map.groupBy(pairs, featureKey)].flatMap(([key, group]) => {
    const [first] = group;

    if (first === undefined) {
      return [];
    }

    const trusted = group.find((pair) => pair.trusted !== undefined)?.trusted;
    const rigid = cache.rigid.get(key);
    const target: Target = {
      key,
      file: first.file,
      ...(trusted === undefined ? {} : { trusted }),
      negative: group.some((pair) => pair.truth === "negative"),
    };
    const needs = primitives.filter(
      (primitive) => appliesTo[primitive](target) && !cache[primitive].has(key),
    );

    return needs.length === 0
      ? []
      : [{ first, target: { ...target, needs, ...(rigid === undefined ? {} : { rigid }) } }];
  });

  return [...Map.groupBy(planned, ({ first }) => first.subtitleSha).values()].map((group) => ({
    subtitle: group[0]?.first.subtitle ?? "",
    targets: group.map(({ target }) => target),
  }));
};

export const bestFit = (rigid: Rigid) => {
  const speedRatio = bestScoredRatio(
    rigid.fits.map((fit) => ({ speedRatio: fit.speedRatio, score: fit.withinScore })),
  );
  const fit = rigid.fits.find((candidate) => candidate.speedRatio === speedRatio);

  if (fit === undefined) {
    throw new Error("No rigid fit");
  }

  return fit;
};

export const startDiffsOf = (aligned: Cue[], trusted: Cue[]) => {
  if (aligned.length !== trusted.length) {
    throw new Error(`${aligned.length} cues against ${trusted.length} trusted cues`);
  }

  return aligned.map((cue, index) => Math.round(cue.start - (trusted[index]?.start ?? 0)));
};

export const mislistedBy = (lines: string[], labelled: Labelled[]) =>
  labelled.find(
    ({ lines: own }) =>
      lines.length > 0 && lines.filter((line) => own.has(line)).length / lines.length >= 0.5,
  )?.id;

const rigidOf = (heard: Heard, cues: Cue[]): Rigid => ({
  audioMs: heard.audioMs,
  speechSpans: heard.spans.length,
  speechShare: speechShareOf(heard),
  window: windowOf(cues),
  speechWindow: windowOf(heard.spans),
  fits: speedRatios.map((speedRatio) => {
    const fit = alignOffset(heard.spans, cues, { ...withinSpeech, speedRatio });

    return {
      speedRatio,
      offsetMs: fit.offsetMs,
      withinScore: fit.score,
      score: scoreOf(heard.spans, fit.cues),
    };
  }),
});

export const featuresFor = async (job: Job, load: Loader): Promise<Computed[]> => {
  const cues = await load.cues(job.subtitle);
  const lines = [...uniqueLines(cues).keys()];

  return Promise.all(
    job.targets.map(async (target) => {
      const heard = await load.heard(target.file);
      const rigid = target.rigid ?? rigidOf(heard, cues);
      const { speedRatio, offsetMs } = bestFit(rigid);

      const rigidCues = offsetCues(cues, speedRatio, offsetMs);
      const trusted = async () => {
        if (target.trusted === undefined) {
          throw new Error(`No trusted cues for ${target.key}`);
        }

        return load.trusted(target.trusted);
      };
      const compute: { [P in Primitive]: () => Promise<Values[P]> | Values[P] } = {
        rigid: () => rigid,
        shifts: () => ({
          scores: shiftGridMs.map((shift) => scoreOf(heard.spans, offsetCues(rigidCues, 1, shift))),
        }),
        windows: () => windowFitsOf(heard.spans, cues, speedRatio, offsetMs),
        mislisting: async () => ({
          by: mislistedBy(lines, await load.labelled(target.file)) ?? null,
        }),
        timing: async () => ({ diffsMs: startDiffsOf(rigidCues, await trusted()) }),
      };
      const values = await Promise.all(
        target.needs.map(async (primitive) => [primitive, await compute[primitive]()] as const),
      );

      return { key: target.key, values: Object.fromEntries(values) };
    }),
  );
};

export const featuresOf = (pairs: Pair[], cache: Cache): Features[] => {
  const features = pairs.flatMap((pair) => {
    const key = featureKey(pair);
    const rigid = cache.rigid.get(key);
    const shifts = cache.shifts.get(key);
    const windows = cache.windows.get(key);
    const mislisting = cache.mislisting.get(key);
    const timing = cache.timing.get(key);
    const complete = pair.truth === "negative" ? mislisting !== undefined : timing !== undefined;

    if (rigid === undefined || shifts === undefined || windows === undefined || !complete) {
      return [];
    }

    return [
      {
        ...pair,
        rigid,
        shifts,
        windows,
        ...(mislisting === undefined ? {} : { mislisting }),
        ...(timing === undefined ? {} : { timing }),
      },
    ];
  });

  if (features.length < pairs.length) {
    throw new Error(
      `${pairs.length - features.length} pairs lack features: run the features stage first.`,
    );
  }

  return features;
};
