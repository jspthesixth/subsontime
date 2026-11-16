import type { Cue } from "../subtitles/cue.ts";
import { alignCuesInWorker, alignOffsetInWorker, speedRatios } from "./alass.ts";
import { agreementMs, deltasOf, isMismatch, median } from "./retime.ts";

const minimumCues = 30;
const sameFamilyShare = 0.9;

export type Timed<T> = { item: T; cues: Cue[] };

type Options = { deadline?: number; now?: () => number };

const agrees = async (subtitle: Cue[], reference: Cue[]) => {
  const offsets = await Promise.all(
    speedRatios.map(async (speedRatio) => ({
      speedRatio,
      ...(await alignOffsetInWorker(reference, subtitle, speedRatio)),
    })),
  );
  const offset = offsets.reduce((best, each) => (each.score > best.score ? each : best));
  const { cues, score } = await alignCuesInWorker(reference, subtitle, offset.speedRatio);

  const deltas = deltasOf(subtitle, cues, 1);
  const center = median(deltas);
  const agreeing = deltas.filter((delta) => Math.abs(delta - center) <= agreementMs);

  return (
    !isMismatch({ offsetScore: offset.score, score }) &&
    agreeing.length >= sameFamilyShare * deltas.length
  );
};

const componentsOf = (size: number, links: [number, number][]) => {
  const parents = Array.from({ length: size }, (_, index) => index);
  const root = (index: number): number =>
    parents[index] === index ? index : root(parents[index] ?? index);

  for (const [a, b] of links) {
    parents[root(b)] = root(a);
  }

  return [...Map.groupBy(parents.keys(), root).values()];
};

export const timingFamiliesOf = async <T>(
  timed: Timed<T>[],
  { deadline = Infinity, now = () => performance.now() }: Options = {},
): Promise<T[][] | undefined> => {
  const usable = timed.filter(({ cues }) => cues.length >= minimumCues);
  const pairs = usable.flatMap((_, a) =>
    usable.slice(a + 1).map((__, offset) => [a, a + 1 + offset] as [number, number]),
  );
  const links: [number, number][] = [];

  for (const [a, b] of pairs) {
    if (now() > deadline) {
      return undefined;
    }

    if (await agrees(usable[a]?.cues ?? [], usable[b]?.cues ?? [])) {
      links.push([a, b]);
    }
  }

  return componentsOf(usable.length, links)
    .filter((members) => members.length >= 2)
    .map((members) =>
      members.flatMap((index) => usable.slice(index, index + 1).map(({ item }) => item)),
    );
};
