import type { Candidate, Source, VideoQuery } from "./source.ts";

const searchWithDeadline = (source: Source, query: VideoQuery, timeoutMs: number) =>
  new Promise<Candidate[]>((resolve, reject) => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort();
      reject(new Error(`${source.name} timed out`));
    }, timeoutMs);

    (async () => source.search(query, controller.signal))().then(
      (candidates) => {
        clearTimeout(timer);
        resolve(candidates);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });

export const searchAll = async (
  sources: Source[],
  query: VideoQuery,
  timeoutMs = 4000,
): Promise<Candidate[]> => {
  const results = await Promise.allSettled(
    sources.map((source) => searchWithDeadline(source, query, timeoutMs)),
  );

  return results.flatMap((result) => (result.status === "fulfilled" ? result.value : []));
};
