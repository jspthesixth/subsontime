import type { Probe, ProbeOutcome } from "../files/probe.ts";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";

const countSeconds = 35 * 24 * 60 * 60;

const dayOf = () => new Date().toISOString().slice(0, 10);

const clients: [RegExp, string][] = [
  [/Tizen|SMART-TV/i, "samsung"],
  [/Web0S|webOS|NetCast/i, "lg"],
  [/Android.*\b(TV|AFT\w*|BRAVIA|SHIELD)\b/i, "android-tv"],
  [/Android|okhttp|Dalvik/i, "android"],
  [/iPhone|iPad/i, "ios"],
  [/Electron|QtWebEngine|StremioShell/i, "desktop"],
  [/Mozilla/i, "browser"],
];

export type FileSent = "hash" | "filename" | "neither";

export const fileSentOf = (hash: boolean, filename: boolean): FileSent => {
  if (hash) {
    return "hash";
  }

  return filename ? "filename" : "neither";
};

export const clientOf = (userAgent = "") =>
  clients.find(([pattern]) => pattern.test(userAgent))?.[1] ?? "other";

export const countListing = (state: SharedState, client: string, sent: FileSent) =>
  orMiss(() => state.increment(`count:${dayOf()}:${client}:${sent}`, countSeconds), 0);

const trackKindOf = (probe: Probe | undefined) => {
  const [track] = probe?.tracks ?? [];

  if (track === undefined) {
    return "no-track";
  }

  return track.changes === true ? "changes" : "lines";
};

export const countProbe = (
  state: SharedState,
  outcome: ProbeOutcome | "failed",
  probe: Probe | undefined,
) =>
  orMiss(
    () => state.increment(`probe:${dayOf()}:${outcome}:${trackKindOf(probe)}`, countSeconds),
    0,
  );
