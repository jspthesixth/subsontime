import type { Cue } from "./cue.ts";

type Word = { word: string; at: number; startsSentence: boolean };

const capitalsShareMinimum = 0.8;
const capitalsCuesMinimum = 50;
const sentenceBreak = /[.?!:)\]♪♫]["”’']*(\s|$)|\n\s*-/u;
const wordPattern = /(?:\p{L}\.){2,}|\p{L}+/gu;

export const isMostlyCapitals = (cues: Cue[]) => {
  const text = cues.map((cue) => cue.text).join("\n");
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const capitals = text.match(/\p{Lu}/gu)?.length ?? 0;

  return capitals > letters * capitalsShareMinimum;
};

export const isCapitals = (cues: Cue[]) =>
  cues.length >= capitalsCuesMinimum && isMostlyCapitals(cues);

const wordsOf = (cues: Cue[]): Word[][] => {
  let gap = ".";

  return cues.map(({ text }) => {
    let end = 0;

    gap += "\n";

    const words = [...text.matchAll(wordPattern)].map(({ 0: word, index: at }) => {
      const startsSentence = sentenceBreak.test(gap + text.slice(end, at));

      gap = "";
      end = at + word.length;

      return { word, at, startsSentence };
    });

    gap += text.slice(end);

    return words;
  });
};

const vocabularyOf = (subtitles: Cue[][]) => {
  const words = subtitles
    .flatMap(wordsOf)
    .flat()
    .filter(({ startsSentence }) => !startsSentence)
    .map(({ word }) => word);

  return new Map(
    [...Map.groupBy(words, (word) => word.toLowerCase())].map(([lower, forms]) => {
      const counted = [...Map.groupBy(forms, (form) => form)];
      const [mostFrequent] = counted.toSorted(([, a], [, b]) => b.length - a.length);

      return [lower, mostFrequent?.[0] ?? lower];
    }),
  );
};

const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const recase = (cues: Cue[], others: Cue[][], lang: string): Cue[] => {
  const vocabulary = vocabularyOf(others.filter((other) => !isMostlyCapitals(other)));
  const turns = cues.map((cue) => ({ ...cue, text: cue.text.replace(/>>\s*/g, "- ") }));
  const casedOf = ({ word, startsSentence }: Word) => {
    if (word !== word.toUpperCase() || word.includes(".")) {
      return word;
    }

    const lower = word.toLowerCase();
    const cased = lang === "eng" && lower === "i" ? "I" : (vocabulary.get(lower) ?? lower);

    return startsSentence ? capitalized(cased) : cased;
  };

  const words = wordsOf(turns);

  return turns.map((cue, index) => ({
    ...cue,
    text: (words[index] ?? []).reduceRight(
      (text, word) =>
        text.slice(0, word.at) + casedOf(word) + text.slice(word.at + word.word.length),
      cue.text,
    ),
  }));
};
