import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import type { SourceSet } from "../sources/from-config.ts";
import { fakeSource, type Entry } from "../sources/test-sources.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { subtitleFixture } from "../subtitles/test-subtitles.ts";
import { writeSRT } from "../subtitles/write.ts";
import { retime } from "../timing/retime.ts";
import { partlyUnrelated, syntheticTrack } from "../timing/test-tracks.ts";
import { decodeRef, refKey } from "./refs.ts";
import {
  appWith,
  installed,
  retimedSources,
  secret,
  shifted,
  track,
  video,
  type App,
  type Listing,
} from "./test-app.ts";

vi.mock("../timing/retime.ts", { spy: true });

const retimeSpy = vi.mocked(retime);

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

const sparse = (cues: typeof track) => cues.filter((_, index) => index % 10 === 0);

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
      f: undefined,
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

  it.each([
    [true, ["eng-best", "OpenSubtitles", ["a", "b"]], ["eng-best-2", "SubDL", ["c"]]],
    [false, ["eng-1", "OpenSubtitles", ["a"]], ["eng-2", "OpenSubtitles", ["b"]]],
  ])(
    "gives the extras the first source's candidates when best-only is %s",
    async (bestOnly, first, second) => {
      const { subtitles } = await listedFor(
        {
          listed: [
            fakeSource("OpenSubtitles", [
              { ref: "a" },
              { ref: "b" },
              { ref: "fa", foreignPartsOnly: true },
              { ref: "ha", lang: "hrv" },
            ]),
            fakeSource("SubDL", [
              { ref: "c" },
              { ref: "fc", foreignPartsOnly: true },
              { ref: "hc", lang: "hrv" },
            ]),
          ],
          references: [fakeSource("Reference", [{ ref: "r", hashMatch: true }])],
        },
        {
          bestOnly,
          extras: { ...dialogueOnly, foreignParts: true, dualLanguage: "hrv" },
        },
      );

      expect(
        subtitles
          .filter(({ id }) => id !== "eng-forced")
          .map(({ id, label, url }) => [id, label, refOf(url).c.map(({ r }) => r)]),
      ).toEqual([
        first,
        ["eng-dialogue", "OpenSubtitles (dialogue only)", ["a", "b"]],
        ["eng+hrv-dual", "OpenSubtitles (with Croatian)", ["a", "b"]],
        second,
        ...(bestOnly ? [] : [["eng-3", "SubDL", ["c"]]]),
      ]);
      expect(
        subtitles
          .filter(({ id }) => id === "eng-forced")
          .map(({ label, url }) => [label, refOf(url).c.map(({ r }) => r)]),
      ).toEqual([["OpenSubtitles (foreign parts only)", ["fa"]]]);
    },
  );

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

describe("foreign parts only", () => {
  const foreignParts = { ...defaultConfig(["eng"]).extras, foreignParts: true };

  it("lists the flagged subtitles after the language's entries and leaves them out of the others", async () => {
    const source = fakeSource("Fake", [
      { ref: "f", foreignPartsOnly: true },
      { ref: "a" },
      { ref: "g", foreignPartsOnly: true },
      { ref: "h", lang: "hrv" },
    ]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { languages: ["eng", "hrv"], extras: foreignParts },
    );

    expect(subtitles.map((entry) => [entry.id, entry.lang, entry.label])).toEqual([
      ["eng-best", "eng", "Fake"],
      ["eng-forced", "eng", "Fake (foreign parts only)"],
      ["hrv-best", "hrv", "Fake"],
    ]);
    expect(refOf(urlOf(subtitles, "eng-best")).c).toEqual([{ n: "Fake", r: "a", l: "eng" }]);
    expect(refOf(urlOf(subtitles, "eng-forced")).c).toEqual([
      { n: "Fake", r: "f", l: "eng" },
      { n: "Fake", r: "g", l: "eng" },
    ]);
  });

  it("lists the foreign-parts entry of a language that has only flagged subtitles", async () => {
    const source = fakeSource("Fake", [{ ref: "f", foreignPartsOnly: true }]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { bestOnly: false, extras: { ...foreignParts, dialogueOnly: true } },
    );

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-forced"]);
  });

  it("leaves the flagged subtitles out and lists no foreign-parts entry when it is off", async () => {
    const source = fakeSource("Fake", [{ ref: "f", foreignPartsOnly: true }, { ref: "a" }]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { extras: defaultConfig(["eng"]).extras },
    );

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-best"]);
    expect(refOf(urlOf(subtitles, "eng-best")).c).toEqual([{ n: "Fake", r: "a", l: "eng" }]);
  });

  it("lists no foreign-parts entry when no source flags one", async () => {
    const source = fakeSource("Fake", [{ ref: "a" }, { ref: "b" }]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { extras: foreignParts },
    );

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-best"]);
  });

  it("never times by a flagged subtitle", async () => {
    const { subtitles } = await listedFor(
      {
        listed: [
          fakeSource("Fake", [{ ref: "a" }, { ref: "f", hashMatch: true, foreignPartsOnly: true }]),
        ],
        references: [
          fakeSource("Reference", [
            { ref: "rf", hashMatch: true, foreignPartsOnly: true },
            { ref: "r", hashMatch: true },
          ]),
        ],
      },
      { extras: foreignParts },
    );

    const ref = refOf(urlOf(subtitles, "eng-forced"));

    expect(ref.x.map(({ n, r }) => [n, r])).toEqual([["Reference", "r"]]);
    expect(ref.a?.map(({ n, r }) => [n, r])).toEqual([
      ["Reference", "r"],
      ["Fake", "a"],
    ]);
    expect(refOf(urlOf(subtitles, "eng-best")).a).toEqual(ref.a);
  });

  it("retimes the foreign-parts entry like any other entry", async () => {
    const { listed, references } = retimedSources();

    const { app, subtitles } = await listedFor(
      {
        listed: [
          ...listed,
          fakeSource("Forced", [{ ref: "f", foreignPartsOnly: true, cues: sparse(shifted) }]),
        ],
        references,
      },
      { extras: foreignParts },
    );

    expect(await fetched(app, urlOf(subtitles, "eng-forced"))).toEqual({
      status: 200,
      text: writeSRT(sparse(track)),
    });
  });
});

const longRef = (name: string) => `https://subs.example.com/download/${name}/${"x".repeat(160)}`;

const many = (lang: string) =>
  Array.from({ length: 6 }, (_, index) => ({ ref: longRef(`${lang}-${index}`), lang }));

const croatian = (cues: typeof track) => cues.map((cue) => ({ ...cue, text: `Hrv ${cue.text}` }));

const dualOf = (cues: typeof track) =>
  cues.map((cue) => ({ ...cue, text: `${cue.text}\n<i>Hrv ${cue.text}</i>` }));

const webRelease = "Movie.2024.1080p.WEB-DL.DDP5.1.H.264-GRP";

const dualSources = (hrv: Partial<Entry> = {}) => {
  const { listed, references } = retimedSources();

  return {
    listed: [
      ...listed,
      fakeSource("Croatian", [{ ref: "h", lang: "hrv", cues: croatian(shifted), ...hrv }]),
    ],
    references,
  };
};

describe("dual subtitles", () => {
  const dual = { ...defaultConfig(["eng"]).extras, dualLanguage: "hrv" };

  beforeEach(() => {
    retimeSpy.mockClear();
  });

  it("lists one dual entry after the first language's best entry and searches the second language", async () => {
    const source = fakeSource("Fake", [
      { ref: "e", lang: "eng" },
      { ref: "f", lang: "fra" },
      { ref: "h", lang: "hrv" },
    ]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [fakeSource("Reference", [{ ref: "r", hashMatch: true }])] },
      { languages: ["eng", "fra"], extras: { ...dual, dialogueOnly: true } },
    );

    expect(subtitles.map((entry) => [entry.id, entry.lang, entry.label])).toEqual([
      ["eng-best", "eng", "Fake"],
      ["eng-dialogue", "eng", "Fake (dialogue only)"],
      ["eng+hrv-dual", "eng", "Fake (with Croatian)"],
      ["fra-best", "fra", "Fake"],
      ["fra-dialogue", "fra", "Fake (dialogue only)"],
    ]);
    expect(source.search.mock.calls.map(([query]) => query.languages)).toEqual([
      ["eng", "fra", "hrv"],
    ]);
    expect(refOf(urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      ...refOf(urlOf(subtitles, "eng-best")),
      f: undefined,
      s: [{ n: "Fake", r: "h", l: "hrv" }],
    });
  });

  it("keeps a dual entry with the best four of each language under 8 KiB", async () => {
    const { subtitles } = await listedFor(
      {
        listed: [fakeSource("Fake", [...many("eng"), ...many("hrv")])],
        references: [
          fakeSource(
            "Reference",
            Array.from({ length: 4 }, (_, index) => ({
              ref: longRef(`r-${index}`),
              hashMatch: true,
            })),
          ),
        ],
      },
      { extras: dual },
    );

    const url = urlOf(subtitles, "eng+hrv-dual");

    expect([refOf(url).c.length, refOf(url).s?.length]).toEqual([4, 4]);
    expect(url.length).toBeLessThan(8 * 1024);
  });

  it("lists no dual entry when the second language has no subtitle", async () => {
    const source = fakeSource("Fake", [{ ref: "e", lang: "eng" }]);

    const { subtitles } = await listedFor({ listed: [source], references: [] }, { extras: dual });

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-best"]);
  });

  it("lists no dual entry when the first language has no subtitle", async () => {
    const source = fakeSource("Fake", [{ ref: "h", lang: "hrv" }]);

    const { subtitles } = await listedFor(
      { listed: [source], references: [] },
      { languages: ["eng", "hrv"], extras: dual },
    );

    expect(subtitles.map((entry) => entry.id)).toEqual(["hrv-best"]);
  });

  it("lists no dual entry when nothing can time the best entry to the file", async () => {
    const { listed } = dualSources();

    const { subtitles } = await listedFor({ listed, references: [] }, { extras: dual });

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-best"]);
  });

  it("serves both languages retimed to the same reference, the second below the first", async () => {
    const sources = dualSources();
    const { app, subtitles } = await listedFor(sources, { extras: dual });

    expect(subtitles.map((entry) => entry.id)).toEqual(["eng-best", "eng+hrv-dual"]);
    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 200,
      text: writeSRT(dualOf(track)),
    });
    expect(
      retimeSpy.mock.calls
        .map(([subtitle, references]) => [
          subtitle.candidate.lang,
          references.map(({ candidate }) => [candidate.sourceName, candidate.ref]),
        ])
        .toSorted(),
    ).toEqual([
      ["eng", [["Reference", "r"]]],
      ["hrv", [["Reference", "r"]]],
    ]);
    expect(retimeSpy.mock.calls[0]?.[1][0]).toBe(retimeSpy.mock.calls[1]?.[1][0]);
  });

  it("serves the second language made for the file from a listing that came before the hash", async () => {
    const fake = fakeSource("Fake", [
      { ref: "a", releaseName: webRelease, cues: track },
      {
        ref: "other",
        lang: "hrv",
        cues: track.map((cue) => ({ ...cue, text: `Druga ${cue.text}` })),
      },
      { ref: "h", lang: "hrv", cues: croatian(track) },
    ]);
    const app = appWith({
      listed: [
        {
          ...fake,
          search: async (query, signal) =>
            (await fake.search(query, signal)).map((candidate) => ({
              ...candidate,
              hashMatch: query.videoHash === video.hash && candidate.ref !== "other",
            })),
        },
      ],
      references: [],
    });
    const { token } = installed({ extras: dual });

    const listing = async (more: string) => {
      const response = await app.request(
        `/${token}/subtitles/movie/tt0111161/filename=${webRelease}.mkv${more}.json`,
      );

      return ((await response.json()) as Listing).subtitles;
    };

    const first = await listing("");

    await listing(`&videoHash=${video.hash}&videoSize=${video.size}`);

    expect(await fetched(app, urlOf(first, "eng+hrv-dual"))).toEqual({
      status: 200,
      text: writeSRT(dualOf(track)),
    });
    expect(retimeSpy).not.toHaveBeenCalled();
  });

  it("answers 404 when nothing times the second language to the file", async () => {
    const { app, subtitles } = await listedFor(dualSources({ cues: croatian(partlyUnrelated) }), {
      extras: dual,
    });

    expect((await fetched(app, urlOf(subtitles, "eng-best"))).status).toBe(200);
    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 404,
      text: "No subtitle fits this file",
    });
  });

  it("serves a second language that shares the anchor's timing as it is", async () => {
    const { app, subtitles } = await listedFor(dualSources({ cues: croatian(track) }), {
      extras: dual,
    });

    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 200,
      text: writeSRT(dualOf(track)),
    });
    expect(retimeSpy.mock.calls.map(([subtitle]) => subtitle.candidate.lang)).toEqual([]);
  });

  it.each([
    ["alone", []],
    [
      "next to an English subtitle of another release",
      [
        {
          ref: "b",
          releaseName: "Movie.2024.720p.BluRay.x264-OTHER",
          cues: track.map((cue) => ({ ...cue, text: `Other ${cue.text}` })),
        },
      ],
    ],
  ])(
    "follows the best entry's subtitle that is as good as the anchor, %s",
    async (_, others: Entry[]) => {
      const app = appWith({
        listed: [
          fakeSource("Fake", [
            { ref: "a", releaseName: webRelease, cues: track },
            ...others,
            {
              ref: "h",
              lang: "hrv",
              releaseName: "Movie.2024.HDTV.x264-LOL",
              cues: croatian(shifted),
            },
          ]),
        ],
        references: [],
      });
      const { token } = installed({ extras: dual });

      const response = await app.request(
        `/${token}/subtitles/movie/tt0111161/filename=${webRelease}.mkv.json`,
      );
      const { subtitles } = (await response.json()) as Listing;

      expect(await fetched(app, urlOf(subtitles, "eng-best"))).toEqual({
        status: 200,
        text: writeSRT(track),
      });
      expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
        status: 200,
        text: writeSRT(dualOf(track)),
      });
    },
  );

  it("serves both languages as the sources timed them when timing is off", async () => {
    const { app, subtitles } = await listedFor(dualSources(), { extras: dual, timing: "off" });

    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 200,
      text: writeSRT(dualOf(shifted)),
    });
  });

  it("lists and serves a dual entry with nothing to time it when timing is off", async () => {
    const { listed } = dualSources();

    const { app, subtitles } = await listedFor(
      { listed, references: [] },
      { extras: dual, timing: "off" },
    );

    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 200,
      text: writeSRT(dualOf(shifted)),
    });
  });

  it("answers 404 when the second language is made for another video", async () => {
    const unrelated = syntheticTrack(2, 200).map((cue) => ({ ...cue, text: `Krivo ${cue.text}` }));
    const { app, subtitles } = await listedFor(dualSources({ cues: unrelated }), {
      extras: { ...dual, hideMismatches: false },
    });

    expect((await fetched(app, urlOf(subtitles, "eng-best"))).status).toBe(200);
    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 404,
      text: "No subtitle fits this file",
    });
  });

  it("answers 404 when the first language cannot be downloaded", async () => {
    const { references } = retimedSources();

    const { app, subtitles } = await listedFor(
      {
        listed: [
          fakeSource("Fake", [{ ref: "a" }]),
          fakeSource("Croatian", [{ ref: "h", lang: "hrv", cues: croatian(shifted) }]),
        ],
        references,
      },
      { extras: dual },
    );

    expect(await fetched(app, urlOf(subtitles, "eng+hrv-dual"))).toEqual({
      status: 404,
      text: "No subtitle fits this file",
    });
  });
});

describe("source in the language name", () => {
  it("names the language and the source in each entry's language", async () => {
    const { subtitles } = await listedFor(
      {
        listed: [
          fakeSource("OpenSubtitles", [{ ref: "a", lang: "hrv" }, { ref: "e" }]),
          fakeSource("Titlovi.com", [{ ref: "t", lang: "hrv" }]),
        ],
        references: [],
      },
      { languages: ["hrv", "eng"], extras: { ...dialogueOnly, sourceInLanguage: true } },
    );

    expect(subtitles.map(({ id, lang, label }) => [id, lang, label])).toEqual([
      ["hrv-best", "Hrvatski - OpenSubtitles", "OpenSubtitles"],
      ["hrv-dialogue", "Hrvatski - OpenSubtitles (dialogue only)", "OpenSubtitles (dialogue only)"],
      ["hrv-best-2", "Hrvatski - Titlovi.com", "Titlovi.com"],
      ["eng-best", "English - OpenSubtitles", "OpenSubtitles"],
      ["eng-dialogue", "English - OpenSubtitles (dialogue only)", "OpenSubtitles (dialogue only)"],
    ]);
  });

  it("keeps the language code when it is off", async () => {
    const { subtitles } = await listedFor({
      listed: [fakeSource("OpenSubtitles", [{ ref: "a" }])],
      references: [],
    });

    expect(subtitles.map(({ lang }) => lang)).toEqual(["eng", "eng"]);
  });
});

const servedLines = async (app: App, url: string) =>
  parseSubtitle((await fetched(app, url)).text)
    .slice(0, 3)
    .map(({ text }) => text);

describe("captions in capitals", () => {
  const capitals = subtitleFixture("gilmore-s05e18-capitals.srt");
  const mixed = subtitleFixture("gilmore-s05e18.srt");

  it("serves a caption made for the file with the casing of another subtitle", async () => {
    const { app, subtitles } = await listedFor({
      listed: [
        fakeSource("Fake", [
          { ref: "a", hashMatch: true, cues: capitals },
          { ref: "b", cues: mixed },
        ]),
      ],
      references: [],
    });

    expect(await servedLines(app, urlOf(subtitles, "eng-best"))).toEqual([
      "(Kevebor) Pes, vumutob.",
      "What are the zanote bin zokago?",
      "(Gosemo) Tuzit surakazugut.",
    ]);
    expect(await servedLines(app, urlOf(subtitles, "eng-dialogue"))).toEqual([
      "Pes, vumutob.",
      "What are the zanote bin zokago?",
      "Tuzit surakazugut.",
    ]);
  });

  it("learns the casing from a free subtitle before a metered reference", async () => {
    const metered = fakeSource("OpenSubtitles API", [
      { ref: "m", hashMatch: true, metered: true, cues: mixed },
    ]);
    const { app, subtitles } = await listedFor(
      {
        listed: [
          fakeSource("Fake", [
            { ref: "a", cues: capitals },
            { ref: "b", cues: mixed },
          ]),
        ],
        references: [metered],
      },
      { timing: "off" },
    );

    expect(await servedLines(app, urlOf(subtitles, "eng-best"))).toEqual([
      "(Kevebor) Pes, vumutob.",
      "What are the zanote bin zokago?",
      "(Gosemo) Tuzit surakazugut.",
    ]);
    expect(metered.download).not.toHaveBeenCalled();
  });

  it("never downloads a metered subtitle of the same entry for the casing", async () => {
    const metered = fakeSource("OpenSubtitles API", [{ ref: "m", metered: true, cues: mixed }]);
    const { app, subtitles } = await listedFor(
      {
        listed: [
          fakeSource("OpenSubtitles", [{ ref: "a", hashMatch: true, cues: capitals }]),
          metered,
        ],
        references: [],
      },
      { timing: "off" },
    );

    const served = parseSubtitle((await fetched(app, urlOf(subtitles, "eng-best"))).text);

    expect(refOf(urlOf(subtitles, "eng-best")).c.map(({ r }) => r)).toEqual(["a", "m"]);
    expect(served[14]?.text).toBe("Lopupa, zivaba. We're caloco\nrazomef to mr. Zosuzuku.");
    expect(metered.download).not.toHaveBeenCalled();
  });

  it("downloads at most one more subtitle for the casing", async () => {
    const source = fakeSource("Fake", [
      { ref: "a", hashMatch: true, cues: capitals },
      { ref: "b", cues: capitals },
      { ref: "c", cues: mixed },
    ]);
    const { app, subtitles } = await listedFor(
      { listed: [source], references: [] },
      { timing: "off" },
    );

    const served = parseSubtitle((await fetched(app, urlOf(subtitles, "eng-best"))).text);

    expect(served[14]?.text).toBe("Lopupa, zivaba. We're caloco\nrazomef to mr. Zosuzuku.");
    expect(source.download.mock.calls.map(([ref]) => ref)).toEqual(["a", "b"]);
  });

  it("adds no download when a subtitle already downloaded gives the casing", async () => {
    const source = fakeSource("Fake", [
      { ref: "a", cues: shifted.map((cue) => ({ ...cue, text: cue.text.toUpperCase() })) },
      { ref: "b", cues: track },
    ]);
    const { references } = retimedSources();

    const { app, subtitles } = await listedFor({ listed: [source], references });

    expect(await fetched(app, urlOf(subtitles, "eng-best"))).toEqual({
      status: 200,
      text: writeSRT(track),
    });
    expect(source.download.mock.calls.map(([ref]) => ref)).toEqual(["a", "b"]);
    expect(references[0]?.download.mock.calls.map(([ref]) => ref)).toEqual(["r"]);
  });

  it("serves a retimed caption with the casing of its reference and its timing", async () => {
    const { app, subtitles } = await listedFor({
      ...retimedSources(),
      listed: [
        fakeSource("Fake", [
          { ref: "a", cues: shifted.map((cue) => ({ ...cue, text: cue.text.toUpperCase() })) },
        ]),
      ],
    });

    expect(await fetched(app, urlOf(subtitles, "eng-best"))).toEqual({
      status: 200,
      text: writeSRT(track),
    });
  });
});
