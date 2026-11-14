import { align, align_offset, score } from "../../wasm/alass_wasm.js";
import type { Cue } from "../subtitles/cue.ts";

type AlignOptions = { speedRatio?: number };

type Alignment = { cues: Cue[]; score: number };

export const speedRatios: readonly number[] = [
  1,
  25 / 23.976,
  23.976 / 25,
  24 / 23.976,
  23.976 / 24,
  25 / 24,
  24 / 25,
];

export const speedRatioFromFPS = (subtitleFPS: number, referenceFPS: number) =>
  subtitleFPS / referenceFPS;

const splitPenalty = 7;

const flatten = (cues: Cue[]) =>
  BigInt64Array.from(
    cues.flatMap((cue) => [cue.start, cue.end]).map((time) => BigInt(Math.round(time))),
  );

const scored = (reference: BigInt64Array, cues: Cue[]): Alignment => ({
  cues,
  score: score(reference, flatten(cues)),
});

export const alignCues = async (
  reference: Cue[],
  subtitle: Cue[],
  options?: AlignOptions,
): Promise<Alignment> => {
  const speedRatio = options?.speedRatio ?? 1;
  const referenceSpans = flatten(reference);
  const deltas = align(referenceSpans, flatten(subtitle), splitPenalty, speedRatio);

  return scored(
    referenceSpans,
    subtitle.map((cue, index) => {
      const start = Math.round(cue.start + Number(deltas[index] ?? 0n));

      return { ...cue, start, end: Math.round(start + (cue.end - cue.start) / speedRatio) };
    }),
  );
};

export const alignOffset = (
  reference: Cue[],
  subtitle: Cue[],
  options?: AlignOptions,
): Alignment => {
  const speedRatio = options?.speedRatio ?? 1;
  const referenceSpans = flatten(reference);
  const delta = Number(align_offset(referenceSpans, flatten(subtitle), speedRatio));

  return scored(
    referenceSpans,
    subtitle.map((cue) => ({
      ...cue,
      start: Math.round(cue.start / speedRatio + delta),
      end: Math.round(cue.end / speedRatio + delta),
    })),
  );
};

export const bestSpeedRatio = (reference: Cue[], subtitle: Cue[], ratios: readonly number[]) =>
  ratios
    .map((speedRatio) => ({
      speedRatio,
      score: alignOffset(reference, subtitle, { speedRatio }).score,
    }))
    .reduce((best, candidate) => (candidate.score > best.score ? candidate : best), {
      speedRatio: ratios[0] ?? 1,
      score: -Infinity,
    }).speedRatio;
