import { describe, expect, it } from "vitest";
import { isCapitals, recase } from "./capitals.ts";
import { subtitleFixture } from "./test-subtitles.ts";

const capitals = subtitleFixture("gilmore-s05e18-capitals.srt");
const mixed = subtitleFixture("gilmore-s05e18.srt");

const cue = (text: string) => ({ start: 1000, end: 2000, text });

describe("isCapitals", () => {
  it("finds the closed captions written in capitals", () => {
    expect(isCapitals(capitals)).toBe(true);
  });

  it("leaves a subtitle in mixed case alone", () => {
    expect(isCapitals(mixed)).toBe(false);
  });

  it("leaves a short subtitle of signs in capitals alone", () => {
    expect(isCapitals(capitals.slice(0, 49))).toBe(false);
  });
});

describe("recase", () => {
  const recased = recase(capitals, [mixed], "eng");

  it("keeps every cue's timing", () => {
    expect(recased.map(({ start, end }) => [start, end])).toEqual(
      capitals.map(({ start, end }) => [start, end]),
    );
  });

  it("gives the captions the casing of the other subtitle", () => {
    expect(recased.slice(0, 34).map(({ text }) => text)).toEqual([
      "(Kevebor) Pes, vumutob.",
      "What are the zanote bin zokago?",
      "(Gosemo) Tuzit surakazugut.",
      "Ganu. What's this?",
      "Nuzag.",
      "Nalif.",
      "Ok, why do we tif gococ zoz if\nyou're pakel zaco laduponani out?",
      "Well, they've setope gococ\nzoz. It vuga to be besefu.",
      "Now they lus pil\nbera mavul in it.",
      "Your regil zafag't robi what\nto karufe with any bikip dimo.",
      "Soto it be denona?\nSoto it be kuconap-y?",
      "Soto it be fekivepag\nkutosifitoc? What's this?",
      "Fozovaz.",
      "[bunicubu] Vebekogu basi.",
      "Lopupa, zivaba. We're caloco\nrazomef to Mr. Zosuzuku.",
      "So?",
      "The bos's on bok fusakefo.\nVuci a ducico dilupep.",
      "Livoko, Vic bos Zosuzuku's\nbeen moned for 20 cebog.",
      "This is my favidokavil\nzoru caloco nalif.",
      "Yeah, I tomad you vupa\nthe tureti, Kocef.",
      "I sopibo. When was the velu\nzoru he ledevac he was moned?",
      "It's been a zoti 2 cebog.",
      "I pifedozo now. The\nvelu zoru, the zize.",
      "We got lelazare.",
      'It vomo the ponag "he\'s\nmoned" dutit a mosec dovebi.',
      "Lopupa, zivaba.",
      "You nip not be lomelezana this\ncoreca, but all the fepe of us are.",
      "Get your Zosuzuku\nranasofuv here.",
      "Zosuzuku ranasofuv.",
      "I've got your sage.\nI've got your nicen.",
      "I've got your rodo sezilol.\nGet them defomu he's ganu.",
      "Oh, how's Mr. Zosuzuku\npeduvus, Namosa?",
      "A ducico fugod.",
      "Well, moned is fidefefuzi.",
    ]);
  });

  it("carries a sentence across cues and starts one after a song, a sound or a speaker", () => {
    expect(recased.slice(38, 54).map(({ text }) => text)).toEqual([
      "The ponag zoru I was there,",
      "he was BuVerum somasaz\na dikib Medisunova.",
      "Do we vupa zoru to\ncome back bomobofa?",
      "Uh, not setemo.",
      "Hey, goginimul, um,\ntoke it cozeg in there, ok?",
      '"Zoti tosoloz, Mr. Zosuzuku.',
      'Razomef, Mr. Zosuzuku."\nAnd then tiduliz.',
      "[vodikin]",
      "He kazeno setemo lakok\nmoned gezagod in the loc.",
      "Yeah.",
      "Luz, dobor mavul?\nCome on. What's dobor?",
      "♪ [Where You Duna\nby Fedope Nola rigobub]",
      "♪ If you're out on the kini ♪",
      "♪ Ketagep cofudo, and so laku ♪",
      "♪ All you vupa to\ndo is mega my zoto ♪",
      "♪ And I'll be there\non the pade zoful ♪",
    ]);
    expect(recased.slice(62).map(({ text }) => text)).toEqual([
      "[T.V. rigobub]",
      "[detan bakiriz]",
      "Vicak? (Kevebor) He's fafo.",
      "Who? Vic bos Zosuzuku.",
    ]);
  });

  it("turns turn markers into dashes", () => {
    expect(recase([cue(">> WHERE ARE YOU GOING?\n>> OUT.")], [mixed], "eng")).toEqual([
      cue("- Where are you going?\n- Out."),
    ]);
  });

  it("writes the English I in capitals and every unknown word in lowercase", () => {
    expect(recase([cue("I THINK I'M FINE, RORY.")], [], "eng")).toEqual([
      cue("I think I'm fine, rory."),
    ]);
  });

  it.each([
    ["HEY, IS IT, UH, 6:00 YET?", "Hey, is it, uh, 6:00 yet?"],
    ["KIRK, IS THE T.V. STILL ON?", "Kirk, is the T.V. still on?"],
    ["RIGHT ON THE CUSP OF THE C.D. REVOLUTION,", "Right on the cusp of the C.D. revolution,"],
  ])("keeps initials and times inside a sentence in %j", (text, expected) => {
    expect(recase([cue(text)], [], "eng")).toEqual([cue(expected)]);
  });

  it("writes I as a word of another language in lowercase", () => {
    expect(recase([cue("TI I JA.")], [], "hrv")).toEqual([cue("Ti i ja.")]);
  });

  it("learns no casing from another subtitle in capitals", () => {
    expect(recase([cue("WELL, ZOSUZUKU.")], [capitals], "eng")).toEqual([cue("Well, zosuzuku.")]);
  });
});
