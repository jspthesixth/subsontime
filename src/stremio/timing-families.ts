import { createHash, randomUUID } from "node:crypto";
import { setTimeout } from "node:timers/promises";
import * as v from "valibot";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { parseJSON } from "../json.ts";
import type { Candidate } from "../sources/source.ts";
import type { Cue } from "../subtitles/cue.ts";
import { sourceKindOf, type SourceKind } from "../subtitles/release.ts";
import { timingFamiliesOf } from "../timing/timing-families.ts";
import { errorName } from "./open-timings.ts";
import { candidateKey, type SubtitleRef } from "./refs.ts";

export const defaultTimeBoxMs = 2500;
const clusteringBudgetMs = 8000;
const familySeconds = 30 * 24 * 60 * 60;
const retrySeconds = 10 * 60;
const lockSeconds = 60;
const familiesSchema = v.array(v.array(v.string()));

const keyOf = ({ sourceName, ref }: Candidate) => candidateKey(sourceName, ref);

export const timingFamilyKeyOf = (video: SubtitleRef["q"], lang: string, candidates: Candidate[]) =>
  `tfam:${createHash("sha256")
    .update(JSON.stringify([video, lang, candidates.map(keyOf).toSorted()]))
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

type Clustered = { families: string[][]; complete: boolean };

const cluster = async (candidates: Candidate[], download: Download): Promise<Clustered> => {
  const deadline = performance.now() + clusteringBudgetMs;
  const downloaded = await Promise.allSettled(
    candidates.map(async (candidate) => ({
      item: keyOf(candidate),
      cues: (await download(candidate)).cues,
    })),
  );
  const timed = downloaded.flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
  const families = await timingFamiliesOf(timed, { deadline });

  return {
    families: families ?? [],
    complete: families !== undefined && timed.length === candidates.length,
  };
};

const candidatesOf = (families: string[][], candidates: Candidate[]) => {
  const byKey = new Map(candidates.map((candidate) => [keyOf(candidate), candidate]));

  return families
    .map((family) => family.flatMap((key) => byKey.get(key) ?? []))
    .filter((family) => family.length >= 2);
};

type Deps = {
  state: SharedState;
  key: string;
  candidates: Candidate[];
  download: Download;
  defer: (work: Promise<unknown>) => void;
  timeBoxMs: number;
};

export type FamilyResult = { families: Candidate[][]; pending: boolean };

const clusterOnce = (
  { state, key, candidates, download }: Deps,
  owner: string,
): Promise<string[][]> =>
  cluster(
    candidates.toSorted((a, b) => keyOf(a).localeCompare(keyOf(b))),
    download,
  )
    .catch((error: unknown): Clustered => {
      console.error(`Timing families failed: ${errorName(error)}`);

      return { families: [], complete: false };
    })
    .then(async ({ families, complete }) => {
      await orMiss(
        () => state.set(key, JSON.stringify(families), complete ? familySeconds : retrySeconds),
        undefined,
      );
      await orMiss(() => state.deleteIfEquals(`${key}:lock`, owner), false);

      return families;
    });

export const timingFamiliesFor = async (deps: Deps): Promise<FamilyResult> => {
  const { state, key, candidates, defer, timeBoxMs } = deps;

  const cached = await orMiss(() => state.get(key), null);

  if (cached === null) {
    return { families: [], pending: false };
  }

  if (cached !== undefined) {
    const parsed = v.safeParse(familiesSchema, parseJSON(cached));

    return {
      families: parsed.success ? candidatesOf(parsed.output, candidates) : [],
      pending: false,
    };
  }

  const owner = randomUUID();
  const locked = await orMiss(() => state.setIfAbsent(`${key}:lock`, owner, lockSeconds), false);

  if (!locked) {
    return { families: [], pending: true };
  }

  const timer = new AbortController();
  const work = clusterOnce(deps, owner);
  const timedOut = setTimeout(timeBoxMs, undefined, { signal: timer.signal, ref: false }).catch(
    () => undefined,
  );
  const families = await Promise.race([work, timedOut]);

  timer.abort();

  if (families !== undefined) {
    return { families: candidatesOf(families, candidates), pending: false };
  }

  try {
    defer(work);
  } catch (error) {
    console.error(`Timing families deferral failed: ${errorName(error)}`);
  }

  return { families: [], pending: true };
};
