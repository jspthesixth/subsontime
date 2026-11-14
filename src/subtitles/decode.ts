import { detect } from "chardet";
import iconv from "iconv-lite";
import { SubtitleError } from "./cue.ts";

const binaryProbeSize = 8192;
const magicNumbers = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x52, 0x61, 0x72, 0x21],
  [0x1f, 0x8b],
];
const encodingAliases: Record<string, string> = {
  "ISO-8859-2": "windows-1250",
  "ISO-8859-5": "windows-1251",
  "KOI8-R": "windows-1251",
};

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

const stripBOM = (text: string) => (text.startsWith("﻿") ? text.slice(1) : text);

export const decodeSubtitle = (bytes: Uint8Array): string => {
  if (bytes.length === 0) {
    throw new SubtitleError("Subtitle file is empty");
  }

  const bom = bomEncoding(bytes);

  if (bom !== undefined) {
    return stripBOM(iconv.decode(Buffer.from(bytes), bom));
  }

  if (isBinary(bytes)) {
    throw new SubtitleError("Subtitle file is binary");
  }

  if (isValidUTF8(bytes)) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  const detected = detect(bytes) ?? "windows-1252";

  return iconv.decode(Buffer.from(bytes), encodingAliases[detected] ?? detected);
};
