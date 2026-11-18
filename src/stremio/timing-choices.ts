import { createHash } from "node:crypto";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { Release } from "../subtitles/release.ts";

export const timingChoices = ["best", "bluray", "web", "dvd"] as const;

export type TimingChoice = (typeof timingChoices)[number];

export const releaseChoices: {
  choice: Exclude<TimingChoice, "best">;
  label: string;
  release: Release;
}[] = [
  {
    choice: "bluray",
    label: "BluRay timing",
    release: { source: "bluray", resolution: "1080p", extended: false },
  },
  {
    choice: "web",
    label: "WEB timing",
    release: { source: "web-dl", resolution: "1080p", extended: false },
  },
  { choice: "dvd", label: "DVD timing", release: { source: "dvdrip", extended: false } },
];

const pickSeconds = 60 * 24 * 60 * 60;

const pickKey = (installId: string, imdbId: string, season: number) =>
  `pick:${createHash("sha256")
    .update(JSON.stringify([installId, imdbId, season]))
    .digest("base64url")}`;

export const recordPick = (
  state: SharedState,
  installId: string,
  imdbId: string,
  season: number,
  choice: TimingChoice,
) => orMiss(() => state.set(pickKey(installId, imdbId, season), choice, pickSeconds), undefined);

export const recalledPick = async (
  state: SharedState,
  installId: string,
  imdbId: string,
  season: number,
) => {
  const parsed = v.safeParse(
    v.picklist(timingChoices),
    await orMiss(() => state.get(pickKey(installId, imdbId, season)), undefined),
  );

  return parsed.success ? parsed.output : undefined;
};
