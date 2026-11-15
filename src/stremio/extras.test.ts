import { describe, expect, it } from "vitest";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { writeSRT } from "../subtitles/write.ts";
import { syntheticTrack } from "../timing/test-tracks.ts";
import { decodeRef, refKey } from "./refs.ts";
import {
  appWith,
  installed,
  retimedSources,
  secret,
  track,
  type App,
  type Listing,
} from "./test-app.ts";

const dialogueOnly = { ...defaultConfig(["eng"]).extras, dialogueOnly: true };

const listedFor = async (sources: SourceSet, overrides: Partial<Config> = {}) => {
  const app = appWith(sources);
  const { token } = installed({ extras: dialogueOnly, ...overrides });
  const response = await app.request(`/${token}/subtitles/movie/tt0111161.json`);
  const { subtitles } = (await response.json()) as Listing;

  return { app, subtitles };
};

const urlOf = (subtitles: Listing["subtitles"], id: string) =>
  subtitles.find((entry) => entry.id === id)?.url ?? "";

const refOf = (url: string) =>
  decodeRef(
    new URL(url).pathname
      .split("/")
      .at(-1)
      ?.replace(/\.srt$/, "") ?? "",
    refKey(secret),
  );

const fetched = async (app: App, url: string) => {
  const response = await app.request(url);

  return { status: response.status, text: await response.text() };
};

const madeForFile = (text: string[]) => ({
  listed: [
    fakeSource("Fake", [
      {
        ref: "a",
        hashMatch: true,
        cues: text.map((line, index) => ({
          start: index * 1000,
          end: index * 1000 + 900,
          text: line,
        })),
      },
    ]),
  ],
  references: [],
});

describe("dialogue only", () => {
  it("lists a dialogue copy after each language's best entry", async () => {
    const source = fakeSource("Fake", [
      { ref: "e1", lang: "eng" },
      { ref: "e2", lang: "eng" },
      { ref: "h", lang: "hrv" },
    ]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { languages: ["hrv", "eng", "fra"] },
    );

    expect(subtitles.map((entry) => [entry.id, entry.lang])).toEqual([
      ["hrv-best", "hrv"],
      ["hrv-dialogue", "hrv"],
      ["eng-best", "eng"],
      ["eng-dialogue", "eng"],
    ]);
    expect(refOf(urlOf(subtitles, "eng-dialogue"))).toEqual({
      ...refOf(urlOf(subtitles, "eng-best")),
      t: "dialogue",
    });
  });

  it("puts a dialogue copy of the best four right after the first entry when every candidate is listed", async () => {
    const source = fakeSource("Fake", [{ ref: "a" }, { ref: "b" }, { ref: "c" }]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { bestOnly: false },
    );

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-1", "eng-dialogue", "eng-2", "eng-3"]);
    expect(subtitles.map((entry) => entry.label)).toEqual([
      "Fake",
      "Fake (dialogue only)",
      "Fake",
      "Fake",
    ]);
    expect(refOf(urlOf(subtitles, "eng-dialogue")).c).toEqual([
      { n: "Fake", r: "a", l: "eng" },
      { n: "Fake", r: "b", l: "eng" },
      { n: "Fake", r: "c", l: "eng" },
    ]);
  });

  it("serves the best subtitle without its hearing-impaired tags", async () => {
    const { app, subtitles } = await listedFor(
      madeForFile(["[DOOR SLAMS]\nHello.", "(sighs)", "JOHN: Over here.", "♪ la la ♪"]),
    );

    expect(await fetched(app, urlOf(subtitles, "eng-dialogue"))).toEqual({
      status: 200,
      text: writeSRT([
        { start: 0, end: 900, text: "Hello." },
        { start: 2000, end: 2900, text: "Over here." },
      ]),
    });
  });

  it("times the dialogue copy like the best entry", async () => {
    const { app, subtitles } = await listedFor(retimedSources());

    const best = await fetched(app, urlOf(subtitles, "eng-best"));

    expect(best.status).toBe(200);
    expect(await fetched(app, urlOf(subtitles, "eng-dialogue"))).toEqual(best);
  });

  it("answers 404 for a subtitle made only of hearing-impaired tags", async () => {
    const { app, subtitles } = await listedFor(
      madeForFile(["[DOOR SLAMS]", "(sighs)", "♪ la la ♪"]),
    );

    expect(await fetched(app, urlOf(subtitles, "eng-dialogue"))).toEqual({
      status: 404,
      text: "No subtitle fits this file",
    });
    expect((await fetched(app, urlOf(subtitles, "eng-best"))).status).toBe(200);
  });

  it("answers 404 for the dialogue copy of a listed subtitle made for another video", async () => {
    const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Wrong ${cue.text}` }));
    const { app, subtitles } = await listedFor(
      {
        listed: [fakeSource("Fake", [{ ref: "wrong", cues: unrelated }])],
        references: [fakeSource("Reference", [{ ref: "r", hashMatch: true, cues: track }])],
      },
      { bestOnly: false },
    );

    expect(await fetched(app, urlOf(subtitles, "eng-1"))).toEqual({ status: 200, text: "" });
    expect(await fetched(app, urlOf(subtitles, "eng-dialogue"))).toEqual({
      status: 404,
      text: "No subtitle fits this file",
    });
  });
});
