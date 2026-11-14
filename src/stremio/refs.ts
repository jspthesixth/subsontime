import * as v from "valibot";

const candidateRefSchema = v.object({
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
    f: v.optional(v.string()),
  }),
  c: v.array(candidateRefSchema),
  x: v.array(candidateRefSchema),
});

export type CandidateRef = v.InferOutput<typeof candidateRefSchema>;
export type SubtitleRef = v.InferOutput<typeof subtitleRefSchema>;

export const encodeRef = (value: SubtitleRef): string =>
  Buffer.from(JSON.stringify(value)).toString("base64url");

export const decodeRef = (text: string): SubtitleRef => {
  try {
    return v.parse(subtitleRefSchema, JSON.parse(Buffer.from(text, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid subtitle reference");
  }
};
