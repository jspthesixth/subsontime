import { correctTiming, timingErrorOf } from "../audio/evaluate.ts";
import type { Cue } from "../subtitles/cue.ts";
import { uniqueLines } from "../subtitles/lines.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "../timing/alass.ts";
import { retimedMinimumScore } from "../timing/retime.ts";

export type Verified = { id: string; lang: string; cues: Cue[] };

export type Outcome = "correct" | "wrong-timing" | "wrong-title" | "unmeasurable";

export type Truth = {
  outcome: Outcome;
  method?: "text" | "alass";
  against?: string;
  matched?: number;
  score?: number;
  medianMs?: number;
  p90Ms?: number;
};

export const textShareMinimum = 0.8;
export const textMatchesMinimum = 20;
export const wrongTitleMaximumScore = 0.35;
export const alassReferences = 3;

const sharedLines = (served: Cue[], verified: Verified) => {
  const servedLines = uniqueLines(served);
  const own = uniqueLines(verified.cues);
  const diffs = [...servedLines].flatMap(([line, index]) => {
    const at = own.get(line);

    return at === undefined ? [] : [(served[index]?.start ?? 0) - (verified.cues[at]?.start ?? 0)];
  });

  return { verified, diffs, share: diffs.length / Math.max(servedLines.size, 1) };
};

const rigidScoreOf = (reference: Cue[], served: Cue[]) =>
  alignOffset(reference, served, { speedRatio: bestSpeedRatio(reference, served, speedRatios) })
    .score;

const timed = (diffs: number[]) => {
  const { medianMs, p90Ms } = timingErrorOf(diffs, 0);

  return {
    outcome:
      medianMs <= correctTiming.medianMs && p90Ms <= correctTiming.p90Ms
        ? ("correct" as const)
        : ("wrong-timing" as const),
    matched: diffs.length,
    medianMs,
    p90Ms,
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
    text.diffs.length >= textMatchesMinimum
  ) {
    return { method: "text", against: text.verified.id, ...timed(text.diffs) };
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
  const diffs = aligned.cues.map((cue, index) => (served[index]?.start ?? 0) - cue.start);

  return { method: "alass", against: reference.id, score, ...timed(diffs) };
};
