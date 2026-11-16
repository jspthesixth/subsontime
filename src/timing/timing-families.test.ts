import { describe, expect, it } from "vitest";
import familyFixture from "../../test/fixtures/subtitles/act-breaks-s01e24.json" with { type: "json" };
import { timingFamiliesOf } from "./timing-families.ts";
import { syntheticTrack, transform } from "./test-tracks.ts";

const timed = (spans: number[][]) =>
  spans.map(([start = 0, end = 0], index) => ({ start, end, text: `Line ${index}` }));

const broadcast = timed(familyFixture.subtitle);
const disc = timed(familyFixture.reference);
const discByAnotherAuthor = transform(disc, (time) => time + 120);
const film = syntheticTrack(5, 500);
const filmWithActBreaks = film.map((cue, index) => {
  const shift = (index >= 170 ? 1200 : 0) + (index >= 340 ? 1200 : 0);

  return { ...cue, start: cue.start + shift, end: cue.end + shift };
});

describe("timingFamiliesOf", () => {
  it("splits an episode's broadcast and disc subtitles into two families", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "broadcast", cues: broadcast },
      { item: "disc by another author", cues: discByAnotherAuthor },
    ]);

    expect(families).toEqual([["disc", "disc by another author"], ["broadcast"]]);
  });

  it("keeps one family when every subtitle agrees", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "disc by another author", cues: discByAnotherAuthor },
    ]);

    expect(families).toEqual([["disc", "disc by another author"]]);
  });

  it("splits a film cut differently", async () => {
    const families = await timingFamiliesOf([
      { item: "cinema", cues: film },
      { item: "television", cues: filmWithActBreaks },
      { item: "cinema again", cues: transform(film, (time) => time - 90) },
    ]);

    expect(families).toEqual([["cinema", "cinema again"], ["television"]]);
  });

  it("leaves out a subtitle that does not fit any family", async () => {
    const families = await timingFamiliesOf([
      { item: "disc", cues: disc },
      { item: "another film", cues: syntheticTrack(9, 300) },
    ]);

    expect(families).toEqual([["disc"]]);
  });

  it("gives up once the deadline passes", async () => {
    let clock = 0;

    const families = await timingFamiliesOf(
      [
        { item: "disc", cues: disc },
        { item: "broadcast", cues: broadcast },
      ],
      {
        deadline: 1,
        now: () => {
          clock += 1;

          return clock;
        },
      },
    );

    expect(families).toBeUndefined();
  });
});
