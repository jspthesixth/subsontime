import * as v from "valibot";
import type { HiddenView, VideoTimings } from "../../../timings/confirm.ts";

export type FixRowView = {
  subtitle: string;
  lines: string;
  timedBy: string;
  agreement: string;
  status: string;
  accent: boolean;
};

const numberFormat = new Intl.NumberFormat("en");
const methodNames: Record<string, string> = {
  audio: "Audio",
  reference: "Reference",
  "release-name": "Release name",
};

const timingsSchema = v.object({
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

const shortId = (id: string) => id.slice(0, 8);

const hiddenRow = ({ subtitleSketch, reason, count }: HiddenView): FixRowView => ({
  subtitle: shortId(subtitleSketch[0] ?? ""),
  lines: "-",
  timedBy: "-",
  agreement: `${count} agree`,
  status: reason === "mismatch" ? "Wrong video" : "Reported",
  accent: false,
});

export const fixRows = ({ fixes, hidden }: VideoTimings): FixRowView[] => [
  ...fixes.map(({ id, status, method, agreeing, cueCount }) => ({
    subtitle: shortId(id),
    lines: numberFormat.format(cueCount),
    timedBy: methodNames[method] ?? method,
    agreement: agreeing === 1 ? "1 submission" : `${agreeing} agree`,
    status: status === "confirmed" ? "Confirmed" : "Hint",
    accent: status === "confirmed",
  })),
  ...hidden.map(hiddenRow),
];
