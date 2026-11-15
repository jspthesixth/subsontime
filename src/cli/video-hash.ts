import { open } from "node:fs/promises";
import { openSubtitlesHash } from "../video-hash.ts";

export const fileFingerprint = async (path: string) => {
  const file = await open(path);

  try {
    const { size } = await file.stat();
    const hash = await openSubtitlesHash(size, async (start, length) => {
      const buffer = Buffer.alloc(Math.max(0, Math.min(length, size - start)));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);

      return buffer.subarray(0, bytesRead);
    });

    return { hash, size };
  } finally {
    await file.close();
  }
};
