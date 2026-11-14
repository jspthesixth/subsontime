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

export const sketchSize = 128;

export const hashOrder = (hash: CueHash) => Number.parseInt(hash.slice(0, 8), 16);

export const subtitleSketch = (hashes: CueHash[]): CueHash[] => {
  const unique = [...new Set(hashes)];
  const orders = unique.map(hashOrder);
  const last = Uint32Array.from(orders).toSorted()[sketchSize - 1] ?? Infinity;

  return unique
    .filter((_, index) => (orders[index] ?? 0) <= last)
    .toSorted()
    .slice(0, sketchSize);
};

export const sketchesSimilarity = <Key extends string | number>(
  left: ArrayLike<Key>,
  right: ArrayLike<Key>,
): number => {
  let at = 0;
  let bt = 0;
  let both = 0;
  let taken = 0;

  while (taken < sketchSize && (at < left.length || bt < right.length)) {
    const a = left[at];
    const b = right[bt];

    both += a === b ? 1 : 0;
    at += b === undefined || (a !== undefined && a <= b) ? 1 : 0;
    bt += a === undefined || (b !== undefined && b <= a) ? 1 : 0;
    taken += 1;
  }

  return taken === 0 ? 0 : both / taken;
};

export const sketchSimilarity = (hashes: CueHash[], sketch: CueHash[]): number =>
  sketchesSimilarity(subtitleSketch(hashes), subtitleSketch(sketch));
