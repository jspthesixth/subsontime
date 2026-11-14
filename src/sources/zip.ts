import { unzipSync } from "fflate";

const subtitleEntry = /\.(srt|sub|ass|ssa|vtt)$/i;

export const pickSubtitleEntry = (zip: Uint8Array, episodeTag?: string): Uint8Array => {
  const entries = Object.entries(unzipSync(zip)).filter(([name]) => subtitleEntry.test(name));
  const tagged =
    episodeTag === undefined
      ? undefined
      : entries.find(([name]) => new RegExp(`${episodeTag}(?!\\d)`, "i").test(name));
  const largest = entries.toSorted(([, a], [, b]) => b.length - a.length)[0];
  const entry = (tagged ?? largest)?.[1];

  if (entry === undefined) {
    throw new Error("No subtitle entry");
  }

  return entry;
};
