import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatioFromFPS, speedRatios } from "./alass.ts";

export type Track = { candidate: Candidate; cues: Cue[] };

type Aligned = {
  reference: Track;
  cues: Cue[];
  score: number;
  offsetScore: number;
  speedRatio: number;
  offsetMs: number;
  cuts: number;
};

export type RetimeResult =
  | { kind: "made-for-file"; cues: Cue[] }
  | {
      kind: "retimed";
      cues: Cue[];
      offsetMs: number;
      speedRatio: number;
      cuts: number;
      byReleaseName: boolean;
      score: number;
      reference: Track;
      references: Track[];
    }
  | { kind: "shared-fix"; cues: Cue[]; agreeing: number; fromAudio: boolean }
  | { kind: "not-retimed"; cues: Cue[]; noFit?: true }
  | { kind: "mismatch" };

export const retimedMinimumScore = 0.6;
export const mismatchMaximumScore = 0.2;
export const splitWorthScore = 0.85;

export const agreementMs = 150;
const cutMs = 1000;

export const median = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

export const deltasOf = (original: Cue[], aligned: Cue[], speedRatio: number) =>
  aligned.map(
    (cue, index) => cue.start - (original[index]?.start ?? cue.start * speedRatio) / speedRatio,
  );

const cutIndexes = (deltas: number[]) =>
  deltas
    .slice(1)
    .flatMap((delta, index) =>
      Math.abs(delta - (deltas[index] ?? delta)) > cutMs ? [index + 1] : [],
    );

export const cutsOf = (deltas: number[]) => cutIndexes(deltas).length;

export const shiftOf = (original: Cue[], aligned: Cue[], speedRatio: number) => {
  const deltas = deltasOf(original, aligned, speedRatio);
  const cuts = cutIndexes(deltas);

  return {
    offsetMs: Math.round(median(deltas)),
    cuts: cuts.length,
    cutsAt: cuts.map((index) => aligned[index]?.start ?? 0),
  };
};

const taggedRatios = ({ fps: subtitleFPS }: Candidate, { fps: referenceFPS }: Candidate) =>
  subtitleFPS === undefined || referenceFPS === undefined
    ? []
    : [speedRatioFromFPS(subtitleFPS, referenceFPS)];

const speedRatioFor = (subtitle: Track, reference: Track) => {
  const tagged = taggedRatios(subtitle.candidate, reference.candidate);
  const fitting = tagged.find(
    (speedRatio) =>
      alignOffset(reference.cues, subtitle.cues, { speedRatio }).score >= retimedMinimumScore,
  );

  return fitting ?? bestSpeedRatio(reference.cues, subtitle.cues, [...tagged, ...speedRatios]);
};

const bestAlignment = async (subtitle: Track, reference: Track, speedRatio: number) => {
  const offset = alignOffset(reference.cues, subtitle.cues, { speedRatio });

  if (offset.score >= splitWorthScore) {
    return { ...offset, offsetScore: offset.score };
  }

  const split = await alignCues(reference.cues, subtitle.cues, { speedRatio });
  const best = offset.score >= retimedMinimumScore && offset.score >= split.score ? offset : split;

  return { ...best, offsetScore: offset.score };
};

const alignAt = async (subtitle: Track, reference: Track, speedRatio: number) => ({
  speedRatio,
  ...(await bestAlignment(subtitle, reference, speedRatio)),
});

const nearOne = (speedRatio: number) => Math.abs(speedRatio - 1) < 0.002;

const alignTo = async (subtitle: Track, reference: Track): Promise<Aligned> => {
  const searched = await alignAt(subtitle, reference, speedRatioFor(subtitle, reference));
  const neighbours =
    searched.offsetScore < splitWorthScore &&
    searched.speedRatio !== 1 &&
    nearOne(searched.speedRatio)
      ? speedRatios.filter((ratio) => ratio !== searched.speedRatio && nearOne(ratio))
      : [];
  const alignments = [
    searched,
    ...(await Promise.all(neighbours.map((ratio) => alignAt(subtitle, reference, ratio)))),
  ];
  const { speedRatio, cues, score, offsetScore } = alignments.reduce((best, alignment) =>
    alignment.score > best.score ? alignment : best,
  );

  const { offsetMs, cuts } = shiftOf(subtitle.cues, cues, speedRatio);

  return { reference, cues, score, offsetScore, speedRatio, offsetMs, cuts };
};

const alignAll = async (subtitle: Track, references: Track[]) => {
  const aligned: Aligned[] = [];

  for (const reference of references) {
    const result = await alignTo(subtitle, reference);

    aligned.push(result);

    if (reference.candidate.hashMatch && result.score >= splitWorthScore) {
      break;
    }
  }

  return aligned;
};

const choose = (aligned: Aligned[]) => {
  const passing = aligned
    .filter((result) => result.score >= retimedMinimumScore)
    .toSorted((a, b) => b.score - a.score);
  const center = median(passing.map((result) => result.offsetMs));

  return passing.find((result) => Math.abs(result.offsetMs - center) <= agreementMs) ?? passing[0];
};

const isMismatch = (result: Aligned) =>
  result.offsetScore < mismatchMaximumScore &&
  Math.max(result.offsetScore, result.score) < retimedMinimumScore;

const sameCandidate = (a: Candidate, b: Candidate) =>
  a.sourceName === b.sourceName && a.ref === b.ref;

export const retime = async (subtitle: Track, references: Track[]): Promise<RetimeResult> => {
  if (subtitle.candidate.hashMatch) {
    return { kind: "made-for-file", cues: subtitle.cues };
  }

  const aligned = await alignAll(
    subtitle,
    references.filter((reference) => !sameCandidate(reference.candidate, subtitle.candidate)),
  );
  const chosen = choose(aligned);
  const hashMatched = aligned.filter((result) => result.reference.candidate.hashMatch);

  if (chosen !== undefined) {
    return {
      kind: "retimed",
      cues: chosen.cues,
      offsetMs: chosen.offsetMs,
      speedRatio: chosen.speedRatio,
      cuts: chosen.cuts,
      byReleaseName: hashMatched.length === 0,
      score: chosen.score,
      reference: chosen.reference,
      references: aligned.map((result) => result.reference),
    };
  }

  if (hashMatched.length > 0 && hashMatched.every(isMismatch)) {
    return { kind: "mismatch" };
  }

  return { kind: "not-retimed", cues: subtitle.cues, noFit: true };
};
