import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import * as v from "valibot";
import { alignToSpeech } from "../src/audio/align-audio.ts";
import { pcmFrom, pcmSampleRate } from "../src/audio/ffmpeg.ts";
import type { Cue } from "../src/subtitles/cue.ts";
import { decodeSubtitle } from "../src/subtitles/decode.ts";
import { parseSubtitle } from "../src/subtitles/parse.ts";
import { cutsOf, deltasOf, median } from "../src/timing/retime.ts";
import { detectSpeech } from "../src/timing/speech.ts";

const usage =
  "usage: SUBSONTIME_FFMPEG=<ffmpeg> node --experimental-strip-types scripts/calibrate-audio.ts <output dir> <imdb id>=<video> [<imdb id>=<video> ...]";
const subtitlesPerFilm = 3;

const SubtitlesResponse = v.object({
  subtitles: v.array(
    v.object({
      id: v.string(),
      url: v.string(),
      lang: v.string(),
      subtitleFileName: v.optional(v.string()),
      fpsMilli: v.optional(v.number()),
    }),
  ),
});

type Subtitle = { id: string; name: string; fps: string; cues: Cue[] };

type Film = {
  name: string;
  speech: Cue[];
  decodeSeconds: number;
  audioMs: number;
  subtitles: Subtitle[];
};

type Aligned = Subtitle & {
  film: string;
  cues: Cue[];
  original: Cue[];
  score: number;
  offsetScore: number;
  contrast: number;
  speedRatio: number;
  shiftSeconds: number;
  cuts: number;
};

const [outputDirectory, ...filmArguments] = process.argv.slice(2);

if (outputDirectory === undefined || filmArguments.length === 0) {
  throw new Error(usage);
}

const seconds = (ms: number) => (ms / 1000).toFixed(1);

const fixed = (value: number) => value.toFixed(3);

const table = (headers: string[], rows: string[][]) => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (cells: string[]) =>
    cells.map((cell, column) => cell.padEnd(widths[column] ?? 0)).join("  ");

  console.log(
    [line(headers), line(widths.map((width) => "-".repeat(width))), ...rows.map(line)].join("\n"),
  );
  console.log();
};

const cached = async (path: string, make: () => Promise<string>) => {
  try {
    return await readFile(path, "utf8");
  } catch {
    const made = await make();

    await writeFile(path, made);

    return made;
  }
};

const subtitlesFor = async (imdbId: string) => {
  const listing = v.parse(
    SubtitlesResponse,
    await (await fetch(`https://opensubtitles-v3.strem.io/subtitles/movie/${imdbId}.json`)).json(),
  );
  const english = listing.subtitles
    .filter((entry) => entry.lang === "eng")
    .slice(0, subtitlesPerFilm);

  return Promise.all(
    english.map(async (entry) => {
      const text = await cached(join(outputDirectory, `${imdbId}-${entry.id}.srt`), async () =>
        decodeSubtitle(new Uint8Array(await (await fetch(entry.url)).arrayBuffer()), "eng"),
      );

      return {
        id: entry.id,
        name: entry.subtitleFileName ?? entry.id,
        fps: entry.fpsMilli === undefined ? "?" : String(entry.fpsMilli / 1000),
        cues: parseSubtitle(text),
      };
    }),
  );
};

const speechOf = async (imdbId: string, videoPath: string) => {
  const started = performance.now();
  const stored = await cached(join(outputDirectory, `${imdbId}.speech.json`), async () => {
    let samples = 0;
    const counted = async function* () {
      for await (const chunk of pcmFrom(videoPath, new AbortController().signal)) {
        samples += chunk.length;
        yield chunk;
      }
    };
    const speech = await detectSpeech(counted(), pcmSampleRate);

    return JSON.stringify({
      speech,
      decodeSeconds: (performance.now() - started) / 1000,
      audioMs: (samples * 1000) / pcmSampleRate,
    });
  });

  return v.parse(
    v.object({
      speech: v.array(v.object({ start: v.number(), end: v.number(), text: v.string() })),
      decodeSeconds: v.number(),
      audioMs: v.number(),
    }),
    JSON.parse(stored),
  );
};

const filmFrom = async (argument: string): Promise<Film> => {
  const separator = argument.indexOf("=");
  const imdbId = argument.slice(0, separator);
  const videoPath = argument.slice(separator + 1);

  if (separator < 1 || videoPath === "") {
    throw new Error(usage);
  }

  return {
    name: basename(videoPath, extname(videoPath)),
    ...(await speechOf(imdbId, videoPath)),
    subtitles: await subtitlesFor(imdbId),
  };
};

const alignedTo = async (film: Film, subtitle: Subtitle): Promise<Aligned> => {
  const result = await alignToSpeech({ spans: film.speech, audioMs: film.audioMs }, subtitle.cues);

  if (result.kind !== "aligned") {
    throw new Error(`${film.name}: ${result.kind}`);
  }

  const deltas = deltasOf(subtitle.cues, result.cues, result.speedRatio);

  return {
    ...subtitle,
    ...result,
    film: film.name,
    original: subtitle.cues,
    shiftSeconds: median(deltas) / 1000,
    cuts: cutsOf(deltas),
  };
};

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

const uniqueLines = (cues: Cue[], times: Cue[]) => {
  const counts = Map.groupBy(
    cues.map((cue, index) => ({
      key: normalized(cue.text),
      start: cue.start,
      before: times[index]?.start ?? 0,
    })),
    (line) => line.key,
  );

  return new Map(
    [...counts].flatMap(([key, lines]) =>
      key.length >= 8 && lines.length === 1 ? [[key, lines[0]]] : [],
    ),
  );
};

const agreement = (a: Aligned, b: Aligned) => {
  const linesA = uniqueLines(a.cues, a.original);
  const linesB = uniqueLines(b.cues, b.original);
  const shared = [...linesA].flatMap(([key, line]) => {
    const other = linesB.get(key);

    return other === undefined || line === undefined
      ? []
      : [
          {
            after: Math.abs(line.start - other.start),
            before: Math.abs(line.before - other.before),
          },
        ];
  });

  return {
    shared: shared.length,
    before: median(shared.map((pair) => pair.before)),
    after: median(shared.map((pair) => pair.after)),
  };
};

const pairsOf = <T>(items: T[]) =>
  items.flatMap((item, index) => items.slice(index + 1).map((other) => [item, other] as const));

await mkdir(outputDirectory, { recursive: true });

const films: Film[] = [];

for (const argument of filmArguments) {
  films.push(await filmFrom(argument));
}

const related: Aligned[] = [];

for (const film of films) {
  for (const subtitle of film.subtitles) {
    related.push(await alignedTo(film, subtitle));
  }
}

const anchors = new Map(
  films.map((film) => [
    film.name,
    related
      .filter((result) => result.film === film.name)
      .reduce((best, result) =>
        Math.abs(result.shiftSeconds) < Math.abs(best.shiftSeconds) ? result : best,
      ),
  ]),
);
const correctMs = 150;
const checked = related.map((result) => {
  const anchor = anchors.get(result.film);

  return {
    ...result,
    isAnchor: anchor === result,
    fromAnchor: anchor === undefined || anchor === result ? 0 : agreement(result, anchor).after,
  };
});
const unrelated: Aligned[] = [];

for (const audio of films) {
  for (const film of films.filter((other) => other !== audio)) {
    for (const subtitle of film.subtitles) {
      unrelated.push({
        ...(await alignedTo(audio, subtitle)),
        film: `${film.name} on ${audio.name}`,
      });
    }
  }
}

table(
  [
    "film",
    "runtime min",
    "speech spans",
    "speech min",
    "speech %",
    "subtitle min",
    "decode + detect s",
  ],
  films.map((film) => [
    film.name,
    seconds(film.audioMs / 60),
    String(film.speech.length),
    seconds(film.speech.reduce((sum, span) => sum + span.end - span.start, 0) / 60),
    (
      (100 * film.speech.reduce((sum, span) => sum + span.end - span.start, 0)) /
      film.audioMs
    ).toFixed(1),
    seconds(
      median(
        film.subtitles.map((subtitle) =>
          subtitle.cues.reduce((sum, cue) => sum + cue.end - cue.start, 0),
        ),
      ) / 60,
    ),
    film.decodeSeconds.toFixed(0),
  ]),
);

table(
  [
    "related: film",
    "subtitle",
    "fps",
    "cues",
    "offset score",
    "final score",
    "ratio",
    "shift s",
    "cuts",
    "baseline",
    "contrast",
    "from anchor ms",
  ],
  checked.map((result) => [
    result.film,
    result.name,
    result.fps,
    String(result.cues.length),
    fixed(result.offsetScore),
    fixed(result.score),
    fixed(result.speedRatio),
    result.shiftSeconds.toFixed(2),
    String(result.cuts),
    fixed(result.score / result.contrast),
    result.contrast.toFixed(2),
    result.isAnchor ? "anchor" : result.fromAnchor.toFixed(0),
  ]),
);

table(
  [
    "agreement: film",
    "subtitle a",
    "subtitle b",
    "shared lines",
    "median diff before ms",
    "median diff after ms",
  ],
  films.flatMap((film) =>
    pairsOf(related.filter((result) => result.film === film.name)).map(([a, b]) => {
      const { shared, before, after } = agreement(a, b);

      return [film.name, a.id, b.id, String(shared), before.toFixed(0), after.toFixed(0)];
    }),
  ),
);

table(
  [
    "unrelated: subtitle film on audio film",
    "subtitle",
    "offset score",
    "final score",
    "ratio",
    "cuts",
    "baseline",
    "contrast",
  ],
  unrelated.map((result) => [
    result.film,
    result.id,
    fixed(result.offsetScore),
    fixed(result.score),
    fixed(result.speedRatio),
    String(result.cuts),
    fixed(result.score / result.contrast),
    result.contrast.toFixed(2),
  ]),
);

const range = (values: number[]) =>
  values.length === 0
    ? "none"
    : `min ${fixed(Math.min(...values))}  median ${fixed(median(values))}  max ${fixed(Math.max(...values))}`;

table(
  ["summary", "offset score", "final score", "contrast"],
  [
    ...[true, false].map((isCorrect) => {
      const group = checked.filter((result) => result.fromAnchor <= correctMs === isCorrect);

      return [
        `related, ${isCorrect ? "within" : "over"} ${correctMs} ms of the anchor (${group.length})`,
        range(group.map((result) => result.offsetScore)),
        range(group.map((result) => result.score)),
        range(group.map((result) => result.contrast)),
      ];
    }),
    [
      `unrelated (${unrelated.length})`,
      range(unrelated.map((result) => result.offsetScore)),
      range(unrelated.map((result) => result.score)),
      range(unrelated.map((result) => result.contrast)),
    ],
  ],
);
