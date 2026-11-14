import iconv from "iconv-lite";
import { SubtitleError } from "./cue.ts";

const binaryProbeSize = 8192;
const magicNumbers = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x52, 0x61, 0x72, 0x21],
  [0x1f, 0x8b],
];
const balkanLanguages = new Set(["hrv", "bos", "slv", "srp", "mkd", "cnr"]);
const codePageByLanguage: Record<string, string> = Object.fromEntries(
  [
    ["windows-1251", ["rus", "ukr", "bel", "bul"]],
    ["windows-1253", ["ell", "gre"]],
    ["windows-1254", ["tur"]],
    ["windows-1255", ["heb"]],
    ["windows-1256", ["ara", "per", "fas"]],
    ["windows-1250", ["pol", "ces", "cze", "slk", "slo", "hun", "ron", "rum"]],
  ].flatMap(([codePage, languages]) =>
    (languages as string[]).map((language) => [language, codePage as string]),
  ),
);

const startsWith = (bytes: Uint8Array, prefix: number[]) =>
  prefix.every((byte, index) => bytes[index] === byte);

const isBinary = (bytes: Uint8Array) =>
  magicNumbers.some((magic) => startsWith(bytes, magic)) ||
  bytes.subarray(0, binaryProbeSize).includes(0);

const isValidUTF8 = (bytes: Uint8Array) => {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);

    return true;
  } catch {
    return false;
  }
};

const bomEncoding = (bytes: Uint8Array) => {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) {
    return "utf-8";
  }

  if (startsWith(bytes, [0xff, 0xfe])) {
    return "utf-16le";
  }

  if (startsWith(bytes, [0xfe, 0xff])) {
    return "utf-16be";
  }

  return undefined;
};

const decodeWith = (bytes: Uint8Array, pickEncoding: () => string) => {
  try {
    return stripBOM(iconv.decode(Buffer.from(bytes), pickEncoding()));
  } catch {
    throw new SubtitleError("Could not decode subtitle");
  }
};

const stripBOM = (text: string) => (text.startsWith("\uFEFF") ? text.slice(1) : text);

const cyrillicShare = (text: string) => {
  const letters = text.match(/\p{L}/gu) ?? [];
  const cyrillic = letters.filter((letter) => /[\u0400-\u04FF]/.test(letter));

  return cyrillic.length / Math.max(letters.length, 1);
};

const balkanCodePage = (bytes: Uint8Array) =>
  cyrillicShare(iconv.decode(Buffer.from(bytes), "windows-1251")) > 0.5
    ? "windows-1251"
    : "windows-1250";

const legacyCodePage = (bytes: Uint8Array, lang?: string) => {
  if (lang === undefined || balkanLanguages.has(lang)) {
    return balkanCodePage(bytes);
  }

  return codePageByLanguage[lang] ?? "windows-1252";
};

export const decodeSubtitle = (bytes: Uint8Array, lang?: string): string => {
  if (bytes.length === 0) {
    throw new SubtitleError("Subtitle file is empty");
  }

  const bom = bomEncoding(bytes);

  if (bom !== undefined) {
    return decodeWith(bytes, () => bom);
  }

  if (isBinary(bytes)) {
    throw new SubtitleError("Subtitle file is binary");
  }

  if (isValidUTF8(bytes)) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  return decodeWith(bytes, () => legacyCodePage(bytes, lang));
};
