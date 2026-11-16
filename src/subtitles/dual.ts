import type { Cue } from "./cue.ts";

const maxAttached = 2;

const overlapOf = (first: Cue, second: Cue) =>
  Math.min(first.end, second.end) - Math.max(first.start, second.start);

const italic = ({ text }: Cue) => `<i>${text.replace(/\s*\n\s*/g, " ")}</i>`;

export const mergeDual = (primary: Cue[], secondary: Cue[]): Cue[] => {
  const matches = secondary.map((cue) => {
    const overlaps = primary.map((line) => overlapOf(line, cue));
    const most = Math.max(0, ...overlaps);

    return { cue, most, line: most > 0 ? overlaps.indexOf(most) : -1 };
  });
  const byLine = Map.groupBy(
    matches.filter(({ line }) => line !== -1),
    ({ line }) => line,
  );
  const attached = new Set(
    [...byLine.values()].flatMap((group) =>
      group.toSorted((first, second) => second.most - first.most).slice(0, maxAttached),
    ),
  );
  const merged = primary.map((cue, index) => ({
    ...cue,
    text: [
      cue.text,
      ...(byLine.get(index) ?? [])
        .filter((match) => attached.has(match))
        .map(({ cue: line }) => italic(line)),
    ].join("\n"),
  }));
  const alone = matches
    .filter((match) => !attached.has(match))
    .map(({ cue }) => ({ ...cue, text: italic(cue) }));

  return [...merged, ...alone].toSorted((first, second) => first.start - second.start);
};
