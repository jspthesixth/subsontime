import { createHash } from "node:crypto";
import type { Cue } from "../subtitles/cue.ts";
import { stripSoundDescriptions } from "../subtitles/hearing-impaired.ts";
import { stripMarkup } from "../subtitles/parse.ts";

export type CueHash = string;

export type FixCue = { h: CueHash; s: number; e: number };

export const normalizeCueText = (text: string): string =>
  stripSoundDescriptions(stripMarkup(text.normalize("NFKC").replace(/\p{Cf}/gu, "")))
    .toLowerCase()
    .replace(/[\p{P}\p{S}\p{C}]/gu, " ")
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

export const setSimilarity = (left: Set<CueHash>, right: Set<CueHash>): number => {
  const shared = [...left].filter((hash) => right.has(hash)).length;
  const union = left.size + right.size - shared;

  return union === 0 ? 0 : shared / union;
};

export const similarity = (a: CueHash[], b: CueHash[]): number =>
  setSimilarity(new Set(a), new Set(b));

const sketchSize = 128;

export const subtitleSketch = (hashes: CueHash[]): CueHash[] =>
  [...new Set(hashes)].toSorted().slice(0, sketchSize);

export const sketchSimilarity = (hashes: CueHash[], sketch: CueHash[]): number => {
  const ours = new Set(subtitleSketch(hashes));
  const theirs = new Set(sketch);
  const bottom = [...new Set([...ours, ...theirs])].toSorted().slice(0, sketchSize);

  return bottom.length === 0
    ? 0
    : bottom.filter((hash) => ours.has(hash) && theirs.has(hash)).length / bottom.length;
};
