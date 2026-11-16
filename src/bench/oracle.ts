import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import {
  isHearingImpaired,
  parseRelease,
  sameGroup,
  sameRelease,
  type Release,
} from "../subtitles/release.ts";
import type { BenchFile, FileResult, Listed, Run } from "./stremio-bench.ts";
import { truthOf, type Shape, type Truth } from "./truth.ts";

export type Availability =
  | "correct-served"
  | "correct-not-chosen"
  | "cross-language-only"
  | "none-correct";

export const availabilities: Availability[] = [
  "correct-served",
  "correct-not-chosen",
  "cross-language-only",
  "none-correct",
];

const truthVersion = "1";

export const candidateKey = ({ sourceName, ref }: Pick<Listed, "sourceName" | "ref">) =>
  `${sourceName}\n${ref}`;

const cuesOf = (bytes: Uint8Array, lang: string) => {
  try {
    return parseSubtitle(decodeSubtitle(bytes, lang));
  } catch {
    return [];
  }
};

export const judgeCandidates = async ({
  file,
  candidates,
  download,
  cacheDir,
}: {
  file: BenchFile;
  candidates: Listed[];
  download: (candidate: Listed) => Promise<Uint8Array>;
  cacheDir: string;
}) => {
  await mkdir(cacheDir, { recursive: true });

  const unique = [...new Map(candidates.map((each) => [candidateKey(each), each])).values()];

  return unique.reduce<Promise<Map<string, Truth>>>(async (done, candidate) => {
    const truths = await done;
    const key = candidateKey(candidate);
    const path = join(
      cacheDir,
      `${createHash("sha256").update(`${truthVersion}\n${file.sha256}\n${key}`).digest("hex")}.json`,
    );
    const cached = await readFile(path, "utf8").then(
      (text) => JSON.parse(text) as Truth,
      () => undefined,
    );

    if (cached !== undefined) {
      return truths.set(key, cached);
    }

    const bytes = await download(candidate).catch(() => undefined);

    if (bytes === undefined) {
      return truths;
    }

    const cues = cuesOf(bytes, candidate.lang);
    const truth: Truth =
      cues.length === 0
        ? { outcome: "unmeasurable" }
        : await truthOf(cues, candidate.lang, file.verified);

    await writeFile(path, JSON.stringify(truth));

    return truths.set(key, truth);
  }, Promise.resolve(new Map()));
};

const correctIn = (truths: Map<string, Truth>) => (candidate: Listed) =>
  truths.get(candidateKey(candidate))?.outcome === "correct";

export const availabilityOf = (
  run: Pick<Run, "outcome" | "candidates">,
  truths: Map<string, Truth>,
  fileCandidates: Listed[],
): Availability => {
  const correct = correctIn(truths);

  if (run.outcome === "correct") {
    return "correct-served";
  }

  if (run.candidates.some(correct)) {
    return "correct-not-chosen";
  }

  return fileCandidates.some(correct) ? "cross-language-only" : "none-correct";
};

const releaseOf = (candidate: Listed) => parseRelease(candidate.releaseName ?? "");

const releaseSignals: [string, (release: Release, file: Release) => boolean][] = [
  ["release name", sameRelease],
  ["group", sameGroup],
  ["source", (release, file) => release.source !== undefined && release.source === file.source],
  [
    "resolution",
    (release, file) => release.resolution !== undefined && release.resolution === file.resolution,
  ],
];

export const signalsOf = (
  run: Pick<Run, "candidates" | "servedRef">,
  truths: Map<string, Truth>,
  filename: string,
) => {
  const fileRelease = parseRelease(filename);
  const correct = run.candidates.filter(correctIn(truths));
  const servedAt = run.candidates.findIndex(
    ({ sourceName, ref }) => sourceName === run.servedRef?.n && ref === run.servedRef.r,
  );
  const served = run.candidates[servedAt];

  if (served === undefined) {
    return ["served candidate unknown"];
  }

  const signals = [
    ...releaseSignals.flatMap(([name, matches]) =>
      correct.some((each) => matches(releaseOf(each), fileRelease)) &&
      !matches(releaseOf(served), fileRelease)
        ? [name]
        : [],
    ),
    ...(correct.some(({ hashMatch }) => hashMatch) && !served.hashMatch ? ["hash match"] : []),
    ...(correct.some(({ fps }) => fps !== undefined && fps !== served.fps)
      ? [
          `fps ${served.fps ?? "unknown"} served, ${correct.find(({ fps }) => fps !== served.fps)?.fps} correct`,
        ]
      : []),
    ...(isHearingImpaired(served.releaseName ?? "") &&
    correct.some(({ releaseName }) => !isHearingImpaired(releaseName ?? ""))
      ? ["not hearing-impaired"]
      : []),
    ...(correct.some((each) => run.candidates.indexOf(each) < servedAt) ? ["listed earlier"] : []),
  ];

  return signals.length === 0 ? ["none"] : signals;
};

const row = (cells: (string | number)[]) => `| ${cells.join(" | ")} |`;

const percent = (part: number, whole: number) =>
  whole === 0 ? "-" : `${Math.round((100 * part) / whole)}%`;

const quartiles = (values: number[]) => {
  const each = values.toSorted((a, b) => a - b);

  return [0.25, 0.5, 0.75].map((q) => each[Math.floor(q * (each.length - 1))] ?? 0);
};

const sizeOf = (kind: Shape["kind"], shapes: Shape[]) => {
  if (kind === "offset") {
    const [low, middle, high] = quartiles(shapes.map(({ offsetMs }) => Math.abs(offsetMs)));

    return `|offset| median ${middle} ms (quartiles ${low}-${high} ms)`;
  }

  if (kind === "frame-rate" || kind === "drift") {
    const ratios = Map.groupBy(shapes, ({ speedRatio }) => speedRatio.toFixed(3));

    return [...ratios]
      .toSorted(([, a], [, b]) => b.length - a.length)
      .map(([ratio, each]) => `${ratio} x${each.length}`)
      .join(", ");
  }

  if (kind === "steps") {
    const [, middle] = quartiles(shapes.map(({ steps }) => steps));

    return `median ${middle} steps`;
  }

  return "";
};

export const oracleTables = (
  results: FileResult[],
  truthsByFile: Map<string, Map<string, Truth>>,
) => {
  const runs = results.flatMap((result) => {
    const truths = truthsByFile.get(result.file) ?? new Map<string, Truth>();
    const fileCandidates = result.runs.flatMap(({ candidates }) => candidates);

    return result.runs.map((run) => ({
      run,
      filename: result.filename,
      truths,
      availability: availabilityOf(run, truths, fileCandidates),
    }));
  });
  const availabilityRows = availabilities.map((availability) => {
    const count = runs.filter((each) => each.availability === availability).length;

    return row([availability, count, percent(count, runs.length)]);
  });
  const wrong = runs.flatMap(({ run }) =>
    run.outcome === "wrong-timing" && run.truth?.shape !== undefined ? [run.truth.shape] : [],
  );
  const shapeRows = (["offset", "frame-rate", "drift", "steps", "other"] as const).map((kind) => {
    const shapes = wrong.filter((shape) => shape.kind === kind);

    return row([kind, shapes.length, percent(shapes.length, wrong.length), sizeOf(kind, shapes)]);
  });
  const notChosen = runs.filter(({ availability }) => availability === "correct-not-chosen");
  const signals = notChosen.flatMap(({ run, truths, filename }) =>
    signalsOf(run, truths, filename).map((signal) => signal.replace(/^fps .*/, "fps differs")),
  );
  const signalRows = [...Map.groupBy(signals, (signal) => signal)]
    .toSorted(([, a], [, b]) => b.length - a.length)
    .map(([signal, each]) => row([signal, each.length, percent(each.length, notChosen.length)]));

  return [
    row(["availability", "runs", "share"]),
    row(["---", "---", "---"]),
    ...availabilityRows,
    "",
    row(["wrong-timing shape", "runs", "share", "size"]),
    row(["---", "---", "---", "---"]),
    ...shapeRows,
    "",
    row([`signal (of ${notChosen.length} correct-not-chosen runs)`, "runs", "share"]),
    row(["---", "---", "---"]),
    ...signalRows,
  ].join("\n");
};
