import { chmod, copyFile, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { parseArgs } from "node:util";
import { alignToAudio, audioAcceptContrast, audioMismatchContrast } from "../audio/align-audio.ts";
import { ffmpegFound } from "../audio/ffmpeg.ts";
import { toISO6391, toISO6392 } from "../languages.ts";
import { sharedFix } from "../stremio/open-timings.ts";
import type { Cue } from "../subtitles/cue.ts";
import { decodeSubtitle } from "../subtitles/decode.ts";
import { parseSubtitle } from "../subtitles/parse.ts";
import { writeSRT } from "../subtitles/write.ts";
import { shiftOf } from "../timing/retime.ts";
import { cueHashes } from "../timings/fingerprint.ts";
import {
  anotherVideoReason,
  audioNotShared,
  ratioOf,
  replaceFile,
  sharedOf,
  shiftText,
  timingOf,
  unusedReason,
} from "./fix.ts";
import type { CLIDeps } from "./main.ts";
import { defaultAPIURL, timingsClient } from "./timings-client.ts";
import { fileFingerprint } from "./video-hash.ts";

class UsageError extends Error {}

const usage = "usage: subsontime bazarr --video <path> --subtitle <path> --lang <code3>";
const left = "left as it is";
const inSyncMs = 100;

const options = {
  video: { type: "string" },
  subtitle: { type: "string" },
  lang: { type: "string" },
  private: { type: "boolean" },
  api: { type: "string" },
} as const;

const parse = (argv: string[]) => {
  try {
    return parseArgs({ args: argv, options }).values;
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : "Unreadable arguments");
  }
};

const firstLine = (error: unknown) =>
  (error instanceof Error ? error.message : "failed").split("\n")[0];

const code3Of = (lang: string) => toISO6392(toISO6391(lang) ?? lang) ?? lang.toLowerCase();

const notSharedText = (isPrivate: boolean) =>
  isPrivate ? "not shared, --private" : `not shared, ${audioNotShared}`;

const inSync = (original: Cue[], timed: Cue[], speedRatio: number) => {
  const { offsetMs, cuts } = shiftOf(original, timed, speedRatio);

  return speedRatio === 1 && cuts === 0 && Math.abs(offsetMs) <= inSyncMs;
};

const readCues = async (path: string, lang: string | undefined) =>
  parseSubtitle(decodeSubtitle(await readFile(path), lang));

const sameTexts = (first: Cue[], second: Cue[]) =>
  cueHashes(first).join() === cueHashes(second).join();

const rewrite = async (subtitle: string, lang: string | undefined, cues: Cue[], timed: Cue[]) => {
  const original = join(dirname(subtitle), `${basename(subtitle, extname(subtitle))}.orig.srt`);
  const kept = await readCues(original, lang).catch(() => []);
  const { mode } = await stat(subtitle);

  if (!sameTexts(kept, cues)) {
    await replaceFile(original, (temp) => copyFile(subtitle, temp));
  }

  await replaceFile(subtitle, async (temp) => {
    await writeFile(temp, writeSRT(timed));
    await chmod(temp, mode);
  });
};

const run = async (argv: string[]) => {
  const { video: videoPath, subtitle, lang, api, private: isPrivate } = parse(argv);

  if (videoPath === undefined || subtitle === undefined) {
    throw new UsageError("Give --video and --subtitle");
  }

  if (api !== undefined && !URL.canParse(api)) {
    throw new UsageError("Give --api as a full address");
  }

  if (extname(subtitle).toLowerCase() !== ".srt") {
    return `${left} · only .srt subtitles are retimed`;
  }

  const timings = isPrivate === true ? undefined : timingsClient(api ?? defaultAPIURL);
  const code3 = lang === undefined ? undefined : code3Of(lang);
  const cues = await readCues(subtitle, code3);
  const video = await fileFingerprint(videoPath);
  const fixed = await sharedFix(cues, await sharedOf(timings, video));

  if (fixed?.kind === "shared-fix") {
    const { label, value = "" } = timingOf(fixed, cues);

    if (inSync(cues, fixed.cues, ratioOf(cues, fixed.cues))) {
      return `already in sync with the ${label} ${value}`;
    }

    await rewrite(subtitle, code3, cues, fixed.cues);

    return `${label} ${value}`;
  }

  if (!ffmpegFound()) {
    return `${left} · ffmpeg is needed to sync to the audio. Install it and try again.`;
  }

  const audio = await alignToAudio(videoPath, cues);

  if (audio.kind !== "aligned") {
    return `${left} · ${unusedReason(audio)}`;
  }

  const contrast = `contrast ${audio.contrast.toFixed(1)}`;
  const notShared = notSharedText(isPrivate === true);

  if (audio.contrast < audioMismatchContrast) {
    return `${left} · ${anotherVideoReason} (${contrast}) · ${notShared}`;
  }

  if (audio.contrast < audioAcceptContrast) {
    return `${left} · ${unusedReason(audio)}`;
  }

  if (inSync(cues, audio.cues, audio.speedRatio)) {
    return `already in sync with the audio · ${contrast} · ${notShared}`;
  }

  await rewrite(subtitle, code3, cues, audio.cues);

  return `synced to the audio ${shiftText(cues, audio.cues, audio.speedRatio)} · ${contrast} · ${notShared}`;
};

export const bazarr = async (argv: string[], deps: CLIDeps) => {
  const line = await run(argv).catch((error: unknown) =>
    error instanceof UsageError
      ? `${firstLine(error)} · ${usage}`
      : `${left} · ${firstLine(error)}`,
  );

  deps.print(`subsontime: ${line}\n`);

  return 0;
};
