import { monitorEventLoopDelay } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import familyFixture from "../../test/fixtures/subtitles/act-breaks-s01e24.json" with { type: "json" };
import { timingFamiliesOf } from "./timing-families.ts";
import { syntheticTrack, transform } from "./test-tracks.ts";

const timed = (spans: number[][]) =>
  spans.map(([start = 0, end = 0], index) => ({ start, end, text: `Line ${index}` }));

const broadcast = timed(familyFixture.subtitle);
const disc = timed(familyFixture.reference);
const discByAnotherAuthor = transform(disc, (time) => time + 120);
const broadcastByAnotherAuthor = transform(broadcast, (time) => time - 90);
const film = syntheticTrack(5, 500);
const filmWithActBreaks = film.map((cue, index) => {
  const shift = (index >= 170 ? 1200 : 0) + (index >= 340 ? 1200 : 0);

  return { ...cue, start: cue.start + shift, end: cue.end + shift };
});

const episode = [
  { item: "broadcast", cues: broadcast },
  { item: "disc", cues: disc },
  { item: "broadcast by another author", cues: broadcastByAnotherAuthor },
  { item: "disc by another author", cues: discByAnotherAuthor },
];

describe("timingFamiliesOf", () => {
  it("splits an episode's broadcast and disc subtitles into two families", async () => {
    expect(await timingFamiliesOf(episode)).toEqual([
      ["broadcast", "broadcast by another author"],
      ["disc", "disc by another author"],
    ]);
  });

  it("finds the same families whatever the order", async () => {
    expect(await timingFamiliesOf(episode.toReversed())).toEqual([
      ["disc by another author", "disc"],
      ["broadcast by another author", "broadcast"],
    ]);
  });

  it("keeps one family when every subtitle agrees", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "disc by another author", cues: discByAnotherAuthor },
    ]);

    expect(families).toEqual([["disc", "disc by another author"]]);
  });

  it("offers no family of one", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "disc by another author", cues: discByAnotherAuthor },
      { item: "broadcast", cues: broadcast },
    ]);

    expect(families).toEqual([["disc", "disc by another author"]]);
  });

  it("splits a film cut differently", async () => {
    const families = await timingFamiliesOf([
      { item: "cinema", cues: film },
      { item: "television", cues: filmWithActBreaks },
      { item: "cinema again", cues: transform(film, (time) => time - 90) },
      { item: "television again", cues: transform(filmWithActBreaks, (time) => time + 60) },
    ]);

    expect(families).toEqual([
      ["cinema", "cinema again"],
      ["television", "television again"],
    ]);
  });

  it("leaves out a subtitle that does not fit any family", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "another film", cues: syntheticTrack(9, 300) },
      { item: "disc by another author", cues: discByAnotherAuthor },
    ]);

    expect(families).toEqual([["disc", "disc by another author"]]);
  });

  it("leaves out a subtitle too short to judge", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "a few lines", cues: disc.slice(0, 10) },
      { item: "disc by another author", cues: discByAnotherAuthor },
    ]);

    expect(families).toEqual([["disc", "disc by another author"]]);
  });

  it("gives up once the deadline passes", async () => {
    let clock = 0;

    const families = await timingFamiliesOf(episode, {
      deadline: 1,
      now: () => {
        clock += 1;

        return clock;
      },
    });

    expect(families).toBeUndefined();
  });
});

describe("timingFamiliesOf and the event loop", () => {
  it("keeps the event loop free while it aligns long subtitles", async () => {
    const long = syntheticTrack(11, 1500);
    const tracks = [0, 1, 2, 3].map((index) => ({
      item: `copy ${index}`,
      cues: transform(long, (time) => time + index * 40),
    }));
    const lag = monitorEventLoopDelay({ resolution: 10 });

    lag.enable();

    const families = await timingFamiliesOf(tracks);

    lag.disable();

    expect(families).toEqual([["copy 0", "copy 1", "copy 2", "copy 3"]]);
    expect(lag.max / 1e6).toBeLessThan(60);
  }, 60_000);
});
