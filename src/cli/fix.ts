import { randomUUID } from "node:crypto";
import { readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import {
  alignToSpeech,
  audioAcceptContrast,
  audioMismatchContrast,
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
  type Attempt,
  type Download,
  type Share,
} from "../stremio/file-route.ts";
import { hashesOf, hiddenMatch, sharedFix, type Shared } from "../stremio/open-timings.ts";
import type { CandidateRef } from "../stremio/refs.ts";
import { bestSlotSize, searchVideo, toCandidateRef } from "../stremio/subtitles-route.ts";
import type { Cue } from "../subtitles/cue.ts";
import { parseRelease } from "../subtitles/release.ts";
import { writeSRT } from "../subtitles/write.ts";
import { cutsOf, deltasOf, median } from "../timing/retime.ts";
import { detectSpeech } from "../timing/speech.ts";
import type { FixWithCues } from "../timings/confirm.ts";
import type { VideoKey } from "../timings/db.ts";
import { nameOf, reasonOf, retimedDetail, timingOf } from "../web/check-route.ts";
import { identify } from "./identify.ts";
import type { TimingsClient } from "./timings-client.ts";
import { fileFingerprint } from "./video-hash.ts";

export type Sharing = "on" | "private" | "offline";

export type FixContext = {
  languages: string[];
  audio: boolean;
  sharing: Sharing;
  sources: SourceSet;
  timings?: TimingsClient;
  installId: () => Promise<string>;
  imdbId?: string;
  subtitle?: string;
  out?: string;
};

type Aligned = Extract<AudioAlignment, { kind: "aligned" }>;
type Skip = { lang: string; candidate: CandidateRef; reason: string };
type Found = { references: Candidate[]; ranked: (lang: string) => Candidate[] };
type AudioResult = AudioAlignment | { kind: "failed"; reason: string };
type Chosen = { candidate: CandidateRef; cues: Cue[]; timing: string; note?: string };
type Pick = { chosen?: Chosen; skipped: Skip[]; shares: Share[] };
type Language = { lines: string[]; skipped: Skip[]; written: boolean };
type Steps = {
  download: Download;
  shared: Shared | undefined;
  align: ((cues: Cue[]) => Promise<AudioResult>) | undefined;
  local: boolean;
};

const videoExtensions = new Set([".mkv", ".mp4", ".avi", ".m4v", ".mov", ".webm", ".ts"]);
const minimumVideoBytes = 50 * 1024 * 1024;
const labelWidth = 13;
const localSourceName = "Local file";
const audioMismatchReason =
  "Made for another video. Its dialogue does not line up with the soundtrack.";
const untimedReason = "Could not be timed to this file";
const unidentifiedReason = "Could not identify this title";

export const row = (label: string, text: string) => `  ${label.padEnd(labelWidth)}${text}`;

const continued = (text: string) => row("", text);

const sizeText = (size: number) =>
  size >= 1e9 ? `${(size / 1e9).toFixed(2)} GB` : `${(size / 1e6).toFixed(2)} MB`;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? String(error.code) : "";

export const findVideos = async (path: string, recursive: boolean): Promise<string[]> => {
  if (!(await stat(path)).isDirectory()) {
    return [path];
  }

  const entries = await readdir(path, { withFileTypes: true });
  const found = await Promise.all(
    entries.map(async (entry) => {
      const full = join(path, entry.name);

      if (entry.isDirectory()) {
        return recursive ? findVideos(full, true) : [];
      }

      const video =
        entry.isFile() &&
        videoExtensions.has(extname(entry.name).toLowerCase()) &&
        !/\bsample\b/i.test(entry.name);

      return video && (await stat(full)).size >= minimumVideoBytes ? [full] : [];
    }),
  );

  return found.flat().toSorted();
};

const writeSubtitle = async (
  directory: string,
  name: string,
  lang: string,
  cues: Cue[],
): Promise<{ file?: string; taken: string[] }> => {
  const code = toISO6391(lang) ?? lang;
  const names = [`${name}.${code}.srt`, `${name}.${code}.subsontime.srt`];

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

    const temp = join(directory, `.${file}.${randomUUID()}.tmp`);

    try {
      await writeFile(temp, writeSRT(cues));
      await rename(temp, target);
    } catch (error) {
      await Promise.all([rm(temp, { force: true }), rm(target, { force: true })]);

      throw error;
    }

    return { file, taken: names };
  }

  return { taken: names };
};

const sharedOf = async (
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

const timingText = (attempt: Attempt) => {
  const { label, detail } = timingOf(attempt, attempt.candidate.p);

  return detail === undefined ? label : `${label} · ${detail}`;
};

const sharedFirst = async (
  candidates: CandidateRef[],
  download: Download,
  shared: Shared | undefined,
): Promise<Chosen | undefined> => {
  if (shared === undefined || (await shared.confirmed()).length === 0) {
    return undefined;
  }

  for (const candidate of candidates) {
    const track = await download(candidate).catch(() => undefined);
    const usable = track !== undefined && hiddenMatch(track.cues, shared) === undefined;
    const result = usable ? await sharedFix(track.cues, shared) : undefined;

    if (result?.kind === "shared-fix") {
      return { candidate, cues: result.cues, timing: timingText({ candidate, result }) };
    }
  }

  return undefined;
};

const audioTiming = ({ candidate, track }: Attempt, audio: Aligned) => {
  const deltas = deltasOf(track?.cues ?? [], audio.cues, audio.speedRatio);
  const detail = retimedDetail(
    { offsetMs: Math.round(median(deltas)), speedRatio: audio.speedRatio, cuts: cutsOf(deltas) },
    candidate.p,
  );

  return `Aligned to the soundtrack · ${detail} · contrast ${audio.contrast.toFixed(1)}`;
};

const speechOnce = (path: string) => {
  let spans: Promise<Cue[] | Error> | undefined;

  return () => {
    spans ??= detectSpeech(pcmFrom(path, new AbortController().signal), pcmSampleRate).catch(
      (error: unknown) => (error instanceof Error ? error : new Error("ffmpeg failed")),
    );

    return spans;
  };
};

const unusedReason = (audio: AudioResult): string => {
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

const audioNote = (steps: Steps, audio: AudioResult | undefined) => {
  if (steps.align === undefined) {
    return undefined;
  }

  return `audio not used: ${audio === undefined ? "confirmed shared fix" : unusedReason(audio)}`;
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
): Promise<Pick> => {
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
      ),
    );
    const served = attempts.find((attempt) => servedCues(attempt, config) !== undefined);
    const passed = attempts.filter((attempt) => attempt !== served);
    const cues = served === undefined ? undefined : servedCues(served, config);

    skipped.push(
      ...passed.map((attempt) => ({
        lang,
        candidate: attempt.candidate,
        reason: reasonOf(attempt),
      })),
    );
    shares.push(...sharesOf(passed, video));
    remaining = remaining.slice(attempts.length);

    if (served === undefined || served.track === undefined || cues === undefined) {
      return { skipped, shares };
    }

    const audio =
      steps.align === undefined || served.result?.kind === "shared-fix"
        ? undefined
        : await steps.align(served.track.cues);
    const aligned = audio?.kind === "aligned" ? audio : undefined;
    const note = audioNote(steps, audio);

    if (aligned !== undefined && aligned.contrast < audioMismatchContrast) {
      skipped.push({ lang, candidate: served.candidate, reason: audioMismatchReason });
      shares.push({
        kind: "mismatch",
        input: { video, subtitleHashes: hashesOf(served.track.cues) },
      });
      continue;
    }

    if (aligned !== undefined && aligned.contrast >= audioAcceptContrast) {
      return {
        chosen: {
          candidate: served.candidate,
          cues: aligned.cues,
          timing: audioTiming(served, aligned),
        },
        skipped,
        shares: [
          ...shares,
          { kind: "fix", input: { video, subtitle: fixCuesOf(aligned.cues), method: "audio" } },
        ],
      };
    }

    if (steps.local && served.result?.kind === "not-retimed") {
      return {
        skipped: [
          ...skipped,
          {
            lang,
            candidate: served.candidate,
            reason: note === undefined ? `${untimedReason}.` : `${untimedReason} (${note}).`,
          },
        ],
        shares,
      };
    }

    return {
      chosen: { candidate: served.candidate, cues, timing: timingText(served), note },
      skipped,
      shares: [...shares, ...sharesOf([served], video)],
    };
  }

  return { skipped, shares };
};

const shareAll = async (shares: Share[], context: FixContext) => {
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

const shareLine = (sharing: Sharing, sent: boolean | undefined) => {
  if (sharing !== "on") {
    return `Not shared (--${sharing})`;
  }

  if (sent === undefined) {
    return "Nothing to share";
  }

  return sent ? "Shared with Open Timings" : "Not shared, Open Timings did not answer";
};

const fixLanguage = async (
  lang: string,
  path: string,
  video: VideoKey,
  found: Found,
  context: FixContext,
  steps: Steps,
): Promise<Language> => {
  const candidates = found.ranked(lang).slice(0, bestSlotSize).map(toCandidateRef);
  const language = nameOf(lang);

  if (candidates.length === 0) {
    return { lines: [row(language, "No subtitles found")], skipped: [], written: false };
  }

  const fromShared = await sharedFirst(candidates, steps.download, steps.shared);
  const picked: Pick =
    fromShared === undefined
      ? await pickTimed(lang, candidates, found.references.map(toCandidateRef), video, steps)
      : { chosen: { ...fromShared, note: audioNote(steps, undefined) }, skipped: [], shares: [] };
  const sent = await shareAll(picked.shares, context);
  const { chosen, skipped } = picked;

  if (chosen === undefined) {
    return { lines: [row(language, "No subtitle fits this file")], skipped, written: false };
  }

  const releaseName = found
    .ranked(lang)
    .find(
      (each) => each.sourceName === chosen.candidate.n && each.ref === chosen.candidate.r,
    )?.releaseName;
  const outcome = await writeSubtitle(
    context.out ?? dirname(path),
    basename(path, extname(path)),
    lang,
    chosen.cues,
  ).catch((error: unknown) => ({
    file: undefined,
    taken: [],
    error: error instanceof Error ? error.message : "Failed",
  }));
  const lines = [
    row(
      language,
      [chosen.candidate.n, ...(releaseName === undefined ? [] : [releaseName])].join(" · "),
    ),
    continued(chosen.timing),
    ...(chosen.note === undefined ? [] : [continued(chosen.note)]),
  ];

  if (outcome.file === undefined) {
    return {
      lines: [
        ...lines,
        continued(
          `Not written: ${"error" in outcome ? outcome.error : `${outcome.taken.join(" and ")} already exist`}`,
        ),
      ],
      skipped,
      written: false,
    };
  }

  return {
    lines: [
      ...lines,
      continued(`Wrote ${outcome.file}`),
      continued(shareLine(context.sharing, sent)),
    ],
    skipped,
    written: true,
  };
};

const skippedLines = (skipped: Skip[], found: Found) =>
  skipped.flatMap(({ lang, candidate, reason }) => {
    const releaseName = found
      .ranked(lang)
      .find((each) => each.sourceName === candidate.n && each.ref === candidate.r)?.releaseName;

    return [
      row(
        "Skipped",
        [nameOf(lang), candidate.n, ...(releaseName === undefined ? [] : [releaseName])].join(
          " · ",
        ),
      ),
      continued(reason),
    ];
  });

const searchFor = async (path: string, video: VideoKey, context: FixContext) => {
  const [lang = ""] = context.languages;

  if (context.subtitle !== undefined) {
    return {
      ...localFound(context.subtitle, lang),
      local: true,
      searched: row("Subtitle", basename(context.subtitle)),
    };
  }

  const title = await identify(basename(path), context.imdbId).catch(() => undefined);

  if (title === undefined) {
    return undefined;
  }

  const { sources } = context;
  const started = performance.now();
  const found = await searchVideo(sources, {
    ...title,
    videoHash: video.hash,
    videoSize: video.size,
    filename: basename(path),
    languages: context.languages,
  });
  const count = sources.listed.length + sources.references.length;
  const seconds = ((performance.now() - started) / 1000).toFixed(1);

  return {
    sources,
    found,
    local: false,
    searched: row("Searched", `${count} ${count === 1 ? "source" : "sources"} in ${seconds} s`),
  };
};

export const fixVideo = async (path: string, context: FixContext) => {
  const video = await fileFingerprint(path);
  const head = [basename(path), row("Fingerprint", `${video.hash} · ${sizeText(video.size)}`)];
  const [search, shared] = await Promise.all([
    searchFor(path, video, context),
    sharedOf(context.timings, video),
  ]);

  if (search === undefined) {
    return { lines: [...head, row("Skipped", unidentifiedReason)], written: 0 };
  }

  const { sources, found, local, searched } = search;
  const speech = speechOnce(path);
  const steps: Steps = {
    download: downloader(sources),
    shared,
    local,
    align: context.audio
      ? async (cues: Cue[]) => {
          const spans = await speech();

          return spans instanceof Error
            ? { kind: "failed", reason: spans.message }
            : alignToSpeech(spans, cues);
        }
      : undefined,
  };
  const languages: Language[] = [];

  for (const each of context.languages) {
    languages.push(await fixLanguage(each, path, video, found, context, steps));
  }

  return {
    lines: [
      ...head,
      searched,
      ...languages.flatMap((language) => language.lines),
      ...skippedLines(
        languages.flatMap((language) => language.skipped),
        found,
      ),
    ],
    written: languages.filter((language) => language.written).length,
  };
};
