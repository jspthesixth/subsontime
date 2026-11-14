import { parse } from "subsrt-ts";
import { SubtitleError, type Cue } from "./cue.ts";

const entities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: "\u00A0",
};

const codePointOf = (name: string) =>
  /^#x/i.test(name) ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);

const decodeEntity = (entity: string, name: string) => {
  if (!name.startsWith("#")) {
    return entities[name.toLowerCase()] ?? entity;
  }

  const codePoint = codePointOf(name);

  return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
};

export const stripMarkup = (text: string) =>
  text
    .replace(/\r\n?/g, "\n")
    .replace(/\{[^}]*\}/g, "")
    .replace(/\\[Nn]/g, "\n")
    .replace(/\\h/g, " ")
    .replace(/<\/?[a-zA-Z][^<>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, decodeEntity)
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
        ? [{ start: caption.start, end: caption.end, text: stripMarkup(caption.content) }]
        : [],
    )
    .filter((cue) => cue.text !== "")
    .toSorted((a, b) => a.start - b.start);

  if (cues.length === 0) {
    throw new SubtitleError("No subtitle lines found");
  }

  return cues;
};
