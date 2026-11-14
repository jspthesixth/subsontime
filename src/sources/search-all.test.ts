import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const names = (candidates: Candidate[]) => candidates.map((entry) => entry.sourceName);

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searchAll", () => {
  it("skips a failed source and one that never settles", async () => {
    const sources = [
      source("broken", async () => {
        throw new Error("down");
      }),
      source("stuck", () => new Promise<Candidate[]>(() => {})),
      source("fast", async () => [candidate("fast")]),
    ];
    const result = searchAll(sources, query);

    await vi.advanceTimersByTimeAsync(4000);

    expect(names(await result)).toEqual(["fast"]);
  });

  it("does not wait past the deadline for a slow source", async () => {
    const sources = [
      source(
        "slow",
        () =>
          new Promise<Candidate[]>((resolve) =>
            setTimeout(() => resolve([candidate("slow")]), 5000),
          ),
      ),
      source("fast", async () => [candidate("fast")]),
    ];
    const result = searchAll(sources, query);

    await vi.advanceTimersByTimeAsync(4000);

    expect(names(await result)).toEqual(["fast"]);
  });

  it("aborts the signal of a source at the deadline", async () => {
    let aborted = false;
    const sources = [
      source("stuck", (_query, signal) => {
        signal.addEventListener("abort", () => {
          aborted = true;
        });

        return new Promise<Candidate[]>(() => {});
      }),
    ];
    const result = searchAll(sources, query);

    await vi.advanceTimersByTimeAsync(4000);
    await result;

    expect(aborted).toBe(true);
  });

  it("skips a source that throws synchronously", async () => {
    const sources = [
      source("sync", () => {
        throw new Error("boom");
      }),
      source("fast", async () => [candidate("fast")]),
    ];

    expect(names(await searchAll(sources, query))).toEqual(["fast"]);
  });

  it("keeps source order", async () => {
    const sources = [
      source("a", async () => [candidate("a")]),
      source("b", async () => [candidate("b")]),
    ];

    expect(names(await searchAll(sources, query))).toEqual(["a", "b"]);
  });
});
