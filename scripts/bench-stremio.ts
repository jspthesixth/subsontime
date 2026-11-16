import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs, parseEnv } from "node:util";
import {
  benchFile,
  cachedFingerprint,
  cachingFetch,
  dailyLedger,
  filenameOf,
  languagesOf,
  loadDataset,
  summaryTable,
  validateTruth,
  type FileResult,
  type Listed,
} from "../src/bench/stremio-bench.ts";
import { openSubtitlesAddonURL } from "../src/config/default-config.ts";
import { stremioAddonSource } from "../src/sources/stremio-addon.ts";
import type { Truth } from "../src/bench/truth.ts";
import { timingErrorOf } from "../src/audio/evaluate.ts";
import { fileFingerprint } from "../src/cli/video-hash.ts";
import { openSubtitlesBudgetSchema, readGroup, sourcesSchema } from "../src/config/env.ts";
import { sourcesFromConfig } from "../src/sources/from-config.ts";

const usage =
  "usage: node scripts/bench-stremio.ts <run|validate|oracle|anchors> <train|test> [bench json for oracle] [--root dir] [--only text] [--rest-downloads n] [--settled]";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string", default: join(homedir(), "subsontime-audio-eval") },
    only: { type: "string" },
    "rest-downloads": { type: "string", default: "20" },
    settled: { type: "boolean", default: false },
  },
});

const [command, split = ""] = positionals;

const { root, only } = values;

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();

const revision = () => {
  const dirty = git("status", "--porcelain") === "" ? "" : "-dirty";

  return `${git("rev-parse", "--short", "HEAD")}${dirty}`;
};

const dataset = await loadDataset(root, split, process.env);
const files = dataset.files.filter((file) => only === undefined || file.path.includes(only));
const out = join(root, "bench");
const cache = join(root, "bench-cache");

await mkdir(out, { recursive: true });
await mkdir(cache, { recursive: true });

const validate = async () => {
  const checks = await validateTruth(root, { ...dataset, files }, 6);
  const groups = Map.groupBy(
    checks,
    ({ expected, truth }) => `${expected} via ${truth.method ?? "identity"}`,
  );
  const lines = [...groups].map(([group, members]) => {
    const outcomes = Map.groupBy(members, ({ truth }) => truth.outcome);
    const medians = members.flatMap(({ truth }) => truth.medianMs ?? []);
    const floor =
      medians.length === 0
        ? ""
        : ` median of medians ${timingErrorOf(medians, 0).medianMs} ms, p90 of medians ${timingErrorOf(medians, 0).p90Ms} ms`;

    return `${group}: ${members.length} (${[...outcomes].map(([outcome, each]) => `${outcome} ${each.length}`).join(", ")})${floor}`;
  });

  await writeFile(join(out, `validate-${revision()}.json`), JSON.stringify(checks, null, 1));
  console.log(lines.join("\n"));
};

const cachedFetch = () =>
  cachingFetch({
    dir: join(cache, "http"),
    seeds: dataset.seeds,
    restDownloadsLeft: dailyLedger(
      join(cache, "rest-downloads.json"),
      Number(values["rest-downloads"]),
    ),
    upstream: globalThis.fetch,
  });

const addon = stremioAddonSource(openSubtitlesAddonURL, "OpenSubtitles");

const download = (candidate: Listed) =>
  /^\d+$/.test(candidate.ref)
    ? Promise.reject(new Error("Metered REST subtitles are not judged"))
    : addon.download(candidate.ref, AbortSignal.timeout(8000));

const resultsFrom = async (from: string) =>
  (JSON.parse(await readFile(from, "utf8")) as { results: FileResult[] }).results;

const anchors = async () => {
  const { judgeCandidates } = await import("../src/bench/oracle.ts");

  const { anchorTables, clustersOf, simulateFile } = await import("../src/bench/anchor.ts");

  const { decodeSubtitle } = await import("../src/subtitles/decode.ts");

  const { parseSubtitle } = await import("../src/subtitles/parse.ts");

  const from = positionals[2] ?? "";
  const results = await resultsFrom(from);
  const clusterCache = join(cache, "clusters");

  globalThis.fetch = cachedFetch().fetch;
  await mkdir(clusterCache, { recursive: true });

  const perFile = await results.reduce<Promise<Parameters<typeof anchorTables>[0]>>(
    async (done, result) => {
      const file = files.find(({ sha256 }) => sha256 === result.file);

      if (file === undefined) {
        return done;
      }

      const listed = [
        ...new Map(
          result.runs
            .flatMap(({ candidates }) => candidates)
            .map((candidate) => [`${candidate.sourceName}\n${candidate.ref}`, candidate]),
        ).values(),
      ];
      const members = (
        await Promise.all(
          listed.map(async (candidate) => {
            const bytes = await download(candidate).catch(() => undefined);
            const cues = (() => {
              try {
                return bytes === undefined
                  ? []
                  : parseSubtitle(decodeSubtitle(bytes, candidate.lang));
              } catch {
                return [];
              }
            })();

            return cues.length === 0 ? [] : [{ ...candidate, cues }];
          }),
        )
      ).flat();
      const keys = members.map(({ sourceName, ref }) => `${sourceName}\n${ref}`);
      const path = join(
        clusterCache,
        `${createHash("sha256")
          .update(["2", file.sha256, ...keys].join("\n"))
          .digest("hex")}.json`,
      );
      const stored = await readFile(path, "utf8").then(
        (text) => JSON.parse(text) as { clusters: number[][]; checks: number; cpuMs: number },
        () => undefined,
      );
      const computed =
        stored ??
        (await (async () => {
          const counter = { checks: 0 };
          const cpu = process.cpuUsage();
          const clustered = await clustersOf(members, counter);
          const cpuMs = process.cpuUsage(cpu).user / 1000;
          const record = {
            clusters: clustered.map((cluster) => cluster.map((member) => members.indexOf(member))),
            checks: counter.checks,
            cpuMs,
          };

          await writeFile(path, JSON.stringify(record));

          return record;
        })());
      const clusters = computed.clusters.map((cluster) =>
        cluster.flatMap((index) => members[index] ?? []),
      );
      const candidateTruths = await judgeCandidates({
        file,
        candidates: listed,
        download,
        cacheDir: join(cache, "candidates"),
      });
      const simulated = await simulateFile({ result, file, members, clusters, candidateTruths });

      console.log(
        `${result.filename}: ${members.length} candidates, ${clusters.length} clusters (largest ${Math.max(...clusters.map((cluster) => cluster.length))}), ${computed.checks} timing checks, ${Math.round(computed.cpuMs / 1000)} s`,
      );

      return [
        ...(await done),
        {
          filename: result.filename,
          simulated,
          clusterChecks: computed.checks,
          clusterCPUMs: computed.cpuMs,
          members: members.length,
          clusters: clusters.length,
        },
      ];
    },
    Promise.resolve([]),
  );
  const table = anchorTables(perFile);
  const base = from.replace(/\.json$/, "");

  await writeFile(`${base}-anchors.json`, JSON.stringify(perFile, null, 1));
  await writeFile(`${base}-anchors.md`, `${table}\n`);
  console.log(table);
};

const oracle = async () => {
  const { availabilityOf, judgeCandidates, oracleTables, signalsOf } =
    await import("../src/bench/oracle.ts");

  const from = positionals[2] ?? "";
  const results = await resultsFrom(from);

  globalThis.fetch = cachedFetch().fetch;

  const truthsByFile = new Map(
    await results.reduce<Promise<[string, Map<string, Truth>][]>>(async (done, result) => {
      const file = files.find(({ sha256 }) => sha256 === result.file);
      const judged =
        file === undefined
          ? new Map()
          : await judgeCandidates({
              file,
              candidates: result.runs.flatMap(({ candidates }) => candidates),
              download,
              cacheDir: join(cache, "candidates"),
            });

      console.log(`${result.filename}: ${judged.size} candidates judged`);

      return [...(await done), [result.file, judged]];
    }, Promise.resolve([])),
  );
  const rows = results.flatMap((result) => {
    const truths = truthsByFile.get(result.file) ?? new Map();
    const fileCandidates = result.runs.flatMap(({ candidates }) => candidates);

    return result.runs.map((each) => {
      const availability = availabilityOf(each, truths, fileCandidates);

      return {
        filename: result.filename,
        lang: each.lang,
        outcome: each.outcome,
        availability,
        shape: each.truth?.shape,
        signals:
          availability === "correct-not-chosen"
            ? signalsOf(each, truths, result.filename)
            : undefined,
      };
    });
  });
  const table = oracleTables(results, truthsByFile);
  const base = from.replace(/\.json$/, "");

  await writeFile(`${base}-oracle.json`, JSON.stringify(rows, null, 1));
  await writeFile(`${base}-oracle.md`, `${table}\n`);
  console.log(table);
};

const run = async () => {
  const { openSubtitlesAppKey } = readGroup(
    sourcesSchema,
    parseEnv(await readFile(join(import.meta.dirname, "..", ".env.local"), "utf8")),
  );

  const { openSubtitlesDailyDownloads } = readGroup(openSubtitlesBudgetSchema, process.env);

  const cached = cachedFetch();
  const fingerprintOf = cachedFingerprint(join(cache, "fingerprints.json"), fileFingerprint);
  const sha = revision();
  const results: FileResult[] = [];

  globalThis.fetch = cached.fetch;

  for (const file of files) {
    const before = { ...cached.counts };
    const started = performance.now();
    const filename = filenameOf(file);
    const runs = await benchFile({
      file,
      filename,
      fingerprint: await fingerprintOf(file.path),
      languages: languagesOf(file),
      settled: values.settled,
      sourcesFor: (config, tokens, state) =>
        sourcesFromConfig(config, {
          tokens,
          state,
          openSubtitlesAppKey,
          openSubtitlesDailyDownloads,
        }),
    });
    const result: FileResult = {
      file: file.sha256,
      imdbId: file.imdbId,
      filename,
      runs,
      wallMs: performance.now() - started,
      fetches: {
        network: cached.counts.network - before.network,
        restDownloads: cached.counts.restDownloads - before.restDownloads,
        refused: cached.counts.refused - before.refused,
      },
    };

    results.push(result);
    console.log(
      `${filename}: ${runs.map((each) => `${each.lang} ${each.outcome}`).join(", ")} (${Math.round(result.wallMs / 1000)} s)`,
    );
  }

  const table = summaryTable(results);

  await writeFile(
    join(out, `${sha}${values.settled ? "-settled" : ""}.json`),
    JSON.stringify(
      { revision: sha, split: dataset.split, totals: cached.counts, results },
      null,
      1,
    ),
  );
  await writeFile(join(out, `${sha}${values.settled ? "-settled" : ""}.md`), `${table}\n`);
  console.log(table);
};

const commands: Record<string, () => Promise<void>> = { run, validate, oracle, anchors };
const chosen = commands[command ?? ""];

if (chosen === undefined) {
  throw new Error(usage);
}

await chosen();
