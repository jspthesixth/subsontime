import { correctTiming, timingErrorOf } from "../audio/evaluate.ts";
import type { Cue } from "../subtitles/cue.ts";
import { uniqueLines } from "../subtitles/lines.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "../timing/alass.ts";
import { cutsOf, median, retimedMinimumScore } from "../timing/retime.ts";

export type Verified = { id: string; lang: string; cues: Cue[] };

export type Outcome = "correct" | "wrong-timing" | "wrong-title" | "unmeasurable";

export type Shape = {
  kind: "offset" | "frame-rate" | "drift" | "steps" | "other";
  offsetMs: number;
  speedRatio: number;
  steps: number;
};

type Point = { at: number; diff: number };

export type Truth = {
  outcome: Outcome;
  method?: "text" | "alass";
  against?: string;
  matched?: number;
  score?: number;
  medianMs?: number;
  p90Ms?: number;
  shape?: Shape;
};

export const textShareMinimum = 0.8;
export const textMatchesMinimum = 20;
export const wrongTitleMaximumScore = 0.35;
export const alassReferences = 3;

const sharedLines = (served: Cue[], verified: Verified) => {
  const servedLines = uniqueLines(served);
  const own = uniqueLines(verified.cues);
  const points = [...servedLines].flatMap(([line, index]): Point[] => {
    const at = own.get(line);
    const start = served[index]?.start ?? 0;

    return at === undefined ? [] : [{ at: start, diff: start - (verified.cues[at]?.start ?? 0) }];
  });

  return { verified, points, share: points.length / Math.max(servedLines.size, 1) };
};

const rigidScoreOf = (reference: Cue[], served: Cue[]) =>
  alignOffset(reference, served, { speedRatio: bestSpeedRatio(reference, served, speedRatios) })
    .score;

const fits = (errors: number[]) => {
  const { medianMs, p90Ms } = timingErrorOf(errors, 0);

  return medianMs <= correctTiming.medianMs && p90Ms <= correctTiming.p90Ms;
};

const frameRateTolerance = 0.002;
const sameSpeedTolerance = 0.0005;
const smoothing = 5;

const stepsOf = (diffs: number[]) => {
  const smoothed = diffs.map((_, index) =>
    median(diffs.slice(Math.max(0, index - smoothing), index + smoothing + 1)),
  );
  const levels = smoothed.map((level, index) =>
    index === 0 || Math.abs(level - (smoothed[index - 1] ?? level)) <= 1000 ? undefined : index,
  );
  const bounds = [
    0,
    ...levels.flatMap((index) => (index === undefined ? [] : [index])),
    diffs.length,
  ];
  const residuals = bounds.slice(1).flatMap((end, segment) => {
    const part = diffs.slice(bounds[segment], end);
    const level = median(part);

    return part.map((diff) => diff - level);
  });

  return { steps: cutsOf(smoothed), fits: fits(residuals) };
};

export const shapeOf = (points: Point[]): Shape => {
  const sorted = points.toSorted((a, b) => a.at - b.at);
  const half = Math.floor(sorted.length / 2);
  const slope = median(
    sorted.slice(0, sorted.length - half).flatMap((point, index) => {
      const other = sorted[index + half];

      return other === undefined || other.at === point.at
        ? []
        : [(other.diff - point.diff) / (other.at - point.at)];
    }),
  );
  const intercept = median(sorted.map(({ at, diff }) => diff - slope * at));
  const diffs = sorted.map(({ diff }) => diff);
  const offsetMs = Math.round(median(diffs));
  const speedRatio = 1 / (1 - slope);
  const linear = fits(sorted.map(({ at, diff }) => diff - intercept - slope * at));

  if (linear && Math.abs(speedRatio - 1) < sameSpeedTolerance) {
    return { kind: "offset", offsetMs, speedRatio: 1, steps: 0 };
  }

  if (linear) {
    const standard = speedRatios
      .flatMap((ratio) => [ratio, 1 / ratio])
      .some((ratio) => Math.abs(ratio - speedRatio) < frameRateTolerance);

    return { kind: standard ? "frame-rate" : "drift", offsetMs, speedRatio, steps: 0 };
  }

  const { steps, fits: stepped } = stepsOf(diffs);

  return { kind: stepped && steps > 0 ? "steps" : "other", offsetMs, speedRatio, steps };
};

const timed = (points: Point[]) => {
  const errors = points.map(({ diff }) => diff);
  const { medianMs, p90Ms } = timingErrorOf(errors, 0);

  return fits(errors)
    ? { outcome: "correct" as const, matched: points.length, medianMs, p90Ms }
    : {
        outcome: "wrong-timing" as const,
        matched: points.length,
        medianMs,
        p90Ms,
        shape: shapeOf(points),
      };
};

export const truthOf = async (
  served: Cue[],
  lang: string,
  verified: Verified[],
): Promise<Truth> => {
  const text = verified
    .filter((each) => each.lang === lang)
    .map((each) => sharedLines(served, each))
    .reduce<ReturnType<typeof sharedLines> | undefined>(
      (best, each) => (best === undefined || each.share > best.share ? each : best),
      undefined,
    );

  if (
    text !== undefined &&
    text.share >= textShareMinimum &&
    text.points.length >= textMatchesMinimum
  ) {
    return { method: "text", against: text.verified.id, ...timed(text.points) };
  }

  const nearest = verified
    .toSorted(
      (a, b) => Number(b.lang === lang) - Number(a.lang === lang) || b.cues.length - a.cues.length,
    )
    .slice(0, alassReferences)
    .map((each) => ({ verified: each, score: rigidScoreOf(each.cues, served) }))
    .reduce<{ verified: Verified; score: number } | undefined>(
      (best, each) => (best === undefined || each.score > best.score ? each : best),
      undefined,
    );

  if (nearest === undefined || served.length === 0) {
    return { outcome: "unmeasurable" };
  }

  const { verified: reference, score } = nearest;

  if (score < wrongTitleMaximumScore) {
    return { outcome: "wrong-title", against: reference.id, score };
  }

  if (score < retimedMinimumScore) {
    return { outcome: "unmeasurable", against: reference.id, score };
  }

  const aligned = await alignCues(reference.cues, served);
  const points = aligned.cues.map((cue, index) => {
    const start = served[index]?.start ?? 0;

    return { at: start, diff: start - cue.start };
  });

  return { method: "alass", against: reference.id, score, ...timed(points) };
};
