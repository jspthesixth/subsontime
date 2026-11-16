import type { Cue } from "../subtitles/cue.ts";

export type SourcedCue = Cue & { origin: number; unchanged: boolean };

export const seededRandom = (seed: number) => {
  let state = seed;

  return () => {
    state = (state + 0x6d2b79f5) | 0;

    let t = Math.imul(state ^ (state >>> 15), 1 | state);

    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const syntheticTrack = (seed: number, count: number): Cue[] => {
  const random = seededRandom(seed);
  const between = (min: number, max: number) => Math.round(min + random() * (max - min));

  return Array.from({ length: count }).reduce<Cue[]>((cues, _, index) => {
    const start = (cues.at(-1)?.end ?? 0) + between(300, 3000);

    return [...cues, { start, end: start + between(1000, 4000), text: `Line ${index}` }];
  }, []);
};

const editFor = (roll: number) => {
  if (roll < 0.15) {
    return "drop";
  }

  if (roll < 0.25) {
    return "split";
  }

  if (roll < 0.35) {
    return "merge";
  }

  return "keep";
};

export const resegment = (cues: Cue[], seed: number): SourcedCue[] => {
  const random = seededRandom(seed);
  const edits = cues.map(() => editFor(random()));
  const jitter = (time: number) => time + Math.round((random() * 2 - 1) * 200);

  return cues
    .flatMap((cue, index): SourcedCue[] => {
      const next = cues[index + 1];
      const middle = Math.round((cue.start + cue.end) / 2);

      if (edits[index - 1] === "merge" || edits[index] === "drop") {
        return [];
      }

      if (edits[index] === "merge" && next !== undefined) {
        return [{ ...cue, end: next.end, origin: index, unchanged: false }];
      }

      if (edits[index] === "split") {
        return [
          { ...cue, end: middle, origin: index, unchanged: false },
          { ...cue, start: middle, origin: index, unchanged: false },
        ];
      }

      return [{ ...cue, origin: index, unchanged: true }];
    })
    .map((cue) => ({ ...cue, start: jitter(cue.start), end: jitter(cue.end) }));
};

export const transform = <T extends Cue>(cues: T[], move: (time: number, cue: T) => number) =>
  cues.map((cue) => ({ ...cue, start: move(cue.start, cue), end: move(cue.end, cue) }));

const timed = async (run: () => unknown) => {
  const started = performance.now();

  await run();

  return performance.now() - started;
};

export const partlyUnrelated = (() => {
  const track = syntheticTrack(1, 200);
  const kept = Math.round(track.length / 2);
  const head = resegment(resegment(track.slice(0, kept), 7), 8);
  const tail = transform(
    syntheticTrack(9, track.length - kept),
    (time) => time + (head.at(-1)?.end ?? 0),
  );

  return transform([...head, ...tail], (time) => time + 2000);
})();

export const fastestOfThree = async (run: () => unknown) =>
  Math.min(await timed(run), await timed(run), await timed(run));

export const englishWords = [
  "where",
  "did",
  "you",
  "put",
  "the",
  "keys",
  "we",
  "need",
  "to",
  "leave",
  "now",
  "tonight",
  "nobody",
  "knows",
  "about",
  "this",
  "place",
  "come",
  "back",
  "here",
  "listen",
  "carefully",
  "train",
  "left",
  "early",
  "morning",
  "river",
  "house",
  "money",
  "letter",
];

export const croatianWords = [
  "gdje",
  "su",
  "ključevi",
  "moramo",
  "otići",
  "večeras",
  "nitko",
  "ne",
  "zna",
  "ovo",
  "mjesto",
  "šuma",
  "žurimo",
  "čekaj",
  "ćuti",
  "đak",
  "rijeka",
  "kuća",
  "novac",
  "pismo",
];

export const dialogueTrack = (seed: number, count: number, words = englishWords): Cue[] => {
  const random = seededRandom(seed + 1);
  const word = () => words[Math.floor(random() * words.length)] ?? "";
  const line = () => {
    const text = Array.from({ length: 4 + Math.floor(random() * 4) }, word).join(" ");

    return `${text.charAt(0).toUpperCase()}${text.slice(1)}${random() < 0.3 ? "?" : "."}`;
  };

  return syntheticTrack(seed, count).map((cue) => ({ ...cue, text: line() }));
};

const soundOnly = ["[DOOR SLAMS]", "(GASPS)", "♪ ♪", "[THUNDER RUMBLES]"];

export const isSoundOnly = (index: number) => index % 9 === 4;

export const withSoundDescriptions = (cues: Cue[]): Cue[] =>
  cues.map((cue, index) => {
    if (isSoundOnly(index)) {
      return { ...cue, text: soundOnly[index % soundOnly.length] ?? "" };
    }

    if (index % 7 === 3) {
      return { ...cue, text: `MARIA: ${cue.text}` };
    }

    if (index % 5 === 2) {
      return { ...cue, text: `(sighs) ${cue.text}` };
    }

    return cue;
  });
