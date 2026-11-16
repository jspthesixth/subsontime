import type { Cue } from "./cue.ts";

const pad = (value: number, width: number) => String(value).padStart(width, "0");

const formatTime = (ms: number) =>
  `${pad(Math.floor(ms / 3_600_000), 2)}:${pad(Math.floor(ms / 60_000) % 60, 2)}:${pad(Math.floor(ms / 1000) % 60, 2)},${pad(Math.floor(ms) % 1000, 3)}`;

export const writeSRT = (cues: Cue[]): string =>
  cues
    .flatMap((cue) => (cue.end <= 0 ? [] : [{ ...cue, start: Math.max(cue.start, 0) }]))
    .map(
      (cue, index) =>
        `${index + 1}\n${formatTime(cue.start)} --> ${formatTime(cue.end)}\n${cue.text}\n`,
    )
    .join("\n");
