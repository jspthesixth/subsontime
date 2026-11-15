import type { Cue } from "./cue.ts";

const minimumLineLength = 8;

export const normalizedLine = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

export const uniqueLines = (cues: Cue[]) => {
  const lines = cues.map((cue) => normalizedLine(cue.text));
  const counts = Map.groupBy(lines, (line) => line);

  return new Map(
    lines.flatMap((line, index) =>
      line.length >= minimumLineLength && counts.get(line)?.length === 1
        ? [[line, index] as const]
        : [],
    ),
  );
};
