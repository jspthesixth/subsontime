import { createHash } from "node:crypto";
import { dialogueTrack } from "../timing/test-tracks.ts";
import { digest as digestWith, present } from "./confirm.ts";
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

export const summarizeWith = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  { groupingKey: key, viewer }: { groupingKey: Buffer; viewer?: string },
) => present(digestWith(fixes, mismatches, reports, key), viewer);

export const summarize = (
  fixes: FixRow[],
  mismatches: MismatchRow[],
  reports: ReportRow[],
  viewer?: string,
) => summarizeWith(fixes, mismatches, reports, { groupingKey, viewer });

export const digest = (fixes: FixRow[], mismatches: MismatchRow[], reports: ReportRow[]) =>
  digestWith(fixes, mismatches, reports, groupingKey);

export const fixesOnly = (fixes: FixRow[]) => summarize(fixes, [], []).fixes;

export const mostlyAgreeingFixes = () => {
  const cues = subtitle(7, 2000);

  return Array.from({ length: 500 }, (_, index) =>
    fix(index % 10 === 0 ? shifted(cues, 1000 + index * 250) : shifted(cues, index % 50), {
      submitter: submitterAt(index),
    }),
  );
};

export const nearIdenticalFixes = () => {
  const cues = subtitle(8, 2000);

  return Array.from({ length: 500 }, (_, index) => {
    const edited = cues.map((cue, at) =>
      at % 20 === index % 20 ? { ...cue, h: hashLike(`${index}-${at}`) } : cue,
    );

    return fix(shifted(index === 0 ? cues : edited, index * 150), {
      submitter: submitterAt(index),
    });
  });
};

const edited = (base: FixCue[], index: number, edit: (at: number) => boolean) =>
  base.map((cue, at) => (edit(at) ? { ...cue, h: hashLike(`${index}-${at}`) } : cue));

export const partlySimilarFixes = () => {
  const base = subtitle(9, 2000);

  return Array.from({ length: 500 }, (_, index) =>
    fix(
      shifted(
        edited(base, index, (at) => at < 200),
        index * 150,
      ),
      { submitter: submitterAt(index) },
    ),
  );
};

export const differentFixes = () => {
  const base = subtitle(9, 2000);

  return Array.from({ length: 500 }, (_, index) =>
    fix(
      edited(base, index, () => true),
      { submitter: submitterAt(index) },
    ),
  );
};
