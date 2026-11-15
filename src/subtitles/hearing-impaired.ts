import type { Cue } from "./cue.ts";

const soundDescriptions = /\[[^\]]*\]|\([^)]*\)/g;
const speakerLabel = /^(\s*-\s*)?\p{Lu}{2}[\p{Lu}\p{N} .'-]*:\s*/u;
const emptyLine = /^[\s♪♫#-]*$/;
const musicLine = /^(-\s*)?[♪♫#]/;

export const stripSoundDescriptions = (text: string): string =>
  text
    .replace(soundDescriptions, "")
    .split("\n")
    .map((line) => line.replace(speakerLabel, "$1").replace(/\s+/g, " ").trim())
    .filter((line) => !emptyLine.test(line))
    .join("\n");

export const stripHearingImpaired = (cues: Cue[]): Cue[] =>
  cues.flatMap((cue) => {
    const text = stripSoundDescriptions(cue.text)
      .split("\n")
      .filter((line) => !musicLine.test(line))
      .join("\n");

    return text === "" ? [] : [{ ...cue, text }];
  });
