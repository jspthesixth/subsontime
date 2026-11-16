import type { Cue } from "./cue.ts";

type Word = { word: string; startsSentence: boolean };

const capitalsShareMinimum = 0.8;
const capitalsCuesMinimum = 50;
const sentenceBreak = /[.?!:)\]♪♫]["”’']*(\s|$)|\n\s*-/u;
const wordPattern = /(?:\p{L}\.){2,}|\p{L}+/gu;

export const isCapitals = (cues: Cue[]) => {
  const text = cues.map((cue) => cue.text).join("\n");
  const letters = text.match(/\p{L}/gu)?.length ?? 0;
  const capitals = text.match(/\p{Lu}/gu)?.length ?? 0;

  return cues.length >= capitalsCuesMinimum && capitals > letters * capitalsShareMinimum;
};

const rewriteWords = (cues: Cue[], rewrite: (word: Word) => string): Cue[] => {
  let gap = ".";

  return cues.map((cue) => {
    let end = 0;

    gap += "\n";

    const text = cue.text.replace(wordPattern, (word: string, at: number) => {
      const startsSentence = sentenceBreak.test(gap + cue.text.slice(end, at));

      gap = "";
      end = at + word.length;

      return rewrite({ word, startsSentence });
    });

    gap += cue.text.slice(end);

    return { ...cue, text };
  });
};

const vocabularyOf = (subtitles: Cue[][]) => {
  const words = subtitles.flatMap((cues) => {
    const inside: string[] = [];

    rewriteWords(cues, ({ word, startsSentence }) => {
      if (!startsSentence) {
        inside.push(word);
      }

      return word;
    });

    return inside;
  });

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
  const vocabulary = vocabularyOf(others.filter((other) => !isCapitals(other)));
  const turns = cues.map((cue) => ({ ...cue, text: cue.text.replace(/>>\s*/g, "- ") }));

  return rewriteWords(turns, ({ word, startsSentence }) => {
    if (word !== word.toUpperCase() || word.includes(".")) {
      return word;
    }

    const lower = word.toLowerCase();
    const cased = lang === "eng" && lower === "i" ? "I" : (vocabulary.get(lower) ?? lower);

    return startsSentence ? capitalized(cased) : cased;
  });
};
