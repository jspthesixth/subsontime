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

const microDVDLine = /^\{(\d+)\}\{(\d*)\}(.*)$/;
const defaultFrameRate = 23.976;

const microDVDOf = (text: string) => {
  const lines = text
    .split(/\r\n?|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const entries = lines.flatMap((line) => {
    const [, start = "0", end = "", body = ""] = microDVDLine.exec(line) ?? [];

    return microDVDLine.test(line)
      ? [{ start: Number(start), end: Number(end || start), body }]
      : [];
  });
  const [first] = entries;

  if (first === undefined || !microDVDLine.test(lines[0] ?? "")) {
    return undefined;
  }

  const declared = first.start <= 1 && /^\d+(\.\d+)?$/.test(first.body) ? Number(first.body) : 0;
  const frameRate = declared > 0 ? declared : defaultFrameRate;
  const msOf = (frame: number) => Math.round((frame / frameRate) * 1000);

  return entries.slice(declared > 0 ? 1 : 0).map(({ start, end, body }) => ({
    start: msOf(start),
    end: msOf(end),
    content: body.replaceAll("|", "\n"),
  }));
};

const captionsOf = (text: string) => {
  try {
    return parse(text).flatMap((caption) =>
      caption.type === "caption"
        ? [{ start: caption.start, end: caption.end, content: caption.content }]
        : [],
    );
  } catch {
    return [];
  }
};

export const parseSubtitle = (text: string): Cue[] => {
  const cues = (microDVDOf(text) ?? captionsOf(text))
    .map(({ start, end, content }) => ({ start, end, text: stripMarkup(content) }))
    .filter((cue) => cue.text !== "")
    .toSorted((a, b) => a.start - b.start);

  if (cues.length === 0) {
    throw new SubtitleError("No subtitle lines found");
  }

  return cues;
};
