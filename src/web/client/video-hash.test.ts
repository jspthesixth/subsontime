import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hashFile } from "../../../scripts/probes/opensubtitles-v3-hash.ts";
import { seededRandom } from "../../timing/test-tracks.ts";
import { videoHash } from "./video-hash.ts";

const random = seededRandom(14);
const bytes = Uint8Array.from({ length: 200 * 1024 }, () => Math.floor(random() * 256));

const onDisk = async (content: Uint8Array) => {
  const folder = await mkdtemp(join(tmpdir(), "video-hash-"));
  const file = join(folder, "video.bin");

  await writeFile(file, content);

  try {
    return await hashFile(file);
  } finally {
    await rm(folder, { recursive: true });
  }
};

describe("videoHash", () => {
  it("hashes a 200 KB blob like the probe hashes the same bytes on disk", async () => {
    const expected = { hash: "e5b3fd07a0e57c89", size: 204800 };

    expect(await videoHash(new Blob([bytes]))).toEqual(expected);
    expect(await onDisk(bytes)).toEqual(expected);
  });

  it("hashes a file shorter than one chunk", async () => {
    const zeros = new Uint8Array(1000);
    const expected = { hash: "00000000000003e8", size: 1000 };

    expect(await videoHash(new Blob([zeros]))).toEqual(expected);
    expect(await onDisk(zeros)).toEqual(expected);
  });
});
