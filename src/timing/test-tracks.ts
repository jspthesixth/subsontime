import type { Cue } from "../subtitles/cue.ts";

export type SourcedCue = Cue & { origin: number; unchanged: boolean };

export const seededRandom = (seed: number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const syntheticTrack = (seed: number, count: number): Cue[] => {
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

export const resegment = (cues: Cue[], seed: number): SourcedCue[] => {
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

export const transform = <T extends Cue>(cues: T[], move: (time: number, cue: T) => number) =>
  cues.map((cue) => ({ ...cue, start: move(cue.start, cue), end: move(cue.end, cue) }));

const timed = async (run: () => unknown) => {
  const started = performance.now();

  await run();

  return performance.now() - started;
};

export const fastestOfThree = async (run: () => unknown) =>
  Math.min(await timed(run), await timed(run), await timed(run));
