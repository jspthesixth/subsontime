import type { Cue } from "../subtitles/cue.ts";
import { alignOffset, bestSpeedRatio, offsetCues, scoreOf, speedRatios } from "../timing/alass.ts";
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
export const audioMismatchContrast = 0.9;
export const audioSkipContrast = 1.5;
export const windowAgreementMs = 250;
export const windowStrides = 20;
export const windowCount = windowStrides - 1;
export const minimumCues = 100;
export const plausibleSpeechShare = { min: 0.15, max: 0.9 };

export const wrongShiftsMs = [37, 71, 113, 149].flatMap((seconds) => [
  -seconds * 1000,
  seconds * 1000,
]);
export const shortClipMs = 300_000;

const minimumBaseline = 0.03;
const minimumShifts = 4;
const windowMarginMs = 15_000;

export const withinSpeech = { withinReference: true };

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
    scoreOf(spans, offsetCues(cues, 1, shift)),
  );

export type WindowFits = { cues: number; windowOffsetsMs: (number | null)[] };

export const windowFitsOf = (
  speech: Cue[],
  cues: Cue[],
  speedRatio: number,
  offsetMs: number,
): WindowFits => {
  const sorted = cues.toSorted((a, b) => a.start - b.start);
  const aligned = offsetCues(sorted, speedRatio, offsetMs);
  const boundOf = (stride: number) => Math.floor((stride * sorted.length) / windowStrides);

  const windowOffsetsMs = Array.from({ length: windowCount }, (_, index) => {
    const own = sorted.slice(boundOf(index), boundOf(index + 2));

    if (own.length === 0) {
      return null;
    }

    const { start, end } = windowOf(aligned.slice(boundOf(index), boundOf(index + 2)));

    const near = speech.filter(
      (span) => span.end > start - windowMarginMs && span.start < end + windowMarginMs,
    );

    return near.length === 0
      ? null
      : alignOffset(near, own, { ...withinSpeech, speedRatio }).offsetMs;
  });

  return { cues: cues.length, windowOffsetsMs };
};

export type AudioEvidence = WindowFits & { contrast: number; windowMs: number; offsetMs: number };

const windowsAgree = ({ cues, offsetMs, windowOffsetsMs }: AudioEvidence) =>
  cues >= minimumCues &&
  windowOffsetsMs.every(
    (windowOffsetMs) =>
      windowOffsetMs !== null && Math.abs(windowOffsetMs - offsetMs) <= windowAgreementMs,
  );

export const decisionOf = (evidence?: AudioEvidence): AudioDecision => {
  if (evidence === undefined) {
    return "not-clear";
  }

  const { contrast, windowMs } = evidence;

  if (contrast < audioMismatchContrast) {
    return "mismatch";
  }

  const accepted =
    contrast >= audioAcceptContrast && windowMs >= shortClipMs && windowsAgree(evidence);

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

export const speechProblemOf = (heard: Heard, cues: Cue[]) => {
  if (cues.length === 0) {
    return { kind: "empty-subtitle" as const };
  }

  if (heard.spans.length === 0) {
    return { kind: "no-speech" as const };
  }

  const share = speechShareOf(heard);

  return isPlausibleSpeech(share) ? undefined : { kind: "implausible-speech" as const, share };
};

export const alignToSpeech = async (heard: Heard, cues: Cue[]): Promise<AudioAlignment> => {
  const { spans: speech } = heard;

  const problem = speechProblemOf(heard, cues);

  if (problem !== undefined) {
    return problem;
  }

  const speedRatio = bestSpeedRatio(speech, cues, speedRatios, withinSpeech);
  const rigid = alignOffset(speech, cues, { ...withinSpeech, speedRatio });
  const score = scoreOf(speech, rigid.cues);
  const contrast = contrastOf(speech, rigid.cues, score);

  if (contrast === undefined) {
    return { kind: "too-short" };
  }

  const { start, end } = windowOf(rigid.cues);

  return {
    kind: "aligned",
    cues: rigid.cues,
    score,
    offsetScore: rigid.score,
    speedRatio,
    contrast,
    decision: decisionOf({
      contrast,
      windowMs: end - start,
      offsetMs: rigid.offsetMs,
      ...windowFitsOf(speech, cues, speedRatio, rigid.offsetMs),
    }),
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
