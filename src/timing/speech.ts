import { SpeechDetector } from "../../wasm/alass_wasm.js";
import type { Cue } from "../subtitles/cue.ts";

export const detectSpeech = async (
  pcm: AsyncIterable<Int16Array>,
  sampleRate: number,
): Promise<Cue[]> => {
  using detector = new SpeechDetector(sampleRate);

  for await (const samples of pcm) {
    detector.push(samples);
  }

  const spans = Array.from(detector.finish(), Number);

  return Array.from({ length: spans.length / 2 }, (_, index) => ({
    start: spans[index * 2] ?? 0,
    end: spans[index * 2 + 1] ?? 0,
    text: "",
  }));
};
