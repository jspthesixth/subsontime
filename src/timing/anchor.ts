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
  type Retimed,
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
