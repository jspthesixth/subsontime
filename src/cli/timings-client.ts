import * as v from "valibot";
import { createGuard, fetchWithTimeout } from "../http.ts";
import { maximumDownloadBytes, maximumSearchBytes } from "../sources/source.ts";
import type { Share } from "../stremio/file-route.ts";
import type { VideoKey } from "../timings/db.ts";
import { timingsOf } from "../web/client/lib/fix-rows.ts";

export const defaultAPIURL = "https://subsontime.com";

export type TimingsClient = ReturnType<typeof timingsClient>;

const readTimeoutMs = 4000;
const writeTimeoutMs = 8000;
const guard = createGuard({ allowLocal: true });
const writePaths = { fix: "/api/v1/fixes", mismatch: "/api/v1/mismatches" };
const cuesSchema = v.object({
  cues: v.array(v.object({ h: v.string(), s: v.number(), e: v.number() })),
});

const videoParam = ({ hash, size }: VideoKey) => `${hash}:${size}`;

export const timingsClient = (apiURL: string) => {
  const base = apiURL.replace(/\/+$/, "");

  const read = async (path: string, maxBytes: number): Promise<unknown> => {
    const response = await fetchWithTimeout(`${base}${path}`, { maxBytes }, readTimeoutMs, guard);

    if (!response.ok) {
      throw new Error(`Open Timings answered ${response.status}`);
    }

    return response.json();
  };

  return {
    async lookUp(video: VideoKey) {
      const timings = timingsOf(
        await read(`/api/v1/fixes?video=${videoParam(video)}`, maximumSearchBytes),
      );

      if (timings === undefined) {
        throw new Error("Open Timings answered an unknown shape");
      }

      return timings;
    },
    async cues(video: VideoKey, id: string) {
      const body = await read(
        `/api/v1/fixes/${videoParam(video)}/${encodeURIComponent(id)}/cues`,
        maximumDownloadBytes,
      );

      return v.parse(cuesSchema, body).cues;
    },
    async submit({ kind, input }: Share, installId: string) {
      const response = await fetchWithTimeout(
        `${base}${writePaths[kind]}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...input, installId }),
          maxBytes: maximumSearchBytes,
        },
        writeTimeoutMs,
        guard,
      );

      await response.body?.cancel();

      if (!response.ok) {
        throw new Error(`Open Timings answered ${response.status}`);
      }
    },
  };
};
