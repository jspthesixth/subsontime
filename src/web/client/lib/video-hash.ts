import { openSubtitlesHash } from "../../../video-hash.ts";

export const videoHash = async (file: Blob): Promise<{ hash: string; size: number }> => ({
  hash: await openSubtitlesHash(
    file.size,
    async (start, length) => new Uint8Array(await file.slice(start, start + length).arrayBuffer()),
  ),
  size: file.size,
});
