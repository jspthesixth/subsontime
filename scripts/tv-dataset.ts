import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { filenameParse } from "@ctrl/video-filename-parser";
import { namesMatch, pickEvenly, truthProblem, type Episode } from "../src/bench/tv-bench.ts";
import { fileFingerprint } from "../src/cli/video-hash.ts";
import { code3Of } from "../src/languages.ts";
import { decodeSubtitle } from "../src/subtitles/decode.ts";
import { parseSubtitle } from "../src/subtitles/parse.ts";

const ffmpegImage =
  "linuxserver/ffmpeg@sha256:822d04f0b2d0c4847430f5cc90f20ea48be866bb502ece63fdeb729400bf5361";

const shows = [
  {
    name: "That '70s Show",
    dir: "That.'70s.Show.1998.S01-S08.1080p.Bluray.10bit.x265.HEVC.DDP.5.1-PHOCiS",
    truth: "embedded",
    lang: "eng",
    perSeason: 6,
  },
  {
    name: "Married with Children",
    dir: "Married with Children - Sve sezone (x265)",
    truth: "sidecar",
    lang: "hrv",
    perSeason: 1,
  },
] as const;

const { values } = parseArgs({
  options: {
    share: { type: "string", default: "/Volumes/Media/TV" },
    root: { type: "string", default: join(homedir(), "subsontime-audio-eval") },
  },
});

const { share, root } = values;

const out = join(root, "tv");
const truthDir = join(out, "truth");

type Stream = {
  index: number;
  codec_type: string;
  codec_name: string;
  tags?: { language?: string };
};

const textCodecs = new Set(["subrip", "ass", "ssa", "mov_text", "webvtt"]);

const docker = (inside: string, ...args: string[]) =>
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${share}:/share:ro`,
      "-v",
      `${out}:/out`,
      "--entrypoint",
      inside,
      ffmpegImage,
      ...args,
    ],
    { encoding: "utf8", maxBuffer: 1 << 26 },
  );

const inShare = (path: string) => join("/share", relative(share, path));

const probe = (path: string) =>
  JSON.parse(
    docker(
      "ffprobe",
      "-v",
      "error",
      "-show_entries",
      "stream=index,codec_type,codec_name:stream_tags=language:format=duration",
      "-of",
      "json",
      inShare(path),
    ),
  ) as { streams: Stream[]; format: { duration: string } };

const cinemeta = async (path: string) => {
  const response = await fetch(`https://v3-cinemeta.strem.io${path}`);

  return response.json();
};

const seriesOf = async (name: string) => {
  const { metas } = (await cinemeta(
    `/catalog/series/top/search=${encodeURIComponent(name)}.json`,
  )) as { metas: { id: string }[] };

  const id = metas[0]?.id ?? "";

  const { meta } = (await cinemeta(`/meta/series/${id}.json`)) as {
    meta: { videos: { id: string; season: number; episode: number; name?: string }[] };
  };

  return { id, videos: meta.videos };
};

const walk = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { withFileTypes: true, recursive: true }))
    .filter((entry) => entry.isFile() && /\.(mkv|mp4)$/i.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .toSorted();

const cuesIn = async (path: string, lang: string) => {
  try {
    return parseSubtitle(decodeSubtitle(new Uint8Array(await readFile(path)), lang));
  } catch {
    return [];
  }
};

await mkdir(truthDir, { recursive: true });

const episodes = await shows.reduce<Promise<Episode[]>>(async (done, show) => {
  const series = await seriesOf(show.name);
  const parsed = (await walk(join(share, show.dir))).map((path) => {
    const { seasons, episodeNumbers } = filenameParse(basename(path), true) as {
      seasons: number[];
      episodeNumbers: number[];
    };

    return { path, seasons, episodeNumbers };
  });
  const seasons = Map.groupBy(
    parsed.filter(({ seasons: found }) => found.length === 1),
    ({ seasons: [season] }) => season ?? 0,
  );
  const picked = [...seasons.values()].flatMap((members) => pickEvenly(members, show.perSeason));

  const built = await picked.reduce<Promise<Episode[]>>(
    async (soFar, { path, seasons: [season = 0], episodeNumbers }) => {
      const [episode = 0] = episodeNumbers;

      const imdbId = `${series.id}:${season}:${episode}`;
      const video = series.videos.find((each) => each.id === imdbId);
      const filename = basename(path);
      const { hash, size } = await fileFingerprint(path);

      const { streams, format } = probe(path);

      const durationMs = Math.round(Number(format.duration) * 1000);
      const subtitleStreams = streams.filter(({ codec_type }) => codec_type === "subtitle");
      const textStreams = subtitleStreams.filter(({ codec_name }) => textCodecs.has(codec_name));
      const sidecar = join(dirname(path), filename.replace(/\.[^.]+$/, ".srt"));

      const truth = await (show.truth === "embedded"
        ? Promise.all(
            textStreams.map(async ({ index, tags }) => {
              const tagged = tags?.language;
              const lang = tagged === undefined || tagged === "und" ? show.lang : code3Of(tagged);
              const track = join("truth", `${hash}.${index}.${lang}.srt`);

              if (!existsSync(join(out, track))) {
                docker(
                  "ffmpeg",
                  "-v",
                  "error",
                  "-y",
                  "-i",
                  inShare(path),
                  "-map",
                  `0:${index}`,
                  "-c:s",
                  "srt",
                  join("/out", track),
                );
              }

              return {
                lang,
                source: "embedded" as const,
                stream: index,
                path: track,
                cues: (await cuesIn(join(out, track), lang)).length,
              };
            }),
          )
        : copyFile(sidecar, join(out, "truth", `${hash}.sidecar.${show.lang}.srt`)).then(
            async () => {
              const track = join("truth", `${hash}.sidecar.${show.lang}.srt`);

              return [
                {
                  lang: show.lang,
                  source: "sidecar" as const,
                  path: track,
                  cues: (await cuesIn(join(out, track), show.lang)).length,
                },
              ];
            },
            () => [],
          ));
      const problems = await Promise.all(
        truth.map(async (track) => {
          const problem = truthProblem(await cuesIn(join(out, track.path), track.lang), durationMs);

          return problem === undefined ? [] : [`${track.lang} track: ${problem}`];
        }),
      );
      const named = video?.name === undefined || namesMatch(filename, video.name);
      const excluded = [
        ...(episodeNumbers.length === 1
          ? []
          : [`episodes ${episodeNumbers.join(", ")} in one file`]),
        ...(video === undefined ? [`${imdbId} is not on Cinemeta`] : []),
        ...(named ? [] : [`Cinemeta names ${imdbId} "${video?.name}"`]),
        ...(truth.length === 0
          ? [subtitleStreams.length === 0 ? "no subtitle track" : "only image subtitle tracks"]
          : []),
        ...problems.flat(),
      ];

      console.log(
        `${filename}: ${imdbId}, ${truth.map(({ lang, cues }) => `${lang} ${cues} cues`).join(", ")}${excluded.length === 0 ? "" : ` excluded: ${excluded.join("; ")}`}`,
      );

      return [
        ...(await soFar),
        {
          show: show.name,
          path,
          filename,
          hash,
          size,
          imdbId,
          season,
          episode,
          episodeName: video?.name,
          durationMs,
          truth,
          excluded: excluded.length === 0 ? undefined : excluded.join("; "),
        },
      ];
    },
    Promise.resolve([]),
  );

  return [...(await done), ...built];
}, Promise.resolve([]));

await writeFile(join(out, "dataset.json"), JSON.stringify({ episodes }, null, 1));
console.log(
  `${episodes.length} episodes, ${episodes.filter(({ excluded }) => excluded === undefined).length} kept`,
);
