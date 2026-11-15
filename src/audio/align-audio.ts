import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, scoreOf, speedRatios } from "../timing/alass.ts";
import { splitWorthScore } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import { pcmFrom, pcmSampleRate } from "./ffmpeg.ts";

type AudioOptions = { signal?: AbortSignal; fps?: number };

export type AudioAlignment =
  | {
      kind: "aligned";
      cues: Cue[];
      score: number;
      offsetScore: number;
      speedRatio: number;
      contrast: number;
    }
  | { kind: "no-speech" };

export const audioAcceptContrast = 3.5;
export const audioMismatchContrast = 1.5;

const wrongShiftsMs = [37, 71, 113, 149].flatMap((seconds) => [-seconds * 1000, seconds * 1000]);
const minimumBaseline = 0.01;

const shifted = (cues: Cue[], ms: number) =>
  cues.map((cue) => ({ ...cue, start: cue.start + ms, end: cue.end + ms }));

export const contrastOf = (spans: Cue[], cues: Cue[], score: number) =>
  score /
  Math.max(...wrongShiftsMs.map((shift) => scoreOf(spans, shifted(cues, shift))), minimumBaseline);

const bestAlignment = async (speech: Cue[], cues: Cue[], speedRatio: number) => {
  const offset = alignOffset(speech, cues, { speedRatio });

  if (offset.score >= splitWorthScore) {
    return { ...offset, offsetScore: offset.score };
  }

  const split = await alignCues(speech, cues, { speedRatio });

  return { ...(split.score > offset.score ? split : offset), offsetScore: offset.score };
};

export const alignToSpeech = async (speech: Cue[], cues: Cue[]): Promise<AudioAlignment> => {
  if (speech.length === 0) {
    return { kind: "no-speech" };
  }

  const speedRatio = bestSpeedRatio(speech, cues, speedRatios);
  const best = await bestAlignment(speech, cues, speedRatio);

  return {
    kind: "aligned",
    ...best,
    speedRatio,
    contrast: contrastOf(speech, best.cues, best.score),
  };
};

export const alignToAudio = async (videoPath: string, cues: Cue[], options?: AudioOptions) => {
  const speech = await detectSpeech(
    pcmFrom(videoPath, options?.signal ?? new AbortController().signal),
    pcmSampleRate,
  );

  return alignToSpeech(speech, cues);
};
