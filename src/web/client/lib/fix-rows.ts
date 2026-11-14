import type { HiddenView, VideoTimings } from "../../../timings/confirm.ts";

export type FixRowView = {
  lines: string;
  subtitle: string;
  fix: string;
  foundBy: string;
  status: string;
  accent: boolean;
};

const numberFormat = new Intl.NumberFormat("en");
const shortId = (id: string) => id.slice(0, 8);

const hiddenRow = ({ subtitleSketch, reason, count }: HiddenView): FixRowView => ({
  lines: "-",
  subtitle: shortId(subtitleSketch[0] ?? ""),
  fix: "none",
  foundBy: `${count} agree`,
  status: reason === "mismatch" ? "Wrong video" : "Reported",
  accent: false,
});

export const fixRows = ({ fixes, hidden }: VideoTimings): FixRowView[] => [
  ...fixes.map(({ id, status, agreeing, fromAudio, cueCount }) => ({
    lines: numberFormat.format(cueCount),
    subtitle: shortId(id),
    fix: [`${numberFormat.format(cueCount)} lines`, ...(fromAudio ? ["from audio"] : [])].join(
      " · ",
    ),
    foundBy: agreeing === 1 ? "1 submission" : `${agreeing} agree`,
    status: status === "confirmed" ? "Confirmed" : "Hint",
    accent: status === "confirmed",
  })),
  ...hidden.map(hiddenRow),
];
