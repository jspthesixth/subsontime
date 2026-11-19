import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memorySharedState } from "../jobs/shared-state.ts";
import { fileSource } from "../sources/file-source.ts";
import { fakeSource } from "../sources/test-sources.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { transform } from "../timing/test-tracks.ts";
import { appWith, fetchAt, installed, track, type Listing } from "./test-app.ts";

const streamAddon = "https://streams.example/key/manifest.json";
const filename = "Movie.1994.2160p.BDRemux.mkv";
const late = transform(track, (time) => time + 3850);

const stubStreamAddon = async (streams: object[], ignoresRange = false, failedLookups = 0) => {
  let lookups = 0;

  const file = await readFile(
    join(import.meta.dirname, "../../test/fixtures/files/synthetic-track.mkv"),
  );
  const requests: string[] = [];

  vi.stubGlobal(
    "fetch",
    fetchAt(async (input, init) => {
      const url = String(input);
      const range = new Headers(init?.headers).get("range");

      requests.push(range === null ? url : `${url} ${range}`);

      if (url === "https://other.example/stream/movie/tt0111161.json") {
        return Response.json({ streams: [] });
      }

      if (url === "https://streams.example/key/stream/movie/tt0111161.json") {
        lookups += 1;

        return lookups <= failedLookups
          ? new Response("Too many requests", { status: 429 })
          : Response.json({ streams });
      }

      if (url === "https://streams.example/resolve/played") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/d/played.mkv" },
        });
      }

      const [, from = "0", to = "0"] = /bytes=(\d+)-(\d+)/.exec(range ?? "") ?? [];

      const end = Math.min(Number(to), file.length - 1);

      if (ignoresRange) {
        return new Response(file, {
          status: 206,
          headers: { "content-range": "bytes 0-117602857958/117602857959" },
        });
      }

      return new Response(file.subarray(Number(from), end + 1), {
        status: 206,
        headers: { "content-range": `bytes ${from}-${end}/${file.length}` },
      });
    }),
  );

  return requests;
};

const appFor = (addons: string[]) => {
  const state = memorySharedState();
  const listed = fakeSource("Fake", [
    { ref: "a", cues: late, releaseName: "Movie.1994.1080p.BluRay.x264-OTHER" },
  ]);
  const app = appWith({ listed: [listed], references: [fileSource(addons, state)] }, undefined, {
    state,
  });

  return { app, listed };
};

const served = async (
  streams: object[],
  ignoresRange = false,
  addons = [streamAddon],
  restarted = false,
) => {
  const requests = await stubStreamAddon(streams, ignoresRange);
  const { app, listed } = appFor(addons);

  const { token } = installed({ streamAddons: addons });

  const listing = await app.request(
    `/${token}/subtitles/movie/tt0111161/filename=${filename}.json`,
  );
  const { subtitles } = (await listing.json()) as Listing;

  const response = await (restarted ? appFor(addons).app : app).request(
    new URL(subtitles[0]?.url ?? "").pathname,
  );
  const cues = parseSubtitle(await response.text());

  return {
    cues,
    requests,
    labels: subtitles.map(({ label }) => label),
    searched: listed.search.mock.calls[0]?.[0],
  };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("timing to the file itself", () => {
  it("retimes a subtitle to the subtitle track inside the played file", async () => {
    const { cues } = await served([
      {
        url: "https://streams.example/resolve/other",
        behaviorHints: { filename: "Movie.1994.1080p.WEB.mkv" },
      },
      { url: "https://streams.example/resolve/played", behaviorHints: { filename } },
    ]);

    expect(cues.slice(0, 3).map(({ start, end }) => [start, end])).toEqual([
      [1993, 3001],
      [4725, 8668],
      [11583, 13426],
    ]);
  });

  it("reads only the header, the track list and the subtitle index of the played file", async () => {
    const { requests } = await served([
      { url: "https://streams.example/resolve/played", behaviorHints: { filename } },
    ]);

    expect(requests.filter((request) => request.includes("bytes="))).toEqual([
      "https://streams.example/resolve/played bytes=0-127",
      "https://cdn.example/d/played.mkv bytes=0-127",
      "https://cdn.example/d/played.mkv bytes=213-224",
      "https://cdn.example/d/played.mkv bytes=291-302",
      "https://cdn.example/d/played.mkv bytes=19592-19603",
      "https://cdn.example/d/played.mkv bytes=218-290",
      "https://cdn.example/d/played.mkv bytes=297-495",
      "https://cdn.example/d/played.mkv bytes=19598-24224",
    ]);
  });

  it("serves the subtitle as uploaded when no stream is the played file", async () => {
    const { cues } = await served([
      {
        url: "https://streams.example/resolve/other",
        behaviorHints: { filename: "Movie.1994.1080p.WEB.mkv" },
      },
    ]);

    expect(cues[0]?.start).toBe(5843);
  });

  it("does not read a file whose server ignores the requested range", async () => {
    const { cues } = await served(
      [{ url: "https://streams.example/resolve/played", behaviorHints: { filename } }],
      true,
    );

    expect(cues[0]?.start).toBe(5843);
  });

  it("leaves out the fingerprint of a file with subtitles inside", async () => {
    const { searched } = await served([
      { url: "https://streams.example/resolve/played", behaviorHints: { filename } },
    ]);

    expect([searched?.videoHash, searched?.videoSize]).toEqual([undefined, undefined]);
  });

  it("finds the played file in whichever stream addon has it", async () => {
    const { cues } = await served(
      [{ url: "https://streams.example/resolve/played", behaviorHints: { filename } }],
      false,
      ["https://other.example/manifest.json", streamAddon],
    );

    expect(cues[0]?.start).toBe(1993);
  });

  it("reads the played file again when its stored timing is gone", async () => {
    const { cues } = await served(
      [{ url: "https://streams.example/resolve/played", behaviorHints: { filename } }],
      false,
      [streamAddon],
      true,
    );

    expect(cues[0]?.start).toBe(1993);
  });

  it("looks the played file up again after a stream addon fails", async () => {
    await stubStreamAddon(
      [{ url: "https://streams.example/resolve/played", behaviorHints: { filename } }],
      false,
      1,
    );

    const { app } = appFor([streamAddon]);

    const { token } = installed({ streamAddons: [streamAddon] });

    const firstCueOf = async () => {
      const listing = await app.request(
        `/${token}/subtitles/movie/tt0111161/filename=${filename}.json`,
      );
      const { subtitles } = (await listing.json()) as Listing;

      const response = await app.request(new URL(subtitles[0]?.url ?? "").pathname);

      return parseSubtitle(await response.text())[0]?.start;
    };

    expect([await firstCueOf(), await firstCueOf()]).toEqual([5843, 1993]);
  });

  it("notes in the menu which subtitles are synced to the played file", async () => {
    const found = await served([
      { url: "https://streams.example/resolve/played", behaviorHints: { filename } },
    ]);
    const missing = await served([
      {
        url: "https://streams.example/resolve/other",
        behaviorHints: { filename: "Movie.1994.1080p.WEB.mkv" },
      },
    ]);

    expect([found.labels, missing.labels]).toEqual([
      ["English · Fake · synced to your file"],
      ["English · Fake"],
    ]);
  });
});
