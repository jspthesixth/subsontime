import type { Candidate, Source, VideoQuery } from "./source.ts";

export const searchAll = async (
  sources: Source[],
  query: VideoQuery,
  timeoutMs = 4000,
): Promise<Candidate[]> => {
  const results = await Promise.allSettled(
    sources.map((source) => source.search(query, AbortSignal.timeout(timeoutMs))),
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
};
