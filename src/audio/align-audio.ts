import type { Cue } from "../subtitles/cue.ts";
import { alignOffset, bestSpeedRatio, scoreOf, speedRatios } from "../timing/alass.ts";
import { detectSpeech } from "../timing/speech.ts";
import { audioStreamOf, pcmFrom, pcmSampleRate } from "./ffmpeg.ts";

type AudioOptions = { signal?: AbortSignal; language?: string };

export type Heard = { spans: Cue[]; audioMs: number };

export type AudioAlignment =
  | {
      kind: "aligned";
      cues: Cue[];
      score: number;
      offsetScore: number;
      speedRatio: number;
      contrast: number;
      decision: AudioDecision;
    }
  | { kind: "no-speech" }
  | { kind: "implausible-speech"; share: number }
  | { kind: "too-short" }
  | { kind: "empty-subtitle" };

export type AudioDecision = "accept" | "not-clear" | "mismatch";

export const audioAcceptContrast = 3.5;
export const audioMismatchContrast = 1;
export const thirdsAgreementMs = 250;
export const plausibleSpeechShare = { min: 0.15, max: 0.9 };

export const wrongShiftsMs = [37, 71, 113, 149].flatMap((seconds) => [
  -seconds * 1000,
  seconds * 1000,
]);
export const shortClipMs = 300_000;

const minimumBaseline = 0.03;
const minimumShifts = 4;

export const withinSpeech = { withinReference: true };

export const shifted = (cues: Cue[], ms: number) =>
  cues.map((cue) => ({ ...cue, start: cue.start + ms, end: cue.end + ms }));

export const windowOf = (cues: Cue[]) => ({
  start: Math.min(...cues.map((cue) => cue.start)),
  end: Math.max(...cues.map((cue) => cue.end)),
});

type Window = ReturnType<typeof windowOf>;

export const usableShifts = (subtitle: Window, speech: Window) => {
  if (subtitle.end - subtitle.start >= shortClipMs) {
    return wrongShiftsMs;
  }

  return wrongShiftsMs.filter(
    (shift) => subtitle.start + shift < speech.end && subtitle.end + shift > speech.start,
  );
};

export const contrastFrom = (score: number, shifts: number[], scoreAt: (shift: number) => number) =>
  shifts.length < minimumShifts
    ? undefined
    : score / Math.max(...shifts.map(scoreAt), minimumBaseline);

export const contrastOf = (spans: Cue[], cues: Cue[], score: number) =>
  contrastFrom(score, usableShifts(windowOf(cues), windowOf(spans)), (shift) =>
    scoreOf(spans, shifted(cues, shift)),
  );

export const thirdsOf = (cues: Cue[]) =>
  [0, 1, 2].map((third) =>
    cues.slice(Math.floor((third * cues.length) / 3), Math.floor(((third + 1) * cues.length) / 3)),
  );

export type AudioEvidence = {
  contrast: number;
  windowMs: number;
  thirdOffsetsMs: (number | null)[];
};

const thirdsAgree = (offsets: (number | null)[]) => {
  const known = offsets.filter((offset) => offset !== null);

  return known.length === 3 && Math.max(...known) - Math.min(...known) <= thirdsAgreementMs;
};

export const decisionOf = (evidence?: AudioEvidence): AudioDecision => {
  if (evidence === undefined) {
    return "not-clear";
  }

  const { contrast, windowMs, thirdOffsetsMs } = evidence;

  if (contrast < audioMismatchContrast) {
    return "mismatch";
  }

  const accepted =
    contrast >= audioAcceptContrast && windowMs >= shortClipMs && thirdsAgree(thirdOffsetsMs);

  return accepted ? "accept" : "not-clear";
};

export const audioDecisionOf = (alignment: AudioAlignment) =>
  alignment.kind === "aligned" ? alignment.decision : "not-clear";

export const speechShareOf = ({ spans, audioMs }: Heard) =>
  spans.reduce((sum, span) => sum + span.end - span.start, 0) / Math.max(audioMs, 1);

export const isPlausibleSpeech = (share: number) =>
  share >= plausibleSpeechShare.min && share <= plausibleSpeechShare.max;

export const hear = async (pcm: AsyncIterable<Int16Array>): Promise<Heard> => {
  let samples = 0;

  const counted = async function* () {
    for await (const chunk of pcm) {
      samples += chunk.length;
      yield chunk;
    }
  };
  const spans = await detectSpeech(counted(), pcmSampleRate);

  return { spans, audioMs: (samples * 1000) / pcmSampleRate };
};

export const alignToSpeech = async (heard: Heard, cues: Cue[]): Promise<AudioAlignment> => {
  const { spans: speech } = heard;

  if (cues.length === 0) {
    return { kind: "empty-subtitle" };
  }

  if (speech.length === 0) {
    return { kind: "no-speech" };
  }

  const share = speechShareOf(heard);

  if (!isPlausibleSpeech(share)) {
    return { kind: "implausible-speech", share };
  }

  const speedRatio = bestSpeedRatio(speech, cues, speedRatios, withinSpeech);
  const rigid = alignOffset(speech, cues, { ...withinSpeech, speedRatio });
  const score = scoreOf(speech, rigid.cues);
  const contrast = contrastOf(speech, rigid.cues, score);

  if (contrast === undefined) {
    return { kind: "too-short" };
  }

  const { start, end } = windowOf(rigid.cues);

  const thirdOffsetsMs = thirdsOf(cues).map((third) =>
    third.length === 0
      ? null
      : alignOffset(speech, third, { ...withinSpeech, speedRatio }).offsetMs,
  );

  return {
    kind: "aligned",
    cues: rigid.cues,
    score,
    offsetScore: rigid.score,
    speedRatio,
    contrast,
    decision: decisionOf({ contrast, windowMs: end - start, thirdOffsetsMs }),
  };
};

export const alignToAudio = async (
  videoPath: string,
  cues: Cue[],
  options?: AudioOptions,
): Promise<AudioAlignment> => {
  if (cues.length === 0) {
    return { kind: "empty-subtitle" };
  }

  const signal = options?.signal ?? new AbortController().signal;
  const stream = await audioStreamOf(videoPath, options?.language, signal);
  const heard = await hear(pcmFrom(videoPath, signal, stream));

  return alignToSpeech(heard, cues);
};
