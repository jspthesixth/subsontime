import { createHash } from "node:crypto";
import { dialogueTrack } from "../timing/test-tracks.ts";
import { digest as digestWith, summarize as summarizeWith } from "./confirm.ts";
import { subtitleKey, type FixRow, type MismatchRow, type NewFix, type ReportRow } from "./db.ts";
import { toFixCues, type FixCue } from "./fingerprint.ts";
import { groupingKeyOf } from "./submitter.ts";

export const video = { hash: "0123456789abcdef", size: 7_345_678_901 };
export const alice = "a".repeat(32);

let clock = Date.UTC(2026, 10, 1);

export const nextTime = () => {
  clock += 1000;

  return new Date(clock);
};

export const subtitle = (seed: number, count = 40) => toFixCues(dialogueTrack(seed, count));

export const shifted = (cues: FixCue[], by: number) =>
  cues.map((cue) => ({ ...cue, s: cue.s + by, e: cue.e + by }));

export const hashesOf = (cues: FixCue[]) => cues.map((cue) => cue.h);

export const originOf = (submitter: string) => submitter.slice(-16);

export const submitterAt = (index: number) => index.toString(16).padStart(32, "0");

export const idOf = (cues: FixCue[]) => subtitleKey(hashesOf(cues));

export const hashLike = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

export const fix = (cues: FixCue[], overrides: Partial<NewFix> = {}): FixRow => ({
  video,
  subtitleHashes: hashesOf(cues),
  cues,
  method: "audio",
  submitter: alice,
  origin: originOf(overrides.submitter ?? alice),
  ...overrides,
  createdAt: nextTime(),
});

const groupingKey = groupingKeyOf("s".repeat(32));

export const summarize = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  viewer?: string,
) => summarizeWith(fixes, mismatches, reports, { groupingKey, viewer });

export const digest = (fixes: FixRow[], mismatches: MismatchRow[], reports: ReportRow[]) =>
  digestWith(fixes, mismatches, reports, groupingKey);

export const fixesOnly = (fixes: FixRow[]) => summarize(fixes, [], []).fixes;
