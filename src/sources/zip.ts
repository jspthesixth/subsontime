import { unzipSync } from "fflate";

const subtitleEntry = /\.(srt|sub|ass|ssa|vtt)$/i;
const maximumEntryBytes = 5 * 1024 * 1024;
const maximumTotalBytes = 20 * 1024 * 1024;

const subtitleEntriesOf = (zip: Uint8Array) => {
  let declared = 0;

  const files = unzipSync(zip, {
    filter: ({ name, originalSize }) => {
      if (!subtitleEntry.test(name) || originalSize > maximumEntryBytes) {
        return false;
      }

      declared += originalSize;

      if (declared > maximumTotalBytes) {
        throw new Error("Subtitle archive too large");
      }

      return true;
    },
  });

  return Object.entries(files).filter(([, data]) => data.length <= maximumEntryBytes);
};

export const pickSubtitleEntry = (zip: Uint8Array, episodeTag?: string): Uint8Array => {
  const entries = subtitleEntriesOf(zip);
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
