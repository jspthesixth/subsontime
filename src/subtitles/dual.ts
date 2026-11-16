import type { Cue } from "./cue.ts";

const maxAttached = 2;

const overlapOf = (first: Cue, second: Cue) =>
  Math.min(first.end, second.end) - Math.max(first.start, second.start);

const italic = ({ text }: Cue) => `<i>${text.replace(/\s*\n\s*/g, " ")}</i>`;

const byStart = (cues: Cue[]) =>
  cues
    .map((cue, index) => ({ cue, index }))
    .toSorted((left, right) => left.cue.start - right.cue.start);

const overlapsOf = (primary: Cue[], secondary: Cue[]) => {
  const lines = byStart(primary);
  let next = 0;
  let open: typeof lines = [];

  return byStart(secondary).flatMap(({ cue, index: second }) => {
    let line = lines[next];

    while (line !== undefined && line.cue.start < cue.end) {
      open.push(line);
      next += 1;
      line = lines[next];
    }

    open = open.filter((each) => each.cue.end > cue.start);

    return open.flatMap(({ cue: each, index: first }) => {
      const overlap = overlapOf(each, cue);

      return overlap > 0 ? [{ first, second, overlap }] : [];
    });
  });
};

const placementsOf = (primary: Cue[], secondary: Cue[]) => {
  const pairs = overlapsOf(primary, secondary).toSorted(
    (left, right) =>
      right.overlap - left.overlap || left.first - right.first || left.second - right.second,
  );
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
