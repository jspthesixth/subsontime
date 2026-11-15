import type { Cue } from "../subtitles/cue.ts";
import { alignCues, alignOffset, bestSpeedRatio, speedRatios } from "../timing/alass.ts";
import { splitWorthScore } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import { pcmFrom, pcmSampleRate } from "./ffmpeg.ts";

type AudioOptions = { signal?: AbortSignal; fps?: number };

export const alignToSpeech = async (speech: Cue[], cues: Cue[]) => {
  const speedRatio = bestSpeedRatio(speech, cues, speedRatios);
  const offset = alignOffset(speech, cues, { speedRatio });

  if (offset.score >= splitWorthScore) {
    return { ...offset, offsetScore: offset.score, speedRatio };
  }

  const split = await alignCues(speech, cues, { speedRatio });
  const best = split.score > offset.score ? split : offset;

  return { ...best, offsetScore: offset.score, speedRatio };
};

export const alignToAudio = async (videoPath: string, cues: Cue[], options?: AudioOptions) => {
  const speech = await detectSpeech(
    pcmFrom(videoPath, options?.signal ?? new AbortController().signal),
    pcmSampleRate,
  );

  return alignToSpeech(speech, cues);
};
