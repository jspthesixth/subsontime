import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack, transform } from "../timing/test-tracks.ts";
import {
  evaluateSubtitle,
  judgeEnvironmentKey,
  labelledByFile,
  loaderOf,
  mislistedBy,
  outcomeOf,
  pairsOf,
  summaryOf,
  upperBound95,
  type Pair,
  type Row,
} from "./evaluate.ts";

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
      })),
      { id: "broken", titles: ["tt1"] },
    ],
  });
  await writeJSON(join(root, "labels.json"), { entries: labels });
  await writeJSON(join(root, "hard-negatives.json"), hardNegatives);
  await Promise.all([
    ...files.map(({ sha256, speech }) =>
      writeJSON(join(root, "spans", `${sha256}.json`), {
        spans: speech,
        audioMs: (speech.at(-1)?.end ?? 0) + 2000,
      }),
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

const evaluated = async (pairs: Pair[]) => {
  const load = loaderOf(root, labelledByFile(pairs));
  const bySubtitle = Map.groupBy(pairs, (pair) => pair.subtitle);
  const rows = await Promise.all(
    [...bySubtitle.values()].map((group) => evaluateSubtitle(group, load)),
  );

  return rows.flat();
};

const rowFor = (rows: Row[], subtitle: string, file: string) =>
  rows.find((row) => row.subtitle === subtitle && row.file === file);

const row = (fields: Partial<Row>): Row => ({
  subtitle: "s",
  file: "f",
  fileTitle: "tt1",
  truth: "negative",
  decision: "not-clear",
  alignment: "aligned",
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
      ].toSorted(),
    );
    expect(skipped).toEqual({ unlabelled: 1, excluded: 1 });
  });

  it("tags hard negatives by kind and keeps the identity flag", async () => {
    const { pairs } = await pairsOf(root, "train", {});

    expect(pairs.filter((pair) => pair.category !== undefined)).toEqual([
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

describe("evaluateSubtitle", () => {
  it("accepts an own subtitle with the label's timing", async () => {
    const rows = await evaluated((await pairsOf(root, "train", {})).pairs);

    expect(rowFor(rows, "ownA", "a")).toMatchObject({ decision: "accept", offsetMs: -2000 });
    expect(outcomeOf(rowFor(rows, "ownA", "a") ?? row({}), 0)).toBe("accept");
  });

  it("does not accept a subtitle of another film", async () => {
    const rows = await evaluated((await pairsOf(root, "train", {})).pairs);

    expect(rowFor(rows, "ownB", "a")?.decision).not.toBe("accept");
  });

  it("names the labelled subtitle a mislisted negative shares its lines with", async () => {
    const rows = await evaluated((await pairsOf(root, "train", {})).pairs);

    expect(rowFor(rows, "sequelOfA", "a")).toMatchObject({
      decision: "accept",
      mislistedBy: "ownA",
    });
    expect(outcomeOf(rowFor(rows, "sequelOfA", "a") ?? row({}), 0)).toBe("mislisted");
  });
});

describe("mislistedBy", () => {
  const lines = russian(speechA.slice(0, 10), "общая");

  it("flags a subtitle sharing half its unique lines", () => {
    expect(
      mislistedBy(lines, [{ id: "own", cues: [...lines.slice(0, 5), ...russian(speechB, "x")] }]),
    ).toBe("own");
  });

  it("keeps a subtitle sharing less than half", () => {
    expect(mislistedBy(lines, [{ id: "own", cues: lines.slice(0, 4) }])).toBeUndefined();
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
