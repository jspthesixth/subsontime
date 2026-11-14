import { describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatioFromFPS, speedRatios } from "./alass.ts";

type SourcedCue = Cue & { origin: number; unchanged: boolean };

const seededRandom = (seed: number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const syntheticTrack = (seed: number, count: number): Cue[] => {
  const random = seededRandom(seed);
  const between = (min: number, max: number) => Math.round(min + random() * (max - min));

  return Array.from({ length: count }).reduce<Cue[]>((cues, _, index) => {
    const start = (cues.at(-1)?.end ?? 0) + between(300, 3000);

    return [...cues, { start, end: start + between(1000, 4000), text: `Line ${index}` }];
  }, []);
};

const editFor = (roll: number) => {
  if (roll < 0.15) {
    return "drop";
  }

  if (roll < 0.25) {
    return "split";
  }

  if (roll < 0.35) {
    return "merge";
  }

  return "keep";
};

const resegment = (cues: Cue[], seed: number): SourcedCue[] => {
  const random = seededRandom(seed);
  const edits = cues.map(() => editFor(random()));
  const jitter = (time: number) => time + Math.round((random() * 2 - 1) * 200);

  return cues
    .flatMap((cue, index): SourcedCue[] => {
      const next = cues[index + 1];
      const middle = Math.round((cue.start + cue.end) / 2);

      if (edits[index - 1] === "merge" || edits[index] === "drop") {
        return [];
      }

      if (edits[index] === "merge" && next !== undefined) {
        return [{ ...cue, end: next.end, origin: index, unchanged: false }];
      }

      if (edits[index] === "split") {
        return [
          { ...cue, end: middle, origin: index, unchanged: false },
          { ...cue, start: middle, origin: index, unchanged: false },
        ];
      }

      return [{ ...cue, origin: index, unchanged: true }];
    })
    .map((cue) => ({ ...cue, start: jitter(cue.start), end: jitter(cue.end) }));
};

const reference = syntheticTrack(1, 200);
const related = resegment(reference, 7);

const transform = <T extends Cue>(cues: T[], move: (time: number, cue: T) => number) =>
  cues.map((cue) => ({ ...cue, start: move(cue.start, cue), end: move(cue.end, cue) }));

const unchangedError = (aligned: Cue[]) =>
  Math.max(
    ...related.flatMap((cue, index) => {
      const source = reference[cue.origin];
      const result = aligned[index];

      if (!cue.unchanged || source === undefined || result === undefined) {
        return [];
      }

      return [Math.abs(result.start - source.start), Math.abs(result.end - source.end)];
    }),
  );

const relatedError = (aligned: Cue[]) =>
  Math.max(
    ...related.flatMap((cue, index) => {
      const result = aligned[index];

      if (!cue.unchanged || result === undefined) {
        return [];
      }

      return [Math.abs(result.start - cue.start), Math.abs(result.end - cue.end)];
    }),
  );

const timed = async (run: () => unknown) => {
  const started = performance.now();

  await run();

  return performance.now() - started;
};

const fastestOfThree = async (run: () => unknown) =>
  Math.min(await timed(run), await timed(run), await timed(run));

describe("alignCues", () => {
  it("removes a constant offset from a re-segmented subtitle", async () => {
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time) => time + 2000),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns a 25 fps subtitle to a 23.976 fps reference", async () => {
    const speedRatio = speedRatioFromFPS(25, 23.976);
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time) => (time * 25) / 23.976),
      { speedRatio },
    );

    expect(speedRatio).toBeCloseTo(1.042709, 6);
    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("closes a gap cut into the middle", async () => {
    const { cues, score } = await alignCues(
      reference,
      transform(related, (time, cue) => (cue.origin >= 100 ? time + 90_000 : time)),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("scores an unrelated track low", async () => {
    const { score } = await alignCues(reference, syntheticTrack(2, 200));

    expect(score).toBeLessThan(0.3);
  });

  it("keeps the text of every cue", async () => {
    const { cues } = await alignCues(reference, related);

    expect(cues.map((cue) => cue.text)).toEqual(related.map((cue) => cue.text));
  });

  it("aligns two 1500-cue tracks in under 1500 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignCues(long, shifted))).toBeLessThan(1500);
  }, 10_000);
});

describe("alignOffset", () => {
  it("removes a constant offset with one delta", () => {
    const { cues, score } = alignOffset(
      reference,
      transform(related, (time) => time - 3000),
    );

    expect(unchangedError(cues)).toBeLessThanOrEqual(300);
    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns a 25 fps subtitle to a 23.976 fps reference with one delta", () => {
    const { cues, score } = alignOffset(
      reference,
      transform(related, (time) => (time * 25) / 23.976 - 3000),
      { speedRatio: speedRatioFromFPS(25, 23.976) },
    );

    expect(relatedError(cues)).toBeLessThanOrEqual(60);
    expect(score).toBeGreaterThanOrEqual(0.6);
  });

  it("aligns two 1500-cue tracks in under 300 ms", async () => {
    const long = syntheticTrack(3, 1500);
    const shifted = transform(long, (time) => time + 2000);

    expect(await fastestOfThree(() => alignOffset(long, shifted))).toBeLessThan(300);
  });
});

describe("bestSpeedRatio", () => {
  it("picks 25 / 23.976 for a subtitle scaled by it", () => {
    const scaled = transform(related, (time) => (time * 25) / 23.976 + 2000);

    expect(bestSpeedRatio(reference, scaled, speedRatios)).toBe(25 / 23.976);
  });

  it("picks 1 for an unscaled subtitle", () => {
    const shifted = transform(related, (time) => time + 2000);

    expect(bestSpeedRatio(reference, shifted, speedRatios)).toBe(1);
  });

  it("falls back to 1 without candidate ratios", () => {
    expect(bestSpeedRatio(reference, related, [])).toBe(1);
  });
});

it("lists every frame rate pairing and its inverse", () => {
  expect(speedRatios).toEqual([
    1,
    25 / 23.976,
    23.976 / 25,
    24 / 23.976,
    23.976 / 24,
    25 / 24,
    24 / 25,
  ]);
});
