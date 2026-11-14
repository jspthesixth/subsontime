import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import * as v from "valibot";
import { openSubtitlesHash } from "../../src/video-hash.ts";

const shownEntries = 6;
const usage =
  "usage: node --experimental-strip-types scripts/probes/opensubtitles-v3-hash.ts <video file> <imdb id>";

const SubtitlesResponse = v.object({
  subtitles: v.array(
    v.object({
      m: v.string(),
      lang: v.optional(v.string()),
      subtitleFileName: v.optional(v.string()),
    }),
  ),
});

export const hashFile = async (file: string) => {
  const { size } = await stat(file);
  const handle = await open(file, "r");

  try {
    const read = async (position: number, length: number) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, position);

      return buffer.subarray(0, bytesRead);
    };

    return { size, hash: await openSubtitlesHash(size, read) };
  } finally {
    await handle.close();
  }
};

const main = async () => {
  const [file, imdb] = process.argv.slice(2);

  if (file === undefined || imdb === undefined) {
    throw new Error(usage);
  }

  const { size, hash } = await hashFile(file);
  const name = basename(file);
  const url = `https://opensubtitles-v3.strem.io/subtitles/movie/${encodeURIComponent(imdb)}/videoHash=${hash}&videoSize=${size}&filename=${encodeURIComponent(name)}.json`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} from the v3 addon`);
  }

  const { subtitles } = v.parse(SubtitlesResponse, await response.json());
  const groups = Object.groupBy(subtitles, (subtitle) => subtitle.m);
  const counts = Object.fromEntries(Object.entries(groups).map(([m, list]) => [m, list?.length]));
  const hashed = subtitles.filter((subtitle) => subtitle.m !== "i").slice(0, shownEntries);

  console.log(name, hash, "total", subtitles.length, JSON.stringify(counts));

  for (const subtitle of hashed) {
    console.log("   ", `${subtitle.m} ${subtitle.lang} ${subtitle.subtitleFileName}`);
  }
};

if (import.meta.main) {
  await main();
}
