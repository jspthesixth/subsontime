import { createHash } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import type { Candidate } from "../sources/source.ts";
import { sourceKindOf, type SourceKind } from "../subtitles/release.ts";
import { timingFamiliesOf } from "../timing/timing-families.ts";
import type { Cue } from "../subtitles/cue.ts";
import type { SubtitleRef } from "./refs.ts";

export const defaultTimeBoxMs = 2500;
const clusteringBudgetMs = 8000;
const familySeconds = 24 * 60 * 60;
const unfinishedSeconds = 60 * 60;
const familiesSchema = v.array(v.array(v.string()));

const keyOf = ({ sourceName, ref }: Candidate) => JSON.stringify([sourceName, ref]);

export const timingFamilyKeyOf = (video: SubtitleRef["q"], candidates: Candidate[]) =>
  `tfam:${createHash("sha256")
    .update(JSON.stringify([video, candidates.map(keyOf).toSorted()]))
    .digest("hex")}`;

const kindNames: Record<SourceKind, string> = {
  tv: "TV timing",
  disc: "DVD/Blu-ray timing",
  web: "Web timing",
};

export const familyKindOf = (family: Candidate[]) => {
  const kinds = new Set(family.flatMap(({ release }) => sourceKindOf(release) ?? []));

  return kinds.size === 1 ? [...kinds][0] : undefined;
};

const nameOf = (family: Candidate[], index: number) => {
  const kind = familyKindOf(family);

  return kind === undefined ? `Timing ${index + 1}` : kindNames[kind];
};

export const timingNamesOf = (families: Candidate[][]) =>
  families
    .map(nameOf)
    .map((name, index, names) =>
      names.indexOf(name) === index
        ? name
        : `${name} ${names.slice(0, index + 1).filter((other) => other === name).length}`,
    );

type Download = (candidate: Candidate) => Promise<{ cues: Cue[] }>;

const cluster = async (candidates: Candidate[], download: Download) => {
  const deadline = performance.now() + clusteringBudgetMs;
  const downloaded = await Promise.allSettled(
    candidates.map(async (candidate) => ({
      item: keyOf(candidate),
      cues: (await download(candidate)).cues,
    })),
  );

  return timingFamiliesOf(
    downloaded.flatMap((result) => (result.status === "fulfilled" ? [result.value] : [])),
    { deadline },
  );
};

const remembered = async (state: SharedState, key: string, families: string[][] | undefined) => {
  await orMiss(
    () =>
      state.set(
        key,
        JSON.stringify(families ?? []),
        families === undefined ? unfinishedSeconds : familySeconds,
      ),
    undefined,
  );

  return families ?? [];
};

const candidatesOf = (families: string[][], candidates: Candidate[]) => {
  const byKey = new Map(candidates.map((candidate) => [keyOf(candidate), candidate]));

  return families
    .map((family) => family.flatMap((key) => byKey.get(key) ?? []))
    .filter((family) => family.length > 0);
};

type Deps = {
  state: SharedState;
  key: string;
  candidates: Candidate[];
  download: Download;
  defer: (work: Promise<unknown>) => void;
  timeBoxMs: number;
};

export const timingFamiliesFor = async ({
  state,
  key,
  candidates,
  download,
  defer,
  timeBoxMs,
}: Deps): Promise<Candidate[][]> => {
  const cached = v.safeParse(
    familiesSchema,
    parseJSON((await orMiss(() => state.get(key), undefined)) ?? ""),
  );

  if (cached.success) {
    return candidatesOf(cached.output, candidates);
  }

  const timer = new AbortController();
  const work = cluster(candidates, download).then((families) => remembered(state, key, families));
  const timedOut = setTimeout(timeBoxMs, undefined, { signal: timer.signal, ref: false }).catch(
    () => undefined,
  );
  const families = await Promise.race([work, timedOut]);

  timer.abort();

  if (families === undefined) {
    defer(work);

    return [];
  }

  return candidatesOf(families, candidates);
};
