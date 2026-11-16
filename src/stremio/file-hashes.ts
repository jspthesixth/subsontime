import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { candidateKey, candidateRefSchema, type CandidateRef, type SubtitleRef } from "./refs.ts";

const recordSeconds = 4 * 60 * 60;

const fileHashSchema = v.object({
  w: v.object({ h: v.string(), z: v.number() }),
  x: v.array(candidateRefSchema),
  a: v.optional(v.array(candidateRefSchema)),
  m: v.array(v.tuple([v.string(), v.string()])),
  d: v.optional(v.string()),
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
    v.pipe(v.string(), v.parseJson(), fileHashSchema),
    (await orMiss(() => state.get(`fh:${key}`), undefined)) ?? "",
  );

  return parsed.success ? parsed.output : undefined;
};

export const withFileHash = (ref: SubtitleRef, { w, x, a, m, d }: FileHash): SubtitleRef => {
  const matched = new Set(m.map(([source, id]) => candidateKey(source, id)));
  const flagged = (candidates: CandidateRef[]) =>
    candidates
      .map((candidate) =>
        matched.has(candidateKey(candidate.n, candidate.r))
          ? { ...candidate, h: 1 as const }
          : { ...candidate, h: undefined },
      )
      .toSorted((left, right) => Number(right.h === 1) - Number(left.h === 1));

  return {
    ...ref,
    c: flagged(ref.c),
    s: ref.s === undefined ? undefined : flagged(ref.s),
    x,
    a: a ?? ref.a,
    w,
    d,
    k: undefined,
  };
};
