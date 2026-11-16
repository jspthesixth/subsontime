import { setImmediate, setTimeout } from "node:timers/promises";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { minimumReleaseScoreOf, releaseScoreOf, type ScoreContext } from "../subtitles/score.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "./alass.ts";
import {
  agreementMs,
  deltasOf,
  median,
  retimedMinimumScore,
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

export const sameTiming = async (reference: Cue[], subtitle: Cue[]) => {
  const rigid = alignOffset(reference, subtitle);

  if (rigid.score < retimedMinimumScore || Math.abs(rigid.offsetMs) > agreementMs) {
    return false;
  }

  if (
    otherSpeedRatios.some(
      (speedRatio) => alignOffset(reference, subtitle, { speedRatio }).score > rigid.score,
    )
  ) {
    return false;
  }

  const starts = reference.map(({ start }) => start);

  if (agrees(subtitle.map(({ start }) => nearestShift(starts, start)))) {
    return true;
  }

  const split = await alignCues(reference, subtitle);

  return agrees(deltasOf(subtitle, split.cues, 1));
};

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

export const retimeToAnchor = (subtitle: Track, anchor: Track): RetimeResult | undefined => {
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
