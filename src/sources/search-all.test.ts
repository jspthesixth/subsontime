import { describe, expect, it } from "vitest";
import { searchAll } from "./search-all.ts";
import type { Candidate, Source, VideoQuery } from "./source.ts";

const query: VideoQuery = { type: "movie", imdbId: "tt0111161", languages: ["eng"] };

const candidate = (sourceName: string): Candidate => ({
  sourceName,
  ref: `https://${sourceName}/1`,
  lang: "eng",
  release: { extended: false },
  hashMatch: false,
});

const source = (name: string, search: Source["search"]): Source => ({
  name,
  search,
  download: async () => new Uint8Array(),
});

describe("searchAll", () => {
  it("skips failed and slow sources", async () => {
    const sources = [
      source("broken", async () => {
        throw new Error("down");
      }),
      source(
        "slow",
        (_query, signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(() => resolve([candidate("slow")]), 200);

            signal.addEventListener("abort", () => {
              clearTimeout(timer);
              reject(signal.reason);
            });
          }),
      ),
      source("fast", async () => [candidate("fast")]),
    ];
    const started = Date.now();

    const candidates = await searchAll(sources, query, 50);

    expect(candidates.map((entry) => entry.sourceName)).toEqual(["fast"]);
    expect(Date.now() - started).toBeLessThan(150);
  });

  it("keeps source order", async () => {
    const sources = [
      source("a", async () => [candidate("a")]),
      source("b", async () => [candidate("b")]),
    ];

    const candidates = await searchAll(sources, query);

    expect(candidates.map((entry) => entry.sourceName)).toEqual(["a", "b"]);
  });
});
