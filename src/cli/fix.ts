import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  alignToSpeech,
  audioAcceptContrast,
  audioMismatchContrast,
  contrastOf,
  type AudioAlignment,
} from "../audio/align-audio.ts";
import { pcmFrom, pcmSampleRate } from "../audio/ffmpeg.ts";
import { defaultConfig } from "../config/default-config.ts";
import { toISO6391 } from "../languages.ts";
import type { SourceSet } from "../sources/from-config.ts";
import type { Candidate, Source } from "../sources/source.ts";
import {
  downloader,
  fixCuesOf,
  recordAttempts,
  resolveAttempts,
  servedCues,
  sharesOf,
  type Share,
} from "../stremio/file-route.ts";
import { hashesOf, type Shared } from "../stremio/open-timings.ts";
import type { CandidateRef } from "../stremio/refs.ts";
import { bestSlotSize, searchVideo, toCandidateRef } from "../stremio/subtitles-route.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import { scoreOf, speedRatios } from "../timing/alass.ts";
import { shiftOf, type RetimeResult } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import type { FixWithCues } from "../timings/confirm.ts";
import type { VideoKey } from "../timings/db.ts";
import { reasonOf } from "../web/check-route.ts";
import { identify, type Identified } from "./identify.ts";
import type { TimingsClient } from "./timings-client.ts";
import { fileFingerprint } from "./video-hash.ts";

export type Sharing = "on" | "private" | "offline";

export type Paint = { value: (text: string) => string; dim: (text: string) => string };

export type FixContext = {
  languages: string[];
  audio: boolean;
  sharing: Sharing;
  sources: SourceSet;
  timings?: TimingsClient;
  installId: () => Promise<string>;
  paint: Paint;
  named: boolean;
  imdbId?: string;
  subtitle?: string;
  out?: string;
};

type AudioResult = AudioAlignment | { kind: "failed"; reason: string };
type Line = { label: string; value?: string; tone?: "value" | "dim" };
type Skip = { lang: string; candidate: CandidateRef; reason: string };
type Found = { references: Candidate[]; ranked: (lang: string) => Candidate[] };
type Chosen = { candidate: CandidateRef; cues: Cue[]; timing: Line; audio?: Line };
type Picked = { chosen?: Chosen; skipped: Skip[]; shares: Share[] };
type Language = { lines: string[]; skipped: Skip[]; written: boolean };
type Listen = {
  align: (cues: Cue[]) => Promise<AudioResult>;
  check: (cues: Cue[]) => Promise<Line>;
};
type Steps = {
  download: ReturnType<typeof downloader>;
  shared: Shared | undefined;
  listen: Listen | undefined;
  local: boolean;
};

const videoExtensions = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts"]);
const minimumVideoBytes = 50 * 1024 * 1024;
const fieldWidth = 12;
const detailWidth = 28;
const maximumCutTimes = 3;
const localSourceName = "Local file";
const untimedReason = "could not be timed";
const inFlight = new Set<string>();

export const anotherVideoReason = "made for another video";

export const plainPaint: Paint = { value: (text) => text, dim: (text) => text };

export const ansiPaint: Paint = {
  value: (text) => `\u001B[33m${text}\u001B[39m`,
  dim: (text) => `\u001B[90m${text}\u001B[39m`,
};

export const field = (paint: Paint, label: string, text: string) =>
  `${paint.dim(`  ${label.padEnd(fieldWidth)}`)}${text}`;

const detail = (paint: Paint, { label, value, tone = "value" }: Line) =>
  value === undefined
    ? `      ${label}`
    : `      ${label.padEnd(detailWidth)}${paint[tone](value)}`;

const codeOf = (lang: string) => toISO6391(lang) ?? lang;

const sizeText = (size: number) =>
  size >= 1e9 ? `${(size / 1e9).toFixed(2)} GB` : `${(size / 1e6).toFixed(2)} MB`;

const seconds = (ms: number) => `${ms < 0 ? "-" : "+"}${Math.abs(ms / 1000).toFixed(2)} s`;

const fpsText = (fps: number) => String(Number(fps.toFixed(3)));

const speedText = (ratio: number, fps: number | undefined) =>
  fps === undefined ? `×${ratio.toFixed(4)}` : `${fpsText(fps)} to ${fpsText(fps / ratio)}`;

const clock = (ms: number) =>
  [ms / 3_600_000, (ms / 60_000) % 60, (ms / 1000) % 60]
    .map((part) => String(Math.floor(part)).padStart(2, "0"))
    .join(":");

export const shiftText = (original: Cue[], timed: Cue[], speedRatio: number, fps?: number) => {
  const { offsetMs, cutsAt } = shiftOf(original, timed, speedRatio);

  return [
    seconds(offsetMs),
    ...(speedRatio === 1 ? [] : [speedText(speedRatio, fps)]),
    ...(cutsAt.length === 0
      ? []
      : [`cuts at ${cutsAt.slice(0, maximumCutTimes).map(clock).join(", ")}`]),
  ].join(" · ");
};

const spanOf = (cues: Cue[]) => (cues.at(-1)?.start ?? 0) - (cues[0]?.start ?? 0);

const ratioOf = (original: Cue[], applied: Cue[]) => {
  const ratio = spanOf(applied) === 0 ? 1 : spanOf(original) / spanOf(applied);

  return speedRatios.reduce((best, each) =>
    Math.abs(each - ratio) < Math.abs(best - ratio) ? each : best,
  );
};

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

const messageOf = (error: unknown) => (error instanceof Error ? error.message : "Failed");

const shortReason = (reason: string) => {
  const [first = reason] = reason.split(". ");
  const trimmed = first.replace(/\.$/, "");

  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1);
};

export const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

export const audioShare = (video: VideoKey, cues: Cue[]): Share => ({
  kind: "fix",
  input: { video, subtitle: fixCuesOf(cues), method: "audio" },
});

export const mismatchShare = (video: VideoKey, cues: Cue[]): Share => ({
  kind: "mismatch",
  input: { video, subtitleHashes: hashesOf(cues) },
});

export const abandonWrites = () => {
  inFlight.forEach((path) => rmSync(path, { force: true }));
  inFlight.clear();
};

export const findVideos = async (
  path: string,
  recursive: boolean,
): Promise<{ videos: string[]; links: string[] }> => {
  if (!(await stat(path)).isDirectory()) {
    return { videos: [path], links: [] };
  }

  const entries = await readdir(path, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = join(path, entry.name);
      const video =
        videoExtensions.has(extname(entry.name).toLowerCase()) && !/\bsample\b/i.test(entry.name);

      if (entry.isDirectory()) {
        return recursive ? findVideos(full, true) : { videos: [], links: [] };
      }

      if (entry.isSymbolicLink()) {
        return { videos: [], links: video ? [full] : [] };
      }

      const big = video && entry.isFile() && (await stat(full)).size >= minimumVideoBytes;

      return { videos: big ? [full] : [], links: [] };
    }),
  );

  return {
    videos: found.flatMap((each) => each.videos).toSorted(),
    links: found.flatMap((each) => each.links).toSorted(),
  };
};

export const replaceFile = async (target: string, write: (temp: string) => Promise<void>) => {
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);

  inFlight.add(temp);

  try {
    await write(temp);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true });

    throw error;
  } finally {
    inFlight.delete(temp);
  }
};

const writeSubtitle = async (
  directory: string,
  name: string,
  lang: string,
  cues: Cue[],
): Promise<{ file?: string; problem?: string }> => {
  const names = [`${name}.${codeOf(lang)}.srt`, `${name}.${codeOf(lang)}.subsontime.srt`];

  for (const file of names) {
    const target = join(directory, file);
    const reserved = await writeFile(target, "", { flag: "wx" }).then(
      () => true,
      (error: unknown) => {
        if (errorCode(error) !== "EEXIST") {
          throw error;
        }

        return false;
      },
    );

    if (!reserved) {
      continue;
    }

    inFlight.add(target);

    try {
      await replaceFile(target, (temp) => writeFile(temp, writeSRT(cues)));
    } catch (error) {
      await rm(target, { force: true });

      return { problem: messageOf(error) };
    } finally {
      inFlight.delete(target);
    }

    return { file };
  }

  return { problem: `${names.join(" and ")} already exist` };
};

export const sharedOf = async (
  timings: TimingsClient | undefined,
  video: VideoKey,
): Promise<Shared | undefined> => {
  const found = await timings?.lookUp(video).catch(() => undefined);

  if (timings === undefined || found === undefined) {
    return undefined;
  }

  let confirmed: Promise<FixWithCues[]> | undefined;

  return {
    hidden: found.hidden,
    confirmed: () => {
      confirmed ??= Promise.all(
        found.fixes
          .filter((view) => view.status === "confirmed")
          .map(async (view) => ({
            ...view,
            cues: await timings.cues(video, view.id).catch(() => []),
          })),
      );

      return confirmed;
    },
  };
};

export const timingOf = (result: RetimeResult | undefined, original: Cue[], fps?: number): Line => {
  switch (result?.kind) {
    case "made-for-file":
      return { label: "made for this file", value: "fingerprint match" };
    case "retimed":
      return {
        label: result.byReleaseName ? "retimed by release name" : "retimed",
        value: shiftText(original, result.cues, result.speedRatio, fps),
      };
    case "shared-fix":
      return {
        label: "shared fix, confirmed",
        value: [
          shiftText(original, result.cues, ratioOf(original, result.cues), fps),
          `${result.agreeing} agree`,
          ...(result.fromAudio ? ["from audio"] : []),
        ].join(" · "),
      };
    default:
      return { label: "not retimed" };
  }
};

export const unusedReason = (audio: AudioResult) => {
  switch (audio.kind) {
    case "aligned":
      return `not clear enough (contrast ${audio.contrast.toFixed(1)})`;
    case "no-speech":
      return "no speech found";
    case "too-short":
      return "clip too short";
    case "empty-subtitle":
      return "empty subtitle";
    case "failed":
      return audio.reason;
  }
};

const unused = (audio: AudioResult): Line => ({
  label: "audio not used",
  value: unusedReason(audio),
});

const listenTo = (path: string): Listen => {
  let spans: Promise<Cue[] | Error> | undefined;

  const speech = () => {
    spans ??= detectSpeech(pcmFrom(path, new AbortController().signal), pcmSampleRate).catch(
      (error: unknown) => (error instanceof Error ? error : new Error("ffmpeg failed")),
    );

    return spans;
  };

  return {
    async align(cues) {
      const heard = await speech();

      return heard instanceof Error
        ? { kind: "failed", reason: heard.message }
        : alignToSpeech(heard, cues);
    },
    async check(cues) {
      const heard = await speech();

      if (heard instanceof Error) {
        return unused({ kind: "failed", reason: heard.message });
      }

      if (heard.length === 0) {
        return unused({ kind: "no-speech" });
      }

      const contrast = contrastOf(heard, cues, scoreOf(heard, cues));

      return contrast === undefined
        ? unused({ kind: "too-short" })
        : { label: "checked against the audio", value: `contrast ${contrast.toFixed(1)}` };
    },
  };
};

const localFound = (path: string, lang: string) => {
  const candidate: Candidate = {
    sourceName: localSourceName,
    ref: path,
    lang,
    release: parseRelease(basename(path)),
    releaseName: basename(path),
    hashMatch: false,
  };
  const source: Source = {
    name: localSourceName,
    search: async () => [candidate],
    download: async (ref) => new Uint8Array(await readFile(ref)),
  };

  return {
    sources: { listed: [source], references: [] },
    found: { references: [], ranked: () => [candidate] },
  };
};

const pickTimed = async (
  lang: string,
  candidates: CandidateRef[],
  references: CandidateRef[],
  video: VideoKey,
  steps: Steps,
): Promise<Picked> => {
  const config = defaultConfig([lang]);
  const skipped: Skip[] = [];
  const shares: Share[] = [];
  let remaining = candidates;

  while (remaining.length > 0) {
    const attempts = await recordAttempts(
      resolveAttempts(
        { c: remaining, x: references },
        config,
        steps.download,
        undefined,
        steps.shared,
        { lazyReferences: true },
      ),
    );
    const served = attempts.find((attempt) => servedCues(attempt, config) !== undefined);
    const passed = attempts.filter((attempt) => attempt !== served);
    const cues = served === undefined ? undefined : servedCues(served, config);

    skipped.push(
      ...passed.map((attempt) => ({
        lang,
        candidate: attempt.candidate,
        reason: shortReason(reasonOf(attempt)),
      })),
    );
    shares.push(...sharesOf(passed, video));
    remaining = remaining.slice(attempts.length);

    if (served === undefined || served.track === undefined || cues === undefined) {
      return { skipped, shares };
    }

    const { candidate, track, result } = served;
    const timing = timingOf(result, track.cues, candidate.p);

    if (result?.kind === "shared-fix") {
      return {
        chosen: { candidate, cues, timing, audio: await steps.listen?.check(cues) },
        skipped,
        shares,
      };
    }

    const audio = await steps.listen?.align(track.cues);
    const aligned = audio?.kind === "aligned" ? audio : undefined;

    if (aligned !== undefined && aligned.contrast < audioMismatchContrast) {
      skipped.push({ lang, candidate, reason: anotherVideoReason });
      shares.push(mismatchShare(video, track.cues));
      continue;
    }

    if (aligned !== undefined && aligned.contrast >= audioAcceptContrast) {
      return {
        chosen: {
          candidate,
          cues: aligned.cues,
          timing: {
            label: "synced against the audio",
            value: shiftText(track.cues, aligned.cues, aligned.speedRatio, candidate.p),
          },
        },
        skipped,
        shares: [...shares, audioShare(video, aligned.cues)],
      };
    }

    const audioLine = audio === undefined ? undefined : unused(audio);

    if (steps.local && result?.kind === "not-retimed") {
      const why = audioLine?.value === undefined ? "" : `, audio not used: ${audioLine.value}`;

      return {
        skipped: [...skipped, { lang, candidate, reason: `${untimedReason}${why}` }],
        shares,
      };
    }

    return {
      chosen: { candidate, cues, timing, audio: audioLine },
      skipped,
      shares: [...shares, ...sharesOf([served], video)],
    };
  }

  return { skipped, shares };
};

export const shareAll = async (
  shares: Share[],
  context: Pick<FixContext, "timings" | "sharing" | "installId">,
) => {
  const { timings } = context;

  if (timings === undefined || context.sharing !== "on" || shares.length === 0) {
    return undefined;
  }

  try {
    const installId = await context.installId();

    for (const share of shares) {
      await timings.submit(share, installId);
    }

    return true;
  } catch {
    return false;
  }
};

const shareLines = (sharing: Sharing, sent: boolean | undefined): Line[] => {
  if (sharing !== "on") {
    return [{ label: "not shared", value: `--${sharing}`, tone: "dim" }];
  }

  if (sent === undefined) {
    return [];
  }

  return sent
    ? [{ label: "shared with Open Timings", value: "numbers and fingerprints only", tone: "dim" }]
    : [{ label: "not shared", value: "Open Timings did not answer", tone: "dim" }];
};

const releaseOf = (found: Found, lang: string, candidate: CandidateRef) =>
  found.ranked(lang).find((each) => each.sourceName === candidate.n && each.ref === candidate.r)
    ?.releaseName;

const fixLanguage = async (
  lang: string,
  path: string,
  video: VideoKey,
  found: Found,
  context: FixContext,
  steps: Steps,
): Promise<Language> => {
  const { paint } = context;
  const candidates = found.ranked(lang).slice(0, bestSlotSize).map(toCandidateRef);
  const header = (text: string) => `${paint.value(`  ${codeOf(lang)}`)}  ${text}`;

  if (candidates.length === 0) {
    return { lines: [header("no subtitles found")], skipped: [], written: false };
  }

  const picked = await pickTimed(
    lang,
    candidates,
    found.references.map(toCandidateRef),
    video,
    steps,
  );
  const sent = await shareAll(picked.shares, context);
  const { chosen, skipped } = picked;

  if (chosen === undefined) {
    return { lines: [header("no subtitle fits this file")], skipped, written: false };
  }

  const release = releaseOf(found, lang, chosen.candidate);
  const outcome = await writeSubtitle(
    context.out ?? dirname(path),
    basename(path, extname(path)),
    lang,
    chosen.cues,
  );
  const written: Line[] =
    outcome.file === undefined
      ? [{ label: "not written", value: outcome.problem }]
      : [{ label: `wrote ${outcome.file}` }, ...shareLines(context.sharing, sent)];

  return {
    lines: [
      header([chosen.candidate.n, ...(release === undefined ? [] : [release])].join(" · ")),
      ...[chosen.timing, ...(chosen.audio === undefined ? [] : [chosen.audio]), ...written].map(
        (line) => detail(paint, line),
      ),
    ],
    skipped,
    written: outcome.file !== undefined,
  };
};

const answering = (sources: SourceSet, answered: Set<string>): SourceSet => {
  const wrap = (source: Source): Source => ({
    ...source,
    search: async (query, signal) => {
      const candidates = await source.search(query, signal);

      answered.add(source.name);

      return candidates;
    },
  });

  return { listed: sources.listed.map(wrap), references: sources.references.map(wrap) };
};

const titleText = (identified: Extract<Identified, { kind: "found" }>) => {
  const { title, name, year } = identified;
  const episode =
    title.season === undefined || title.episode === undefined
      ? undefined
      : `S${String(title.season).padStart(2, "0")}E${String(title.episode).padStart(2, "0")}`;

  return [name, year, episode, title.imdbId].filter((part) => part !== undefined).join(" · ");
};

const searchFor = async (path: string, video: VideoKey, context: FixContext) => {
  const { paint, sources } = context;
  const [lang = ""] = context.languages;

  if (context.subtitle !== undefined) {
    return {
      ...localFound(context.subtitle, lang),
      local: true,
      rows: [field(paint, "subtitle", basename(context.subtitle))],
    };
  }

  const identified = await identify(basename(path), context.imdbId);

  if (identified.kind === "skipped") {
    return identified.reason;
  }

  const answered = new Set<string>();
  const started = performance.now();
  const found = await searchVideo(answering(sources, answered), {
    ...identified.title,
    videoHash: video.hash,
    videoSize: video.size,
    filename: basename(path),
    languages: context.languages,
  });
  const names = [
    ...new Set(
      [...sources.listed, ...sources.references]
        .map((source) => source.name)
        .filter((name) => answered.has(name)),
    ),
  ];
  const time = paint.dim(`· ${((performance.now() - started) / 1000).toFixed(1)} s`);

  return {
    sources,
    found,
    local: false,
    rows: [
      field(paint, "title", titleText(identified)),
      field(paint, "searching", `${names.join(", ") || "no source answered"} ${time}`),
    ],
  };
};

export const fixVideo = async (path: string, context: FixContext) => {
  const { paint } = context;
  const video = await fileFingerprint(path);
  const head = [
    ...(context.named ? [basename(path)] : []),
    field(paint, "file", `${video.hash} · ${sizeText(video.size)}`),
  ];
  const [search, shared] = await Promise.all([
    searchFor(path, video, context),
    sharedOf(context.timings, video),
  ]);

  if (typeof search === "string") {
    return { text: [...head, field(paint, "skipped", search)].join("\n"), written: 0 };
  }

  const { sources, found, local, rows } = search;
  const steps: Steps = {
    download: downloader(sources),
    shared,
    local,
    listen: context.audio ? listenTo(path) : undefined,
  };
  const languages: Language[] = [];

  for (const lang of context.languages) {
    languages.push(await fixLanguage(lang, path, video, found, context, steps));
  }

  const skipped = languages
    .flatMap((language) => language.skipped)
    .map(({ lang, candidate, reason }) =>
      field(paint, "skipped", [codeOf(lang), candidate.n, reason].join(" · ")),
    );

  return {
    text: [
      [...head, ...rows],
      ...languages.map((language) => language.lines),
      ...(skipped.length === 0 ? [] : [skipped]),
    ]
      .map((block) => block.join("\n"))
      .join("\n\n"),
    written: languages.filter((language) => language.written).length,
  };
};
