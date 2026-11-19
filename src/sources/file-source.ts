import * as v from "valibot";
import { probed, probeFile, probeKeyOf } from "../files/probe.ts";
import type { SharedState } from "../jobs/shared-state.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import type { Candidate, Source } from "./source.ts";

export const fileSourceName = "Your file";

const refSchema = v.object({
  type: v.picklist(["movie", "series"]),
  imdbId: v.string(),
  season: v.optional(v.number()),
  episode: v.optional(v.number()),
  filename: v.optional(v.string()),
  videoSize: v.optional(v.number()),
  languages: v.array(v.string()),
  track: v.number(),
  changes: v.optional(v.literal(true)),
});

const refOf = (ref: string) => {
  const parsed = v.safeParse(v.pipe(v.string(), v.parseJson(), refSchema), ref);

  return parsed.success ? parsed.output : undefined;
};

export const isFileChanges = (ref: string) => refOf(ref)?.changes === true;

export const fileSource = (manifestURLs: string[], state: SharedState): Source => ({
  name: fileSourceName,
  async search(query) {
    const { type, imdbId, season, episode, filename, videoSize, languages } = query;

    const tracks = (await probed(state, probeKeyOf(manifestURLs, query)))?.tracks ?? [];

    return tracks.length === 0
      ? []
      : languages.map((lang): Candidate => {
          const own = tracks.findIndex(({ language }) => language === lang);
          const track = own === -1 ? 0 : own;

          return {
            sourceName: fileSourceName,
            ref: JSON.stringify({
              type,
              imdbId,
              season,
              episode,
              filename,
              videoSize: filename === undefined ? videoSize : undefined,
              languages,
              track,
              changes: tracks[track]?.changes,
            }),
            lang,
            release: parseRelease(filename ?? ""),
            releaseName: filename,
            hashMatch: true,
          };
        });
  },
  async download(ref, signal) {
    const played = refOf(ref);
    const probe =
      played === undefined ? undefined : await probeFile(manifestURLs, played, state, signal);
    const track = played === undefined ? undefined : probe?.tracks[played.track];

    if (track === undefined) {
      throw new Error("The file has no subtitle track to time to");
    }

    return new TextEncoder().encode(
      writeSRT(track.cues.map(([start, end]) => ({ start, end, text: "…" }))),
    );
  },
});
