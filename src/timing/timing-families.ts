import { setImmediate } from "node:timers/promises";
import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "./alass.ts";
import { median, mismatchMaximumScore, retimedMinimumScore } from "./retime.ts";

const agreementMs = 150;
const sameFamilyShare = 0.9;
const maximumFamilies = 3;

export type Timed<T> = { item: T; cues: Cue[] };

type Options = { deadline?: number; now?: () => number };

export const timingAgreement = async (subtitle: Cue[], reference: Cue[]) => {
  const speedRatio = bestSpeedRatio(reference, subtitle, speedRatios);
  const offsetScore = alignOffset(reference, subtitle, { speedRatio }).score;
  const { cues, score } = await alignCues(reference, subtitle, { speedRatio });

  const deltas = cues.map((cue, index) => cue.start - (subtitle[index]?.start ?? cue.start));
  const center = median(deltas);
  const agreeing = deltas.filter((delta) => Math.abs(delta - center) <= agreementMs);

  return {
    share: agreeing.length / Math.max(deltas.length, 1),
    score,
    related: offsetScore >= mismatchMaximumScore || score >= retimedMinimumScore,
  };
};

export const timingFamiliesOf = async <T>(
  timed: Timed<T>[],
  { deadline = Infinity, now = () => performance.now() }: Options = {},
): Promise<T[][] | undefined> => {
  const families: Timed<T>[][] = [];

  for (const entry of timed) {
    if (now() > deadline) {
      return undefined;
    }

    const agreements = [];

    for (const family of families) {
      await setImmediate();
      agreements.push({ family, ...(await timingAgreement(entry.cues, family[0]?.cues ?? [])) });
    }

    const related = agreements.filter((agreement) => agreement.related);
    const joined = related
      .filter(({ share }) => share >= sameFamilyShare)
      .toSorted((a, b) => b.score - a.score)[0];

    if (joined !== undefined) {
      joined.family.push(entry);
    } else if (families.length < maximumFamilies && (families.length === 0 || related.length > 0)) {
      families.push([entry]);
    }
  }

  return families.map((family) => family.map(({ item }) => item));
};
