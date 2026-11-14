import type { FixRow, MismatchRow, NewReport, ReportRow } from "./db.ts";
import type { CueHash, FixCue } from "./fingerprint.ts";

export type ReportReason = NewReport["reason"];

export type FixView = {
  subtitleHashes: CueHash[];
  cues: FixCue[];
  status: "confirmed" | "hint";
  method: string;
  agreeing: number;
  fromAudio: boolean;
};

export type HiddenView = {
  subtitleHashes: CueHash[];
  reason: "mismatch" | ReportReason;
  count: number;
};

export type VideoTimings = { fixes: FixView[]; hidden: HiddenView[] };

export const summarize = (
  fixes: FixRow[],
  _mismatches: MismatchRow[],
  _reports: ReportRow[],
  _viewer?: string,
): VideoTimings => ({
  fixes: fixes.map((fix) => ({
    subtitleHashes: fix.subtitleHashes,
    cues: fix.cues,
    status: "hint",
    method: fix.method,
    agreeing: 1,
    fromAudio: fix.method === "audio",
  })),
  hidden: [],
});
