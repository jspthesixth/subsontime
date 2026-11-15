import { align, align_offset, score } from "../../wasm/alass_wasm.js";
import type { Cue } from "../subtitles/cue.ts";

type AlignOptions = { speedRatio?: number; withinReference?: boolean };

export type Alignment = { cues: Cue[]; score: number };

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
  referenceFPS / subtitleFPS;

const splitPenalty = 7;

const flatten = (cues: Cue[]) =>
  BigInt64Array.from(
    cues.flatMap((cue) => [cue.start, cue.end]).map((time) => BigInt(Math.round(time))),
  );

export const scoreOf = (reference: Cue[], cues: Cue[], options?: AlignOptions) =>
  score(flatten(reference), flatten(cues), options?.withinReference === true);

const scored = (reference: BigInt64Array, cues: Cue[], options?: AlignOptions): Alignment => ({
  cues,
  score: score(reference, flatten(cues), options?.withinReference === true),
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
    options,
  );
};

export const offsetCues = (subtitle: Cue[], speedRatio: number, offsetMs: number) =>
  subtitle.map((cue) => ({
    ...cue,
    start: Math.round(cue.start / speedRatio + offsetMs),
    end: Math.round(cue.end / speedRatio + offsetMs),
  }));

export const alignOffset = (
  reference: Cue[],
  subtitle: Cue[],
  options?: AlignOptions,
): Alignment & { offsetMs: number } => {
  const speedRatio = options?.speedRatio ?? 1;
  const referenceSpans = flatten(reference);
  const offsetMs = Number(align_offset(referenceSpans, flatten(subtitle), speedRatio));

  return {
    ...scored(referenceSpans, offsetCues(subtitle, speedRatio, offsetMs), options),
    offsetMs,
  };
};

export const bestScoredRatio = (candidates: readonly { speedRatio: number; score: number }[]) =>
  candidates.reduce((best, candidate) => (candidate.score > best.score ? candidate : best), {
    speedRatio: candidates[0]?.speedRatio ?? 1,
    score: -Infinity,
  }).speedRatio;

export const bestSpeedRatio = (
  reference: Cue[],
  subtitle: Cue[],
  ratios: readonly number[],
  options?: AlignOptions,
) =>
  bestScoredRatio(
    ratios.map((speedRatio) => ({
      speedRatio,
      score: alignOffset(reference, subtitle, { ...options, speedRatio }).score,
    })),
  );
