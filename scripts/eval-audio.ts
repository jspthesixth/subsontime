import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  headRule,
  labelOffsetMs,
  offsetsOf,
  pairsOf,
  rowsOf,
  summaryOf,
} from "../src/audio/evaluate.ts";
import {
  featurePath,
  featuresFor,
  featuresOf,
  jobsOf,
  labelledByFile,
  loaderOf,
  primitives,
  primitiveVersions,
  readCache,
  trimCutLine,
  type Computed,
  type Job,
  type Primitive,
} from "../src/audio/features.ts";

const usage = "usage: node scripts/eval-audio.ts <features|decide> <cache dir> <train|test>";

type Shared = { root: string; labelled: [string, string[]][] };

const serve = () => {
  const { root, labelled } = workerData as Shared;

  const load = loaderOf(root, new Map(labelled));

  parentPort?.on("message", async (job: Job) => {
    parentPort?.postMessage(await featuresFor(job, load), []);
  });
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();

const revision = () => {
  const dirty = git("status", "--porcelain") === "" ? "" : "-dirty";

  return `${git("rev-parse", "--short", "HEAD")}${dirty}`;
};

const appender = async (path: string) => {
  await mkdir(dirname(path), { recursive: true });
  await trimCutLine(path);

  return createWriteStream(path, { flags: "a" });
};

const computeFeatures = async (root: string, split: string) => {
  const { pairs } = await pairsOf(root, split, process.env);

  const sha = revision();
  const queue = jobsOf(pairs, await readCache(root, split, process.env, sha));
  const targets = queue.reduce((sum, job) => sum + job.targets.length, 0);
  const streams = new Map(
    await Promise.all(
      primitives.map(
        async (primitive) =>
          [primitive, await appender(featurePath(root, split, primitive, process.env))] as const,
      ),
    ),
  );
  const shared: Shared = { root, labelled: [...labelledByFile(pairs)] };
  const started = performance.now();
  let done = 0;

  const write = (computed: Computed[]) =>
    computed.forEach(({ key, values }) =>
      Object.entries(values).forEach(([primitive, value]) =>
        streams
          .get(primitive as Primitive)
          ?.write(
            `${JSON.stringify({ key, version: primitiveVersions[primitive as Primitive], sha, value })}\n`,
          ),
      ),
    );

  const pace = () => done / ((performance.now() - started) / 1000);

  const work = () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: shared });
      const next = () => {
        const job = queue.shift();

        if (job === undefined) {
          resolve();
          void worker.terminate();

          return;
        }

        worker.postMessage(job, []);
      };

      worker.on("message", (computed: Computed[]) => {
        done += computed.length;
        process.stderr.write(`\r${done} / ${targets} pairs, ${pace().toFixed(1)} pairs/s`);
        write(computed);
        next();
      });
      worker.on("error", reject);
      worker.on("exit", (code) => reject(new Error(`A worker exited with code ${code}`)));
      next();
    });

  await Promise.all(Array.from({ length: availableParallelism() }, work));
  await Promise.all([...streams.values()].map((stream) => new Promise((end) => stream.end(end))));

  console.log(JSON.stringify({ pairs: targets, pairsPerSecond: pace() }, null, 2));
};

const decide = async (root: string, split: string) => {
  const started = performance.now();
  const { pairs, skipped } = await pairsOf(root, split, process.env);

  const sha = revision();
  const cache = await readCache(root, split, process.env, sha);
  const rows = rowsOf(featuresOf(pairs, cache), headRule, labelOffsetMs);
  const path = join(root, "results", `${split}-${sha}.jsonl`);

  await mkdir(dirname(path), { recursive: true });

  const output = createWriteStream(path);

  rows.forEach((row) => output.write(`${JSON.stringify(row)}\n`));
  await new Promise((end) => output.end(end));

  console.log(
    JSON.stringify(
      {
        results: path,
        seconds: (performance.now() - started) / 1000,
        skipped,
        offsets: offsetsOf(rows),
        summary: summaryOf(rows, labelOffsetMs),
      },
      null,
      2,
    ),
  );
};

const main = async () => {
  const [stage, root, split] = process.argv.slice(2);

  if (root === undefined || split === undefined) {
    throw new Error(usage);
  }

  if (stage === "features") {
    await computeFeatures(root, split);

    return;
  }

  if (stage === "decide") {
    await decide(root, split);

    return;
  }

  throw new Error(usage);
};

if (isMainThread) {
  await main();
} else {
  serve();
}
