import type { Cue } from "./cue.ts";

const maxAttached = 2;

const overlapOf = (first: Cue, second: Cue) =>
  Math.min(first.end, second.end) - Math.max(first.start, second.start);

const italic = ({ text }: Cue) => `<i>${text.replace(/\s*\n\s*/g, " ")}</i>`;

const placementsOf = (primary: Cue[], secondary: Cue[]) => {
  const pairs = secondary
    .flatMap((cue, second) =>
      primary.flatMap((line, first) => {
        const overlap = overlapOf(line, cue);

        return overlap > 0 ? [{ first, second, overlap }] : [];
      }),
    )
    .toSorted((left, right) => right.overlap - left.overlap || left.first - right.first);
  const owner = new Map<number, number>();
  const attached = new Map<number, number>();

  for (const { first, second } of pairs) {
    const count = attached.get(first) ?? 0;

    if (!owner.has(second) && count < maxAttached) {
      owner.set(second, first);
      attached.set(first, count + 1);
    }
  }

  return owner;
};

export const mergeDual = (primary: Cue[], secondary: Cue[]): Cue[] => {
  const owner = placementsOf(primary, secondary);
  const placed = secondary.map((cue, second) => ({ cue, first: owner.get(second) }));
  const byLine = Map.groupBy(
    placed.filter(({ first }) => first !== undefined),
    ({ first }) => first,
  );
  const merged = primary.map((cue, first) => ({
    ...cue,
    text: [cue.text, ...(byLine.get(first) ?? []).map(({ cue: line }) => italic(line))].join("\n"),
  }));
  const alone = placed
    .filter(({ first }) => first === undefined)
    .map(({ cue }) => ({ ...cue, text: italic(cue) }));

  return [...merged, ...alone].toSorted((first, second) => first.start - second.start);
};
