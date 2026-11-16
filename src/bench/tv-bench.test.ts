import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { syntheticTrack } from "../timing/test-tracks.ts";
import { classOf, loadTVDataset, namesMatch, pickEvenly, truthProblem } from "./tv-bench.ts";

const srt = [
  "1",
  "00:00:01,000 --> 00:00:02,500",
  "Hello there.",
  "",
  "2",
  "00:00:03,000 --> 00:00:04,000",
  "General Kenobi.",
  "",
].join("\n");

const episode = {
  show: "Example Show",
  path: "/media/Example.Show.S01E02.mkv",
  filename: "Example.Show.S01E02.mkv",
  hash: "0123456789abcdef",
  size: 1_234_567,
  imdbId: "tt0000001:1:2",
  season: 1,
  episode: 2,
  durationMs: 1_320_000,
  truth: [{ lang: "eng", source: "embedded", stream: 2, path: "truth/a.2.eng.srt", cues: 2 }],
};

describe("loadTVDataset", () => {
  it("reads the kept episodes with their truth tracks and lists the excluded ones", async () => {
    const root = await mkdtemp(join(tmpdir(), "tv-bench-"));

    await mkdir(join(root, "tv", "truth"), { recursive: true });
    await writeFile(join(root, "tv", "truth", "a.2.eng.srt"), srt);
    await writeFile(
      join(root, "tv", "dataset.json"),
      JSON.stringify({
        episodes: [
          episode,
          { ...episode, hash: "fedcba9876543210", truth: [], excluded: "no subtitle track" },
        ],
      }),
    );

    const { files, excluded } = await loadTVDataset(root);

    expect(files).toEqual([
      {
        sha256: "0123456789abcdef",
        kind: "episode",
        imdbId: "tt0000001:1:2",
        path: "/media/Example.Show.S01E02.mkv",
        show: "Example Show",
        source: "embedded",
        fingerprint: { hash: "0123456789abcdef", size: 1_234_567 },
        verified: [
          {
            id: "embedded:2",
            lang: "eng",
            cues: [
              { start: 1000, end: 2500, text: "Hello there." },
              { start: 3000, end: 4000, text: "General Kenobi." },
            ],
          },
        ],
      },
    ]);
    expect(excluded.map(({ excluded: reason }) => reason)).toEqual(["no subtitle track"]);
  });
});

describe("truthProblem", () => {
  const track = syntheticTrack(3, 400);

  it("accepts a track that covers the episode", () => {
    expect(truthProblem(track, 1_700_000)).toBeUndefined();
  });

  it("rejects an empty, sparse, overlong or truncated track", () => {
    expect(truthProblem([], 1_320_000)).toBe("no cues");
    expect(truthProblem(track.slice(0, 20), 1_320_000)).toBe("20 cues in 22 min");
    expect(truthProblem(track, 1_500_000)).toBe("last cue ends at 1666 s, after the 1500 s video");
    expect(
      truthProblem(
        Array.from({ length: 60 }, (_, index) => ({
          start: index * 1000,
          end: index * 1000 + 800,
          text: `Line ${index}`,
        })),
        1_320_000,
      ),
    ).toBe("last cue ends at 60 s of 1320 s");
  });
});

const wrong = (kind: "offset" | "frame-rate" | "drift" | "steps" | "other", onTimeShare = 0) =>
  classOf({
    outcome: "wrong-timing",
    truth: {
      outcome: "wrong-timing",
      onTimeShare,
      shape: { kind, offsetMs: 2000, speedRatio: 1, steps: 0 },
    },
  });

describe("classOf", () => {
  it("keeps the bench outcomes that are not timing errors", () => {
    expect(classOf({ outcome: "correct" })).toBe("correct");
    expect(classOf({ outcome: "nothing" })).toBe("nothing");
    expect(classOf({ outcome: "wrong-title" })).toBe("wrong-title");
  });

  it("names the shape of a timing error", () => {
    expect(wrong("offset")).toBe("constant-offset");
    expect(wrong("frame-rate")).toBe("drift");
    expect(wrong("drift")).toBe("drift");
    expect(wrong("steps")).toBe("partial");
    expect(wrong("other", 0.6)).toBe("partial");
    expect(wrong("other", 0.2)).toBe("other");
  });
});

describe("namesMatch", () => {
  it("matches an episode name written differently in the filename", () => {
    expect(namesMatch("Show - 11x13 - TRASH.mkv", "T*R*A*S*H")).toBe(true);
    expect(
      namesMatch("Show - 04x12 - It's A Bundyful Life (Part 2).mkv", "It's a Bundyful Life (2)"),
    ).toBe(true);
    expect(
      namesMatch(
        "Show - 03x12 - Can't Dance Dont Ask Me.mkv",
        "Can't Dance, Don't Ask Me (aka Kelly's Dance)",
      ),
    ).toBe(true);
  });

  it("rejects another episode's name", () => {
    expect(namesMatch("Show - 03x12 - Can't Dance Dont Ask Me.mkv", "The Godfather")).toBe(false);
  });
});

describe("pickEvenly", () => {
  it("spreads the picks over the whole list", () => {
    expect(pickEvenly([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 3)).toEqual([2, 6, 9]);
    expect(pickEvenly([1, 2], 3)).toEqual([1, 2]);
  });
});
