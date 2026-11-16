import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import * as v from "valibot";

const signatureLength = 16;

export const candidateRefSchema = v.object({
  n: v.string(),
  r: v.string(),
  l: v.string(),
  h: v.optional(v.literal(1)),
  p: v.optional(v.number()),
});

const subtitleRefSchema = v.object({
  v: v.literal(1),
  q: v.object({
    t: v.picklist(["movie", "series"]),
    i: v.string(),
    s: v.optional(v.number()),
    e: v.optional(v.number()),
  }),
  c: v.array(candidateRefSchema),
  x: v.array(candidateRefSchema),
  a: v.optional(v.array(candidateRefSchema)),
  w: v.optional(v.object({ h: v.string(), z: v.number() })),
  k: v.optional(v.string()),
  d: v.optional(v.string()),
  t: v.optional(v.literal("dialogue")),
});

export const candidateKey = (sourceName: string, ref: string) => JSON.stringify([sourceName, ref]);

export type CandidateRef = v.InferOutput<typeof candidateRefSchema>;
export type SubtitleRef = v.InferOutput<typeof subtitleRefSchema>;

export const refKey = (secret: string): Buffer =>
  createHash("sha256").update(`subsontime-ref:${secret}`).digest();

const sign = (payload: string, key: Buffer) =>
  createHmac("sha256", key).update(payload).digest().subarray(0, signatureLength);

export const encodeRef = (value: SubtitleRef, key: Buffer): string => {
  const payload = Buffer.from(JSON.stringify(value)).toString("base64url");

  return `${payload}.${sign(payload, key).toString("base64url")}`;
};

const isSigned = (payload: string, signature: string, key: Buffer) => {
  const expected = sign(payload, key);
  const actual = Buffer.from(signature, "base64url");

  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const decodeRef = (text: string, key: Buffer): SubtitleRef => {
  const [payload = "", signature = "", ...rest] = text.split(".");

  try {
    if (rest.length > 0 || !isSigned(payload, signature, key)) {
      throw new Error("Unsigned");
    }

    return v.parse(
      subtitleRefSchema,
      JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
    );
  } catch {
    throw new Error("Invalid subtitle reference");
  }
};
