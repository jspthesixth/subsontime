import { createHash } from "node:crypto";
import { orMiss, type SharedState } from "../jobs/shared-state.ts";
import type { SingleFlight } from "../jobs/single-flight.ts";
import { fileSourceName } from "../sources/file-source.ts";
import { firstAgreeing } from "../timing/anchor.ts";
import type { Track } from "../timing/retime.ts";
import type { Download } from "./attempts.ts";
import { candidateKey, type CandidateRef, type SubtitleRef } from "./refs.ts";

const decisionSeconds = 30 * 24 * 60 * 60;
const retrySeconds = 10 * 60;
const guardBudgetMs = 5000;
const untrusted = -1;

export type Anchor = { track: Track; sharing: Set<string> };

export type AnchorDeps = {
  state: SharedState;
  singleFlight: SingleFlight;
  prepared: (track: Track) => Promise<Track | undefined>;
};

const keyOf = ({ n, r }: CandidateRef) => candidateKey(n, r);

const decide = async (
  state: SharedState,
  key: string,
  anchor: Track,
  guards: CandidateRef[],
  download: Download,
) => {
  const { partner, failed, cut } = await firstAgreeing(
    anchor.cues,
    guards.map((guard) =>
      download(guard).then(
        ({ cues }) => cues,
        () => undefined,
      ),
    ),
    performance.now() + guardBudgetMs,
  );

  const decision = partner ?? untrusted;

  if (!cut) {
    const seconds = partner === undefined && failed ? retrySeconds : decisionSeconds;

    await orMiss(() => state.set(key, String(decision), seconds), undefined);
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

const anchorKey = ({ q, a = [] }: Pick<SubtitleRef, "q" | "a">) =>
  `anchor:${createHash("sha256")
    .update(JSON.stringify([q, a.map(keyOf)]))
    .digest("base64url")}`;

export const anchorDecided = async (state: SharedState, ref: Pick<SubtitleRef, "q" | "a">) =>
  decisionOf(
    await orMiss(() => state.get(anchorKey(ref)), undefined),
    Math.max((ref.a?.length ?? 0) - 1, 0),
  ) !== undefined;

export const anchorFor = async (
  { state, singleFlight, prepared }: AnchorDeps,
  { q, a = [], x }: Pick<SubtitleRef, "q" | "a" | "x">,
  download: Download,
): Promise<Anchor | undefined> => {
  const [first, ...guards] = a;

  if (first === undefined || (first.h !== 1 && x.some(({ h }) => h === 1))) {
    return undefined;
  }

  const key = anchorKey({ q, a });
  const fromFile = first.n === fileSourceName;
  const decided = fromFile
    ? undefined
    : decisionOf(await orMiss(() => state.get(key), undefined), guards.length);

  if (decided === untrusted) {
    return undefined;
  }

  const downloaded = await download(first).catch(() => undefined);
  const track = downloaded === undefined ? undefined : await prepared(downloaded);

  if (track === undefined) {
    return undefined;
  }

  if (fromFile) {
    return { track, sharing: new Set([keyOf(first)]) };
  }

  const partner =
    decided ??
    Number(
      await singleFlight(`${key}:decision`, async () =>
        String(await decide(state, key, track, guards, download)),
      ),
    );
  const agreeing = guards[partner];

  return agreeing === undefined
    ? undefined
    : { track, sharing: new Set([first, agreeing].map(keyOf)) };
};
