import type { Cue } from "../subtitles/cue.ts";
import {
  alignCues,
  alignOffset,
  bestSpeedRatio,
  scoreOf,
  speedRatios,
  type Alignment,
} from "../timing/alass.ts";
import { splitWorthScore } from "../timing/retime.ts";
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
    }
  | { kind: "no-speech" }
  | { kind: "implausible-speech"; share: number }
  | { kind: "too-short" }
  | { kind: "empty-subtitle" };

export type AudioDecision = "accept" | "not-clear" | "mismatch";

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

export const windowOf = (cues: Cue[]) => ({
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

const refined = async (speech: Cue[], rigid: Alignment, cues: Cue[], speedRatio: number) => {
  if (rigid.score >= splitWorthScore) {
    return rigid.cues;
  }

  const split = await alignCues(speech, cues, { ...withinSpeech, speedRatio });

  return split.score > rigid.score ? split.cues : rigid.cues;
};

export const audioDecisionOf = (alignment: AudioAlignment): AudioDecision => {
  if (alignment.kind !== "aligned") {
    return "not-clear";
  }

  if (alignment.contrast < audioMismatchContrast) {
    return "mismatch";
  }

  return alignment.contrast >= audioAcceptContrast ? "accept" : "not-clear";
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
  const rigid = alignOffset(speech, cues, { ...withinSpeech, speedRatio });
  const score = scoreOf(speech, rigid.cues);
  const contrast = contrastOf(speech, rigid.cues, score);

  if (contrast === undefined) {
    return { kind: "too-short" };
  }

  const accepted = contrast >= audioAcceptContrast;

  return {
    kind: "aligned",
    cues: accepted ? await refined(speech, rigid, cues, speedRatio) : rigid.cues,
    score,
    offsetScore: rigid.score,
    speedRatio,
    contrast,
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
