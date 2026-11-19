import { probed, probeKeyOf } from "../files/probe.ts";
import type { SharedState } from "../jobs/shared-state.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import type { Candidate, Source } from "./source.ts";

export const fileSourceName = "Your file";

const changesMark = "#changes";

export const isFileChanges = (ref: string) => ref.endsWith(changesMark);

export const fileSource = (manifestURLs: string[], state: SharedState): Source => ({
  name: fileSourceName,
  async search(query) {
    const key = probeKeyOf(manifestURLs, query);
    const tracks = (await probed(state, key))?.tracks ?? [];

    return tracks.length === 0
      ? []
      : query.languages.map((lang): Candidate => {
          const own = tracks.findIndex(({ language }) => language === lang);
          const index = own === -1 ? 0 : own;

          return {
            sourceName: fileSourceName,
            ref: `${key}#${index}${tracks[index]?.changes === true ? changesMark : ""}`,
            lang,
            release: parseRelease(query.filename ?? ""),
            releaseName: query.filename,
            hashMatch: true,
          };
        });
  },
  async download(ref) {
    const [key = "", index = ""] = ref.split("#");

    const track = (await probed(state, key))?.tracks[Number(index)];

    if (track === undefined) {
      throw new Error("The file's timing is no longer known");
    }

    return new TextEncoder().encode(
      writeSRT(track.cues.map(([start, end]) => ({ start, end, text: "…" }))),
    );
  },
});
