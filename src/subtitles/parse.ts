import { parse } from "subsrt-ts";
import { SubtitleError, type Cue } from "./cue.ts";

const normalizeText = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/<[^>]*>/g, "")
    .trim();

export const parseSubtitle = (text: string): Cue[] => {
  const captions = (() => {
    try {
      return parse(text);
    } catch {
      return [];
    }
  })();

  const cues = captions
    .flatMap((caption) =>
      caption.type === "caption"
        ? [{ start: caption.start, end: caption.end, text: normalizeText(caption.content) }]
        : [],
    )
    .filter((cue) => cue.text !== "")
    .toSorted((a, b) => a.start - b.start);

  if (cues.length === 0) {
    throw new SubtitleError("No subtitle lines found");
  }

  return cues;
};
