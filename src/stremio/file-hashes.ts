import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import { candidateRefSchema, type SubtitleRef } from "./refs.ts";

const recordSeconds = 4 * 60 * 60;

const fileHashSchema = v.object({
  w: v.object({ h: v.string(), z: v.number() }),
  x: v.array(candidateRefSchema),
  m: v.array(v.string()),
});

export type FileHash = v.InferOutput<typeof fileHashSchema>;

export const fileKeyOf = (install: string, video: SubtitleRef["q"], filename: string) =>
  createHash("sha256")
    .update(JSON.stringify([install, video.t, video.i, video.s, video.e, filename]))
    .digest("base64url");

export const recordFileHash = (state: SharedState, key: string, fileHash: FileHash) =>
  orMiss(() => state.set(`fh:${key}`, JSON.stringify(fileHash), recordSeconds), undefined);

export const recalledFileHash = async (state: SharedState, key: string) => {
  const parsed = v.safeParse(
    fileHashSchema,
    parseJSON((await orMiss(() => state.get(`fh:${key}`), undefined)) ?? ""),
  );

  return parsed.success ? parsed.output : undefined;
};

export const withFileHash = (ref: SubtitleRef, { w, x, m }: FileHash): SubtitleRef => {
  const matched = new Set(m);

  return {
    ...ref,
    c: ref.c
      .map((candidate) => (matched.has(candidate.r) ? { ...candidate, h: 1 as const } : candidate))
      .toSorted((a, b) => Number(b.h === 1) - Number(a.h === 1)),
    x,
    w,
    k: undefined,
  };
};
