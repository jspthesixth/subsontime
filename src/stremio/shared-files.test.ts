import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memorySharedState, type SharedState } from "../jobs/shared-state.ts";
import { fileSource } from "../sources/file-source.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { transform } from "../timing/test-tracks.ts";
import { appWith, installed, track, type Listing } from "./test-app.ts";

const filename = "Movie.1994.2160p.BDRemux.mkv";
const torrent = "2f0b59a88c1f70bd325b57cb3df3833ea5ecc275";
const late = transform(track, (time) => time + 3850);
const fixtures = join(import.meta.dirname, "../../test/fixtures/files");

const debridWith = async (files: Record<string, string>) => {
  const bytes = new Map(
    await Promise.all(
      Object.entries(files).map(
        async ([path, fixture]) => [path, await readFile(join(fixtures, fixture))] as const,
      ),
    ),
  );
  const reads: string[] = [];

  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input));
      const range = new Headers(init?.headers).get("range");

      if (url.pathname.endsWith(".json")) {
        return Response.json({
          streams: Object.keys(files)
            .filter((path) => path.startsWith(`/${url.host.split(".")[0]}/`))
            .map((path) => ({
              url: `https://${url.host}${path}`,
              behaviorHints: { filename },
            })),
        });
      }

      const file = bytes.get(url.pathname) ?? new Uint8Array();
      const [, from = "0", to = "0"] = /bytes=(\d+)-(\d+)/.exec(range ?? "") ?? [];

      const end = Math.min(Number(to), file.length - 1);

      reads.push(url.pathname);

      return new Response(file.subarray(Number(from), end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${from}-${end}/${file.length}` },
      });
    }),
  );

  return reads;
};

const firstCueFor = async (state: SharedState, streamAddons: string[]) => {
  const app = appWith(
    {
      listed: [fakeSource("Fake", [{ ref: "a", cues: late }])],
      references: [fileSource(streamAddons, state)],
    },
    undefined,
    { state },
  );
  const { token } = installed({ streamAddons });

  const listing = await app.request(
    `/${token}/subtitles/movie/tt0111161/filename=${filename}.json`,
  );
  const { subtitles } = (await listing.json()) as Listing;

  const response = await app.request(new URL(subtitles[0]?.url ?? "").pathname);

  return parseSubtitle(await response.text())[0]?.start;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("a file read once for everyone", () => {
  it("reads a torrent's file once for two installs with different stream addons", async () => {
    const reads = await debridWith({ [`/one/${torrent}/0`]: "synthetic-track.mkv" });
    const state = memorySharedState();

    const first = await firstCueFor(state, ["https://one.example/key-a/manifest.json"]);
    const readsByFirst = reads.length;
    const second = await firstCueFor(state, ["https://one.example/key-b/manifest.json"]);

    expect([first, second, readsByFirst, reads.length - readsByFirst]).toEqual([1993, 1993, 1, 0]);
  });

  it("times a subtitle for an install without stream addons to a file someone read", async () => {
    await debridWith({ [`/one/${torrent}/0`]: "synthetic-track.mkv" });

    const state = memorySharedState();

    await firstCueFor(state, ["https://one.example/key-a/manifest.json"]);

    expect(await firstCueFor(state, [])).toBe(1993);
  });

  it("leaves a filename alone once two different files were seen under it", async () => {
    await debridWith({
      [`/one/${torrent}/0`]: "synthetic-track.mkv",
      [`/two/${"a".repeat(40)}/0`]: "two-subtitles.mkv",
    });

    const state = memorySharedState();

    await firstCueFor(state, ["https://one.example/manifest.json"]);
    await firstCueFor(state, ["https://two.example/manifest.json"]);

    expect(await firstCueFor(state, [])).toBe(5843);
  });

  it("counts how each listing found the file's timing", async () => {
    await debridWith({ [`/one/${torrent}/0`]: "synthetic-track.mkv" });

    const state = memorySharedState();
    const day = new Date().toISOString().slice(0, 10);

    await firstCueFor(state, ["https://one.example/key-a/manifest.json"]);
    await firstCueFor(state, ["https://one.example/key-b/manifest.json"]);
    await firstCueFor(state, []);
    await firstCueFor(state, ["https://one.example/key-a/manifest.json"]);

    expect(
      await Promise.all(
        ["read:lines", "shared:lines", "named:lines", "known:lines"].map((outcome) =>
          state.get(`probe:${day}:${outcome}`),
        ),
      ),
    ).toEqual(["1", "1", "1", "1"]);
  });
});
