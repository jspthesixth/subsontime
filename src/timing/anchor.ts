import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { releaseScoreOf, type ScoreContext } from "../subtitles/score.ts";
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

export type Counter = { alignments: number };

export const sameTiming = async (
  reference: Cue[],
  subtitle: Cue[],
  counter: Counter = { alignments: 0 },
) => {
  const speedRatio = bestSpeedRatio(reference, subtitle, speedRatios);

  counter.alignments += speedRatios.length;

  if (speedRatio !== 1) {
    return false;
  }

  const rigid = alignOffset(reference, subtitle);

  counter.alignments += 1;

  if (rigid.score < retimedMinimumScore || Math.abs(rigid.offsetMs) > agreementMs) {
    return false;
  }

  const split = await alignCues(reference, subtitle);

  counter.alignments += 1;

  const deltas = deltasOf(subtitle, split.cues, 1);
  const shift = median(deltas);
  const within = deltas.filter((delta) => Math.abs(delta - shift) <= agreementMs).length;

  return Math.abs(shift) <= agreementMs && within / Math.max(deltas.length, 1) >= agreementShare;
};

export const rigidlyAligned = (
  anchor: Cue[],
  subtitle: Cue[],
  counter: Counter = { alignments: 0 },
) => {
  const speedRatio = bestSpeedRatio(anchor, subtitle, speedRatios);

  counter.alignments += speedRatios.length + 1;

  return { ...alignOffset(anchor, subtitle, { speedRatio }), speedRatio };
};

export const retimeToAnchor = (subtitle: Track, anchor: Track): RetimeResult => {
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
    : { kind: "not-retimed", cues: subtitle.cues };
};

export const timingAnchorOf = <T extends Candidate>(ranked: T[], context: ScoreContext) => {
  const scores = ranked.map((candidate) => releaseScoreOf(candidate, context));
  const best = Math.max(0, ...scores);

  return (
    ranked.find(({ hashMatch }) => hashMatch) ??
    (best > 0 ? ranked[scores.indexOf(best)] : undefined)
  );
};

export const anchorWithGuardsOf = (ranked: Candidate[], context: ScoreContext) => {
  const anchor = timingAnchorOf(ranked, context);

  return anchor === undefined
    ? []
    : [anchor, ...ranked.filter((candidate) => candidate !== anchor).slice(0, guardChecks)];
};
