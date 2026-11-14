import { open, stat, type FileHandle } from "node:fs/promises";
import { basename } from "node:path";
import * as v from "valibot";

const chunkBytes = 65536;
const wordBytes = 8;
const mask64 = 0xffffffffffffffffn;
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

const readChunk = async (handle: FileHandle, position: number) => {
  const buffer = Buffer.alloc(chunkBytes);
  const { bytesRead } = await handle.read(buffer, 0, chunkBytes, position);

  return buffer.subarray(0, bytesRead);
};

const addWords = (sum: bigint, chunk: Buffer) => {
  let total = sum;

  for (let offset = 0; offset + wordBytes <= chunk.length; offset += wordBytes) {
    total = (total + chunk.readBigUInt64LE(offset)) & mask64;
  }

  return total;
};

const hashFile = async (file: string) => {
  const { size } = await stat(file);
  const handle = await open(file, "r");

  try {
    const head = await readChunk(handle, 0);
    const tail = await readChunk(handle, Math.max(0, size - chunkBytes));
    const sum = [head, tail].reduce(addWords, BigInt(size));

    return { size, hash: sum.toString(16).padStart(16, "0") };
  } finally {
    await handle.close();
  }
};

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
