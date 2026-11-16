import { vi } from "vitest";
import { memorySharedState } from "../jobs/shared-state.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import type { Candidate, Source } from "./source.ts";
import { installKeyOf, tokenCacheFor } from "./token-cache.ts";

export type Entry = {
  ref: string;
  lang?: string;
  hashMatch?: boolean;
  metered?: boolean;
  releaseName?: string;
  fps?: number;
  cues?: Cue[];
  hang?: boolean;
  delayMs?: number;
};

export const fakeSource = (name: string, entries: Entry[]) => {
  const candidates = entries.map((entry): Candidate => ({
    sourceName: name,
    ref: entry.ref,
    lang: entry.lang ?? "eng",
    release: parseRelease(entry.releaseName ?? ""),
    releaseName: entry.releaseName,
    hashMatch: entry.hashMatch ?? false,
    fps: entry.fps,
    metered: entry.metered,
  }));
  const search = vi.fn<Source["search"]>(async () => candidates);
  const download = vi.fn<Source["download"]>(async (ref) => {
    const entry = entries.find((candidate) => candidate.ref === ref);
    const cues = entry?.cues;

    if (entry?.hang === true) {
      return new Promise<Uint8Array>(() => {});
    }

    if (entry?.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, entry.delayMs));
    }

    if (cues === undefined) {
      throw new Error("Download failed");
    }

    return new TextEncoder().encode(writeSRT(cues));
  });

  return { name, search, download };
};

export const memoryTokenCache = () =>
  tokenCacheFor(memorySharedState(), "test-secret", installKeyOf("test"));
