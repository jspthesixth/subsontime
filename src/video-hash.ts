const chunkBytes = 65536;
const wordBytes = 8;
const mask64 = 0xffffffffffffffffn;

export type ReadBytes = (start: number, length: number) => Promise<Uint8Array>;

const addWords = (sum: bigint, chunk: Uint8Array) => {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  const offsets = Array.from(
    { length: Math.floor(chunk.byteLength / wordBytes) },
    (_, index) => index * wordBytes,
  );

  return offsets.reduce((total, offset) => (total + view.getBigUint64(offset, true)) & mask64, sum);
};

export const openSubtitlesHash = async (size: number, read: ReadBytes) => {
  const head = await read(0, chunkBytes);
  const tail = await read(Math.max(0, size - chunkBytes), chunkBytes);

  return [head, tail].reduce(addWords, BigInt(size)).toString(16).padStart(16, "0");
};
