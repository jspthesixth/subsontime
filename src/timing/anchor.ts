import { setImmediate, setTimeout } from "node:timers/promises";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { minimumReleaseScoreOf, releaseScoreOf, type ScoreContext } from "../subtitles/score.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "./alass.ts";
import {
  agreementMs,
  deltasOf,
  median,
  mismatchMaximumScore,
  retimedMinimumScore,
  shiftOf,
  type Retimed,
  type RetimeResult,
  type Track,
} from "./retime.ts";

export const agreementShare = 0.9;
export const guardChecks = 8;

const agrees = (deltas: number[]) => {
  const shift = median(deltas);
  const within = deltas.filter((delta) => Math.abs(delta - shift) <= agreementMs).length;

  return Math.abs(shift) <= agreementMs && within / Math.max(deltas.length, 1) >= agreementShare;
};

// ponytail: O(n x m) scan, about a million steps for two episodes; binary search if films get slow
const nearestShift = (starts: number[], time: number) =>
  starts.reduce(
    (best, start) => (Math.abs(start - time) < Math.abs(best) ? start - time : best),
    Number.POSITIVE_INFINITY,
  );

const otherSpeedRatios = speedRatios.filter((speedRatio) => speedRatio !== 1);

const sameStarts = async (reference: Cue[], subtitle: Cue[]) => {
  const starts = reference.map(({ start }) => start);

  if (agrees(subtitle.map(({ start }) => nearestShift(starts, start)))) {
    return true;
  }

  const split = await alignCues(reference, subtitle);

  return agrees(deltasOf(subtitle, split.cues, 1));
};

const rigidlyClose = (reference: Cue[], subtitle: Cue[]) => {
  const rigid = alignOffset(reference, subtitle);

  return rigid.score >= retimedMinimumScore && Math.abs(rigid.offsetMs) <= agreementMs
    ? rigid
    : undefined;
};

export const sameTiming = async (reference: Cue[], subtitle: Cue[]) => {
  const rigid = rigidlyClose(reference, subtitle);

  return (
    rigid !== undefined &&
    !otherSpeedRatios.some(
      (speedRatio) => alignOffset(reference, subtitle, { speedRatio }).score > rigid.score,
    ) &&
    sameStarts(reference, subtitle)
  );
};

const sameTimingAtOneSpeed = async (reference: Cue[], subtitle: Cue[]) =>
  rigidlyClose(reference, subtitle) !== undefined && sameStarts(reference, subtitle);

export type Guarded = { partner?: number; failed: boolean; cut: boolean };

const cutOff = Symbol("cut off");

const beforeDeadline = <T>(work: Promise<T>, deadline: number) => {
  const left = deadline - performance.now();

  return left <= 0
    ? Promise.resolve(cutOff)
    : Promise.race([work, setTimeout(left, cutOff, { ref: false })]);
};

export const firstAgreeing = (
  anchor: Cue[],
  guards: Promise<Cue[] | undefined>[],
  deadline = Number.POSITIVE_INFINITY,
) =>
  guards.reduce<Promise<Guarded>>(
    async (previous, guard, index) => {
      const search = await previous;

      if (search.partner !== undefined || search.cut) {
        return search;
      }

      const cues = await beforeDeadline(guard, deadline);

      await setImmediate();

      if (cues === cutOff) {
        return { ...search, cut: true };
      }

      if (cues === undefined) {
        return { ...search, failed: true };
      }

      return (await sameTiming(anchor, cues)) ? { ...search, partner: index } : search;
    },
    Promise.resolve({ failed: false, cut: false }),
  );

export const rigidlyAligned = (anchor: Cue[], subtitle: Cue[]) => {
  const speedRatio = bestSpeedRatio(anchor, subtitle, speedRatios);

  return { ...alignOffset(anchor, subtitle, { speedRatio }), speedRatio };
};

export const retimeToAnchor = (subtitle: Track, anchor: Track): Retimed | undefined => {
  const { cues, score, offsetMs, speedRatio } = rigidlyAligned(anchor.cues, subtitle.cues);

  return score >= retimedMinimumScore
    ? {
        kind: "retimed",
        cues,
        offsetMs,
        speedRatio,
        cuts: 0,
        byReleaseName: !anchor.candidate.hashMatch,
        score,
        reference: anchor,
        references: [anchor],
      }
    : undefined;
};

const stretchMs = 10 * 60 * 1000;
const stretchLines = 20;
const marginMs = 20_000;
const visibleStepMs = 500;

const steady = (file: Cue[], aligned: Cue[]) => {
  const shifts = [...Map.groupBy(aligned, ({ start }) => Math.floor(start / stretchMs)).values()]
    .filter((stretch) => stretch.length >= stretchLines)
    .flatMap((stretch) => {
      const from = (stretch[0]?.start ?? 0) - marginMs;
      const to = (stretch.at(-1)?.end ?? 0) + marginMs;
      const near = file.filter(({ start, end }) => start >= from && end <= to);

      return near.length < stretchLines / 2 ? [] : [alignOffset(near, stretch).offsetMs];
    });

  return Math.max(...shifts) - Math.min(...shifts) <= visibleStepMs;
};

export const changeMarkMs = 400;

const lineScores = { fits: retimedMinimumScore, mismatch: mismatchMaximumScore };
const changeScores = { fits: 0.3, mismatch: 0.15 };

const marksOf = (cues: Cue[]) =>
  cues
    .flatMap(({ start, end }) => [start, end])
    .toSorted((a, b) => a - b)
    .map((time) => ({ start: time, end: time + changeMarkMs, text: "" }));

const movedBy = (cues: Cue[], marks: Cue[], moved: Cue[]) => {
  const to = new Map(marks.map((mark, index) => [mark.start, moved[index]?.start ?? mark.start]));

  return cues.map((cue) => {
    const start = to.get(cue.start) ?? cue.start;

    return { ...cue, start, end: Math.max(start, to.get(cue.end) ?? cue.end) };
  });
};

export const retimeToFile = async (
  subtitle: Track,
  file: Track,
  changes = false,
): Promise<RetimeResult> => {
  const compared = changes ? marksOf(subtitle.cues) : subtitle.cues;
  const { fits, mismatch } = changes ? changeScores : lineScores;

  const atOne = alignOffset(file.cues, compared);
  const speedRatio = atOne.score >= fits ? 1 : bestSpeedRatio(file.cues, compared, speedRatios);
  const rigid = speedRatio === 1 ? atOne : alignOffset(file.cues, compared, { speedRatio });
  const split =
    rigid.score >= fits && steady(file.cues, rigid.cues)
      ? undefined
      : await alignCues(file.cues, compared, { speedRatio });
  const best = split !== undefined && split.score > rigid.score ? split : rigid;

  if (best.score < fits) {
    return rigid.score < mismatch
      ? { kind: "mismatch" }
      : { kind: "not-retimed", cues: subtitle.cues, noFit: true };
  }

  const cues = changes ? movedBy(subtitle.cues, compared, best.cues) : best.cues;
  const { offsetMs, cuts } = shiftOf(subtitle.cues, cues, speedRatio);

  return {
    kind: "retimed",
    cues,
    offsetMs,
    cuts,
    speedRatio,
    byReleaseName: false,
    score: best.score,
    reference: file,
    references: [file],
  };
};

export const timingAnchorOf = <T extends Candidate>(ranked: T[], context: ScoreContext) => {
  const scores = ranked.map((candidate) => releaseScoreOf(candidate, context));
  const best = Math.max(0, ...scores);

  return (
    ranked.find(({ hashMatch }) => hashMatch) ??
    (best >= minimumReleaseScoreOf(context.video.type) ? ranked[scores.indexOf(best)] : undefined)
  );
};

export const anchorWithGuardsOf = <T extends Candidate>(ranked: T[], context: ScoreContext) => {
  const anchor = timingAnchorOf(ranked, context);

  return anchor === undefined
    ? []
    : [anchor, ...ranked.filter((candidate) => candidate !== anchor).slice(0, guardChecks)];
};

export const asGoodAsAnchor = (candidate: Candidate, anchor: Candidate, context: ScoreContext) =>
  !anchor.hashMatch && releaseScoreOf(candidate, context) >= releaseScoreOf(anchor, context);

export const sameVideoMinimumScore = 0.3;

export type AlignedAt = (other: Track, speedRatio: number) => ReturnType<typeof alignOffset>;

export const sameVideo = (other: Track, alignedAt: AlignedAt) =>
  speedRatios.some((speedRatio) => alignedAt(other, speedRatio).score >= sameVideoMinimumScore);

const sharesTiming = async (track: Track, tracks: Track[]) => {
  for (const other of tracks) {
    if (other !== track && (await sameTimingAtOneSpeed(track.cues, other.cues))) {
      return true;
    }
  }

  return false;
};

const sharedTimingOf = async (tracks: Track[]) => {
  for (const track of tracks) {
    if (await sharesTiming(track, tracks)) {
      return track;
    }
  }

  return undefined;
};

export const atSpeedOfMost = async (
  subtitle: Track,
  anchored: Retimed,
  anchor: Track,
  voters: Track[],
  alignedAt: AlignedAt,
) => {
  const votes = voters
    .map((track) => ({
      track,
      own: alignedAt(track, 1).score,
      sped: alignedAt(track, anchored.speedRatio).score,
    }))
    .filter(({ own, sped }) => Math.max(own, sped) >= mismatchMaximumScore);
  const atSpeed = votes.filter(({ own, sped }) => sped > own).map(({ track }) => track);

  if (atSpeed.length <= votes.length - atSpeed.length) {
    return undefined;
  }

  const shared = await sharedTimingOf([anchor, ...atSpeed]);

  return (shared === undefined ? undefined : retimeToAnchor(subtitle, shared)) ?? anchored;
};
