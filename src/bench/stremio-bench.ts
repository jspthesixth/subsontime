import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import * as v from "valibot";
import { createApp } from "../app.ts";
import { splitOf } from "../audio/features.ts";
import type { Config } from "../config/config.ts";
import { defaultConfig } from "../config/default-config.ts";
import { seal } from "../config/seal.ts";
import { memorySharedState, type SharedState } from "../jobs/shared-state.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import type { TokenCache } from "../sources/token-cache.ts";
import { decodeRef, refKey, type SubtitleRef } from "../stremio/refs.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { isDiscOrWeb, looksLikeRip, parseRelease, sameRelease } from "../subtitles/release.ts";
import { truthOf, type Outcome, type Truth, type Verified } from "./truth.ts";

export const benchSecret = "a-throwaway-bench-secret-that-is-long-enough";
export const benchSalt = "a-throwaway-bench-salt-that-is-long-enough";

export type BenchFile = {
  sha256: string;
  kind: string;
  imdbId: string;
  path: string;
  verified: Verified[];
};

export type Tier = "hash" | "exact-release" | "disc-web-default" | "other" | "none";

export type Run = {
  lang: string;
  outcome: Outcome | "nothing";
  tier?: Tier;
  truth?: Truth;
  served?: string;
  downloads: number;
  wallMs: number;
};

export type Fingerprint = { hash: string; size: number };

export type SourcesFor = (config: Config, tokens: TokenCache, state: SharedState) => SourceSet;

export type FetchCounts = { network: number; restDownloads: number; refused: number };

const ManifestSchema = v.object({
  files: v.array(
    v.object({
      sha256: v.string(),
      split: v.string(),
      kind: v.string(),
      imdbId: v.string(),
      path: v.string(),
    }),
  ),
  subtitles: v.array(
    v.object({
      id: v.string(),
      titles: v.array(v.string()),
      lang: v.string(),
      url: v.string(),
      raw: v.optional(v.string()),
      normalized: v.optional(v.string()),
    }),
  ),
});

const HardNegativesSchema = v.object({
  pairs: v.array(
    v.object({ category: v.string(), split: v.string(), subtitle: v.string(), file: v.string() }),
  ),
});

const LabelsSchema = v.object({
  entries: v.array(
    v.object({
      file: v.string(),
      subtitle: v.string(),
      lang: v.string(),
      status: v.string(),
      cues: v.optional(v.string()),
    }),
  ),
});

const CuesSchema = v.array(v.object({ start: v.number(), end: v.number(), text: v.string() }));

const readJSON = async <T extends v.GenericSchema>(path: string, schema: T) =>
  v.parse(schema, JSON.parse(await readFile(path, "utf8")));

const titleOf = (imdbId: string) => imdbId.split(":")[0] ?? imdbId;

export const loadDataset = async (root: string, name: string, env: NodeJS.ProcessEnv) => {
  const split = splitOf(name, env);
  const manifest = await readJSON(join(root, "manifest.json"), ManifestSchema);
  const files = manifest.files.filter((file) => file.split === split);
  const shas = new Set(files.map(({ sha256 }) => sha256));
  const titles = new Set(files.map(({ imdbId }) => titleOf(imdbId)));
  const { entries } = await readJSON(join(root, "labels.json"), LabelsSchema);

  const verified = await Promise.all(
    entries
      .filter((entry) => shas.has(entry.file) && entry.status === "labelled")
      .flatMap(({ file, subtitle, lang, cues }) =>
        cues === undefined
          ? []
          : [
              readJSON(join(root, cues), CuesSchema).then((trusted) => ({
                file,
                verified: { id: subtitle, lang, cues: trusted },
              })),
            ],
      ),
  );
  const seeds = new Map(
    manifest.subtitles.flatMap(({ titles: listed, url, raw }) =>
      raw !== undefined && listed.some((title) => titles.has(title))
        ? [[url, join(root, raw)] as const]
        : [],
    ),
  );

  return {
    split,
    seeds,
    files: files.map(({ sha256, kind, imdbId, path }): BenchFile => ({
      sha256,
      kind,
      imdbId,
      path,
      verified: verified.filter((each) => each.file === sha256).map((each) => each.verified),
    })),
  };
};

export type Dataset = Awaited<ReturnType<typeof loadDataset>>;

export type Check = {
  file: string;
  subtitle: string;
  expected: "correct" | "wrong-title";
  truth: Truth;
};

const relatedCategories = new Set(["sequel", "remake"]);

export const validateTruth = async (root: string, dataset: Dataset, perFile: number) => {
  const { pairs } = await readJSON(join(root, "hard-negatives.json"), HardNegativesSchema);

  const manifest = await readJSON(join(root, "manifest.json"), ManifestSchema);
  const subtitles = new Map(manifest.subtitles.map((subtitle) => [subtitle.id, subtitle]));
  const cuesAt = async (path: string) =>
    parseSubtitle(decodeSubtitle(new Uint8Array(await readFile(join(root, path)))));

  const checks = dataset.files.flatMap((file) => [
    ...file.verified.slice(0, perFile).map(async (held): Promise<Check> => ({
      file: file.sha256,
      subtitle: held.id,
      expected: "correct",
      truth: await truthOf(
        held.cues,
        held.lang,
        file.verified.filter((each) => each !== held),
      ),
    })),
    ...pairs
      .filter(
        (pair) =>
          pair.split === dataset.split &&
          pair.file === file.sha256 &&
          relatedCategories.has(pair.category),
      )
      .slice(0, perFile)
      .flatMap((pair) => {
        const subtitle = subtitles.get(pair.subtitle);

        return subtitle?.normalized === undefined
          ? []
          : [
              cuesAt(subtitle.normalized).then(async (cues): Promise<Check> => ({
                file: file.sha256,
                subtitle: pair.subtitle,
                expected: "wrong-title",
                truth: await truthOf(cues, subtitle.lang, file.verified),
              })),
            ];
      }),
  ]);

  return (await Promise.allSettled(checks)).flatMap((result) =>
    result.status === "fulfilled" ? [result.value] : [],
  );
};

export const cachedFingerprint =
  (path: string, compute: (file: string) => Promise<Fingerprint>) =>
  async (file: string): Promise<Fingerprint> => {
    const known = await readFile(path, "utf8").then(
      (text) => JSON.parse(text) as Record<string, Fingerprint>,
      () => ({}) as Record<string, Fingerprint>,
    );
    const hit = known[file];

    if (hit !== undefined) {
      return hit;
    }

    const fingerprint = await compute(file);

    await writeFile(path, JSON.stringify({ ...known, [file]: fingerprint }));

    return fingerprint;
  };

export const languagesOf = (file: BenchFile) => [
  ...new Set(["eng", ...file.verified.map(({ lang }) => lang).toSorted()]),
];

type Stored = { status: number; statusText: string; headers: [string, string][]; body: string };

const droppedHeaders = new Set(["content-encoding", "content-length", "transfer-encoding"]);

const replay = ({ status, statusText, headers, body }: Stored) =>
  new Response(body === "" ? null : Buffer.from(body, "base64"), { status, statusText, headers });

const isRESTDownload = (method: string, url: string) =>
  method === "POST" && new URL(url).pathname.endsWith("/download");

export const cachingFetch = ({
  dir,
  seeds,
  restDownloadsLeft,
  upstream,
}: {
  dir: string;
  seeds: Map<string, string>;
  restDownloadsLeft: () => Promise<boolean>;
  upstream: typeof fetch;
}) => {
  const counts: FetchCounts = { network: 0, restDownloads: 0, refused: 0 };

  const cached = async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    const path = join(
      dir,
      `${createHash("sha256").update(`${method} ${url}\n${body}`).digest("hex")}.json`,
    );
    const stored = await readFile(path, "utf8").then(
      (text) => JSON.parse(text) as Stored,
      () => undefined,
    );

    if (stored !== undefined) {
      return replay(stored);
    }

    const seed = method === "GET" ? seeds.get(url) : undefined;

    if (seed !== undefined) {
      return new Response(await readFile(seed), { status: 200 });
    }

    const restDownload = isRESTDownload(method, url);

    if (restDownload && !(await restDownloadsLeft())) {
      counts.refused += 1;

      throw new Error("The bench REST download budget is spent");
    }

    counts.network += 1;

    const response = await upstream(input, init);

    if (response.status >= 400) {
      return response;
    }

    counts.restDownloads += restDownload ? 1 : 0;

    const record: Stored = {
      status: response.status,
      statusText: response.statusText,
      headers: [...response.headers].filter(([name]) => !droppedHeaders.has(name)),
      body: Buffer.from(await response.arrayBuffer()).toString("base64"),
    };

    await mkdir(dir, { recursive: true });
    await writeFile(path, JSON.stringify(record));

    return replay(record);
  };

  return { fetch: cached as typeof fetch, counts };
};

export const dailyLedger = (path: string, limit: number, now = () => new Date()) => {
  const day = () => now().toISOString().slice(0, 10);

  return async () => {
    const ledger = await readFile(path, "utf8").then(
      (text) => JSON.parse(text) as Record<string, number>,
      () => ({}) as Record<string, number>,
    );
    const spent = ledger[day()] ?? 0;

    if (spent >= limit) {
      return false;
    }

    await writeFile(path, JSON.stringify({ ...ledger, [day()]: spent + 1 }));

    return true;
  };
};

const candidateKey = (sourceName: string, ref: string) => `${sourceName}\n${ref}`;

const instrumented = (sources: SourceSet, seen: Map<string, Candidate>, downloads: string[]) => {
  const wrap = (source: Source): Source => ({
    name: source.name,
    async search(query, signal) {
      const found = await source.search(query, signal);

      found.forEach((candidate) =>
        seen.set(candidateKey(candidate.sourceName, candidate.ref), candidate),
      );

      return found;
    },
    download(ref, signal) {
      downloads.push(ref);

      return source.download(ref, signal);
    },
  });

  return { listed: sources.listed.map(wrap), references: sources.references.map(wrap) };
};

export const tierOf = (
  ref: Pick<SubtitleRef, "c" | "x">,
  seen: Map<string, Candidate>,
  filename: string,
): Tier => {
  if ([...ref.c.slice(0, 1), ...ref.x].some(({ h }) => h === 1)) {
    return "hash";
  }

  if (ref.x.length === 0) {
    return "none";
  }

  const fileRelease = parseRelease(filename);
  const releases = ref.x.flatMap(({ n, r }) => seen.get(candidateKey(n, r))?.release ?? []);

  if (releases.some((release) => sameRelease(release, fileRelease))) {
    return "exact-release";
  }

  return looksLikeRip(filename) && releases.length > 0 && releases.every(isDiscOrWeb)
    ? "disc-web-default"
    : "other";
};

const cuesOf = (srt: string): Cue[] => {
  try {
    return parseSubtitle(decodeSubtitle(new TextEncoder().encode(srt)));
  } catch {
    return [];
  }
};

type Listing = { subtitles: { lang: string; url: string }[] };

export const benchFile = async ({
  file,
  filename,
  fingerprint,
  languages,
  sourcesFor,
}: {
  file: BenchFile;
  filename: string;
  fingerprint: Fingerprint;
  languages: string[];
  sourcesFor: SourcesFor;
}): Promise<Run[]> => {
  const state = memorySharedState();
  const deferred: Promise<unknown>[] = [];
  const seen = new Map<string, Candidate>();
  const downloads: string[] = [];
  const app = createApp({
    secret: benchSecret,
    installSalt: benchSalt,
    state,
    sourcesFor: (config, tokens) =>
      instrumented(sourcesFor(config, tokens, state), seen, downloads),
    defer: (work) => {
      deferred.push(work.catch(() => undefined));
    },
  });
  const type = file.kind === "film" ? "movie" : "series";
  const name = encodeURIComponent(filename);
  const key = refKey(benchSecret);

  const runLanguage = async (lang: string): Promise<Run> => {
    const started = performance.now();
    const before = downloads.length;
    const base = `/${seal(defaultConfig([lang]), benchSecret)}/subtitles/${type}/${file.imdbId}`;

    await app.request(`${base}/filename=${name}.json`);

    const listing = await app.request(
      `${base}/videoHash=${fingerprint.hash}&videoSize=${fingerprint.size}&filename=${name}.json`,
    );
    const { subtitles } = (await listing.json()) as Listing;

    const entry = subtitles.find((subtitle) => subtitle.lang === lang);
    const path = entry === undefined ? undefined : new URL(entry.url).pathname;
    const response = path === undefined ? undefined : await app.request(path);
    const srt = response?.status === 200 ? await response.text() : "";
    const served = cuesOf(srt);
    const measured = { downloads: downloads.length - before, wallMs: performance.now() - started };

    if (path === undefined || served.length === 0) {
      return { lang, outcome: "nothing", ...measured };
    }

    const tier = tierOf(
      decodeRef((path.split("/").at(-1) ?? "").replace(/\.srt$/, ""), key),
      seen,
      filename,
    );
    const judged = await truthOf(served, lang, file.verified);

    return {
      lang,
      outcome: judged.outcome,
      tier,
      truth: judged,
      served: createHash("sha256").update(srt).digest("hex"),
      ...measured,
    };
  };

  const runs = await languages.reduce<Promise<Run[]>>(
    async (done, lang) => [...(await done), await runLanguage(lang)],
    Promise.resolve([]),
  );

  await Promise.all(deferred);

  return runs;
};

export const filenameOf = (file: Pick<BenchFile, "path">) => basename(file.path);

const outcomes = [
  "correct",
  "wrong-timing",
  "wrong-title",
  "unmeasurable",
  "nothing",
] as const satisfies readonly Run["outcome"][];

export const tiers = [
  "hash",
  "exact-release",
  "disc-web-default",
  "other",
  "none",
] as const satisfies readonly Tier[];

export const countOutcomes = (runs: Pick<Run, "outcome">[]) =>
  Object.fromEntries(
    outcomes.map((outcome) => [outcome, runs.filter((run) => run.outcome === outcome).length]),
  ) as Record<Run["outcome"], number>;

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

const outcomeRow = (label: string, runs: Run[]) => {
  const counts = countOutcomes(runs);

  return row([
    label,
    runs.length,
    ...outcomes.map((outcome) => `${counts[outcome]} (${percent(counts[outcome], runs.length)})`),
  ]);
};

export type FileResult = {
  file: string;
  imdbId: string;
  filename: string;
  runs: Run[];
  wallMs: number;
  fetches: FetchCounts;
};

export const summaryTable = (results: FileResult[]) => {
  const runs = results.flatMap((result) => result.runs);
  const header = [
    row(["", "runs", ...outcomes]),
    row(Array.from({ length: outcomes.length + 2 }, () => "---")),
  ];
  const tierRows = tiers.flatMap((tier) => {
    const inTier = runs.filter((run) => run.tier === tier);

    return inTier.length === 0 ? [] : [outcomeRow(`tier ${tier}`, inTier)];
  });
  const fileRows = results.map((result) => {
    const downloads = result.runs.reduce((sum, run) => sum + run.downloads, 0);

    return `${outcomeRow(result.filename, result.runs)} ${downloads} | ${Math.round(result.wallMs / 1000)} s | ${result.fetches.restDownloads} |`;
  });

  return [
    ...header,
    outcomeRow("all languages", runs),
    outcomeRow(
      "eng",
      runs.filter((run) => run.lang === "eng"),
    ),
    ...tierRows,
    "",
    `${row(["file", "runs", ...outcomes])} downloads | wall | REST downloads |`,
    row(Array.from({ length: outcomes.length + 5 }, () => "---")),
    ...fileRows,
  ].join("\n");
};
