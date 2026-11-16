import * as v from "valibot";
import type { VideoTimings } from "./confirm.ts";

export const timingsSchema = v.object({
  fixes: v.array(
    v.object({
      id: v.string(),
      subtitleSketch: v.array(v.string()),
      status: v.picklist(["confirmed", "hint"]),
      method: v.string(),
      agreeing: v.number(),
      fromAudio: v.boolean(),
      cueCount: v.number(),
    }),
  ),
  hidden: v.array(
    v.object({
      subtitleSketch: v.array(v.string()),
      reason: v.picklist([
        "mismatch",
        "machine-translated",
        "wrong-language",
        "lines-missing",
        "timing-off",
        "broken-characters",
      ]),
      count: v.number(),
    }),
  ),
});

export const timingsOf = (body: unknown): VideoTimings | undefined => {
  const parsed = v.safeParse(timingsSchema, body);

  return parsed.success ? parsed.output : undefined;
};
