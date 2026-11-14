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
const dialogue = dialogueTrack(1, 200);
const fix = toFixCues(transform(withSoundDescriptions(dialogue), move));
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
