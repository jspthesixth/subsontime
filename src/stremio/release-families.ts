import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import { releaseSignatureOf, type ReleaseFamily } from "../subtitles/release.ts";

const familySeconds = 90 * 24 * 60 * 60;

const familySchema = v.object({
  source: v.optional(v.picklist(["bluray", "web-dl", "webrip", "hdtv", "dvdrip"])),
  group: v.string(),
});

export const releaseFamilyKeyOf = (imdbId: string, filename: string) => {
  const signature = releaseSignatureOf(filename);

  return signature === undefined ? undefined : `fam:${imdbId}:${signature}`;
};

export const recordReleaseFamily = (state: SharedState, key: string, family: ReleaseFamily) =>
  orMiss(() => state.set(key, JSON.stringify(family), familySeconds), undefined);

export const recalledReleaseFamily = async (
  state: SharedState,
  key: string,
): Promise<ReleaseFamily | undefined> => {
  const parsed = v.safeParse(
    familySchema,
    parseJSON((await orMiss(() => state.get(key), undefined)) ?? ""),
  );

  return parsed.success ? parsed.output : undefined;
};
