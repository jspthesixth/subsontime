import type { Cue } from "../subtitles/cue.ts";
import { cueHashes, type FixCue } from "./fingerprint.ts";

type Anchor = { index: number; from: number; fix: FixCue };

const minimumMatchedShare = 0.6;
const maximumStretch = 3;

const shift = (cue: Cue, anchor: Anchor): Cue => {
  const offset = anchor.fix.s - anchor.from;

  return { ...cue, start: cue.start + offset, end: cue.end + offset };
};

const interpolate = (cue: Cue, before: Anchor, after: Anchor): Cue => {
  const span = after.from - before.from;
  const ratio = span === 0 ? 1 : (after.fix.s - before.fix.s) / span;
  const start = before.fix.s + (cue.start - before.from) * ratio;

  return {
    ...cue,
    start: Math.round(start),
    end: Math.round(start + (cue.end - cue.start) * Math.min(ratio, maximumStretch)),
  };
};

const place = (cue: Cue, first: Anchor, before?: Anchor, after?: Anchor): Cue => {
  if (before === undefined) {
    return shift(cue, first);
  }

  return after === undefined ? shift(cue, before) : interpolate(cue, before, after);
};

const longestInOrder = (matches: Anchor[]): Anchor[] => {
  const tails: Anchor[] = [];
  const previous = new Map<Anchor, Anchor | undefined>();

  matches.forEach((anchor) => {
    let low = 0;
    let high = tails.length;

    while (low < high) {
      const middle = (low + high) >>> 1;

      if ((tails[middle]?.fix.s ?? Infinity) <= anchor.fix.s) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }

    previous.set(anchor, tails[low - 1]);
    tails[low] = anchor;
  });

  const kept: Anchor[] = [];

  for (let at = tails.at(-1); at !== undefined; at = previous.get(at)) {
    kept.push(at);
  }

  return kept.toReversed();
};

const keepInOrder = (original: Cue[], placed: Cue[]): Cue[] =>
  placed.map((cue, index) => {
    const start = Math.max(cue.start, 0);
    const end = Math.max(cue.end, 0);
    const next = placed[index + 1];
    const wasApart = (original[index]?.end ?? 0) <= (original[index + 1]?.start ?? Infinity);
    const trimmed = next !== undefined && wasApart ? Math.min(end, Math.max(next.start, 0)) : end;

    return { ...cue, start, end: trimmed > start ? trimmed : start + 1 };
  });

export const applyFix = (
  cues: Cue[],
  fix: FixCue[],
): { cues: Cue[]; matched: number } | undefined => {
  const hashes = cueHashes(cues);
  const ours = Map.groupBy(hashes, (hash) => hash);
  const theirs = Map.groupBy(fix, (cue) => cue.h);
  const hashed = hashes.filter((hash) => hash !== undefined).length;

  const matches = cues.flatMap((cue, index): Anchor[] => {
    const hash = hashes[index];
    const sameLine = hash === undefined ? [] : (theirs.get(hash) ?? []);
    const [match] = sameLine;

    return match !== undefined && sameLine.length === 1 && ours.get(hash)?.length === 1
      ? [{ index, from: cue.start, fix: match }]
      : [];
  });

  const anchors = longestInOrder(matches);
  const [first] = anchors;

  if (first === undefined || anchors.length / hashed < minimumMatchedShare) {
    return undefined;
  }

  const byIndex = new Map(anchors.map((anchor) => [anchor.index, anchor]));

  const placed = cues.map((cue, index) => {
    const anchor = byIndex.get(index);

    if (anchor !== undefined) {
      return { ...cue, start: anchor.fix.s, end: anchor.fix.e };
    }

    return place(
      cue,
      first,
      anchors.findLast((candidate) => candidate.index < index),
      anchors.find((candidate) => candidate.index > index),
    );
  });

  return {
    matched: anchors.length,
    cues: keepInOrder(cues, placed),
  };
};
