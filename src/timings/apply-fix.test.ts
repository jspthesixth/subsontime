import { describe, expect, it } from "vitest";
import type { Cue } from "../subtitles/cue.ts";
import {
  dialogueTrack,
  isSoundOnly,
  transform,
  withSoundDescriptions,
} from "../timing/test-tracks.ts";
import { applyFix } from "./apply-fix.ts";
import { toFixCues } from "./fingerprint.ts";

const move = (time: number) => Math.round(time * 1.001 + 2500);
const early = (time: number) => time - 5000;
const dialogue = dialogueTrack(1, 200);
const fix = toFixCues(transform(withSoundDescriptions(dialogue), move));
const plain = toFixCues(transform(dialogue, move));
const unmatchedIndex = 50;

const ours = dialogue
  .filter((_, index) => !isSoundOnly(index))
  .map((cue, index) =>
    index === unmatchedIndex || index === 0
      ? { ...cue, text: `Only this copy says ${index}.` }
      : cue,
  );

const replaceText = (cues: Cue[], indexes: number[], text: string) =>
  cues.map((cue, index) => (indexes.includes(index) ? { ...cue, text } : cue));

describe("applyFix", () => {
  it("gives every matched cue the fix times", () => {
    const result = applyFix(ours, fix);

    expect(result?.matched).toBe(ours.length - 2);
    ours.forEach((cue, index) => {
      if (index === unmatchedIndex || index === 0) {
        return;
      }

      expect(Math.abs((result?.cues[index]?.start ?? 0) - move(cue.start))).toBeLessThanOrEqual(1);
      expect(Math.abs((result?.cues[index]?.end ?? 0) - move(cue.end))).toBeLessThanOrEqual(1);
    });
  });

  it("places an unmatched cue between its neighbours", () => {
    const cues = applyFix(ours, fix)?.cues ?? [];
    const placed = cues[unmatchedIndex];
    const original = ours[unmatchedIndex];

    expect(placed?.start).toBeGreaterThan(cues[unmatchedIndex - 1]?.end ?? Infinity);
    expect(placed?.end).toBeLessThan(cues[unmatchedIndex + 1]?.start ?? -Infinity);
    expect(Math.abs((placed?.start ?? 0) - move(original?.start ?? 0))).toBeLessThanOrEqual(1);
    expect(placed?.text).toBe(original?.text);
  });

  it("moves a cue before the first matched cue by that cue's offset", () => {
    const cues = applyFix(ours, fix)?.cues ?? [];
    const offset = (cues[1]?.start ?? 0) - (ours[1]?.start ?? 0);

    expect(cues[0]?.start).toBe((ours[0]?.start ?? 0) + offset);
    expect(cues[0]?.end).toBe((ours[0]?.end ?? 0) + offset);
  });

  it("keeps the cues sorted and apart", () => {
    const cues = applyFix(ours, fix)?.cues ?? [];

    expect(cues.slice(1).every((cue, index) => cue.start >= (cues[index]?.end ?? 0))).toBe(true);
  });

  it("does not anchor on a line that repeats", () => {
    const repeated = replaceText(dialogue, [10, 30], "Yes.");
    const result = applyFix(repeated, toFixCues(transform(repeated, move)));

    expect(result?.matched).toBe(repeated.length - 2);
    expect(
      Math.abs((result?.cues[30]?.start ?? 0) - move(repeated[30]?.start ?? 0)),
    ).toBeLessThanOrEqual(1);
  });

  it("does not anchor on a line the fix repeats", () => {
    const once = replaceText(dialogue, [10], "Yes.");
    const fixTwice = toFixCues(transform(replaceText(dialogue, [10, 30], "yes!"), move));
    const result = applyFix(once, fixTwice);

    expect(result?.matched).toBe(once.length - 2);
    expect(
      Math.abs((result?.cues[10]?.start ?? 0) - move(once[10]?.start ?? 0)),
    ).toBeLessThanOrEqual(1);
  });

  it("clamps times below zero to zero", () => {
    const cues = applyFix(dialogue, toFixCues(transform(dialogue, early)))?.cues ?? [];

    expect(cues.every((cue) => cue.start >= 0 && cue.end >= 0)).toBe(true);
    expect(cues[0]?.start).toBe(0);
    expect(cues.at(-1)?.start).toBe(early(dialogue.at(-1)?.start ?? 0));
  });

  it("trims an end that runs past the next start", () => {
    const late = plain.map((cue, index) =>
      index === 20 ? { ...cue, e: (plain[21]?.s ?? 0) + 5000 } : cue,
    );
    const cues = applyFix(dialogue, late)?.cues ?? [];

    expect(cues[20]?.end).toBe(cues[21]?.start);
  });

  it("keeps a trimmed cue at least 1 ms long", () => {
    const together = plain.map((cue, index) =>
      index === 21 ? { ...cue, s: plain[20]?.s ?? 0 } : cue,
    );
    const cues = applyFix(dialogue, together)?.cues ?? [];

    expect(cues[21]?.start).toBe(cues[20]?.start);
    expect(cues[20]?.end).toBe((cues[20]?.start ?? 0) + 1);
  });

  it("keeps cues that overlapped in our copy overlapping", () => {
    const overlapping = dialogue.map((cue, index) =>
      index === 20 ? { ...cue, end: (dialogue[21]?.start ?? 0) + 500 } : cue,
    );
    const cues = applyFix(overlapping, toFixCues(transform(overlapping, move)))?.cues ?? [];

    expect(cues[20]?.end).toBeGreaterThan(cues[21]?.start ?? Infinity);
  });

  it("drops an anchor the fix puts before an earlier one", () => {
    const swapped = plain.map((cue, index) =>
      index === 40 ? { ...cue, s: (plain[30]?.s ?? 0) - 1000, e: plain[30]?.s ?? 0 } : cue,
    );
    const result = applyFix(dialogue, swapped);
    const cues = result?.cues ?? [];

    expect(result?.matched).toBe(dialogue.length - 1);
    expect(Math.abs((cues[40]?.start ?? 0) - move(dialogue[40]?.start ?? 0))).toBeLessThanOrEqual(
      1,
    );
    expect(cues.slice(1).every((cue, index) => cue.start >= (cues[index]?.start ?? 0))).toBe(true);
  });

  it("returns undefined when under 60 % of the cues match", () => {
    expect(applyFix(ours, fix.slice(0, fix.length / 2))).toBeUndefined();
    expect(applyFix(ours, toFixCues(dialogueTrack(2, 200)))).toBeUndefined();
  });

  it("counts the 60 % against cues that have a line", () => {
    const short = replaceText(dialogueTrack(1, 10), [1, 3, 5, 7, 9], "[DOOR SLAMS]");
    const lines = toFixCues(short);

    expect(applyFix(short, lines.slice(0, 3))?.matched).toBe(3);
    expect(applyFix(short, lines.slice(0, 2))).toBeUndefined();
  });

  it("returns undefined for a subtitle with no lines to match", () => {
    expect(
      applyFix(
        replaceText(
          dialogue,
          dialogue.map((_, index) => index),
          "[DOOR SLAMS]",
        ),
        fix,
      ),
    ).toBeUndefined();
  });
});
