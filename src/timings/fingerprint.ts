import { createHash } from "node:crypto";
import type { Cue } from "../subtitles/cue.ts";
import { stripSoundDescriptions } from "../subtitles/hearing-impaired.ts";
import { stripMarkup } from "../subtitles/parse.ts";

export type CueHash = string;

export type FixCue = { h: CueHash; s: number; e: number };

export const normalizeCueText = (text: string): string =>
  stripSoundDescriptions(stripMarkup(text.normalize("NFKC")))
    .toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export const cueHashes = (cues: Cue[]): (CueHash | undefined)[] =>
  cues.map((cue) => {
    const text = normalizeCueText(cue.text);

    return text === "" ? undefined : hashOf(text);
  });

export const toFixCues = (cues: Cue[]): FixCue[] => {
  const hashes = cueHashes(cues);

  return cues.flatMap((cue, index) => {
    const h = hashes[index];

    return h === undefined ? [] : [{ h, s: cue.start, e: cue.end }];
  });
};

export const similarity = (a: CueHash[], b: CueHash[]): number => {
  const left = new Set(a);
  const right = new Set(b);
  const shared = [...left].filter((hash) => right.has(hash)).length;
  const union = left.size + right.size - shared;

  return union === 0 ? 0 : shared / union;
};
