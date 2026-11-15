import { describe, expect, it } from "vitest";
import { stripHearingImpaired, stripSoundDescriptions } from "./hearing-impaired.ts";

describe("stripSoundDescriptions", () => {
  it.each([
    ["[DOOR SLAMS] Hello.", "Hello."],
    ["(laughs) Hi there.", "Hi there."],
    ["Wait [sighs] for me.", "Wait for me."],
    ["[THUNDER\nRUMBLES]", ""],
    ["♪ ♪\nWhat?", "What?"],
    ["# #", ""],
    ["♫", ""],
    ["JOHN: Over here.", "Over here."],
    ["JOHN (whispering): Over here.", "Over here."],
    ["- MARY: Wait.\n- Okay.", "- Wait.\n- Okay."],
    ["ŽELJKO: Dobro.", "Dobro."],
    ["♪ Dancing in the dark ♪", "♪ Dancing in the dark ♪"],
    ["Meet me at 10:30.", "Meet me at 10:30."],
    ["Note: bring the keys.", "Note: bring the keys."],
    ["A 10:30 train.", "A 10:30 train."],
  ])("turns %j into %j", (text, expected) => {
    expect(stripSoundDescriptions(text)).toBe(expected);
  });
});

describe("stripHearingImpaired", () => {
  it.each([
    ["[DOOR SLAMS]\nHello.", "Hello."],
    ["(sighs) Hello.", "Hello."],
    ["♪ la la ♪\nHello.", "Hello."],
    ["# la la #\nHello.", "Hello."],
    ["JOHN: Hello", "Hello"],
    ["Wait [sighs] for me.", "Wait for me."],
    ["- MARY: Wait.\n- ♪ la la ♪", "- Wait."],
  ])("keeps the dialogue of %j as %j", (text, expected) => {
    expect(stripHearingImpaired([{ start: 1000, end: 2000, text }])).toEqual([
      { start: 1000, end: 2000, text: expected },
    ]);
  });

  it("drops a cue left empty", () => {
    const cues = [
      { start: 0, end: 1000, text: "[DOOR SLAMS]" },
      { start: 1000, end: 2000, text: "Hello." },
      { start: 2000, end: 3000, text: "♪ la la ♪" },
    ];

    expect(stripHearingImpaired(cues)).toEqual([{ start: 1000, end: 2000, text: "Hello." }]);
  });

  it("leaves nothing of a subtitle made only of sound descriptions", () => {
    const cues = [
      { start: 0, end: 1000, text: "[DOOR SLAMS]" },
      { start: 1000, end: 2000, text: "(sighs)" },
      { start: 2000, end: 3000, text: "♪ la la ♪" },
    ];

    expect(stripHearingImpaired(cues)).toEqual([]);
  });
});
