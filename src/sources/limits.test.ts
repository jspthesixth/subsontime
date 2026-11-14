import { afterEach, describe, expect, it, vi } from "vitest";
import loginFixture from "../../test/fixtures/sources/titlovi-login.json" with { type: "json" };
import { openSubtitlesSource } from "./opensubtitles.ts";
import { maximumDownloadBytes, maximumSearchBytes } from "./source.ts";
import { stremioAddonSource } from "./stremio-addon.ts";
import { subdlSource } from "./subdl.ts";
import { subSourceSource } from "./subsource.ts";
import { memoryTokenCache } from "./test-sources.ts";
import { titloviSource } from "./titlovi.ts";

const signal = () => AbortSignal.timeout(1000);
const fileLink = "https://dl.example.com/file.srt";

const json = (body: unknown) => new Response(JSON.stringify(body));

const stubFetch = (fileBytes: number) =>
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input) => {
      const url = String(input);

      if (url === "https://api.opensubtitles.com/api/v1/download") {
        return json({ link: fileLink });
      }

      if (url.includes("gettoken")) {
        return json(loginFixture);
      }

      return new Response(new Uint8Array(fileBytes));
    }),
  );

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("source downloads", () => {
  it.each([
    [
      "a Stremio addon",
      () =>
        stremioAddonSource("https://subs.example.com/manifest.json", "Subs").download(
          fileLink,
          signal(),
        ),
    ],
    [
      "OpenSubtitles",
      () => openSubtitlesSource(undefined, "app-key", memoryTokenCache()).download("501", signal()),
    ],
    ["SubDL", () => subdlSource("key").download("/subtitle/1-1.zip", signal())],
    ["SubSource", () => subSourceSource("key").download("1", signal())],
    [
      "Titlovi.com",
      () =>
        titloviSource({ username: "user", password: "pass" }, memoryTokenCache()).download(
          "1:1001",
          signal(),
        ),
    ],
  ])("stop a file from %s past 5 MB", async (_, download) => {
    stubFetch(maximumDownloadBytes + 1);

    await expect(download()).rejects.toThrow("Response too large");
  });
});

const listing = (padding: number) =>
  JSON.stringify({
    subtitles: [{ id: "1", url: fileLink, lang: "eng" }],
    padding: "x".repeat(padding),
  });

const search = (body: string) => {
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async () => new Response(body)),
  );

  return stremioAddonSource("https://subs.example.com/manifest.json", "Subs").search(
    { type: "movie", imdbId: "tt0111161", languages: ["eng"] },
    signal(),
  );
};

describe("source searches", () => {
  it("read a listing up to 2 MB", async () => {
    const body = listing(0);
    const padded = listing(maximumSearchBytes - body.length);

    expect(await search(padded)).toHaveLength(1);
  });

  it("refuse a listing past 2 MB", async () => {
    const body = listing(0);

    await expect(search(listing(maximumSearchBytes - body.length + 1))).rejects.toThrow(
      "Response too large",
    );
  });
});
