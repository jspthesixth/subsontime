import { execFileSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import {
  evaluateSubtitle,
  labelOffsetMs,
  labelledByFile,
  loaderOf,
  offsetsOf,
  pairsOf,
  summaryOf,
  type Pair,
  type Row,
} from "../src/audio/evaluate.ts";

const usage = "usage: node scripts/eval-audio.ts <cache dir> <train|test>";

type Shared = { root: string; labelled: [string, string[]][] };

const serve = () => {
  const { root, labelled } = workerData as Shared;
  const load = loaderOf(root, new Map(labelled));

  parentPort?.on("message", async (pairs: Pair[]) => {
    parentPort?.postMessage(await evaluateSubtitle(pairs, load), []);
  });
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: import.meta.dirname, encoding: "utf8" }).trim();

const revision = () => {
  const dirty = git("status", "--porcelain") === "" ? "" : "-dirty";

  return `${git("rev-parse", "--short", "HEAD")}${dirty}`;
};

const main = async () => {
  const [root, split] = process.argv.slice(2);

  if (root === undefined || split === undefined) {
    throw new Error(usage);
  }

  const { pairs, skipped } = await pairsOf(root, split, process.env);
  const path = join(root, "results", `${split}-${revision()}.jsonl`);

  await mkdir(join(root, "results"), { recursive: true });

  const output = createWriteStream(path);
  const queue = [...Map.groupBy(pairs, (pair) => pair.subtitle).values()];
  const shared: Shared = { root, labelled: [...labelledByFile(pairs)] };
  const rows: Row[] = [];
  const started = performance.now();
  const pace = () => rows.length / ((performance.now() - started) / 1000);

  const work = () =>
    new Promise<void>((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: shared });
      const next = () => {
        const job = queue.shift();

        if (job === undefined) {
          void worker.terminate().then(() => resolve());

          return;
        }

        worker.postMessage(job, []);
      };

      worker.on("message", (done: Row[]) => {
        done.forEach((row) => output.write(`${JSON.stringify(row)}\n`));
        rows.push(...done);
        process.stderr.write(
          `\r${rows.length} / ${pairs.length} pairs, ${pace().toFixed(1)} pairs/s`,
        );
        next();
      });
      worker.on("error", reject);
      next();
    });

  await Promise.all(Array.from({ length: Math.max(availableParallelism() - 1, 1) }, work));
  await new Promise((resolve) => output.end(resolve));

  console.log(
    JSON.stringify(
      {
        results: path,
        pairsPerSecond: pace(),
        skipped,
        offsets: offsetsOf(rows),
        summary: summaryOf(rows, labelOffsetMs),
      },
      null,
      2,
    ),
  );
};

if (isMainThread) {
  await main();
} else {
  serve();
}
