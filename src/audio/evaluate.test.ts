import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { uniqueLines } from "../subtitles/lines.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import { alignToSpeech, audioDecisionOf, type Heard } from "./align-audio.ts";
import {
  headContrastOf,
  headRule,
  judgeEnvironmentKey,
  outcomeOf,
  pairsOf,
  rowsOf,
  summaryOf,
  upperBound95,
  type Pair,
  type Row,
} from "./evaluate.ts";
import {
  featureKey,
  featurePath,
  featuresFor,
  featuresOf,
  jobsOf,
  labelledByFile,
  loaderOf,
  mislistedBy,
  primitiveVersions,
  readCache,
  type Cache,
  type Computed,
} from "./features.ts";

const speechA = syntheticTrack(1, 400);
const speechB = syntheticTrack(2, 400);
const speechC = syntheticTrack(3, 400);

const russian = (cues: Cue[], prefix: string) =>
  cues.map((cue, index) => ({ ...cue, text: `${prefix} строка номер ${index}` }));

const subtitles: Record<string, { titles: string[]; cues: Cue[] }> = {
  ownA: {
    titles: ["tt1"],
    cues: russian(
      transform(speechA, (time) => time + 2000),
      "первая",
    ),
  },
  untimedA: { titles: ["tt1"], cues: russian(speechA, "вторая") },
  ownB: {
    titles: ["tt2"],
    cues: russian(
      transform(speechB, (time) => time + 5000),
      "третья",
    ),
  },
  sequelOfA: { titles: ["tt9"], cues: russian(speechA, "первая") },
  excludedOnB: { titles: ["tt8"], cues: russian(speechC, "пятая") },
  clipOfA: { titles: ["tt7"], cues: russian(speechA.slice(0, 20), "седьмая") },
  ownC: { titles: ["tt3"], cues: russian(speechC, "шестая") },
};

const files = [
  { sha256: "a", split: "train", imdbId: "tt1", speech: speechA },
  { sha256: "b", split: "train", imdbId: "tt2", speech: speechB },
  { sha256: "c", split: "test", imdbId: "tt3", speech: speechC },
];

const labels = [
  { file: "a", subtitle: "ownA", status: "labelled", cues: "labels/a/ownA.cues.json" },
  { file: "a", subtitle: "untimedA", status: "unlabelled" },
  { file: "b", subtitle: "ownB", status: "labelled", cues: "labels/b/ownB.cues.json" },
  { file: "c", subtitle: "ownC", status: "labelled", cues: "labels/c/ownC.cues.json" },
];

const trusted: Record<string, Cue[]> = {
  "labels/a/ownA.cues.json": speechA,
  "labels/b/ownB.cues.json": speechB,
  "labels/c/ownC.cues.json": speechC,
};

const hardNegatives = {
  pairs: [
    { category: "sequel", subtitle: "sequelOfA", file: "a" },
    { category: "two-part-half", subtitle: "sequelOfA", file: "b", identityUnverified: true },
  ],
  excluded: [{ subtitle: "excludedOnB", file: "b" }],
};

const heardOf = (speech: Cue[]) => ({ spans: speech, audioMs: (speech.at(-1)?.end ?? 0) + 2000 });

let root = "";

const writeJSON = async (path: string, value: unknown) => {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "subsontime-eval-"));

  await writeJSON(join(root, "manifest.json"), {
    files: files.map(({ sha256, split, imdbId }) => ({
      sha256,
      split,
      imdbId,
      spans: `spans/${sha256}.json`,
    })),
    subtitles: [
      ...Object.entries(subtitles).map(([id, { titles }]) => ({
        id,
        titles,
        normalized: `subs/norm/${id}.srt`,
        normalizedSha256: `sha-${id}`,
      })),
      { id: "broken", titles: ["tt1"] },
    ],
  });
  await writeJSON(join(root, "labels.json"), { entries: labels });
  await writeJSON(join(root, "hard-negatives.json"), hardNegatives);
  await Promise.all([
    ...files.map(({ sha256, speech }) =>
      writeJSON(join(root, "spans", `${sha256}.json`), heardOf(speech)),
    ),
    ...Object.entries(subtitles).map(async ([id, { cues }]) => {
      await mkdir(join(root, "subs", "norm"), { recursive: true });
      await writeFile(join(root, "subs", "norm", `${id}.srt`), writeSRT(cues));
    }),
    ...Object.entries(trusted).map(([path, cues]) => writeJSON(join(root, path), cues)),
  ]);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const emptyCache = (): Cache => ({
  rigid: new Map(),
  shifts: new Map(),
  thirds: new Map(),
  mislisting: new Map(),
  timing: new Map(),
  split: new Map(),
});

const cacheOf = (computed: Computed[]) => {
  const cache = emptyCache();

  computed.forEach(({ key, values }) =>
    Object.entries(values).forEach(([primitive, value]) =>
      (cache[primitive as keyof Cache] as Map<string, unknown>).set(key, value),
    ),
  );

  return cache;
};

const computedFor = async (pairs: Pair[], cache = emptyCache()) => {
  const load = loaderOf(root, labelledByFile(pairs));
  const computed = await Promise.all(jobsOf(pairs, cache).map((job) => featuresFor(job, load)));

  return computed.flat();
};

const ruleFeaturesOf = async (heard: Heard, cues: Cue[]) => {
  const load = {
    heard: async () => heard,
    cues: async () => cues,
    trusted: async () => [],
    labelled: async () => [],
  };
  const [computed] = await featuresFor(
    {
      subtitle: "clip",
      targets: [{ key: "k", file: "f", negative: true, needs: ["rigid", "shifts", "thirds"] }],
    },
    load,
  );
  const { rigid, shifts, thirds } = computed?.values ?? {};

  if (rigid === undefined || shifts === undefined || thirds === undefined) {
    throw new Error("Features missing");
  }

  return { rigid, shifts, thirds };
};

const trainPairs = async () => (await pairsOf(root, "train", {})).pairs;

const decidedRows = async () => {
  const pairs = await trainPairs();

  return rowsOf(featuresOf(pairs, cacheOf(await computedFor(pairs))), headRule, 0);
};

const rowFor = (rows: Row[], subtitle: string, file: string) =>
  rows.find((row) => row.subtitle === subtitle && row.file === file);

const row = (fields: Partial<Row>): Row => ({
  subtitle: "s",
  subtitleSha: "sha-s",
  file: "f",
  fileTitle: "tt1",
  truth: "negative",
  decision: "not-clear",
  score: 0.5,
  offsetScore: 0.5,
  speedRatio: 1,
  offsetMs: 0,
  speechShare: 0.5,
  coverage: 0.9,
  ...fields,
});

describe("pairsOf", () => {
  it("pairs every usable subtitle with every file of the split", async () => {
    const { pairs, skipped } = await pairsOf(root, "train", {});

    expect(
      pairs.map(({ subtitle, file, truth }) => `${subtitle} ${file} ${truth}`).toSorted(),
    ).toEqual(
      [
        "ownA a positive",
        "ownA b negative",
        "ownB a negative",
        "ownB b positive",
        "ownC a negative",
        "ownC b negative",
        "sequelOfA a negative",
        "sequelOfA b negative",
        "untimedA b negative",
        "excludedOnB a negative",
        "clipOfA a negative",
        "clipOfA b negative",
      ].toSorted(),
    );
    expect(skipped).toEqual({ unlabelled: 1, excluded: 1 });
  });

  it("tags hard negatives by kind and keeps the identity flag", async () => {
    expect((await trainPairs()).filter((pair) => pair.category !== undefined)).toEqual([
      expect.objectContaining({ subtitle: "sequelOfA", file: "a", category: "sequel" }),
      expect.objectContaining({
        subtitle: "sequelOfA",
        file: "b",
        category: "two-part-half",
        identityUnverified: true,
      }),
    ]);
  });

  it("refuses the test split before reading the cache", async () => {
    await expect(pairsOf(join(root, "missing"), "test", {})).rejects.toThrow(judgeEnvironmentKey);
  });

  it("reads the test split for the judging seat", async () => {
    const { pairs } = await pairsOf(root, "test", { [judgeEnvironmentKey]: "judge" });

    expect(pairs.filter((pair) => pair.truth === "positive")).toEqual([
      expect.objectContaining({ subtitle: "ownC", file: "c" }),
    ]);
  });

  it("refuses an unknown split", async () => {
    await expect(pairsOf(root, "validation", {})).rejects.toThrow("validation");
  });
});

describe("headRule over cached features", () => {
  it("decides every pair with the contrast alignToSpeech gives", async () => {
    const pairs = await trainPairs();
    const rows = rowsOf(featuresOf(pairs, cacheOf(await computedFor(pairs))), headRule, 0);
    const speeches: Record<string, Cue[]> = { a: speechA, b: speechB };
    const expected = await Promise.all(
      rows.map(async ({ subtitle, file }) => {
        const alignment = await alignToSpeech(
          heardOf(speeches[file] ?? []),
          subtitles[subtitle]?.cues ?? [],
        );

        return {
          decision: audioDecisionOf(alignment),
          contrast: alignment.kind === "aligned" ? alignment.contrast : undefined,
        };
      }),
    );

    expect(rows.map(({ decision, contrast }) => ({ decision, contrast }))).toEqual(expected);
  });

  const shortSpeech = syntheticTrack(5, 15);
  const speechMs = speechA.reduce((sum, cue) => sum + cue.end - cue.start, 0);

  it.each([
    ["a clip too short to judge", heardOf(shortSpeech), shortSpeech, "too-short"],
    [
      "implausible speech",
      { spans: speechA, audioMs: speechMs / 0.95 },
      speechA,
      "implausible-speech",
    ],
  ])("gives no contrast for %s as alignToSpeech does", async (_, heard, cues, kind) => {
    expect(await alignToSpeech(heard, cues)).toMatchObject({ kind });
    expect(headContrastOf(await ruleFeaturesOf(heard, cues))).toBeUndefined();
  });

  it("accepts an own subtitle with the label's timing", async () => {
    const owned = rowFor(await decidedRows(), "ownA", "a") ?? row({});

    expect(owned).toMatchObject({
      decision: "accept",
      offsetMs: -2000,
      timingErrorMs: { medianMs: 0, p90Ms: 0 },
    });
    expect(outcomeOf(owned, 0)).toBe("accept");
  });

  it("does not accept a subtitle of another film", async () => {
    expect(rowFor(await decidedRows(), "ownB", "a")?.decision).not.toBe("accept");
  });

  it("names the labelled subtitle a mislisted negative shares its lines with", async () => {
    const mislisted = rowFor(await decidedRows(), "sequelOfA", "a") ?? row({});

    expect(mislisted).toMatchObject({ decision: "accept", mislistedBy: "ownA" });
    expect(outcomeOf(mislisted, 0)).toBe("mislisted");
  });
});

describe("the feature cache", () => {
  it("computes only the primitives a pair lacks and reuses its rigid fit", async () => {
    const pairs = (await trainPairs()).filter((pair) => pair.subtitle === "ownA");
    const cache = cacheOf(await computedFor(pairs));
    const ownOnA = featureKey({ subtitleSha: "sha-ownA", file: "a" });
    const rigid = cache.rigid.get(ownOnA);

    cache.split.delete(ownOnA);

    expect(jobsOf(pairs, cache)).toEqual([
      {
        subtitle: "ownA",
        targets: [expect.objectContaining({ key: ownOnA, needs: ["split"], rigid })],
      },
    ]);
  });

  it("refuses to decide pairs without features", async () => {
    const pairs = await trainPairs();
    const cache = cacheOf(await computedFor(pairs));

    cache.mislisting.clear();

    expect(() => featuresOf(pairs, cache)).toThrow("lack features");
  });

  it("reads a versioned cache file and skips a line cut short", async () => {
    const pairs = (await trainPairs()).filter((pair) => pair.subtitle === "ownA");
    const [first] = await computedFor(pairs);
    const path = featurePath(root, "train", "rigid");

    expect(path).toContain(`rigid-v${primitiveVersions.rigid}.jsonl`);

    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(
      path,
      `${JSON.stringify({ key: first?.key, value: first?.values.rigid })}\n{"key":`,
    );

    expect([...(await readCache(root, "train")).rigid.keys()]).toEqual([first?.key]);
  });
});

const linesOf = (cues: Cue[]) => new Set(uniqueLines(cues).keys());

describe("mislistedBy", () => {
  const lines = russian(speechA.slice(0, 10), "общая");
  const subtitleLines = [...linesOf(lines)];

  it("flags a subtitle sharing half its unique lines", () => {
    expect(
      mislistedBy(subtitleLines, [
        { id: "own", lines: linesOf([...lines.slice(0, 5), ...russian(speechB, "x")]) },
      ]),
    ).toBe("own");
  });

  it("keeps a subtitle sharing less than half", () => {
    expect(
      mislistedBy(subtitleLines, [{ id: "own", lines: linesOf(lines.slice(0, 4)) }]),
    ).toBeUndefined();
  });
});

const diffs = (ms: number) => Array.from({ length: 20 }, () => ms);

describe("outcomeOf", () => {
  it.each([
    [row({ decision: "accept" }), "false-accept"],
    [row({ decision: "accept", mislistedBy: "own" }), "mislisted"],
    [row({ decision: "mismatch" }), "mismatch"],
    [row({ decision: "not-clear" }), "not-clear"],
    [row({ truth: "positive", decision: "accept", startDiffsMs: diffs(250) }), "accept"],
    [row({ truth: "positive", decision: "accept", startDiffsMs: diffs(251) }), "false-accept"],
    [
      row({
        truth: "positive",
        decision: "accept",
        startDiffsMs: [...diffs(0).slice(2), 1001, 1001],
      }),
      "false-accept",
    ],
    [row({ truth: "positive", decision: "mismatch" }), "false-mismatch"],
    [row({ truth: "positive", decision: "not-clear" }), "not-clear"],
  ])("classifies %o as %s", (classified, outcome) => {
    expect(outcomeOf(classified, 0)).toBe(outcome);
  });

  it("removes the ruled offset before judging the timing", () => {
    expect(
      outcomeOf(row({ truth: "positive", decision: "accept", startDiffsMs: diffs(600) }), 500),
    ).toBe("accept");
  });
});

describe("upperBound95", () => {
  it("is 1 - 0.05^(1/n) with no failures", () => {
    expect(upperBound95(0, 3000)).toBeCloseTo(1 - 0.05 ** (1 / 3000), 9);
  });

  it("is the exact one-sided Clopper-Pearson bound with failures", () => {
    expect(upperBound95(1, 10)).toBeCloseTo(0.3942, 4);
  });
});

describe("summaryOf", () => {
  const rows = [
    row({ decision: "accept", category: "sequel" }),
    row({ decision: "mismatch", category: "sequel" }),
    row({ decision: "not-clear" }),
    row({ decision: "accept", mislistedBy: "own", subtitle: "m", file: "x" }),
    row({ decision: "accept", identityUnverified: true }),
    row({ truth: "positive", decision: "accept", startDiffsMs: [0] }),
    row({ truth: "positive", decision: "mismatch" }),
  ];

  it("bounds the false accepts over the counted pairs", () => {
    expect(summaryOf(rows, 0)).toMatchObject({
      pairs: 5,
      falseAccepts: { negatives: 1, positives: 0 },
      bound: { failures: 1, pairs: 5, upper: upperBound95(1, 5) },
      negativesBound: { failures: 1, pairs: 3, upper: upperBound95(1, 3) },
      falseMismatches: 1,
      recall: { accepts: 1, positives: 2 },
    });
  });

  it("breaks out hard negatives, unverified identities and mislisted pairs", () => {
    expect(summaryOf(rows, 0)).toMatchObject({
      hard: { sequel: { pairs: 2, "false-accept": 1, mismatch: 1 } },
      identityUnverified: { pairs: 1, "false-accept": 1 },
      mislisted: ["m on x: shares unique lines with own"],
    });
  });
});
