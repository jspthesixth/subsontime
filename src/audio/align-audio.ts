import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, scoreOf, speedRatios } from "../timing/alass.ts";
import { splitWorthScore } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import { pcmFrom, pcmSampleRate } from "./ffmpeg.ts";

type AudioOptions = { signal?: AbortSignal };

export type Heard = { spans: Cue[]; audioMs: number };

export type AudioAlignment =
  | {
      kind: "aligned";
      cues: Cue[];
      score: number;
      offsetScore: number;
      speedRatio: number;
      contrast: number;
    }
  | { kind: "no-speech" }
  | { kind: "implausible-speech"; share: number }
  | { kind: "too-short" }
  | { kind: "empty-subtitle" };

export const audioAcceptContrast = 3.5;
export const audioMismatchContrast = 1.5;
export const plausibleSpeechShare = { min: 0.15, max: 0.9 };

const wrongShiftsMs = [37, 71, 113, 149].flatMap((seconds) => [-seconds * 1000, seconds * 1000]);
const minimumBaseline = 0.03;
const shortClipMs = 300_000;
const minimumShifts = 4;

const withinSpeech = { withinReference: true };

const shifted = (cues: Cue[], ms: number) =>
  cues.map((cue) => ({ ...cue, start: cue.start + ms, end: cue.end + ms }));

const windowOf = (cues: Cue[]) => ({
  start: Math.min(...cues.map((cue) => cue.start)),
  end: Math.max(...cues.map((cue) => cue.end)),
});

const usableShifts = (spans: Cue[], cues: Cue[]) => {
  const subtitle = windowOf(cues);
  const speech = windowOf(spans);

  if (subtitle.end - subtitle.start >= shortClipMs) {
    return wrongShiftsMs;
  }

  return wrongShiftsMs.filter(
    (shift) => subtitle.start + shift < speech.end && subtitle.end + shift > speech.start,
  );
};

export const contrastOf = (spans: Cue[], cues: Cue[], score: number) => {
  const shifts = usableShifts(spans, cues);

  if (shifts.length < minimumShifts) {
    return undefined;
  }

  return (
    score /
    Math.max(...shifts.map((shift) => scoreOf(spans, shifted(cues, shift))), minimumBaseline)
  );
};

const bestAlignment = async (speech: Cue[], cues: Cue[], speedRatio: number) => {
  const offset = alignOffset(speech, cues, { ...withinSpeech, speedRatio });

  if (offset.score >= splitWorthScore) {
    return { ...offset, offsetScore: offset.score };
  }

  const split = await alignCues(speech, cues, { ...withinSpeech, speedRatio });

  return { ...(split.score > offset.score ? split : offset), offsetScore: offset.score };
};

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
  const best = await bestAlignment(speech, cues, speedRatio);
  const score = scoreOf(speech, best.cues);
  const contrast = contrastOf(speech, best.cues, score);

  if (contrast === undefined) {
    return { kind: "too-short" };
  }

  return { kind: "aligned", ...best, score, speedRatio, contrast };
};

export const alignToAudio = async (
  videoPath: string,
  cues: Cue[],
  options?: AudioOptions,
): Promise<AudioAlignment> => {
  if (cues.length === 0) {
    return { kind: "empty-subtitle" };
  }

  const heard = await hear(pcmFrom(videoPath, options?.signal ?? new AbortController().signal));

  return alignToSpeech(heard, cues);
};
