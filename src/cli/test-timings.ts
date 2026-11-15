import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { vi } from "vitest";
import { appWith } from "../stremio/test-app.ts";
import type { Cue } from "../subtitles/cue.ts";
import { memoryStore, type TimingsStore } from "../timings/db.ts";
import { toFixCues } from "../timings/fingerprint.ts";
import { openSubtitlesHash } from "../video-hash.ts";

export type Recorded = { method: string; path: string; body: unknown };

const servers: { close: () => void }[] = [];

export const startTimings = async (store: TimingsStore = memoryStore()) => {
  const app = appWith({ listed: [], references: [] }, store);
  const requests: Recorded[] = [];
  const server = serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (request: Request) => {
      requests.push({
        method: request.method,
        path: new URL(request.url).pathname,
        body: request.method === "POST" ? await request.clone().json() : undefined,
      });

      return app.fetch(request);
    },
  });

  await once(server, "listening");
  servers.push(server);

  const { port } = server.address() as AddressInfo;

  return { url: `http://127.0.0.1:${port}`, requests, store };
};

export const stopTimings = () => servers.splice(0).forEach((server) => server.close());

export const posts = (requests: Recorded[]) =>
  requests.filter((request) => request.method === "POST");

export const videoKeyOf = async (path: string) => {
  const bytes = await readFile(path);

  return {
    hash: await openSubtitlesHash(bytes.length, async (start, length) =>
      bytes.subarray(start, start + length),
    ),
    size: bytes.length,
  };
};

export const confirmFix = async (
  store: TimingsStore,
  video: { hash: string; size: number },
  cues: Cue[],
) => {
  const fix = toFixCues(cues);
  const row = { video, subtitleHashes: fix.map((cue) => cue.h), cues: fix };

  await store.putFix({ ...row, method: "audio", submitter: "s1", origin: "o1" });
  await store.putFix({ ...row, method: "audio", submitter: "s2", origin: "o2" });
};

export const noNetwork = () =>
  vi.fn<typeof fetch>(async () => {
    throw new Error("No network");
  });
