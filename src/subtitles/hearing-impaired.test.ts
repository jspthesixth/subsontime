import { describe, expect, it } from "vitest";
import { stripSoundDescriptions } from "./hearing-impaired.ts";

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
