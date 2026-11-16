import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import { sameTiming } from "../timing/anchor.ts";
import type { Download, Track } from "./file-route.ts";
import { candidateKey, type CandidateRef, type SubtitleRef } from "./refs.ts";

const decisionSeconds = 30 * 24 * 60 * 60;
const untrusted = -1;

export type Anchor = { track: Track; sharing: Set<string> };

const keyOf = ({ n, r }: CandidateRef) => candidateKey(n, r);

type Search = { partner?: number; complete: boolean };

const partnerOf = (anchor: Track, guards: CandidateRef[], download: Download) =>
  guards.reduce<Promise<Search>>(
    async (previous, guard, index) => {
      const search = await previous;

      if (search.partner !== undefined) {
        return search;
      }

      const track = await download(guard).catch(() => undefined);

      await setImmediate();

      if (track === undefined) {
        return { complete: false };
      }

      return (await sameTiming(anchor.cues, track.cues))
        ? { partner: index, complete: true }
        : search;
    },
    Promise.resolve({ complete: true }),
  );

const decide = async (state: SharedState, key: string, search: Promise<Search>) => {
  const { partner, complete } = await search;

  const decision = partner ?? untrusted;

  if (partner !== undefined || complete) {
    await orMiss(() => state.set(key, String(decision), decisionSeconds), undefined);
  }

  return decision;
};

const decisionOf = (cached: string | undefined, guards: number) => {
  const decided = Number(cached);

  return cached !== undefined &&
    Number.isInteger(decided) &&
    decided >= untrusted &&
    decided < guards
    ? decided
    : undefined;
};

export const anchorFor = async (
  state: SharedState,
  { q, a = [] }: Pick<SubtitleRef, "q" | "a">,
  download: Download,
): Promise<Anchor | undefined> => {
  const [first, ...guards] = a;

  if (first === undefined) {
    return undefined;
  }

  const key = `anchor:${createHash("sha256")
    .update(JSON.stringify([q, a.map(keyOf)]))
    .digest("base64url")}`;
  const decided = decisionOf(await orMiss(() => state.get(key), undefined), guards.length);

  if (decided === untrusted) {
    return undefined;
  }

  const track = await download(first).catch(() => undefined);

  if (track === undefined) {
    return undefined;
  }

  const partner = decided ?? (await decide(state, key, partnerOf(track, guards, download)));
  const agreeing = guards[partner];

  return agreeing === undefined
    ? undefined
    : { track, sharing: new Set([first, agreeing].map(keyOf)) };
};
