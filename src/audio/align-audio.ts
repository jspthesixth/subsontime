import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, scoreOf, speedRatios } from "../timing/alass.ts";
import { splitWorthScore } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import { pcmFrom, pcmSampleRate } from "./ffmpeg.ts";

type AudioOptions = { signal?: AbortSignal };

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
  | { kind: "too-short" }
  | { kind: "empty-subtitle" };

export const audioAcceptContrast = 3.5;
export const audioMismatchContrast = 1.5;

const wrongShiftsMs = [37, 71, 113, 149].flatMap((seconds) => [-seconds * 1000, seconds * 1000]);
const minimumBaseline = 0.01;
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

export const alignToSpeech = async (speech: Cue[], cues: Cue[]): Promise<AudioAlignment> => {
  if (cues.length === 0) {
    return { kind: "empty-subtitle" };
  }

  if (speech.length === 0) {
    return { kind: "no-speech" };
  }

  const speedRatio = bestSpeedRatio(speech, cues, speedRatios, withinSpeech);
  const best = await bestAlignment(speech, cues, speedRatio);
  const contrast = contrastOf(speech, best.cues, scoreOf(speech, best.cues));

  if (contrast === undefined) {
    return { kind: "too-short" };
  }

  return { kind: "aligned", ...best, speedRatio, contrast };
};

export const alignToAudio = async (
  videoPath: string,
  cues: Cue[],
  options?: AudioOptions,
): Promise<AudioAlignment> => {
  if (cues.length === 0) {
    return { kind: "empty-subtitle" };
  }

  const speech = await detectSpeech(
    pcmFrom(videoPath, options?.signal ?? new AbortController().signal),
    pcmSampleRate,
  );

  return alignToSpeech(speech, cues);
};
